import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as crypto from 'crypto';
import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/all-exceptions.filter';
import { DatabaseService } from '../../src/modules/database/database.service';

export async function createTestApp(): Promise<INestApplication> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication({
    rawBody: true,
  });

  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  await app.init();
  return app;
}

export function generateHmacSignature(
  secret: string,
  rawBody: string,
  timestamp: number,
): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
}

export function getHmacHeaders(
  secret: string,
  body: unknown,
  timestampOffsetSec = 0,
): {
  'x-signature': string;
  'x-timestamp': string;
  'Content-Type': string;
} {
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000) + timestampOffsetSec;
  const signature = generateHmacSignature(secret, rawBody, timestamp);

  return {
    'x-signature': signature,
    'x-timestamp': timestamp.toString(),
    'Content-Type': 'application/json',
  };
}

export async function cleanupTestWebhookEvents(
  db: DatabaseService,
  sourceEventIds: string[],
): Promise<void> {
  if (!sourceEventIds.length) return;

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // 1. Delete odoo_sync_status through journal_entries
    await client.query(
      `DELETE FROM odoo_sync_status 
       WHERE journal_entry_id IN (
         SELECT je.id FROM journal_entries je
         JOIN webhook_events we ON je.webhook_event_id = we.id
         WHERE we.source_event_id = ANY($1::text[])
       )`,
      [sourceEventIds],
    );

    // 2. Delete journal_entries
    await client.query(
      `DELETE FROM journal_entries 
       WHERE webhook_event_id IN (
         SELECT id FROM webhook_events 
         WHERE source_event_id = ANY($1::text[])
       )`,
      [sourceEventIds],
    );

    // 3. Delete webhook_events
    await client.query(
      `DELETE FROM webhook_events WHERE source_event_id = ANY($1::text[])`,
      [sourceEventIds],
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function cleanupTestCategoryMappings(
  db: DatabaseService,
  categories: string[],
): Promise<void> {
  if (!categories.length) return;
  await db.query(
    `DELETE FROM category_gl_mapping WHERE category = ANY($1::text[])`,
    [categories],
  );
}
