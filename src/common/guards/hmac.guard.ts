/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

@Injectable()
export class HmacGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const signatureHeader = request.headers['x-signature'] as string;
    const timestampHeader = request.headers['x-timestamp'] as string;

    if (!signatureHeader || !timestampHeader) {
      throw new UnauthorizedException('Missing signature or timestamp headers');
    }

    // Prevent replay attacks (reject payloads older than 5 minutes)
    const currentTime = Math.floor(Date.now() / 1000);
    if (Math.abs(currentTime - parseInt(timestampHeader, 10)) > 300) {
      throw new UnauthorizedException(
        'Webhook timestamp outside tolerance window',
      );
    }

    const secret = this.configService.getOrThrow<string>('WEBHOOK_SECRET');
    const rawBody = request.rawBody;

    if (!rawBody) {
      throw new UnauthorizedException('Raw body unavailable');
    }

    // Verify signature: sha256(timestamp + "." + rawBody)
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(`${timestampHeader}.${rawBody.toString('utf8')}`)
      .digest('hex');

    const expectedBuffer = Buffer.from(expectedSignature, 'hex');
    const providedBuffer = Buffer.from(signatureHeader, 'hex');

    if (
      expectedBuffer.length !== providedBuffer.length ||
      !crypto.timingSafeEqual(expectedBuffer, providedBuffer)
    ) {
      throw new UnauthorizedException('Invalid HMAC signature');
    }

    return true;
  }
}
