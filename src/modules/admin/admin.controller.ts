import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  HttpCode,
  HttpStatus,
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
import {
  CreateCostCenterMappingDto,
  UpdateCostCenterMappingDto,
} from './dto/cost-center-mapping.dto';

export interface FailedSyncRow {
  journal_id: string;
  source_event_id: string;
  transaction_type: string;
  amount: string;
  currency: string;
  merchant_name: string;
  debit_account: string;
  credit_account: string;
  cost_center: string | null;
  analytic_account_code: string | null;
  status: string;
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
  cost_center: string | null;
  analytic_account_code: string | null;
  synced_at: Date | null;
}

export interface CategoryMappingRow {
  category: string;
  expense_account: string;
  description: string | null;
}

export interface CostCenterMappingRow {
  cost_center: string;
  analytic_account_code: string;
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

  // Delete an existing category to GL account mapping
  @Delete('mappings/:category')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteCategoryMapping(
    @Param('category') categoryParam: string,
  ): Promise<void> {
    const category = categoryParam.trim().toLowerCase();

    const res = await this.db.query(
      'DELETE FROM category_gl_mapping WHERE category = $1 RETURNING category',
      [category],
    );

    if (res.rows.length === 0) {
      throw new NotFoundException(
        `Category mapping for '${category}' not found`,
      );
    }

    this.logger.log(`Deleted GL mapping for category: ${category}`);
  }

  // List all cost center to analytical account mappings
  @Get('cost-centers')
  async getCostCenterMappings(): Promise<CostCenterMappingRow[]> {
    const query = `
      SELECT cost_center, analytic_account_code, description
      FROM cost_center_analytic_mapping
      ORDER BY cost_center ASC
    `;
    const res = await this.db.query<CostCenterMappingRow>(query);
    return res.rows;
  }

  // Create a new cost center to analytical account mapping
  @Post('cost-centers')
  async createCostCenterMapping(
    @Body() dto: CreateCostCenterMappingDto,
  ): Promise<CostCenterMappingRow> {
    const costCenter = dto.cost_center.trim().toLowerCase();

    const existing = await this.db.query(
      'SELECT cost_center FROM cost_center_analytic_mapping WHERE cost_center = $1',
      [costCenter],
    );
    if (existing.rows.length > 0) {
      throw new ConflictException(
        `Cost center mapping for '${costCenter}' already exists`,
      );
    }

    const query = `
      INSERT INTO cost_center_analytic_mapping (cost_center, analytic_account_code, description)
      VALUES ($1, $2, $3)
      RETURNING cost_center, analytic_account_code, description
    `;
    const res = await this.db.query<CostCenterMappingRow>(query, [
      costCenter,
      dto.analytic_account_code.trim(),
      dto.description ? dto.description.trim() : null,
    ]);

    this.logger.log(
      `Created cost center mapping: ${costCenter} -> ${dto.analytic_account_code}`,
    );
    return res.rows[0];
  }

  // Update an existing cost center mapping
  @Put('cost-centers/:costCenter')
  async updateCostCenterMapping(
    @Param('costCenter') costCenterParam: string,
    @Body() dto: UpdateCostCenterMappingDto,
  ): Promise<CostCenterMappingRow> {
    const costCenter = costCenterParam.trim().toLowerCase();

    const query = `
      UPDATE cost_center_analytic_mapping
      SET analytic_account_code = $1, description = COALESCE($2, description)
      WHERE cost_center = $3
      RETURNING cost_center, analytic_account_code, description
    `;
    const res = await this.db.query<CostCenterMappingRow>(query, [
      dto.analytic_account_code.trim(),
      dto.description !== undefined ? dto.description.trim() : null,
      costCenter,
    ]);

    if (res.rows.length === 0) {
      throw new NotFoundException(
        `Cost center mapping for '${costCenter}' not found`,
      );
    }

    this.logger.log(
      `Updated cost center mapping: ${costCenter} -> ${dto.analytic_account_code}`,
    );
    return res.rows[0];
  }

  // Delete an existing cost center mapping
  @Delete('cost-centers/:costCenter')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteCostCenterMapping(
    @Param('costCenter') costCenterParam: string,
  ): Promise<void> {
    const costCenter = costCenterParam.trim().toLowerCase();

    const res = await this.db.query(
      'DELETE FROM cost_center_analytic_mapping WHERE cost_center = $1 RETURNING cost_center',
      [costCenter],
    );

    if (res.rows.length === 0) {
      throw new NotFoundException(
        `Cost center mapping for '${costCenter}' not found`,
      );
    }

    this.logger.log(`Deleted cost center mapping: ${costCenter}`);
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
        je.cost_center,
        je.analytic_account_code,
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
        je.cost_center,
        je.analytic_account_code,
        oss.status,
        oss.last_error, 
        oss.attempts, 
        oss.last_attempt_at
      FROM odoo_sync_status oss
      JOIN journal_entries je ON oss.journal_entry_id = je.id
      JOIN webhook_events we ON je.webhook_event_id = we.id
      WHERE oss.status IN ('failed', 'exhausted')
      ORDER BY oss.last_attempt_at DESC
      LIMIT $1
    `;
    const res = await this.db.query<FailedSyncRow>(query, [limit]);
    return res.rows;
  }

  // Bulk re-queue all failed and exhausted sync jobs
  @Post('sync-failures/retry-all')
  async retryAllFailedSyncs() {
    const client = await this.db.getClient();

    try {
      await client.query('BEGIN');

      const failedQuery = `
        SELECT journal_entry_id
        FROM odoo_sync_status
        WHERE status IN ('failed', 'exhausted')
        FOR UPDATE
      `;
      const failedRes = await client.query<{ journal_entry_id: string }>(
        failedQuery,
      );

      if (failedRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return {
          message: 'No failed sync jobs found to retry',
          count: 0,
          journalIds: [],
        };
      }

      const journalIds = failedRes.rows.map((row) => row.journal_entry_id);

      await client.query(
        `UPDATE odoo_sync_status 
         SET status = 'pending' 
         WHERE journal_entry_id = ANY($1::uuid[])`,
        [journalIds],
      );

      for (const journalId of journalIds) {
        await this.odooSyncQueue.add(
          'sync-to-odoo',
          { journalEntryId: journalId },
          {
            jobId: `retry-${journalId}-${Date.now()}`,
            attempts: 3,
            backoff: { type: 'exponential', delay: 2000 },
          },
        );
      }

      await client.query('COMMIT');
      this.logger.log(
        `Bulk re-queued ${journalIds.length} failed/exhausted sync jobs`,
      );

      return {
        message: `Successfully re-queued ${journalIds.length} sync jobs`,
        count: journalIds.length,
        journalIds,
      };
    } catch (error: unknown) {
      await client.query('ROLLBACK');
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to bulk re-queue sync jobs: ${errorMessage}`);
      throw error;
    } finally {
      client.release();
    }
  }

  // Remap an account code and/or analytic account and trigger a sync retry
  @Post('sync-failures/:journalId/retry')
  async retryFailedSync(
    @Param('journalId') journalId: string,
    @Body('new_debit_account') newDebitAccount?: string,
    @Body('new_analytic_account') newAnalyticAccount?: string,
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

      if (newAnalyticAccount) {
        this.logger.log(
          `Ops overriding analytic account for ${journalId} to ${newAnalyticAccount}`,
        );
        await client.query(
          `UPDATE journal_entries SET analytic_account_code = $1 WHERE id = $2`,
          [newAnalyticAccount, journalId],
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
