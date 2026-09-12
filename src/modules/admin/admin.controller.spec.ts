/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { AdminController, FailedSyncRow } from './admin.controller';
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

  describe('getFailedSyncs', () => {
    it('should execute query with limit and return typed failed sync rows', async () => {
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
          last_error: 'Odoo XML-RPC connection timeout',
          attempts: 3,
          last_attempt_at: new Date('2026-09-12T18:00:00.000Z'),
        },
      ];

      dbService.query.mockResolvedValueOnce({ rows: mockRows });

      const result = await controller.getFailedSyncs(20);

      expect(dbService.query).toHaveBeenCalledWith(
        expect.stringContaining("WHERE oss.status = 'failed'"),
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
});
