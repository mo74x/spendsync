import {
  Controller,
  Post,
  Body,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { HmacGuard } from '../../common/guards/hmac.guard';
import { CardTransactionWebhookDto } from './dto/card-transaction-webhook.dto';
import { WebhooksService } from './webhooks.service';
import type { RequestWithCorrelationId } from '../../common/middleware/request-logger.middleware';

@Controller('api/v1/webhooks')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Post('transactions')
  @UseGuards(HmacGuard)
  @HttpCode(HttpStatus.ACCEPTED) // Always return 202 quickly for webhooks
  async handleIncomingWebhook(
    @Body() payload: CardTransactionWebhookDto,
    @Req() req?: RequestWithCorrelationId,
  ) {
    return this.webhooksService.ingestEvent(payload, req?.correlationId);
  }
}
