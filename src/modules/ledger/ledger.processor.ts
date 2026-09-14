import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DatabaseService } from '../database/database.service';
import {
  CardTransactionWebhookDto,
  TransactionType,
} from '../webhooks/dto/card-transaction-webhook.dto';

@Processor('transaction-ledger')
@Injectable()
export class LedgerProcessor extends WorkerHost {
  private readonly logger = new Logger(LedgerProcessor.name);
  private readonly clearingAccount: string;

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
    // We inject the next queue to hand off the work when done
    @InjectQueue('odoo-sync') private readonly odooSyncQueue: Queue,
  ) {
    super();
    this.clearingAccount =
      this.config.get<string>('CARD_CLEARING_ACCOUNT') || '210000';
  }

  async process(
    job: Job<{
      webhookEventId: string;
      payload: CardTransactionWebhookDto;
      correlationId?: string;
    }>,
  ): Promise<void> {
    const { webhookEventId, payload } = job.data;

    // Acquire a dedicated Postgres client for the ACID transaction
    const client = await this.db.getClient();

    try {
      await client.query('BEGIN');

      // Pessimistic Read Lock: Prevent concurrent processing of the same event
      const eventRes = await client.query<{ status: string }>(
        'SELECT status FROM webhook_events WHERE id = $1 FOR UPDATE',
        [webhookEventId],
      );

      // If it's already processed, abort safely
      if (
        eventRes.rows.length === 0 ||
        eventRes.rows[0].status === 'processed'
      ) {
        await client.query('ROLLBACK');
        this.logger.warn(
          `Event ${webhookEventId} already processed. Skipping.`,
        );
        return;
      }

      // Resolve the Odoo Chart of Accounts ID (The Mapping Layer)
      const category = payload.data.category.toLowerCase();
      const mappingRes = await client.query<{ expense_account: string }>(
        'SELECT expense_account FROM category_gl_mapping WHERE category = $1',
        [category],
      );

      // Fallback to a general unallocated expense account if mapping is missing
      const expenseAccount =
        mappingRes.rows.length > 0
          ? mappingRes.rows[0].expense_account
          : '600999';

      // Double-Entry Accounting Logic
      let debitAccount = '';
      let creditAccount = '';

      if (payload.event_type === TransactionType.PURCHASE) {
        debitAccount = expenseAccount; // Debit increases expenses
        creditAccount = this.clearingAccount; // Credit increases liabilities
      } else if (payload.event_type === TransactionType.REFUND) {
        debitAccount = this.clearingAccount; // Reverse the flow
        creditAccount = expenseAccount;
      } else if (payload.event_type === TransactionType.FEE) {
        debitAccount = '600400'; // Bank Fees
        creditAccount = this.clearingAccount;
      }

      // Resolve Cost Center / Department & Odoo Analytical Account
      const rawCostCenter =
        payload.data.cost_center || payload.data.department || null;
      let costCenter: string | null = null;
      let analyticAccountCode: string | null = null;

      if (rawCostCenter) {
        costCenter = rawCostCenter.trim().toLowerCase();
        const costCenterRes = await client.query<{
          analytic_account_code: string;
        }>(
          'SELECT analytic_account_code FROM cost_center_analytic_mapping WHERE cost_center = $1',
          [costCenter],
        );
        if (costCenterRes.rows.length > 0) {
          analyticAccountCode = costCenterRes.rows[0].analytic_account_code;
        }
      }

      // Record the perfectly balanced journal entry
      const insertJournalQuery = `
        INSERT INTO journal_entries (
          webhook_event_id, transaction_type, amount, currency,
          debit_account, credit_account, card_last4, merchant_name,
          cost_center, analytic_account_code
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id;
      `;
      const journalRes = await client.query<{ id: string }>(
        insertJournalQuery,
        [
          webhookEventId,
          payload.event_type,
          payload.data.amount,
          payload.data.currency,
          debitAccount,
          creditAccount,
          payload.data.card_last4,
          payload.data.merchant,
          costCenter,
          analyticAccountCode,
        ],
      );
      const journalEntryId = journalRes.rows[0].id;

      // Initialize the Odoo Sync Tracking state
      await client.query(
        `INSERT INTO odoo_sync_status (journal_entry_id, status) VALUES ($1, 'pending')`,
        [journalEntryId],
      );

      // Mark the raw webhook as successfully processed
      await client.query(
        `UPDATE webhook_events SET status = 'processed' WHERE id = $1`,
        [webhookEventId],
      );

      await client.query('COMMIT');
      this.logger.log(
        `Created ledger entry ${journalEntryId} for event ${webhookEventId}`,
      );

      // Hand off to the Odoo Worker
      await this.odooSyncQueue.add(
        'sync-to-odoo',
        { journalEntryId, correlationId: job.data.correlationId },
        {
          jobId: journalEntryId, // Idempotency key for the next queue
          attempts: 5, // Resilience: Retry 5 times if Odoo is down
          backoff: { type: 'exponential', delay: 2000 }, // Exponential backoff
          removeOnComplete: true,
        },
      );
    } catch (error) {
      await client.query('ROLLBACK');
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to process ledger: ${errorMessage}`);

      // update the event so Ops can see it failed
      await this.db.query(
        `UPDATE webhook_events SET status = 'failed', error_message = $2 WHERE id = $1`,
        [webhookEventId, errorMessage],
      );
      throw error;
    } finally {
      client.release();
    }
  }
}
