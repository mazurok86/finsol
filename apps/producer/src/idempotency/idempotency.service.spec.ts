import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { REDIS_CLIENT } from './idempotency.tokens';
import { IdempotencyService } from './idempotency.service';

describe('IdempotencyService', () => {
  let service: IdempotencyService;
  let redis: { get: jest.Mock; set: jest.Mock; del: jest.Mock; quit: jest.Mock };

  beforeEach(async () => {
    redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      quit: jest.fn().mockResolvedValue('OK'),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        IdempotencyService,
        { provide: REDIS_CLIENT, useValue: redis },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, def?: unknown) => {
              const map: Record<string, unknown> = {
                PRODUCER_IDEMPOTENCY_TTL_SEC: 60,
                PRODUCER_IDEMPOTENCY_WAIT_TIMEOUT_MS: 100,
                PRODUCER_IDEMPOTENCY_POLL_INTERVAL_MS: 5,
              };
              return map[key] ?? def;
            },
          },
        },
      ],
    }).compile();
    service = moduleRef.get(IdempotencyService);
  });

  describe('fingerprint', () => {
    it('produces a hex SHA-256 string', () => {
      const fp = service.fingerprint({ a: 1 });
      expect(fp).toMatch(/^[0-9a-f]{64}$/);
    });

    it('canonicalizes object key order', () => {
      expect(service.fingerprint({ a: 1, b: 2 })).toEqual(service.fingerprint({ b: 2, a: 1 }));
    });

    it('differs for different content', () => {
      expect(service.fingerprint({ a: 1 })).not.toEqual(service.fingerprint({ a: 2 }));
    });
  });

  describe('acquire', () => {
    it('returns null when SET NX succeeds (lock acquired)', async () => {
      const fp = 'h1';
      await expect(service.acquire('k1', fp)).resolves.toBeNull();
      expect(redis.set).toHaveBeenCalledWith(
        'idemp:producer:k1',
        JSON.stringify({ status: 'pending', requestHash: fp }),
        'EX',
        60,
        'NX',
      );
    });

    it('replays the stored response when key already done with same hash', async () => {
      redis.set.mockResolvedValueOnce(null);
      redis.get.mockResolvedValueOnce(
        JSON.stringify({ status: 'done', requestHash: 'h1', response: { ok: true } }),
      );
      await expect(service.acquire('k1', 'h1')).resolves.toEqual({ ok: true });
    });

    it('throws ConflictException on hash mismatch in done entry', async () => {
      redis.set.mockResolvedValueOnce(null);
      redis.get.mockResolvedValueOnce(
        JSON.stringify({ status: 'done', requestHash: 'other', response: { ok: true } }),
      );
      await expect(service.acquire('k1', 'h1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('throws ConflictException on hash mismatch in pending entry', async () => {
      redis.set.mockResolvedValueOnce(null);
      redis.get.mockResolvedValueOnce(JSON.stringify({ status: 'pending', requestHash: 'other' }));
      await expect(service.acquire('k1', 'h1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('waits for in-flight to complete and replays the result', async () => {
      redis.set.mockResolvedValueOnce(null);
      redis.get
        .mockResolvedValueOnce(JSON.stringify({ status: 'pending', requestHash: 'h1' }))
        .mockResolvedValueOnce(JSON.stringify({ status: 'pending', requestHash: 'h1' }))
        .mockResolvedValueOnce(
          JSON.stringify({ status: 'done', requestHash: 'h1', response: { ok: true } }),
        );
      await expect(service.acquire('k1', 'h1')).resolves.toEqual({ ok: true });
    });

    it('throws ServiceUnavailable on wait timeout', async () => {
      redis.set.mockResolvedValueOnce(null);
      redis.get.mockResolvedValue(JSON.stringify({ status: 'pending', requestHash: 'h1' }));
      await expect(service.acquire('k1', 'h1')).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('throws ServiceUnavailable when lock disappears', async () => {
      redis.set.mockResolvedValueOnce(null);
      redis.get.mockResolvedValueOnce(null);
      await expect(service.acquire('k1', 'h1')).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('throws ServiceUnavailable on corrupt JSON', async () => {
      redis.set.mockResolvedValueOnce(null);
      redis.get.mockResolvedValueOnce('{not json');
      await expect(service.acquire('k1', 'h1')).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  describe('commit', () => {
    it('writes done entry with configured TTL', async () => {
      await service.commit('k1', 'h1', { ok: true });
      expect(redis.set).toHaveBeenCalledWith(
        'idemp:producer:k1',
        JSON.stringify({ status: 'done', requestHash: 'h1', response: { ok: true } }),
        'EX',
        60,
      );
    });
  });

  describe('release', () => {
    it('deletes the key', async () => {
      await service.release('k1');
      expect(redis.del).toHaveBeenCalledWith('idemp:producer:k1');
    });
  });
});
