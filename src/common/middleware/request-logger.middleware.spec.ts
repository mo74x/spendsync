import { Logger } from '@nestjs/common';
import {
  RequestLoggerMiddleware,
  RequestWithCorrelationId,
} from './request-logger.middleware';
import { Response, NextFunction } from 'express';

describe('RequestLoggerMiddleware', () => {
  let middleware: RequestLoggerMiddleware;
  let mockRequest: Partial<RequestWithCorrelationId>;
  let mockResponse: Partial<Response>;
  let nextFunction: NextFunction;
  let loggerLogSpy: jest.SpyInstance;
  let finishCallback: () => void;

  beforeEach(() => {
    middleware = new RequestLoggerMiddleware();

    mockRequest = {
      headers: {},
      method: 'GET',
      originalUrl: '/api/v1/admin/sync-failures',
    };

    finishCallback = () => {};

    mockResponse = {
      statusCode: 200,
      setHeader: jest.fn(),
      on: jest.fn((event: string, callback: () => void) => {
        if (event === 'finish') {
          finishCallback = callback;
        }
        return mockResponse as Response;
      }),
    };

    nextFunction = jest.fn();
    loggerLogSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should generate a correlation ID and set header if none provided', () => {
    middleware.use(
      mockRequest as RequestWithCorrelationId,
      mockResponse as Response,
      nextFunction,
    );

    expect(mockRequest.correlationId).toBeDefined();
    expect(mockResponse.setHeader).toHaveBeenCalledWith(
      'x-correlation-id',
      mockRequest.correlationId,
    );
    expect(nextFunction).toHaveBeenCalled();
  });

  it('should preserve incoming x-correlation-id header', () => {
    const existingCorrelationId = 'custom-trace-uuid-1234';
    mockRequest.headers = { 'x-correlation-id': existingCorrelationId };

    middleware.use(
      mockRequest as RequestWithCorrelationId,
      mockResponse as Response,
      nextFunction,
    );

    expect(mockRequest.correlationId).toBe(existingCorrelationId);
    expect(mockResponse.setHeader).toHaveBeenCalledWith(
      'x-correlation-id',
      existingCorrelationId,
    );
    expect(nextFunction).toHaveBeenCalled();
  });

  it('should log request details on response finish', () => {
    middleware.use(
      mockRequest as RequestWithCorrelationId,
      mockResponse as Response,
      nextFunction,
    );

    finishCallback();

    expect(loggerLogSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(
          `^\\[${mockRequest.correlationId}\\] GET /api/v1/admin/sync-failures 200 - \\d+ms$`,
        ),
      ),
    );
  });
});
