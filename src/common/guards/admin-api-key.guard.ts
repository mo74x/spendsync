import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { Request } from 'express';

@Injectable()
export class AdminApiKeyGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const apiKey = request.headers['x-api-key'];

    if (!apiKey || typeof apiKey !== 'string') {
      throw new UnauthorizedException('Missing or invalid Admin API key');
    }

    const configuredApiKey = this.configService.get<string>('ADMIN_API_KEY');
    if (!configuredApiKey) {
      throw new UnauthorizedException('Missing or invalid Admin API key');
    }

    const providedBuffer = Buffer.from(apiKey, 'utf8');
    const expectedBuffer = Buffer.from(configuredApiKey, 'utf8');

    if (
      providedBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
    ) {
      throw new UnauthorizedException('Missing or invalid Admin API key');
    }

    return true;
  }
}
