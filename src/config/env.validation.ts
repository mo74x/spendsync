import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  validateSync,
} from 'class-validator';

export enum Environment {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

export class EnvironmentVariables {
  @IsEnum(Environment)
  @IsOptional()
  NODE_ENV: Environment = Environment.Development;

  @IsNumber()
  @IsOptional()
  PORT: number = 3000;

  @IsString()
  DATABASE_URL: string;

  @IsString()
  REDIS_HOST: string;

  @IsNumber()
  @IsOptional()
  REDIS_PORT: number = 6379;

  @IsString()
  WEBHOOK_SECRET: string;

  @IsString()
  ODOO_HOST: string;

  @IsNumber()
  @IsOptional()
  ODOO_PORT: number = 8069;

  @IsString()
  ODOO_DB: string;

  @IsString()
  ODOO_USERNAME: string;

  @IsString()
  ODOO_PASSWORD: string;

  @IsString()
  @IsOptional()
  CARD_CLEARING_ACCOUNT: string = '210000';

  @IsString()
  ADMIN_API_KEY: string;

  @IsString()
  @IsOptional()
  SLACK_WEBHOOK_URL?: string;
}

export function validateEnv(
  config: Record<string, unknown>,
): EnvironmentVariables {
  const validatedConfig = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validatedConfig, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    const errorMessages = errors
      .map((err) => Object.values(err.constraints || {}))
      .flat();
    throw new Error(`Config validation error:\n${errorMessages.join('\n')}`);
  }
  return validatedConfig;
}
