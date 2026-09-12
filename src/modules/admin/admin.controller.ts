import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  Logger,
  UseGuards,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { AdminApiKeyGuard } from './admin-api-key.guard';

export interface FailedSyncRow {
  journal_id: string;
  source_event_id: string;
  transaction_type: string;
  amount: string;
  currency: string;
  merchant_name: string;
  debit_account: string;
  credit_account: string;
  last_error: string | null;
  attempts: number;
  last_attempt_at: Date | null;
}

@Controller('api/v1/admin')
@UseGuards(AdminApiKeyGuard)
export class AdminController {
  private readonly logger = new Logger(AdminController.name);

  constructor(
    private readonly db: DatabaseService,
    @InjectQueue('odoo-sync') private readonly odooSyncQueue: Queue,
  ) {}

  // Fetch failed syncs for the Operations UI Data Table
  @Get('sync-failures')
  async getFailedSyncs(@Query('limit') limit = 50): Promise<FailedSyncRow[]> {
    const query = `
      SELECT 
        je.id as journal_id, 
        we.source_event_id,
        je.transaction_type,
        je.amount, 
        je.currency,
        je.merchant_name,
        je.debit_account, 
        je.credit_account,
        oss.last_error, 
        oss.attempts, 
        oss.last_attempt_at
      FROM odoo_sync_status oss
      JOIN journal_entries je ON oss.journal_entry_id = je.id
      JOIN webhook_events we ON je.webhook_event_id = we.id
      WHERE oss.status = 'failed'
      ORDER BY oss.last_attempt_at DESC
      LIMIT $1
    `;
    const res = await this.db.query<FailedSyncRow>(query, [limit]);
    return res.rows;
  }

  // Remap an account code and trigger a sync retry
  @Post('sync-failures/:journalId/retry')
  async retryFailedSync(
    @Param('journalId') journalId: string,
    @Body('new_debit_account') newDebitAccount?: string,
  ) {
    const client = await this.db.getClient();

    try {
      await client.query('BEGIN');

      if (newDebitAccount) {
        this.logger.log(
          `Ops overriding debit account for ${journalId} to ${newDebitAccount}`,
        );
        await client.query(
          `UPDATE journal_entries SET debit_account = $1 WHERE id = $2`,
          [newDebitAccount, journalId],
        );
      }

      // Reset the status back to pending
      await client.query(
        `UPDATE odoo_sync_status SET status = 'pending' WHERE journal_entry_id = $1`,
        [journalId],
      );

      await this.odooSyncQueue.add(
        'sync-to-odoo',
        { journalEntryId: journalId },
        {
          jobId: `retry-${journalId}-${Date.now()}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
        },
      );

      await client.query('COMMIT');
      return { message: 'Sync job re-queued successfully', journalId };
    } catch (error: unknown) {
      await client.query('ROLLBACK');
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to re-queue job ${journalId}: ${errorMessage}`);
      throw error;
    } finally {
      client.release();
    }
  }
}
