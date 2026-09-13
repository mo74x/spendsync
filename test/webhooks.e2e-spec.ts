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

describe('Webhook Ingestion (e2e)', () => {
  let app: INestApplication;
  let db: DatabaseService;
  let webhookSecret: string;
  const createdEventIds: string[] = [];

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DatabaseService);
    const config = app.get(ConfigService);
    webhookSecret = config.getOrThrow<string>('WEBHOOK_SECRET');
  });

  afterAll(async () => {
    if (createdEventIds.length > 0) {
      await cleanupTestWebhookEvents(db, createdEventIds);
    }
    await app.close();
  });

  const createPayload = (eventId: string, overrides = {}) => ({
    event_id: eventId,
    event_type: 'purchase',
    data: {
      transaction_id: `txn_${eventId}`,
      amount: 149.99,
      currency: 'USD',
      merchant: 'AWS Cloud Services',
      category: 'software',
      card_last4: '4242',
      ...overrides,
    },
  });

  describe('HMAC Verification and Security', () => {
    it('should successfully ingest a webhook with valid HMAC signature and recent timestamp', async () => {
      const eventId = `e2e_evt_valid_${Date.now()}`;
      createdEventIds.push(eventId);
      const payload = createPayload(eventId);
      const headers = getHmacHeaders(webhookSecret, payload);

      const res = await request(app.getHttpServer())
        .post('/api/v1/webhooks/transactions')
        .set(headers)
        .send(payload)
        .expect(202);

      expect(res.body).toEqual({
        status: 'enqueued',
        event_id: eventId,
      });

      // Verify recorded in database
      const dbRes = await db.query(
        'SELECT status, source_event_id FROM webhook_events WHERE source_event_id = $1',
        [eventId],
      );
      expect(dbRes.rows.length).toBe(1);
      expect(dbRes.rows[0].source_event_id).toBe(eventId);
    });

    it('should reject requests with a tampered body as 401 Unauthorized', async () => {
      const eventId = `e2e_evt_tampered_${Date.now()}`;
      const originalPayload = createPayload(eventId, { amount: 100.0 });
      // Generate signature for 100.00
      const headers = getHmacHeaders(webhookSecret, originalPayload);

      // Tamper the body with a different amount
      const tamperedPayload = createPayload(eventId, { amount: 9999.99 });

      const res = await request(app.getHttpServer())
        .post('/api/v1/webhooks/transactions')
        .set(headers)
        .send(tamperedPayload)
        .expect(401);

      expect(res.body.message).toBe('Invalid HMAC signature');
    });

    it('should reject requests with expired timestamp (> 300 seconds old) as 401 Unauthorized', async () => {
      const eventId = `e2e_evt_expired_past_${Date.now()}`;
      const payload = createPayload(eventId);
      // 305 seconds in the past
      const headers = getHmacHeaders(webhookSecret, payload, -305);

      const res = await request(app.getHttpServer())
        .post('/api/v1/webhooks/transactions')
        .set(headers)
        .send(payload)
        .expect(401);

      expect(res.body.message).toBe(
        'Webhook timestamp outside tolerance window',
      );
    });

    it('should reject requests with future timestamp (> 300 seconds forward) as 401 Unauthorized', async () => {
      const eventId = `e2e_evt_expired_future_${Date.now()}`;
      const payload = createPayload(eventId);
      // 305 seconds in the future
      const headers = getHmacHeaders(webhookSecret, payload, 305);

      const res = await request(app.getHttpServer())
        .post('/api/v1/webhooks/transactions')
        .set(headers)
        .send(payload)
        .expect(401);

      expect(res.body.message).toBe(
        'Webhook timestamp outside tolerance window',
      );
    });

    it('should reject requests missing the x-signature header as 401 Unauthorized', async () => {
      const eventId = `e2e_evt_no_sig_${Date.now()}`;
      const payload = createPayload(eventId);

      const res = await request(app.getHttpServer())
        .post('/api/v1/webhooks/transactions')
        .set('x-timestamp', Math.floor(Date.now() / 1000).toString())
        .send(payload)
        .expect(401);

      expect(res.body.message).toBe('Missing signature or timestamp headers');
    });

    it('should reject requests missing the x-timestamp header as 401 Unauthorized', async () => {
      const eventId = `e2e_evt_no_ts_${Date.now()}`;
      const payload = createPayload(eventId);

      const res = await request(app.getHttpServer())
        .post('/api/v1/webhooks/transactions')
        .set('x-signature', '0123456789abcdef0123456789abcdef')
        .send(payload)
        .expect(401);

      expect(res.body.message).toBe('Missing signature or timestamp headers');
    });
  });

  describe('Validation & Idempotency', () => {
    it('should reject invalid payload schemas with 400 Bad Request', async () => {
      const eventId = `e2e_evt_invalid_dto_${Date.now()}`;
      const invalidPayload = {
        event_id: eventId,
        event_type: 'purchase',
        data: {
          transaction_id: 'txn_123',
          amount: -50.0, // negative amount is invalid
          currency: 'TOOLONG', // currency must be 3 characters
          merchant: 'Test Merchant',
          category: 'software',
          card_last4: '42', // must be 4 characters
        },
      };

      const headers = getHmacHeaders(webhookSecret, invalidPayload);

      await request(app.getHttpServer())
        .post('/api/v1/webhooks/transactions')
        .set(headers)
        .send(invalidPayload)
        .expect(400);
    });

    it('should handle duplicate webhook events idempotently', async () => {
      const eventId = `e2e_evt_dedup_${Date.now()}`;
      createdEventIds.push(eventId);
      const payload = createPayload(eventId);
      const headers = getHmacHeaders(webhookSecret, payload);

      // First delivery: enqueued
      const firstRes = await request(app.getHttpServer())
        .post('/api/v1/webhooks/transactions')
        .set(headers)
        .send(payload)
        .expect(202);

      expect(firstRes.body).toEqual({
        status: 'enqueued',
        event_id: eventId,
      });

      // Second delivery with identical event_id: acknowledged as duplicate
      const secondHeaders = getHmacHeaders(webhookSecret, payload);
      const secondRes = await request(app.getHttpServer())
        .post('/api/v1/webhooks/transactions')
        .set(secondHeaders)
        .send(payload)
        .expect(202);

      expect(secondRes.body).toEqual({
        status: 'acknowledged',
        duplicate: true,
      });

      // Confirm only 1 database record exists
      const dbRes = await db.query(
        'SELECT id FROM webhook_events WHERE source_event_id = $1',
        [eventId],
      );
      expect(dbRes.rows.length).toBe(1);
    });
  });
});
