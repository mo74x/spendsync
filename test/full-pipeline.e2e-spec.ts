/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { DatabaseService } from '../src/modules/database/database.service';
import {
  createTestApp,
  getHmacHeaders,
  cleanupTestWebhookEvents,
} from './helpers/test-helpers';

describe('Full Pipeline Integration Flow (e2e)', () => {
  let app: INestApplication;
  let db: DatabaseService;
  let webhookSecret: string;
  let adminApiKey: string;
  const createdEventIds: string[] = [];

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DatabaseService);
    const config = app.get(ConfigService);
    webhookSecret = config.getOrThrow<string>('WEBHOOK_SECRET');
    adminApiKey = config.getOrThrow<string>('ADMIN_API_KEY');
  });

  afterAll(async () => {
    if (createdEventIds.length > 0) {
      await cleanupTestWebhookEvents(db, createdEventIds);
    }
    await app.close();
  });

  it('should process webhook event through BullMQ and book balanced double-entry ledger records', async () => {
    const eventId = `e2e_evt_pipeline_${Date.now()}`;
    createdEventIds.push(eventId);

    const webhookPayload = {
      event_id: eventId,
      event_type: 'purchase',
      data: {
        transaction_id: `txn_pipe_${Date.now()}`,
        amount: 350.5,
        currency: 'USD',
        merchant: 'GitHub Enterprise',
        category: 'software',
        card_last4: '9988',
      },
    };

    const headers = getHmacHeaders(webhookSecret, webhookPayload);

    // 1. Ingest webhook via HTTP endpoint
    const response = await request(app.getHttpServer())
      .post('/api/v1/webhooks/transactions')
      .set(headers)
      .send(webhookPayload)
      .expect(202);

    expect(response.body).toEqual({
      status: 'enqueued',
      event_id: eventId,
    });

    // 2. Poll PostgreSQL for asynchronous BullMQ ledger processing completion (max 10s)
    let processedEvent: { status: string; id: string } | null = null;
    const startTime = Date.now();

    while (Date.now() - startTime < 10000) {
      const res = await db.query<{ id: string; status: string }>(
        'SELECT id, status FROM webhook_events WHERE source_event_id = $1',
        [eventId],
      );

      if (res.rows.length > 0 && res.rows[0].status === 'processed') {
        processedEvent = res.rows[0];
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    expect(processedEvent).not.toBeNull();
    expect(processedEvent?.status).toBe('processed');

    // 3. Verify double-entry journal entry was created and balanced
    const journalRes = await db.query<{
      id: string;
      transaction_type: string;
      amount: string;
      currency: string;
      debit_account: string;
      credit_account: string;
      card_last4: string;
      merchant_name: string;
    }>('SELECT * FROM journal_entries WHERE webhook_event_id = $1', [
      processedEvent?.id,
    ]);

    expect(journalRes.rows.length).toBe(1);
    const entry = journalRes.rows[0];
    expect(entry.transaction_type).toBe('purchase');
    expect(parseFloat(entry.amount)).toBe(350.5);
    expect(entry.currency).toBe('USD');
    expect(entry.debit_account).toBe('600100'); // Mapped from 'software'
    expect(entry.credit_account).toBe('210000'); // Card clearing liability
    expect(entry.card_last4).toBe('9988');
    expect(entry.merchant_name).toBe('GitHub Enterprise');

    // 4. Verify Odoo sync status record was initialized
    const syncStatusRes = await db.query<{
      journal_entry_id: string;
      status: string;
    }>(
      'SELECT journal_entry_id, status FROM odoo_sync_status WHERE journal_entry_id = $1',
      [entry.id],
    );

    expect(syncStatusRes.rows.length).toBe(1);
    expect(['pending', 'synced', 'failed']).toContain(
      syncStatusRes.rows[0].status,
    );

    // 5. Verify Admin stats API reflects the recorded transactions
    const statsRes = await request(app.getHttpServer())
      .get('/api/v1/admin/stats')
      .set('x-api-key', adminApiKey)
      .expect(200);

    expect(statsRes.body.total).toBeGreaterThan(0);
  });
});
