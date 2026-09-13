/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import {
  AdminController,
  FailedSyncRow,
  AdminSyncStats,
  SyncedHistoryRow,
  CategoryMappingRow,
} from './admin.controller';
import { DatabaseService } from '../database/database.service';

describe('AdminController', () => {
  let controller: AdminController;
  let dbService: { query: jest.Mock; getClient: jest.Mock };
  let mockClient: { query: jest.Mock; release: jest.Mock };
  let odooSyncQueue: { add: jest.Mock };

  beforeEach(async () => {
    mockClient = {
      query: jest.fn().mockResolvedValue(undefined),
      release: jest.fn(),
    };

    dbService = {
      query: jest.fn(),
      getClient: jest.fn().mockResolvedValue(mockClient),
    };

    odooSyncQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [
        { provide: DatabaseService, useValue: dbService },
        { provide: getQueueToken('odoo-sync'), useValue: odooSyncQueue },
      ],
    }).compile();

    controller = module.get<AdminController>(AdminController);
  });

  describe('getStats', () => {
    it('should query and return aggregated sync counts', async () => {
      const mockStats: AdminSyncStats = {
        synced: 42,
        pending: 5,
        failed: 3,
        total: 50,
      };

      dbService.query.mockResolvedValueOnce({ rows: [mockStats] });

      const result = await controller.getStats();

      expect(dbService.query).toHaveBeenCalledWith(
        expect.stringContaining("WHERE status = 'synced'"),
      );
      expect(result).toEqual({
        synced: 42,
        pending: 5,
        failed: 3,
        total: 50,
      });
    });

    it('should return zero defaults when query returns empty rows', async () => {
      dbService.query.mockResolvedValueOnce({ rows: [] });

      const result = await controller.getStats();

      expect(result).toEqual({
        synced: 0,
        pending: 0,
        failed: 0,
        total: 0,
      });
    });
  });

  describe('getSyncHistory', () => {
    it('should query successful syncs with limit and return typed rows', async () => {
      const mockHistory: SyncedHistoryRow[] = [
        {
          journal_id: 'je_100',
          odoo_move_id: 1234,
          source_event_id: 'evt_webhook_1',
          transaction_type: 'purchase',
          amount: '89.99',
          currency: 'USD',
          merchant_name: 'Figma',
          debit_account: '600100',
          credit_account: '210000',
          synced_at: new Date('2026-09-12T20:00:00.000Z'),
        },
      ];

      dbService.query.mockResolvedValueOnce({ rows: mockHistory });

      const result = await controller.getSyncHistory(15);

      expect(dbService.query).toHaveBeenCalledWith(
        expect.stringContaining("WHERE oss.status = 'synced'"),
        [15],
      );
      expect(result).toEqual(mockHistory);
    });

    it('should use default limit of 50 for sync history when omitted', async () => {
      dbService.query.mockResolvedValueOnce({ rows: [] });

      await controller.getSyncHistory();

      expect(dbService.query).toHaveBeenCalledWith(expect.any(String), [50]);
    });
  });

  describe('getFailedSyncs', () => {
    it('should execute query with limit and return typed failed sync rows including exhausted', async () => {
      const mockRows: FailedSyncRow[] = [
        {
          journal_id: 'je_1',
          source_event_id: 'evt_1',
          transaction_type: 'purchase',
          amount: '120.00',
          currency: 'USD',
          merchant_name: 'Stripe',
          debit_account: '600100',
          credit_account: '210000',
          status: 'exhausted',
          last_error: 'Odoo XML-RPC connection timeout',
          attempts: 3,
          last_attempt_at: new Date('2026-09-12T18:00:00.000Z'),
        },
      ];

      dbService.query.mockResolvedValueOnce({ rows: mockRows });

      const result = await controller.getFailedSyncs(20);

      expect(dbService.query).toHaveBeenCalledWith(
        expect.stringContaining("WHERE oss.status IN ('failed', 'exhausted')"),
        [20],
      );
      expect(result).toEqual(mockRows);
    });

    it('should use default limit of 50 when limit parameter is not provided', async () => {
      dbService.query.mockResolvedValueOnce({ rows: [] });

      await controller.getFailedSyncs();

      expect(dbService.query).toHaveBeenCalledWith(expect.any(String), [50]);
    });
  });

  describe('retryFailedSync', () => {
    it('should remap debit account, reset status to pending, and re-queue with exponential backoff', async () => {
      const journalId = 'je_999';
      const newDebitAccount = '600300';

      const result = await controller.retryFailedSync(
        journalId,
        newDebitAccount,
      );

      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith(
        'UPDATE journal_entries SET debit_account = $1 WHERE id = $2',
        [newDebitAccount, journalId],
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        "UPDATE odoo_sync_status SET status = 'pending' WHERE journal_entry_id = $1",
        [journalId],
      );
      expect(odooSyncQueue.add).toHaveBeenCalledWith(
        'sync-to-odoo',
        { journalEntryId: journalId },
        expect.objectContaining({
          jobId: expect.stringMatching(new RegExp(`^retry-${journalId}-\\d+$`)),
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
        }),
      );
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClient.release).toHaveBeenCalled();
      expect(result).toEqual({
        message: 'Sync job re-queued successfully',
        journalId,
      });
    });

    it('should retry without updating debit account when newDebitAccount is omitted', async () => {
      const journalId = 'je_888';

      await controller.retryFailedSync(journalId);

      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).not.toHaveBeenCalledWith(
        expect.stringContaining('UPDATE journal_entries SET debit_account'),
        expect.anything(),
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        "UPDATE odoo_sync_status SET status = 'pending' WHERE journal_entry_id = $1",
        [journalId],
      );
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should rollback database transaction and release client on error', async () => {
      const journalId = 'je_777';
      const dbError = new Error('Database write failure');
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockRejectedValueOnce(dbError); // error on update

      await expect(
        controller.retryFailedSync(journalId, '600100'),
      ).rejects.toThrow(dbError);

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
      expect(odooSyncQueue.add).not.toHaveBeenCalled();
    });
  });

  describe('retryAllFailedSyncs', () => {
    it('should query all failed and exhausted syncs, reset status to pending, and re-queue all jobs', async () => {
      const mockFailedJobs = [
        { journal_entry_id: 'je_uuid_1' },
        { journal_entry_id: 'je_uuid_2' },
      ];

      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: mockFailedJobs }) // SELECT failed/exhausted FOR UPDATE
        .mockResolvedValueOnce(undefined) // UPDATE status = pending
        .mockResolvedValueOnce(undefined); // COMMIT

      const result = await controller.retryAllFailedSyncs();

      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("WHERE status IN ('failed', 'exhausted')"),
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining(
          "UPDATE odoo_sync_status \n         SET status = 'pending'",
        ),
        [['je_uuid_1', 'je_uuid_2']],
      );
      expect(odooSyncQueue.add).toHaveBeenCalledTimes(2);
      expect(odooSyncQueue.add).toHaveBeenCalledWith(
        'sync-to-odoo',
        { journalEntryId: 'je_uuid_1' },
        expect.objectContaining({
          jobId: expect.stringMatching(/^retry-je_uuid_1-\d+$/),
          attempts: 3,
        }),
      );
      expect(odooSyncQueue.add).toHaveBeenCalledWith(
        'sync-to-odoo',
        { journalEntryId: 'je_uuid_2' },
        expect.objectContaining({
          jobId: expect.stringMatching(/^retry-je_uuid_2-\d+$/),
          attempts: 3,
        }),
      );
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClient.release).toHaveBeenCalled();
      expect(result).toEqual({
        message: 'Successfully re-queued 2 sync jobs',
        count: 2,
        journalIds: ['je_uuid_1', 'je_uuid_2'],
      });
    });

    it('should return count 0 and rollback when no failed or exhausted jobs exist', async () => {
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // SELECT -> empty
        .mockResolvedValueOnce(undefined); // ROLLBACK

      const result = await controller.retryAllFailedSyncs();

      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(odooSyncQueue.add).not.toHaveBeenCalled();
      expect(mockClient.release).toHaveBeenCalled();
      expect(result).toEqual({
        message: 'No failed sync jobs found to retry',
        count: 0,
        journalIds: [],
      });
    });

    it('should rollback transaction on error and rethrow', async () => {
      const dbError = new Error('Database connection severed');
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockRejectedValueOnce(dbError); // SELECT throws

      await expect(controller.retryAllFailedSyncs()).rejects.toThrow(dbError);

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
      expect(odooSyncQueue.add).not.toHaveBeenCalled();
    });
  });

  describe('getCategoryMappings', () => {
    it('should return all category mappings ordered by category', async () => {
      const mockMappings: CategoryMappingRow[] = [
        {
          category: 'fees',
          expense_account: '600400',
          description: 'Bank Fees',
        },
        {
          category: 'software',
          expense_account: '600100',
          description: 'IT & Cloud',
        },
      ];

      dbService.query.mockResolvedValueOnce({ rows: mockMappings });

      const result = await controller.getCategoryMappings();

      expect(dbService.query).toHaveBeenCalledWith(
        expect.stringContaining(
          'SELECT category, expense_account, description FROM category_gl_mapping',
        ),
      );
      expect(result).toEqual(mockMappings);
    });
  });

  describe('createCategoryMapping', () => {
    it('should insert and return a new category mapping when category does not exist', async () => {
      const dto = {
        category: 'marketing',
        expense_account: '600500',
        description: 'Marketing & Ads',
      };

      dbService.query
        .mockResolvedValueOnce({ rows: [] }) // check existing -> none
        .mockResolvedValueOnce({
          rows: [
            {
              category: 'marketing',
              expense_account: '600500',
              description: 'Marketing & Ads',
            },
          ],
        });

      const result = await controller.createCategoryMapping(dto);

      expect(dbService.query).toHaveBeenCalledWith(
        expect.stringContaining(
          'SELECT category FROM category_gl_mapping WHERE category = $1',
        ),
        ['marketing'],
      );
      expect(dbService.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO category_gl_mapping'),
        ['marketing', '600500', 'Marketing & Ads'],
      );
      expect(result).toEqual({
        category: 'marketing',
        expense_account: '600500',
        description: 'Marketing & Ads',
      });
    });

    it('should throw ConflictException when category mapping already exists', async () => {
      const dto = {
        category: 'software',
        expense_account: '600100',
      };

      dbService.query.mockResolvedValueOnce({
        rows: [{ category: 'software' }],
      });

      await expect(controller.createCategoryMapping(dto)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('updateCategoryMapping', () => {
    it('should update and return category mapping when it exists', async () => {
      const dto = {
        expense_account: '600150',
        description: 'Updated Software',
      };

      dbService.query.mockResolvedValueOnce({
        rows: [
          {
            category: 'software',
            expense_account: '600150',
            description: 'Updated Software',
          },
        ],
      });

      const result = await controller.updateCategoryMapping('software', dto);

      expect(dbService.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE category_gl_mapping'),
        ['600150', 'Updated Software', 'software'],
      );
      expect(result).toEqual({
        category: 'software',
        expense_account: '600150',
        description: 'Updated Software',
      });
    });

    it('should throw NotFoundException when category mapping does not exist', async () => {
      dbService.query.mockResolvedValueOnce({ rows: [] });

      await expect(
        controller.updateCategoryMapping('non_existent', {
          expense_account: '600999',
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteCategoryMapping', () => {
    it('should delete category mapping and complete without error when category exists', async () => {
      dbService.query.mockResolvedValueOnce({
        rows: [{ category: 'software' }],
      });

      await expect(
        controller.deleteCategoryMapping('software'),
      ).resolves.toBeUndefined();

      expect(dbService.query).toHaveBeenCalledWith(
        expect.stringContaining(
          'DELETE FROM category_gl_mapping WHERE category = $1',
        ),
        ['software'],
      );
    });

    it('should throw NotFoundException when category to delete does not exist', async () => {
      dbService.query.mockResolvedValueOnce({ rows: [] });

      await expect(
        controller.deleteCategoryMapping('non_existent'),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
