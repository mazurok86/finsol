import { ConfigService } from '@nestjs/config';
import { RmqContext } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import { of, throwError } from 'rxjs';
import { EventMessage, MESSAGE_PATTERNS, RMQ_CLIENTS } from '@app/common';
import { EventsService } from './events.service';

function makeContext() {
  const channel = {
    ack: jest.fn(),
    nack: jest.fn(),
    sendToQueue: jest.fn(),
  };
  const message = { content: Buffer.from('{}'), fields: { routingKey: 'events_queue' } };
  const ctx = {
    getChannelRef: () => channel,
    getMessage: () => message,
  } as unknown as RmqContext;
  return { ctx, channel, message };
}

describe('EventsService (consumer)', () => {
  let service: EventsService;
  let notificationsClient: { emit: jest.Mock; connect: jest.Mock; close: jest.Mock };

  beforeEach(async () => {
    notificationsClient = {
      emit: jest.fn().mockReturnValue(of(true)),
      connect: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        EventsService,
        { provide: RMQ_CLIENTS.NOTIFICATIONS, useValue: notificationsClient },
        {
          provide: ConfigService,
          useValue: {
            get: (k: string, def: unknown) => {
              const map: Record<string, unknown> = {
                CONSUMER_MAX_RETRIES: 2,
                CONSUMER_RETRY_DELAY_MS: 1,
                RABBITMQ_EVENTS_QUEUE: 'events_queue',
              };
              return map[k] ?? def;
            },
          },
        },
      ],
    }).compile();
    service = moduleRef.get(EventsService);
  });

  const baseEvent: EventMessage = {
    eventId: 'e-1',
    eventType: 'user.signup',
    payload: { id: 1 },
    occurredAt: new Date().toISOString(),
  };

  it('processes an event and forwards to notifications queue', async () => {
    const { ctx, channel } = makeContext();
    await service.process(baseEvent, ctx);

    expect(notificationsClient.emit).toHaveBeenCalledWith(
      MESSAGE_PATTERNS.NOTIFICATION_SEND,
      expect.objectContaining({ eventId: 'e-1', eventType: 'user.signup' }),
    );
    expect(channel.ack).toHaveBeenCalled();
  });

  it('on error, acks original, and re-publishes for retry', async () => {
    jest.useFakeTimers();
    notificationsClient.emit.mockReturnValue(throwError(() => new Error('downstream')));
    const { ctx, channel } = makeContext();

    await service.process(baseEvent, ctx);

    expect(channel.ack).toHaveBeenCalled();

    jest.runAllTimers();
    expect(channel.sendToQueue).toHaveBeenCalledWith('events_queue', expect.any(Buffer), {
      persistent: true,
    });
    jest.useRealTimers();
  });

  it('after max retries, drops the message (poison)', async () => {
    notificationsClient.emit.mockReturnValue(throwError(() => new Error('downstream')));
    const { ctx, channel } = makeContext();

    await service.process({ ...baseEvent, retryCount: 2 }, ctx);

    expect(channel.ack).toHaveBeenCalled();
    expect(channel.sendToQueue).not.toHaveBeenCalled();
  });

  it('discards message without eventId', async () => {
    const { ctx, channel } = makeContext();
    await service.process({ ...baseEvent, eventId: '' }, ctx);
    expect(notificationsClient.emit).not.toHaveBeenCalled();
    expect(channel.ack).toHaveBeenCalled();
  });
});
