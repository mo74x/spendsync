import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Body,
  Query,
  Logger,
  UseGuards,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { AdminApiKeyGuard } from './admin-api-key.guard';
import {
  CreateCategoryMappingDto,
  UpdateCategoryMappingDto,
} from './dto/category-mapping.dto';

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

export interface AdminSyncStats {
  synced: number;
  pending: number;
  failed: number;
  total: number;
}

export interface SyncedHistoryRow {
  journal_id: string;
  odoo_move_id: number;
  source_event_id: string;
  transaction_type: string;
  amount: string;
  currency: string;
  merchant_name: string;
  debit_account: string;
  credit_account: string;
  synced_at: Date | null;
}

export interface CategoryMappingRow {
  category: string;
  expense_account: string;
  description: string | null;
}

@Controller('api/v1/admin')
@UseGuards(AdminApiKeyGuard)
export class AdminController {
  private readonly logger = new Logger(AdminController.name);

  constructor(
    private readonly db: DatabaseService,
    @InjectQueue('odoo-sync') private readonly odooSyncQueue: Queue,
  ) {}

  // List all category to GL account mappings
  @Get('mappings')
  async getCategoryMappings(): Promise<CategoryMappingRow[]> {
    const query = `
      SELECT category, expense_account, description
      FROM category_gl_mapping
      ORDER BY category ASC
    `;
    const res = await this.db.query<CategoryMappingRow>(query);
    return res.rows;
  }

  // Create a new category to GL account mapping
  @Post('mappings')
  async createCategoryMapping(
    @Body() dto: CreateCategoryMappingDto,
  ): Promise<CategoryMappingRow> {
    const category = dto.category.trim().toLowerCase();

    const existing = await this.db.query(
      'SELECT category FROM category_gl_mapping WHERE category = $1',
      [category],
    );
    if (existing.rows.length > 0) {
      throw new ConflictException(
        `Category mapping for '${category}' already exists`,
      );
    }

    const query = `
      INSERT INTO category_gl_mapping (category, expense_account, description)
      VALUES ($1, $2, $3)
      RETURNING category, expense_account, description
    `;
    const res = await this.db.query<CategoryMappingRow>(query, [
      category,
      dto.expense_account.trim(),
      dto.description ? dto.description.trim() : null,
    ]);

    this.logger.log(
      `Created GL mapping: ${category} -> ${dto.expense_account}`,
    );
    return res.rows[0];
  }

  // Update an existing category to GL account mapping
  @Put('mappings/:category')
  async updateCategoryMapping(
    @Param('category') categoryParam: string,
    @Body() dto: UpdateCategoryMappingDto,
  ): Promise<CategoryMappingRow> {
    const category = categoryParam.trim().toLowerCase();

    const query = `
      UPDATE category_gl_mapping
      SET expense_account = $1, description = COALESCE($2, description)
      WHERE category = $3
      RETURNING category, expense_account, description
    `;
    const res = await this.db.query<CategoryMappingRow>(query, [
      dto.expense_account.trim(),
      dto.description !== undefined ? dto.description.trim() : null,
      category,
    ]);

    if (res.rows.length === 0) {
      throw new NotFoundException(
        `Category mapping for '${category}' not found`,
      );
    }

    this.logger.log(
      `Updated GL mapping: ${category} -> ${dto.expense_account}`,
    );
    return res.rows[0];
  }

  // Fetch dashboard statistics (total synced, pending, failed counts)
  @Get('stats')
  async getStats(): Promise<AdminSyncStats> {
    const query = `
      SELECT 
        COUNT(*) FILTER (WHERE status = 'synced')::int AS synced,
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
        COUNT(*) FILTER (WHERE status IN ('failed', 'exhausted'))::int AS failed,
        COUNT(*)::int AS total
      FROM odoo_sync_status
    `;
    const res = await this.db.query<AdminSyncStats>(query);
    const row = res.rows[0];
    return {
      synced: Number(row?.synced) || 0,
      pending: Number(row?.pending) || 0,
      failed: Number(row?.failed) || 0,
      total: Number(row?.total) || 0,
    };
  }

  // Fetch recent successful syncs
  @Get('sync-history')
  async getSyncHistory(
    @Query('limit') limit = 50,
  ): Promise<SyncedHistoryRow[]> {
    const query = `
      SELECT 
        je.id as journal_id,
        oss.odoo_move_id,
        we.source_event_id,
        je.transaction_type,
        je.amount, 
        je.currency,
        je.merchant_name,
        je.debit_account, 
        je.credit_account,
        oss.synced_at
      FROM odoo_sync_status oss
      JOIN journal_entries je ON oss.journal_entry_id = je.id
      JOIN webhook_events we ON je.webhook_event_id = we.id
      WHERE oss.status = 'synced'
      ORDER BY oss.synced_at DESC
      LIMIT $1
    `;
    const res = await this.db.query<SyncedHistoryRow>(query, [limit]);
    return res.rows;
  }

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
