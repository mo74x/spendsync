import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';

export interface RequestWithCorrelationId extends Request {
  correlationId?: string;
}

@Injectable()
export class RequestLoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(req: RequestWithCorrelationId, res: Response, next: NextFunction): void {
    const incomingHeader = req.headers['x-correlation-id'];
    const correlationId =
      typeof incomingHeader === 'string' && incomingHeader.trim().length > 0
        ? incomingHeader
        : crypto.randomUUID();

    req.correlationId = correlationId;
    res.setHeader('x-correlation-id', correlationId);

    const startTime = Date.now();

    res.on('finish', () => {
      const { method, originalUrl } = req;
      const { statusCode } = res;
      const duration = Date.now() - startTime;

      this.logger.log(
        `[${correlationId}] ${method} ${originalUrl} ${statusCode} - ${duration}ms`,
      );
    });

    next();
  }
}
