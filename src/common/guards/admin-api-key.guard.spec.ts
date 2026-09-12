import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminApiKeyGuard } from './admin-api-key.guard';

describe('AdminApiKeyGuard', () => {
  let guard: AdminApiKeyGuard;
  let configService: jest.Mocked<ConfigService>;

  const mockConfigKey = 'admin_ops_secret_key_482910';

  beforeEach(() => {
    configService = {
      get: jest.fn((key: string) => {
        if (key === 'ADMIN_API_KEY') {
          return mockConfigKey;
        }
        return undefined;
      }),
    } as unknown as jest.Mocked<ConfigService>;

    guard = new AdminApiKeyGuard(configService);
  });

  function createMockExecutionContext(
    headers: Record<string, string | undefined>,
  ): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          headers,
        }),
      }),
    } as unknown as ExecutionContext;
  }

  it('should allow access when x-api-key matches configured key', () => {
    const context = createMockExecutionContext({
      'x-api-key': mockConfigKey,
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('should throw UnauthorizedException when x-api-key is missing', () => {
    const context = createMockExecutionContext({});

    expect(() => guard.canActivate(context)).toThrow(
      new UnauthorizedException('Missing or invalid Admin API key'),
    );
  });

  it('should throw UnauthorizedException when x-api-key has different length', () => {
    const context = createMockExecutionContext({
      'x-api-key': 'short_key',
    });

    expect(() => guard.canActivate(context)).toThrow(
      new UnauthorizedException('Missing or invalid Admin API key'),
    );
  });

  it('should throw UnauthorizedException when x-api-key has same length but incorrect content', () => {
    const wrongKey = 'a'.repeat(mockConfigKey.length);
    const context = createMockExecutionContext({
      'x-api-key': wrongKey,
    });

    expect(() => guard.canActivate(context)).toThrow(
      new UnauthorizedException('Missing or invalid Admin API key'),
    );
  });

  it('should throw UnauthorizedException when ADMIN_API_KEY is not configured', () => {
    (configService.get as jest.Mock).mockReturnValue(undefined);

    const context = createMockExecutionContext({
      'x-api-key': mockConfigKey,
    });

    expect(() => guard.canActivate(context)).toThrow(
      new UnauthorizedException('Missing or invalid Admin API key'),
    );
  });
});
