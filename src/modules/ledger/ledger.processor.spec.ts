import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { LedgerProcessor } from './ledger.processor';
import { DatabaseService } from '../database/database.service';
import {
  CardTransactionWebhookDto,
  TransactionType,
} from '../webhooks/dto/card-transaction-webhook.dto';

describe('LedgerProcessor', () => {
  let processor: LedgerProcessor;
  let dbService: { getClient: jest.Mock; query: jest.Mock };
  let mockClient: { query: jest.Mock; release: jest.Mock };
  let odooSyncQueue: { add: jest.Mock };
  let configService: { get: jest.Mock };

  const clearingAccount = '210000';

  beforeEach(async () => {
    mockClient = {
      query: jest.fn(),
      release: jest.fn(),
    };

    dbService = {
      getClient: jest.fn().mockResolvedValue(mockClient),
      query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [] }),
    };

    odooSyncQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    };

    configService = {
      get: jest.fn((key: string) => {
        if (key === 'CARD_CLEARING_ACCOUNT') {
          return clearingAccount;
        }
        return undefined;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LedgerProcessor,
        { provide: DatabaseService, useValue: dbService },
        { provide: ConfigService, useValue: configService },
        { provide: getQueueToken('odoo-sync'), useValue: odooSyncQueue },
      ],
    }).compile();

    processor = module.get<LedgerProcessor>(LedgerProcessor);
  });

  function createMockJob(
    eventType: TransactionType,
    category = 'software',
    costCenter?: string,
  ): Job<{ webhookEventId: string; payload: CardTransactionWebhookDto }> {
    return {
      data: {
        webhookEventId: 'evt_row_123',
        payload: {
          event_id: 'evt_source_456',
          event_type: eventType,
          data: {
            transaction_id: 'tx_789',
            amount: 49.99,
            currency: 'USD',
            merchant: 'GitHub',
            category,
            card_last4: '4242',
            cost_center: costCenter,
          },
        },
      },
    } as unknown as Job<{
      webhookEventId: string;
      payload: CardTransactionWebhookDto;
    }>;
  }

  it('should create double-entry balance for purchase (Debit: Expense, Credit: Clearing)', async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'pending' }] }) // SELECT status ... FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ expense_account: '600100' }] }) // category_gl_mapping
      .mockResolvedValueOnce({ rows: [{ id: 'journal_entry_001' }] }) // INSERT journal_entries
      .mockResolvedValueOnce(undefined) // INSERT odoo_sync_status
      .mockResolvedValueOnce(undefined) // UPDATE webhook_events status = 'processed'
      .mockResolvedValueOnce(undefined); // COMMIT

    const job = createMockJob(TransactionType.PURCHASE, 'software');
    await processor.process(job);

    expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
    expect(mockClient.query).toHaveBeenCalledWith(
      'SELECT status FROM webhook_events WHERE id = $1 FOR UPDATE',
      ['evt_row_123'],
    );
    expect(mockClient.query).toHaveBeenCalledWith(
      'SELECT expense_account FROM category_gl_mapping WHERE category = $1',
      ['software'],
    );

    // Verify journal entry insert: [webhookEventId, event_type, amount, currency, debitAccount, creditAccount, card_last4, merchant, costCenter, analyticAccountCode]
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO journal_entries'),
      [
        'evt_row_123',
        TransactionType.PURCHASE,
        49.99,
        'USD',
        '600100', // Debit: Expense
        clearingAccount, // Credit: Clearing
        '4242',
        'GitHub',
        null,
        null,
      ],
    );

    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    expect(odooSyncQueue.add).toHaveBeenCalledWith(
      'sync-to-odoo',
      expect.objectContaining({ journalEntryId: 'journal_entry_001' }),
      expect.objectContaining({ jobId: 'journal_entry_001' }),
    );
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('should resolve cost center and attach analytic account code if provided', async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'pending' }] }) // SELECT status ... FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ expense_account: '600100' }] }) // category_gl_mapping
      .mockResolvedValueOnce({ rows: [{ analytic_account_code: '1010' }] }) // cost_center_analytic_mapping
      .mockResolvedValueOnce({ rows: [{ id: 'journal_entry_cc_01' }] }) // INSERT journal_entries
      .mockResolvedValueOnce(undefined) // INSERT odoo_sync_status
      .mockResolvedValueOnce(undefined) // UPDATE webhook_events status = 'processed'
      .mockResolvedValueOnce(undefined); // COMMIT

    const job = createMockJob(
      TransactionType.PURCHASE,
      'software',
      'engineering',
    );
    await processor.process(job);

    expect(mockClient.query).toHaveBeenCalledWith(
      'SELECT analytic_account_code FROM cost_center_analytic_mapping WHERE cost_center = $1',
      ['engineering'],
    );

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO journal_entries'),
      [
        'evt_row_123',
        TransactionType.PURCHASE,
        49.99,
        'USD',
        '600100',
        clearingAccount,
        '4242',
        'GitHub',
        'engineering',
        '1010',
      ],
    );
  });

  it('should create double-entry balance for refund (Debit: Clearing, Credit: Expense)', async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'pending' }] }) // SELECT status
      .mockResolvedValueOnce({ rows: [{ expense_account: '600100' }] }) // category mapping
      .mockResolvedValueOnce({ rows: [{ id: 'journal_entry_002' }] }) // INSERT journal_entries
      .mockResolvedValueOnce(undefined) // INSERT odoo_sync_status
      .mockResolvedValueOnce(undefined) // UPDATE webhook_events
      .mockResolvedValueOnce(undefined); // COMMIT

    const job = createMockJob(TransactionType.REFUND, 'software');
    await processor.process(job);

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO journal_entries'),
      [
        'evt_row_123',
        TransactionType.REFUND,
        49.99,
        'USD',
        clearingAccount, // Debit: Clearing
        '600100', // Credit: Expense
        '4242',
        'GitHub',
        null,
        null,
      ],
    );
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('should create double-entry balance for fee (Debit: 600400, Credit: Clearing)', async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'pending' }] }) // SELECT status
      .mockResolvedValueOnce({ rows: [{ expense_account: '600100' }] }) // category mapping
      .mockResolvedValueOnce({ rows: [{ id: 'journal_entry_003' }] }) // INSERT journal_entries
      .mockResolvedValueOnce(undefined) // INSERT odoo_sync_status
      .mockResolvedValueOnce(undefined) // UPDATE webhook_events
      .mockResolvedValueOnce(undefined); // COMMIT

    const job = createMockJob(TransactionType.FEE, 'software');
    await processor.process(job);

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO journal_entries'),
      [
        'evt_row_123',
        TransactionType.FEE,
        49.99,
        'USD',
        '600400', // Debit: Bank Fees
        clearingAccount, // Credit: Clearing
        '4242',
        'GitHub',
        null,
        null,
      ],
    );
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('should fall back to unmapped category default (600999)', async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'pending' }] }) // SELECT status
      .mockResolvedValueOnce({ rows: [] }) // No category mapping found
      .mockResolvedValueOnce({ rows: [{ id: 'journal_entry_004' }] }) // INSERT journal_entries
      .mockResolvedValueOnce(undefined) // INSERT odoo_sync_status
      .mockResolvedValueOnce(undefined) // UPDATE webhook_events
      .mockResolvedValueOnce(undefined); // COMMIT

    const job = createMockJob(TransactionType.PURCHASE, 'unknown_category');
    await processor.process(job);

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO journal_entries'),
      expect.arrayContaining(['600999', clearingAccount]),
    );
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('should enforce pessimistic concurrency lock & idempotency check (status === processed)', async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'processed' }] }) // SELECT status FOR UPDATE
      .mockResolvedValueOnce(undefined); // ROLLBACK

    const job = createMockJob(TransactionType.PURCHASE);
    await processor.process(job);

    expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
    expect(mockClient.query).toHaveBeenCalledWith(
      'SELECT status FROM webhook_events WHERE id = $1 FOR UPDATE',
      ['evt_row_123'],
    );
    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(odooSyncQueue.add).not.toHaveBeenCalled();
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('should rollback database transaction on error and update status to failed', async () => {
    const error = new Error('Database disk full');
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockRejectedValueOnce(error); // Query fails

    const job = createMockJob(TransactionType.PURCHASE);

    await expect(processor.process(job)).rejects.toThrow(error);

    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(dbService.query).toHaveBeenCalledWith(
      `UPDATE webhook_events SET status = 'failed', error_message = $2 WHERE id = $1`,
      ['evt_row_123', 'Database disk full'],
    );
    expect(mockClient.release).toHaveBeenCalled();
  });
});
