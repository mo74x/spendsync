import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { WebhooksService } from './webhooks.service';
import { DatabaseService } from '../database/database.service';
import {
  CardTransactionWebhookDto,
  TransactionType,
} from './dto/card-transaction-webhook.dto';

describe('WebhooksService', () => {
  let service: WebhooksService;
  let dbService: { query: jest.Mock };
  let ledgerQueue: { add: jest.Mock };

  const mockPayload: CardTransactionWebhookDto = {
    event_id: 'evt_webhook_999',
    event_type: TransactionType.PURCHASE,
    data: {
      transaction_id: 'txn_001',
      amount: 150.0,
      currency: 'USD',
      merchant: 'AWS Cloud',
      category: 'cloud_services',
      card_last4: '1234',
    },
  };

  beforeEach(async () => {
    dbService = {
      query: jest.fn(),
    };

    ledgerQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhooksService,
        { provide: DatabaseService, useValue: dbService },
        { provide: getQueueToken('transaction-ledger'), useValue: ledgerQueue },
      ],
    }).compile();

    service = module.get<WebhooksService>(WebhooksService);
  });

  it('should ignore duplicate event when rowCount === 0', async () => {
    dbService.query.mockResolvedValueOnce({
      rowCount: 0,
      rows: [],
    });

    const result = await service.ingestEvent(mockPayload);

    expect(result).toEqual({ status: 'acknowledged', duplicate: true });
    expect(dbService.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO webhook_events'),
      [
        mockPayload.event_id,
        mockPayload.event_type,
        JSON.stringify(mockPayload),
      ],
    );
    expect(ledgerQueue.add).not.toHaveBeenCalled();
  });

  it('should ingest new event into DB and dispatch to BullMQ queue with deduplication jobId', async () => {
    dbService.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 'db_event_internal_id_1' }],
    });

    const result = await service.ingestEvent(mockPayload);

    expect(result).toEqual({
      status: 'enqueued',
      event_id: mockPayload.event_id,
    });
    expect(dbService.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO webhook_events'),
      [
        mockPayload.event_id,
        mockPayload.event_type,
        JSON.stringify(mockPayload),
      ],
    );
    expect(ledgerQueue.add).toHaveBeenCalledWith(
      'process-ledger',
      {
        webhookEventId: 'db_event_internal_id_1',
        payload: mockPayload,
      },
      {
        jobId: mockPayload.event_id,
        removeOnComplete: true,
      },
    );
  });
});
