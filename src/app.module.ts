import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { DatabaseModule } from './modules/database/database.module';
import { WebhooksController } from './modules/webhooks/webhooks.controller';
import { WebhooksService } from './modules/webhooks/webhooks.service';
import { LedgerProcessor } from './modules/ledger/ledger.processor';
import { OdooSyncProcessor } from './modules/odoo/odoo-sync.processor';
import { OdooClient } from './modules/odoo/odoo.client';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.get<string>('REDIS_HOST'),
          port: configService.get<number>('REDIS_PORT'),
        },
      }),
      inject: [ConfigService],
    }),
    BullModule.registerQueue({ name: 'transaction-ledger' }),
    BullModule.registerQueue({ name: 'odoo-sync' }),
  ],
  controllers: [WebhooksController],
  providers: [WebhooksService, LedgerProcessor, OdooSyncProcessor, OdooClient],
})
export class AppModule {}
