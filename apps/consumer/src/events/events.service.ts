import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy, RmqContext } from '@nestjs/microservices';
import { lastValueFrom } from 'rxjs';
import {
  EventMessage,
  MESSAGE_PATTERNS,
  NotificationMessage,
  QUEUE_NAMES,
  RMQ_CLIENTS,
} from '@app/common';
@Injectable()
export class EventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventsService.name);
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly eventsQueue: string;

  constructor(
    @Inject(RMQ_CLIENTS.NOTIFICATIONS) private readonly notificationsClient: ClientProxy,
    private readonly config: ConfigService,
  ) {
    this.maxRetries = Number(this.config.get('CONSUMER_MAX_RETRIES', 3));
    this.retryDelayMs = Number(this.config.get('CONSUMER_RETRY_DELAY_MS', 1000));
    this.eventsQueue = this.config.get<string>('RABBITMQ_EVENTS_QUEUE', QUEUE_NAMES.EVENTS);
  }

  async onModuleInit(): Promise<void> {
    await this.notificationsClient.connect();
    this.logger.log('Notifications RMQ client connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.notificationsClient.close();
  }

  async process(event: EventMessage, context: RmqContext): Promise<void> {
    const channel = context.getChannelRef();
    const originalMsg = context.getMessage();
    const attempt = (event.retryCount ?? 0) + 1;

    if (!event.eventId) {
      this.logger.error(`Rejecting message without eventId (poison)`);
      channel.ack(originalMsg);
      return;
    }

    try {
      const notification = this.buildNotification(event);
      await lastValueFrom(
        this.notificationsClient.emit(MESSAGE_PATTERNS.NOTIFICATION_SEND, notification),
      );

      this.logger.log(
        `Processed eventId=${event.eventId} type=${event.eventType} attempt=${attempt}`,
      );
      channel.ack(originalMsg);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed eventId=${event.eventId} attempt=${attempt}: ${reason}`);

      channel.ack(originalMsg);

      if (attempt < this.maxRetries) {
        const backoff = this.retryDelayMs * Math.pow(2, attempt - 1);
        this.logger.warn(
          `Re-queueing eventId=${event.eventId} for retry ${attempt + 1}/${this.maxRetries} in ${backoff}ms`,
        );
        setTimeout(() => this.republish({ ...event, retryCount: attempt }, channel), backoff);
      } else {
        this.logger.error(
          `Discarding eventId=${event.eventId} after ${this.maxRetries} attempts (poison message)`,
        );
      }
    }
  }

  private republish(
    event: EventMessage,
    channel: { sendToQueue: (q: string, buf: Buffer, opts?: object) => boolean },
  ) {
    const envelope = {
      pattern: MESSAGE_PATTERNS.EVENT_CREATED,
      data: event,
    };
    channel.sendToQueue(this.eventsQueue, Buffer.from(JSON.stringify(envelope)), {
      persistent: true,
    });
  }

  private buildNotification(event: EventMessage): NotificationMessage {
    const text = `[${event.eventType}] ${JSON.stringify(event.payload)}`;
    return {
      eventId: event.eventId,
      eventType: event.eventType,
      text,
      occurredAt: event.occurredAt,
    };
  }
}
