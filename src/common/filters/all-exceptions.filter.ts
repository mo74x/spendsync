import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import * as http from 'http';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const isProduction = process.env.NODE_ENV === 'production';
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let error = http.STATUS_CODES[status] ?? 'Internal Server Error';
    let message: string | string[] = 'Internal server error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      error = http.STATUS_CODES[status] ?? 'Error';
      const res = exception.getResponse();

      if (typeof res === 'string') {
        message = res;
      } else if (typeof res === 'object' && res !== null) {
        const resObj = res as Record<string, unknown>;
        if (typeof resObj.error === 'string') {
          error = resObj.error;
        }
        if (
          typeof resObj.message === 'string' ||
          Array.isArray(resObj.message)
        ) {
          message = resObj.message as string | string[];
        }
      }
    } else {
      // Unhandled runtime errors
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      error = http.STATUS_CODES[status] ?? 'Internal Server Error';

      if (isProduction) {
        message = 'Internal server error';
      } else {
        message =
          exception instanceof Error
            ? exception.message
            : 'Internal server error';
      }
    }

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      const stack = exception instanceof Error ? exception.stack : undefined;
      const exceptionMessage =
        exception instanceof Error ? exception.message : String(exception);
      this.logger.error(
        `${request.method} ${request.url} - ${status} - ${exceptionMessage}`,
        stack,
      );
    }

    response.status(status).json({
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      message,
      error,
    });
  }
}
