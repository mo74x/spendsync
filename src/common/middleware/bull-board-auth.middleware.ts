import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function verifyAdminAuth(adminApiKey: string, req: Request): boolean {
  if (!adminApiKey) {
    return false;
  }

  // 1. Check x-api-key header
  const apiKeyHeader = req.headers['x-api-key'];
  if (
    typeof apiKeyHeader === 'string' &&
    safeCompare(apiKeyHeader, adminApiKey)
  ) {
    return true;
  }

  // 2. Check HTTP Basic Authentication
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Basic ')) {
    const base64Credentials = authHeader.substring(6).trim();
    try {
      const credentials = Buffer.from(base64Credentials, 'base64').toString(
        'utf-8',
      );
      const separatorIndex = credentials.indexOf(':');
      if (separatorIndex !== -1) {
        const password = credentials.substring(separatorIndex + 1);
        if (safeCompare(password, adminApiKey)) {
          return true;
        }
      }
    } catch {
      return false;
    }
  }

  return false;
}

export function createBullBoardAuthMiddleware(adminApiKey: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (verifyAdminAuth(adminApiKey, req)) {
      next();
      return;
    }

    res.setHeader('WWW-Authenticate', 'Basic realm="SpendSync Bull Board"');
    res.status(401).send('Unauthorized: Admin credentials required');
  };
}

@Injectable()
export class BullBoardAuthMiddleware implements NestMiddleware {
  private readonly logger = new Logger(BullBoardAuthMiddleware.name);

  constructor(private readonly configService: ConfigService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const adminApiKey = this.configService.get<string>('ADMIN_API_KEY') || '';

    if (!adminApiKey) {
      this.logger.error(
        'ADMIN_API_KEY is not configured; rejecting Bull Board request',
      );
      res
        .status(500)
        .send('Internal Server Error: Missing server configuration');
      return;
    }

    if (verifyAdminAuth(adminApiKey, req)) {
      next();
      return;
    }

    res.setHeader('WWW-Authenticate', 'Basic realm="SpendSync Bull Board"');
    res.status(401).send('Unauthorized: Admin credentials required');
  }
}
