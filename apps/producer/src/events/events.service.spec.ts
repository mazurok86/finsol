import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Observable, defer, of, throwError } from 'rxjs';
import { MESSAGE_PATTERNS, RMQ_CLIENTS } from '@app/common';
import { EventsService } from './events.service';
import { IdempotencyService } from '../idempotency/idempotency.service';

describe('EventsService', () => {
  let service: EventsService;
  let client: { emit: jest.Mock; connect: jest.Mock; close: jest.Mock };
  let idempotency: {
    fingerprint: jest.Mock;
    acquire: jest.Mock;
    commit: jest.Mock;
    release: jest.Mock;
  };

  beforeEach(async () => {
    client = {
      emit: jest.fn(),
      connect: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };
    idempotency = {
      fingerprint: jest.fn().mockReturnValue('hash-of-request'),
      acquire: jest.fn().mockResolvedValue(null), // null = lock acquired, proceed
      commit: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        EventsService,
        { provide: RMQ_CLIENTS.EVENTS, useValue: client },
        { provide: IdempotencyService, useValue: idempotency },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, def?: unknown) => {
              const map: Record<string, unknown> = {
                PUBLISH_MAX_RETRIES: 2,
                PUBLISH_RETRY_DELAY_MS: 1,
              };
              return map[key] ?? def;
            },
          },
        },
      ],
    }).compile();

    service = moduleRef.get(EventsService);
  });

  it('publishes a generated UUID and skips idempotency entirely', async () => {
    client.emit.mockReturnValue(of(true));

    const outcome = await service.publish({
      eventType: 'user.signup',
      payload: { userId: 1 },
    });

    expect(outcome.eventId).toMatch(/[0-9a-f-]{36}/);
    expect(idempotency.fingerprint).not.toHaveBeenCalled();
    expect(idempotency.acquire).not.toHaveBeenCalled();
    expect(idempotency.commit).not.toHaveBeenCalled();

    expect(client.emit).toHaveBeenCalledTimes(1);
    const [pattern, payload] = client.emit.mock.calls[0];
    expect(pattern).toBe(MESSAGE_PATTERNS.EVENT_CREATED);
    expect(payload).toMatchObject({
      eventId: outcome.eventId,
      eventType: 'user.signup',
      payload: { userId: 1 },
    });
  });

  it('claims via idempotency, publishes, then commits', async () => {
    client.emit.mockReturnValue(of(true));

    const outcome = await service.publish({
      eventId: 'fixed',
      eventType: 'x',
      payload: { a: 1 },
    });

    expect(outcome).toEqual({ eventId: 'fixed', eventType: 'x' });
    expect(idempotency.fingerprint).toHaveBeenCalledWith({
      eventType: 'x',
      payload: { a: 1 },
    });
    expect(idempotency.acquire).toHaveBeenCalledWith('fixed', 'hash-of-request');
    expect(idempotency.commit).toHaveBeenCalledWith('fixed', 'hash-of-request', {
      eventId: 'fixed',
      eventType: 'x',
    });
  });

  it('returns the cached response from acquire without re-emitting', async () => {
    idempotency.acquire.mockResolvedValueOnce({ eventId: 'fixed', eventType: 'x' });

    const outcome = await service.publish({
      eventId: 'fixed',
      eventType: 'x',
      payload: {},
    });

    expect(outcome).toEqual({ eventId: 'fixed', eventType: 'x' });
    expect(client.emit).not.toHaveBeenCalled();
    expect(idempotency.commit).not.toHaveBeenCalled();
  });

  it('releases the lock if emit ultimately fails', async () => {
    client.emit.mockReturnValue(throwError(() => new Error('broker down')));

    await expect(
      service.publish({ eventId: 'fixed', eventType: 'x', payload: {} }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(idempotency.release).toHaveBeenCalledWith('fixed');
    expect(idempotency.commit).not.toHaveBeenCalled();
  });

  function mockSequence(...factories: Array<() => Observable<unknown>>) {
    let i = 0;
    const counter = { calls: 0 };
    client.emit.mockImplementation(() =>
      defer(() => {
        counter.calls += 1;
        const next = factories[Math.min(i, factories.length - 1)];
        if (!next) throw new Error('mockSequence requires at least one factory');
        i += 1;
        return next();
      }),
    );
    return counter;
  }

  it('retries on transient errors before succeeding', async () => {
    const counter = mockSequence(
      () => throwError(() => new Error('boom')),
      () => of(true),
    );

    await expect(service.publish({ eventType: 't', payload: {} })).resolves.toMatchObject({
      eventType: 't',
    });
    expect(counter.calls).toBe(2);
  });

  it('throws ServiceUnavailableException after exhausting retries', async () => {
    const counter = mockSequence(() => throwError(() => new Error('broker down')));

    await expect(service.publish({ eventType: 't', payload: {} })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(counter.calls).toBe(3);
  });
});
