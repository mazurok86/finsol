import { ConfigService } from '@nestjs/config';
import { RmqContext } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import { MESSAGE_PATTERNS, NotificationMessage } from '@app/common';
import { TelegramController } from './telegram.controller';
import { TelegramService } from './telegram.service';
import { TelegramPermanentError, TelegramTransientError } from './telegram.errors';

function makeContext() {
  const channel = {
    ack: jest.fn(),
    nack: jest.fn(),
    sendToQueue: jest.fn(),
  };
  const message = { content: Buffer.from('{}'), fields: { routingKey: 'notifications_queue' } };
  const ctx = {
    getChannelRef: () => channel,
    getMessage: () => message,
  } as unknown as RmqContext;
  return { ctx, channel, message };
}

describe('TelegramController', () => {
  let controller: TelegramController;
  let telegram: { sendMessage: jest.Mock };

  beforeEach(async () => {
    telegram = { sendMessage: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      controllers: [TelegramController],
      providers: [
        { provide: TelegramService, useValue: telegram },
        {
          provide: ConfigService,
          useValue: {
            get: (k: string, def: unknown) => {
              const map: Record<string, unknown> = {
                NOTIFICATION_MAX_RETRIES: 3,
                NOTIFICATION_RETRY_DELAY_MS: 1,
                RABBITMQ_NOTIFICATIONS_QUEUE: 'notifications_queue',
              };
              return map[k] ?? def;
            },
          },
        },
      ],
    }).compile();
    controller = moduleRef.get(TelegramController);
  });

  const baseMsg: NotificationMessage = {
    eventId: 'e-1',
    eventType: 'user.signup',
    text: 'hello',
    occurredAt: '2024-01-01T00:00:00Z',
  };

  it('acks on success and does not republish', async () => {
    telegram.sendMessage.mockResolvedValue(undefined);
    const { ctx, channel } = makeContext();

    await controller.handle(baseMsg, ctx);

    expect(channel.ack).toHaveBeenCalledTimes(1);
    expect(channel.sendToQueue).not.toHaveBeenCalled();
  });

  it('drops permanent errors without republishing', async () => {
    telegram.sendMessage.mockRejectedValue(new TelegramPermanentError('chat not found', 400));
    const { ctx, channel } = makeContext();

    await controller.handle(baseMsg, ctx);

    expect(channel.ack).toHaveBeenCalledTimes(1);
    expect(channel.sendToQueue).not.toHaveBeenCalled();
  });

  it('republishes on transient error with incremented retryCount', async () => {
    jest.useFakeTimers();
    telegram.sendMessage.mockRejectedValue(new TelegramTransientError('upstream', 500));
    const { ctx, channel } = makeContext();

    await controller.handle(baseMsg, ctx);

    expect(channel.ack).toHaveBeenCalledTimes(1);
    expect(channel.sendToQueue).not.toHaveBeenCalled();

    jest.runAllTimers();

    expect(channel.sendToQueue).toHaveBeenCalledTimes(1);
    const [queue, buf, opts] = channel.sendToQueue.mock.calls[0];
    expect(queue).toBe('notifications_queue');
    expect(opts).toEqual({ persistent: true });
    const envelope = JSON.parse((buf as Buffer).toString());
    expect(envelope.pattern).toBe(MESSAGE_PATTERNS.NOTIFICATION_SEND);
    expect(envelope.data.retryCount).toBe(1);
    expect(envelope.data.eventId).toBe('e-1');
    jest.useRealTimers();
  });

  it('drops transient error after max retries', async () => {
    telegram.sendMessage.mockRejectedValue(new TelegramTransientError('upstream', 500));
    const { ctx, channel } = makeContext();

    await controller.handle({ ...baseMsg, retryCount: 2 }, ctx);

    expect(channel.ack).toHaveBeenCalledTimes(1);
    expect(channel.sendToQueue).not.toHaveBeenCalled();
  });

  it('uses retryAfterSec from 429 for backoff', async () => {
    jest.useFakeTimers();
    telegram.sendMessage.mockRejectedValue(new TelegramTransientError('rate limited', 429, 5));
    const { ctx, channel } = makeContext();

    await controller.handle(baseMsg, ctx);

    // Not yet republished — waiting on the 5s timer
    jest.advanceTimersByTime(4999);
    expect(channel.sendToQueue).not.toHaveBeenCalled();

    jest.advanceTimersByTime(2);
    expect(channel.sendToQueue).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });
});
