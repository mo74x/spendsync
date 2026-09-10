import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient } from 'pg';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private pool: Pool;
  private readonly logger = new Logger(DatabaseService.name);

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    this.pool = new Pool({
      connectionString: this.configService.get<string>('DATABASE_URL'),
      max: 20, // Max number of clients in the pool
      idleTimeoutMillis: 30000,
    });

    this.pool.on('error', (err) => {
      this.logger.error('Unexpected error on idle pg client', err);
      process.exit(-1);
    });
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  // for single queries
  async query(text: string, params?: any[]) {
    return this.pool.query(text, params);
  }

  async getClient(): Promise<PoolClient> {
    const client = await this.pool.connect();
    return client;
  }
}
