import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface DlqAlertPayload {
  jobId: string;
  queueName: string;
  journalEntryId: string;
  error: string;
  attemptsMade: number;
  failedAt: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly config: ConfigService) {}

  async sendDlqAlert(payload: DlqAlertPayload): Promise<boolean> {
    this.logger.error(
      `🚨 [DLQ ALERT] Job ${payload.jobId} on queue '${payload.queueName}' exhausted all ${payload.attemptsMade} attempts! Error: ${payload.error}. Journal Entry: ${payload.journalEntryId}`,
    );

    const slackWebhookUrl = this.config.get<string>('SLACK_WEBHOOK_URL');
    if (!slackWebhookUrl) {
      this.logger.warn('SLACK_WEBHOOK_URL not configured. Alert logged only.');
      return false;
    }

    try {
      const response = await fetch(slackWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `🚨 *Dead Letter Queue Alert: ${payload.queueName}*\n*Job ID:* ${payload.jobId}\n*Journal Entry ID:* ${payload.journalEntryId}\n*Attempts:* ${payload.attemptsMade}\n*Error:* ${payload.error}\n*Failed At:* ${payload.failedAt}`,
        }),
      });

      if (!response.ok) {
        this.logger.error(
          `Failed to dispatch Slack DLQ alert: HTTP ${response.status}`,
        );
        return false;
      }

      this.logger.log(
        `Slack DLQ notification sent successfully for job ${payload.jobId}`,
      );
      return true;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Error sending Slack DLQ alert: ${errorMsg}`);
      return false;
    }
  }
}
