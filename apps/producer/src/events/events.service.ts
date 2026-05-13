import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { randomUUID } from 'node:crypto';
import { lastValueFrom } from 'rxjs';
import {
  EventMessage,
  MESSAGE_PATTERNS,
  PublishEventDto,
  RMQ_CLIENTS,
  retryWithBackoff,
} from '@app/common';
import { IdempotencyService } from '../idempotency/idempotency.service';

export interface PublishOutcome {
  eventId: string;
  eventType: string;
}

@Injectable()
export class EventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventsService.name);
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(
    @Inject(RMQ_CLIENTS.EVENTS) private readonly client: ClientProxy,
    private readonly idempotency: IdempotencyService,
    private readonly config: ConfigService,
  ) {
    this.maxRetries = Number(this.config.get('PUBLISH_MAX_RETRIES', 5));
    this.retryDelayMs = Number(this.config.get('PUBLISH_RETRY_DELAY_MS', 500));
  }

  async onModuleInit(): Promise<void> {
    await this.client.connect();
    this.logger.log('RabbitMQ producer client connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.close();
  }

  async publish(dto: PublishEventDto): Promise<PublishOutcome> {
    const clientProvidedId = dto.eventId !== undefined;
    const eventId = dto.eventId ?? randomUUID();
    const fingerprint = clientProvidedId
      ? this.idempotency.fingerprint({ eventType: dto.eventType, payload: dto.payload })
      : null;

    let acquiredLock = false;
    if (clientProvidedId && fingerprint) {
      const cached = await this.idempotency.acquire<PublishOutcome>(eventId, fingerprint);
      if (cached) return cached;
      acquiredLock = true;
    }

    const message: EventMessage = {
      eventId,
      eventType: dto.eventType,
      payload: dto.payload,
      occurredAt: new Date().toISOString(),
    };

    try {
      await lastValueFrom(
        this.client.emit(MESSAGE_PATTERNS.EVENT_CREATED, message).pipe(
          retryWithBackoff({
            count: this.maxRetries,
            baseDelayMs: this.retryDelayMs,
            onRetry: (error, attempt, delayMs) => {
              const reason = (error as Error)?.message ?? String(error);
              this.logger.warn(
                `Publish attempt ${attempt}/${this.maxRetries} failed for eventId=${eventId}: ${reason}. Retrying in ${delayMs}ms`,
              );
            },
          }),
        ),
      );
    } catch (error) {
      this.logger.error(
        `Failed to publish event eventId=${eventId} after ${this.maxRetries} retries`,
        error instanceof Error ? error.stack : undefined,
      );
      if (acquiredLock) await this.idempotency.release(eventId);
      throw new ServiceUnavailableException('Message broker is unavailable');
    }

    this.logger.log(`Published event eventId=${eventId} type=${message.eventType}`);
    const outcome: PublishOutcome = { eventId, eventType: message.eventType };
    if (acquiredLock && fingerprint) {
      await this.idempotency.commit(eventId, fingerprint, outcome);
    }
    return outcome;
  }
}
