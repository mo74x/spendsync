import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DatabaseService } from '../database/database.service';
import { CardTransactionWebhookDto } from './dto/card-transaction-webhook.dto';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly db: DatabaseService,
    @InjectQueue('transaction-ledger') private readonly ledgerQueue: Queue,
  ) {}

  async ingestEvent(dto: CardTransactionWebhookDto, correlationId?: string) {
    // Enforce atomic idempotency check at the DB boundary
    const query = `
      INSERT INTO webhook_events (source_event_id, event_type, payload, status)
      VALUES ($1, $2, $3, 'pending')
      ON CONFLICT (source_event_id) DO NOTHING
      RETURNING id;
    `;

    const res = await this.db.query<{ id: string }>(query, [
      dto.event_id,
      dto.event_type,
      JSON.stringify(dto),
    ]);

    if (res.rowCount === 0) {
      this.logger.warn(
        `Duplicate webhook received and ignored: ${dto.event_id}`,
      );
      return { status: 'acknowledged', duplicate: true };
    }

    const internalEventId = res.rows[0].id;

    // Dispatch to the background queue for asynchronous processing
    await this.ledgerQueue.add(
      'process-ledger',
      { webhookEventId: internalEventId, payload: dto, correlationId },
      {
        jobId: dto.event_id, // BullMQ level deduplication
        removeOnComplete: true,
      },
    );

    this.logger.log(`Webhook ingested and queued: ${dto.event_id}`);
    return { status: 'enqueued', event_id: dto.event_id };
  }
}
