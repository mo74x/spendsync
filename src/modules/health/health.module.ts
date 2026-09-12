import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { BullModule } from '@nestjs/bullmq';
import { DatabaseModule } from '../database/database.module';
import { HealthController } from './health.controller';

@Module({
  imports: [
    TerminusModule,
    DatabaseModule,
    BullModule.registerQueue({ name: 'transaction-ledger' }),
  ],
  controllers: [HealthController],
})
export class HealthModule {}
