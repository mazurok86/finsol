import { Controller, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import { MESSAGE_PATTERNS, NotificationMessage, QUEUE_NAMES } from '@app/common';
import { TelegramService } from './telegram.service';
import { TelegramPermanentError, TelegramTransientError } from './telegram.errors';

interface ChannelLike {
  ack: (msg: unknown) => void;
  sendToQueue: (queue: string, content: Buffer, options?: object) => boolean;
}

@Controller()
export class TelegramController {
  private readonly logger = new Logger(TelegramController.name);
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly queueName: string;

  constructor(
    private readonly telegram: TelegramService,
    config: ConfigService,
  ) {
    this.maxRetries = Number(config.get('NOTIFICATION_MAX_RETRIES', 3));
    this.retryDelayMs = Number(config.get('NOTIFICATION_RETRY_DELAY_MS', 1000));
    this.queueName = config.get<string>('RABBITMQ_NOTIFICATIONS_QUEUE', QUEUE_NAMES.NOTIFICATIONS);
  }

  @EventPattern(MESSAGE_PATTERNS.NOTIFICATION_SEND)
  async handle(@Payload() data: NotificationMessage, @Ctx() context: RmqContext) {
    const channel = context.getChannelRef() as ChannelLike;
    const originalMsg = context.getMessage();

    try {
      await this.telegram.sendMessage(data);
      this.logger.log(`Sent notification eventId=${data.eventId} type=${data.eventType}`);
      channel.ack(originalMsg);
      return;
    } catch (error) {
      channel.ack(originalMsg);

      if (error instanceof TelegramPermanentError) {
        this.logger.error(
          `Permanent Telegram failure for eventId=${data.eventId}: code=${error.errorCode ?? 'n/a'} description="${error.description}". Dropping.`,
        );
        return;
      }

      const reason =
        error instanceof TelegramTransientError
          ? `code=${error.errorCode ?? 'n/a'} description="${error.description}"`
          : error instanceof Error
            ? error.message
            : String(error);

      const attempt = (data.retryCount ?? 0) + 1;
      if (attempt >= this.maxRetries) {
        this.logger.error(
          `Discarding notification eventId=${data.eventId} after ${this.maxRetries} attempts (${reason})`,
        );
        return;
      }

      const retryAfterMs =
        error instanceof TelegramTransientError && error.retryAfterSec
          ? error.retryAfterSec * 1000
          : this.retryDelayMs * Math.pow(2, attempt - 1);

      this.logger.warn(
        `Re-queueing notification eventId=${data.eventId} for retry ${attempt + 1}/${this.maxRetries} in ${retryAfterMs}ms (${reason})`,
      );

      setTimeout(() => {
        const envelope = {
          pattern: MESSAGE_PATTERNS.NOTIFICATION_SEND,
          data: { ...data, retryCount: attempt },
        };
        channel.sendToQueue(this.queueName, Buffer.from(JSON.stringify(envelope)), {
          persistent: true,
        });
      }, retryAfterMs);
    }
  }
}
