import 'reflect-metadata';
import { validateEnv, Environment } from './env.validation';

describe('validateEnv', () => {
  const validConfig: Record<string, unknown> = {
    PORT: '3000',
    DATABASE_URL: 'postgresql://postgres:password@localhost:5432/spendsync',
    REDIS_HOST: 'localhost',
    REDIS_PORT: '6379',
    WEBHOOK_SECRET: 'whsec_secret_123',
    ODOO_HOST: 'localhost',
    ODOO_PORT: '8069',
    ODOO_DB: 'spendsync_odoo',
    ODOO_USERNAME: 'admin',
    ODOO_PASSWORD: 'admin_password',
    CARD_CLEARING_ACCOUNT: '210000',
    ADMIN_API_KEY: 'admin_key_456',
  };

  it('should successfully validate and convert valid configuration', () => {
    const validated = validateEnv(validConfig);

    expect(validated.PORT).toBe(3000);
    expect(validated.REDIS_PORT).toBe(6379);
    expect(validated.ODOO_PORT).toBe(8069);
    expect(validated.ODOO_HOST).toBe('localhost');
    expect(validated.DATABASE_URL).toBe(
      'postgresql://postgres:password@localhost:5432/spendsync',
    );
    expect(validated.NODE_ENV).toBe(Environment.Development);
  });

  it('should throw error when required ODOO_HOST is missing', () => {
    const invalidConfig = { ...validConfig };
    delete invalidConfig.ODOO_HOST;

    expect(() => validateEnv(invalidConfig)).toThrow(/Config validation error/);
  });

  it('should throw error when required DATABASE_URL is missing', () => {
    const invalidConfig = { ...validConfig };
    delete invalidConfig.DATABASE_URL;

    expect(() => validateEnv(invalidConfig)).toThrow(/Config validation error/);
  });

  it('should throw error when required ADMIN_API_KEY is missing', () => {
    const invalidConfig = { ...validConfig };
    delete invalidConfig.ADMIN_API_KEY;

    expect(() => validateEnv(invalidConfig)).toThrow(/Config validation error/);
  });

  it('should throw error when NODE_ENV is not a valid enum value', () => {
    const invalidConfig = {
      ...validConfig,
      NODE_ENV: 'staging_invalid',
    };

    expect(() => validateEnv(invalidConfig)).toThrow(/Config validation error/);
  });
});
