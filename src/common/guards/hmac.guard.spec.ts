import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { HmacGuard } from './hmac.guard';

describe('HmacGuard', () => {
  let guard: HmacGuard;
  let configService: { getOrThrow: jest.Mock };

  const secret = 'whsec_test_secret_123456';

  beforeEach(() => {
    configService = {
      getOrThrow: jest.fn((key: string) => {
        if (key === 'WEBHOOK_SECRET') {
          return secret;
        }
        throw new Error(`Config ${key} not found`);
      }),
    };

    guard = new HmacGuard(configService as unknown as ConfigService);
  });

  function createMockExecutionContext(options: {
    signature?: string;
    timestamp?: string;
    rawBody?: Buffer;
  }): ExecutionContext {
    const headers: Record<string, string | undefined> = {};
    if (options.signature !== undefined) {
      headers['x-signature'] = options.signature;
    }
    if (options.timestamp !== undefined) {
      headers['x-timestamp'] = options.timestamp;
    }

    return {
      switchToHttp: () => ({
        getRequest: () => ({
          headers,
          rawBody: options.rawBody,
        }),
      }),
    } as unknown as ExecutionContext;
  }

  it('should throw UnauthorizedException when signature or timestamp headers are missing', () => {
    const contextNoHeaders = createMockExecutionContext({});
    expect(() => guard.canActivate(contextNoHeaders)).toThrow(
      new UnauthorizedException('Missing signature or timestamp headers'),
    );

    const contextOnlySig = createMockExecutionContext({
      signature: 'some_sig',
    });
    expect(() => guard.canActivate(contextOnlySig)).toThrow(
      new UnauthorizedException('Missing signature or timestamp headers'),
    );

    const contextOnlyTs = createMockExecutionContext({
      timestamp: '1700000000',
    });
    expect(() => guard.canActivate(contextOnlyTs)).toThrow(
      new UnauthorizedException('Missing signature or timestamp headers'),
    );
  });

  it('should prevent replay attacks when timestamp delta exceeds 300 seconds', () => {
    const now = Math.floor(Date.now() / 1000);
    const expiredTimestamp = String(now - 301);

    const context = createMockExecutionContext({
      signature: 'valid_looking_signature',
      timestamp: expiredTimestamp,
      rawBody: Buffer.from(JSON.stringify({ test: 'data' })),
    });

    expect(() => guard.canActivate(context)).toThrow(
      new UnauthorizedException('Webhook timestamp outside tolerance window'),
    );
  });

  it('should reject invalid HMAC signature', () => {
    const now = Math.floor(Date.now() / 1000);
    const timestamp = String(now);
    const rawBody = Buffer.from(JSON.stringify({ test: 'data' }));

    const invalidSignature = crypto
      .createHmac('sha256', 'wrong_secret')
      .update(`${timestamp}.${rawBody.toString('utf8')}`)
      .digest('hex');

    const context = createMockExecutionContext({
      signature: invalidSignature,
      timestamp,
      rawBody,
    });

    expect(() => guard.canActivate(context)).toThrow(
      new UnauthorizedException('Invalid HMAC signature'),
    );
  });

  it('should accept request when HMAC SHA256 signature is valid and within tolerance window', () => {
    const now = Math.floor(Date.now() / 1000);
    const timestamp = String(now);
    const rawBody = Buffer.from(JSON.stringify({ event: 'card_purchase' }));

    const validSignature = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.${rawBody.toString('utf8')}`)
      .digest('hex');

    const context = createMockExecutionContext({
      signature: validSignature,
      timestamp,
      rawBody,
    });

    expect(guard.canActivate(context)).toBe(true);
  });
});
