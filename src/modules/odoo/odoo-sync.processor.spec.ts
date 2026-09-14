/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { OdooSyncProcessor } from './odoo-sync.processor';
import { DatabaseService } from '../database/database.service';
import { OdooClient } from './odoo.client';
import { NotificationsService } from '../notifications/notifications.service';

describe('OdooSyncProcessor', () => {
  let processor: OdooSyncProcessor;
  let dbService: { getClient: jest.Mock; query: jest.Mock };
  let mockClient: { query: jest.Mock; release: jest.Mock };
  let odooClient: {
    [x: string]: any;
    getAccountIdByCode: jest.Mock;
    executeKw: jest.Mock;
  };
  let dlqQueue: { add: jest.Mock };
  let notificationsService: { sendDlqAlert: jest.Mock };

  beforeEach(async () => {
    mockClient = {
      query: jest.fn().mockResolvedValue(undefined),
      release: jest.fn(),
    };

    dbService = {
      getClient: jest.fn().mockResolvedValue(mockClient),
      query: jest.fn().mockResolvedValue(undefined),
    };

    odooClient = {
      getAccountIdByCode: jest.fn(),
      getAnalyticAccountIdByCode: jest.fn(),
      executeKw: jest.fn(),
    };

    dlqQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    };

    notificationsService = {
      sendDlqAlert: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OdooSyncProcessor,
        { provide: DatabaseService, useValue: dbService },
        { provide: OdooClient, useValue: odooClient },
        { provide: getQueueToken('odoo-sync-dlq'), useValue: dlqQueue },
        { provide: NotificationsService, useValue: notificationsService },
      ],
    }).compile();

    processor = module.get<OdooSyncProcessor>(OdooSyncProcessor);
  });

  function createMockJob(
    attemptsMade = 1,
    attempts = 5,
  ): Job<{ journalEntryId: string }> {
    return {
      id: 'job_odoo_101',
      attemptsMade,
      opts: { attempts },
      data: { journalEntryId: 'je_entry_101' },
    } as unknown as Job<{ journalEntryId: string }>;
  }

  describe('process', () => {
    it('should successfully sync journal entry to Odoo and update status to synced', async () => {
      const mockEntry = {
        id: 'je_entry_101',
        webhook_event_id: 'we_1',
        transaction_type: 'purchase',
        amount: '250.00',
        currency: 'USD',
        debit_account: '600100',
        credit_account: '210000',
        card_last4: '4242',
        merchant_name: 'Stripe Merchant',
        cost_center: null,
        analytic_account_code: null,
        source_event_id: 'evt_stripe_123',
      };

      mockClient.query.mockResolvedValueOnce({ rows: [mockEntry] });
      odooClient.getAccountIdByCode
        .mockResolvedValueOnce(10) // debit account id
        .mockResolvedValueOnce(20); // credit account id
      odooClient.executeKw
        .mockResolvedValueOnce(9999) // account.move create -> move_id
        .mockResolvedValueOnce(true); // account.move action_post

      const job = createMockJob(1, 5);
      await processor.process(job);

      expect(odooClient.getAccountIdByCode).toHaveBeenCalledWith('600100');
      expect(odooClient.getAccountIdByCode).toHaveBeenCalledWith('210000');
      expect(odooClient.executeKw).toHaveBeenCalledWith(
        'account.move',
        'create',
        expect.any(Array),
      );
      expect(odooClient.executeKw).toHaveBeenCalledWith(
        'account.move',
        'action_post',
        [[9999]],
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'synced'"),
        [9999, 'je_entry_101'],
      );
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should attach analytic_distribution when analytic_account_code is present', async () => {
      const mockEntry = {
        id: 'je_entry_102',
        webhook_event_id: 'we_2',
        transaction_type: 'purchase',
        amount: '150.00',
        currency: 'USD',
        debit_account: '600100',
        credit_account: '210000',
        card_last4: '4242',
        merchant_name: 'AWS Cloud',
        cost_center: 'engineering',
        analytic_account_code: '1010',
        source_event_id: 'evt_stripe_456',
      };

      mockClient.query.mockResolvedValueOnce({ rows: [mockEntry] });
      odooClient.getAccountIdByCode
        .mockResolvedValueOnce(10)
        .mockResolvedValueOnce(20);
      odooClient.getAnalyticAccountIdByCode.mockResolvedValueOnce(55);
      odooClient.executeKw
        .mockResolvedValueOnce(8888)
        .mockResolvedValueOnce(true);

      const job = createMockJob(1, 5);
      await processor.process(job);

      expect(odooClient.getAnalyticAccountIdByCode).toHaveBeenCalledWith(
        '1010',
      );
      expect(odooClient.executeKw).toHaveBeenCalledWith(
        'account.move',
        'create',
        [
          expect.objectContaining({
            line_ids: [
              [
                0,
                0,
                expect.objectContaining({
                  account_id: 10,
                  analytic_distribution: { '55': 100 },
                }),
              ],
              [0, 0, expect.objectContaining({ account_id: 20 })],
            ],
          }),
        ],
      );
    });

    it('should update status to failed and throw error when Odoo sync fails', async () => {
      const mockEntry = {
        id: 'je_entry_101',
        webhook_event_id: 'we_1',
        transaction_type: 'purchase',
        amount: '250.00',
        currency: 'USD',
        debit_account: '600100',
        credit_account: '210000',
        card_last4: '4242',
        merchant_name: 'Stripe Merchant',
        source_event_id: 'evt_stripe_123',
      };

      mockClient.query.mockResolvedValueOnce({ rows: [mockEntry] });
      odooClient.getAccountIdByCode.mockRejectedValueOnce(
        new Error('Account code 600100 not found in Odoo Chart of Accounts'),
      );

      const job = createMockJob(1, 5);

      await expect(processor.process(job)).rejects.toThrow(
        'Account code 600100 not found in Odoo Chart of Accounts',
      );

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'failed'"),
        [
          'Account code 600100 not found in Odoo Chart of Accounts',
          'je_entry_101',
        ],
      );
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('onFailed', () => {
    it('should NOT route to DLQ if retry attempts are not yet exhausted', async () => {
      const job = createMockJob(2, 5); // 2 of 5 attempts
      const error = new Error('Temporary Odoo network blip');

      await processor.onFailed(job, error);

      expect(dlqQueue.add).not.toHaveBeenCalled();
      expect(notificationsService.sendDlqAlert).not.toHaveBeenCalled();
      expect(dbService.query).not.toHaveBeenCalled();
    });

    it('should route to DLQ, dispatch alert, and update status to exhausted when attempts are exhausted', async () => {
      const job = createMockJob(5, 5); // 5 of 5 attempts
      const error = new Error('Permanent XML-RPC authentication failure');

      await processor.onFailed(job, error);

      expect(dlqQueue.add).toHaveBeenCalledWith(
        'exhausted-odoo-sync',
        {
          journalEntryId: 'je_entry_101',
          error: 'Permanent XML-RPC authentication failure',
          attemptsMade: 5,
          failedAt: expect.any(String),
        },
        expect.objectContaining({
          jobId: expect.stringMatching(/^dlq-job_odoo_101-\d+$/),
          removeOnComplete: false,
        }),
      );

      expect(notificationsService.sendDlqAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: 'job_odoo_101',
          queueName: 'odoo-sync',
          journalEntryId: 'je_entry_101',
          error: 'Permanent XML-RPC authentication failure',
          attemptsMade: 5,
        }),
      );

      expect(dbService.query).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'exhausted'"),
        [
          '[DLQ] Exhausted 5 attempts: Permanent XML-RPC authentication failure',
          'je_entry_101',
        ],
      );
    });
  });
});
