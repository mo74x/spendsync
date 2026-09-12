import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

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
  async query<R extends QueryResultRow = any>(
    text: string,
    params?: any[],
  ): Promise<QueryResult<R>> {
    return this.pool.query<R>(text, params);
  }

  async getClient(): Promise<PoolClient> {
    const client = await this.pool.connect();
    return client;
  }
}
