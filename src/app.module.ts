import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { ExpressAdapter } from '@bull-board/express';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { DatabaseModule } from './modules/database/database.module';
import { WebhooksController } from './modules/webhooks/webhooks.controller';
import { WebhooksService } from './modules/webhooks/webhooks.service';
import { LedgerProcessor } from './modules/ledger/ledger.processor';
import { OdooSyncProcessor } from './modules/odoo/odoo-sync.processor';
import { OdooClient } from './modules/odoo/odoo.client';
import { AdminController } from './modules/admin/admin.controller';
import { HealthModule } from './modules/health/health.module';
import { NotificationsService } from './modules/notifications/notifications.service';
import { RequestLoggerMiddleware } from './common/middleware/request-logger.middleware';
import { validateEnv } from './config/env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
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
    BullModule.registerQueue({ name: 'odoo-sync-dlq' }),
    BullBoardModule.forRoot({
      route: '/admin/queues',
      adapter: ExpressAdapter,
    }),
    BullBoardModule.forFeature(
      {
        name: 'transaction-ledger',
        adapter: BullMQAdapter,
      },
      {
        name: 'odoo-sync',
        adapter: BullMQAdapter,
      },
      {
        name: 'odoo-sync-dlq',
        adapter: BullMQAdapter,
      },
    ),
    HealthModule,
  ],
  controllers: [WebhooksController, AdminController],
  providers: [
    WebhooksService,
    LedgerProcessor,
    OdooSyncProcessor,
    OdooClient,
    NotificationsService,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestLoggerMiddleware).forRoutes('*');
  }
}
