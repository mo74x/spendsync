import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { OdooClient } from './odoo.client';

interface JournalEntrySyncRow {
  id: string;
  webhook_event_id: string;
  transaction_type: string;
  amount: string;
  currency: string;
  debit_account: string;
  credit_account: string;
  card_last4: string;
  merchant_name: string;
  created_at: Date;
  source_event_id: string;
}

@Processor('odoo-sync')
@Injectable()
export class OdooSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(OdooSyncProcessor.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly odoo: OdooClient,
  ) {
    super();
  }

  async process(job: Job<{ journalEntryId: string }>): Promise<void> {
    const { journalEntryId } = job.data;
    const client = await this.db.getClient();

    try {
      // Fetch the local journal entry and the original webhook idempotency key
      const query = `
        SELECT je.*, we.source_event_id 
        FROM journal_entries je
        JOIN webhook_events we ON je.webhook_event_id = we.id
        WHERE je.id = $1
      `;
      const res = await client.query<JournalEntrySyncRow>(query, [
        journalEntryId,
      ]);
      if (res.rows.length === 0) throw new Error('Journal entry not found');

      const entry = res.rows[0];

      // Resolve account string codes to Odoo integer IDs
      const debitOdooId = await this.odoo.getAccountIdByCode(
        entry.debit_account,
      );
      const creditOdooId = await this.odoo.getAccountIdByCode(
        entry.credit_account,
      );

      // Construct the Odoo account.move payload
      const accountMovePayload = {
        move_type: 'entry',
        date: new Date().toISOString().split('T')[0],
        ref: `Swypex Sync: ${entry.source_event_id}`, // Store source ID in Odoo for auditability
        journal_id: 1, // 'Miscellaneous Operations' journal default ID
        line_ids: [
          // Debit Line Tuple
          [
            0,
            0,
            {
              account_id: debitOdooId,
              name: `${entry.merchant_name} - ${entry.transaction_type}`,
              debit: parseFloat(entry.amount),
              credit: 0.0,
            },
          ],
          // Credit Line Tuple
          [
            0,
            0,
            {
              account_id: creditOdooId,
              name: `Card ${entry.card_last4} Liability`,
              debit: 0.0,
              credit: parseFloat(entry.amount),
            },
          ],
        ],
      };

      this.logger.log(`Pushing entry ${journalEntryId} to Odoo...`);

      // Create the Journal Entry in Odoo
      const odooMoveId = await this.odoo.executeKw<number>(
        'account.move',
        'create',
        [accountMovePayload],
      );

      // Automatically "Post" (confirm) the entry
      await this.odoo.executeKw('account.move', 'action_post', [[odooMoveId]]);

      // Update local sync state to Success
      await client.query(
        `UPDATE odoo_sync_status 
         SET status = 'synced', odoo_move_id = $1, attempts = attempts + 1, synced_at = NOW(), last_error = NULL
         WHERE journal_entry_id = $2`,
        [odooMoveId, journalEntryId],
      );

      this.logger.log(
        `Successfully synced ${journalEntryId} to Odoo. Move ID: ${odooMoveId}`,
      );
    } catch (error) {
      // Handle failure: Log the error and update status, then throw to trigger BullMQ retry
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      await client.query(
        `UPDATE odoo_sync_status 
         SET status = 'failed', attempts = attempts + 1, last_error = $1, last_attempt_at = NOW()
         WHERE journal_entry_id = $2`,
        [errorMessage, journalEntryId],
      );

      this.logger.error(
        `Odoo Sync failed for ${journalEntryId}: ${errorMessage}`,
      );

      // Throwing the error triggers BullMQ's exponential backoff retry mechanism
      throw error;
    } finally {
      client.release();
    }
  }
}
