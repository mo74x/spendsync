import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
  HealthIndicatorService,
} from '@nestjs/terminus';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, IRedisClient } from 'bullmq';
import { DatabaseService } from '../database/database.service';

type RedisClientWithPing = IRedisClient & {
  ping(): Promise<string>;
};

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly healthIndicator: HealthIndicatorService,
    private readonly db: DatabaseService,
    @InjectQueue('transaction-ledger') private readonly ledgerQueue: Queue,
  ) {}

  @Get()
  @HealthCheck()
  async check(): Promise<HealthCheckResult> {
    return this.health.check([
      async () => {
        try {
          await this.db.query('SELECT 1');
          return this.healthIndicator.check('database').up();
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return this.healthIndicator.check('database').down({ message });
        }
      },
      async () => {
        try {
          const client = (await this.ledgerQueue.getBackend()
            .client) as RedisClientWithPing;
          await client.ping();
          return this.healthIndicator.check('redis').up();
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return this.healthIndicator.check('redis').down({ message });
        }
      },
    ]);
  }
}
