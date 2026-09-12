import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from './health.controller';
import { TerminusModule } from '@nestjs/terminus';
import { DatabaseService } from '../database/database.service';
import { getQueueToken } from '@nestjs/bullmq';

describe('HealthController', () => {
  let controller: HealthController;
  let dbService: { query: jest.Mock };
  let mockQueue: { getBackend: jest.Mock };
  let mockPing: jest.Mock;

  beforeEach(async () => {
    mockPing = jest.fn().mockResolvedValue('PONG');
    mockQueue = {
      getBackend: jest.fn().mockReturnValue({
        client: Promise.resolve({
          ping: mockPing,
        }),
      }),
    };

    dbService = {
      query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    };

    const module: TestingModule = await Test.createTestingModule({
      imports: [TerminusModule],
      controllers: [HealthController],
      providers: [
        {
          provide: DatabaseService,
          useValue: dbService,
        },
        {
          provide: getQueueToken('transaction-ledger'),
          useValue: mockQueue,
        },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('should return status ok when both database and redis are healthy', async () => {
    const result = await controller.check();

    expect(result.status).toBe('ok');
    expect(result.info).toEqual({
      database: { status: 'up' },
      redis: { status: 'up' },
    });
    expect(dbService.query).toHaveBeenCalledWith('SELECT 1');
    expect(mockPing).toHaveBeenCalled();
  });

  it('should throw and report database down when database query fails', async () => {
    dbService.query.mockRejectedValueOnce(new Error('Database unreachable'));

    await expect(controller.check()).rejects.toThrow();
  });

  it('should throw and report redis down when redis ping fails', async () => {
    mockPing.mockRejectedValueOnce(new Error('Redis connection timed out'));

    await expect(controller.check()).rejects.toThrow();
  });
});
