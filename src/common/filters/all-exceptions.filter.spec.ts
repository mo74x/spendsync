/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  ArgumentsHost,
  BadRequestException,
  HttpStatus,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { Request, Response } from 'express';

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;
  let mockResponse: {
    status: jest.Mock;
    json: jest.Mock;
  };
  let mockRequest: {
    url: string;
    method: string;
  };
  let mockArgumentsHost: ArgumentsHost;
  let loggerErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    filter = new AllExceptionsFilter();

    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    mockRequest = {
      url: '/api/v1/admin/sync-failures',
      method: 'GET',
    };

    mockArgumentsHost = {
      switchToHttp: () => ({
        getResponse: () => mockResponse as unknown as Response,
        getRequest: () => mockRequest as unknown as Request,
      }),
    } as unknown as ArgumentsHost;

    loggerErrorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should format HttpException correctly (e.g. UnauthorizedException)', () => {
    const exception = new UnauthorizedException(
      'Missing or invalid Admin API key',
    );

    filter.catch(exception, mockArgumentsHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.UNAUTHORIZED);
    expect(mockResponse.json).toHaveBeenCalledWith({
      statusCode: 401,
      timestamp: expect.any(String),
      path: '/api/v1/admin/sync-failures',
      message: 'Missing or invalid Admin API key',
      error: 'Unauthorized',
    });
    expect(loggerErrorSpy).not.toHaveBeenCalled();
  });

  it('should handle validation pipe error array in HttpException', () => {
    const exception = new BadRequestException(['name should not be empty']);

    filter.catch(exception, mockArgumentsHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(mockResponse.json).toHaveBeenCalledWith({
      statusCode: 400,
      timestamp: expect.any(String),
      path: '/api/v1/admin/sync-failures',
      message: ['name should not be empty'],
      error: 'Bad Request',
    });
    expect(loggerErrorSpy).not.toHaveBeenCalled();
  });

  it('should log 5xx unhandled error and return error message in development', () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';

    const exception = new Error('Database connection failed');

    filter.catch(exception, mockArgumentsHost);

    expect(mockResponse.status).toHaveBeenCalledWith(
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
    expect(mockResponse.json).toHaveBeenCalledWith({
      statusCode: 500,
      timestamp: expect.any(String),
      path: '/api/v1/admin/sync-failures',
      message: 'Database connection failed',
      error: 'Internal Server Error',
    });
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      'GET /api/v1/admin/sync-failures - 500 - Database connection failed',
      exception.stack,
    );

    process.env.NODE_ENV = originalEnv;
  });

  it('should sanitize unhandled 500 error messages in production', () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    const exception = new Error('SELECT * FROM secret_table WHERE id = 1');

    filter.catch(exception, mockArgumentsHost);

    expect(mockResponse.status).toHaveBeenCalledWith(
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
    expect(mockResponse.json).toHaveBeenCalledWith({
      statusCode: 500,
      timestamp: expect.any(String),
      path: '/api/v1/admin/sync-failures',
      message: 'Internal server error',
      error: 'Internal Server Error',
    });
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      'GET /api/v1/admin/sync-failures - 500 - SELECT * FROM secret_table WHERE id = 1',
      exception.stack,
    );

    process.env.NODE_ENV = originalEnv;
  });
});
