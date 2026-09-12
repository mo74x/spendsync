/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationsService, DlqAlertPayload } from './notifications.service';

describe('NotificationsService', () => {
  let service: NotificationsService;
  let configService: { get: jest.Mock };
  let loggerErrorSpy: jest.SpyInstance;
  let loggerWarnSpy: jest.SpyInstance;
  let loggerLogSpy: jest.SpyInstance;

  const samplePayload: DlqAlertPayload = {
    jobId: 'odoo-retry-123',
    queueName: 'odoo-sync',
    journalEntryId: 'je_555',
    error: 'Odoo XML-RPC connection refused',
    attemptsMade: 5,
    failedAt: '2026-09-12T20:00:00.000Z',
  };

  beforeEach(() => {
    configService = {
      get: jest.fn(),
    };

    service = new NotificationsService(
      configService as unknown as ConfigService,
    );

    loggerErrorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    loggerWarnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    loggerLogSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should log alert and return false when SLACK_WEBHOOK_URL is not configured', async () => {
    configService.get.mockReturnValue(undefined);

    const result = await service.sendDlqAlert(samplePayload);

    expect(result).toBe(false);
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "🚨 [DLQ ALERT] Job odoo-retry-123 on queue 'odoo-sync' exhausted all 5 attempts!",
      ),
    );
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('SLACK_WEBHOOK_URL not configured'),
    );
  });

  it('should post payload to Slack webhook when configured', async () => {
    configService.get.mockReturnValue(
      'https://hooks.slack.com/services/test/webhook',
    );

    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    global.fetch = mockFetch;

    const result = await service.sendDlqAlert(samplePayload);

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://hooks.slack.com/services/test/webhook',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: expect.stringContaining('Dead Letter Queue Alert: odoo-sync'),
      }),
    );
    expect(loggerLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Slack DLQ notification sent successfully'),
    );
  });

  it('should handle fetch errors gracefully and return false', async () => {
    configService.get.mockReturnValue(
      'https://hooks.slack.com/services/test/webhook',
    );

    const mockFetch = jest.fn().mockRejectedValue(new Error('Network timeout'));
    global.fetch = mockFetch;

    const result = await service.sendDlqAlert(samplePayload);

    expect(result).toBe(false);
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Error sending Slack DLQ alert: Network timeout'),
    );
  });
});
