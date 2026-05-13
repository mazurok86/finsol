import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { createHash } from 'node:crypto';
import { REDIS_CLIENT } from './idempotency.tokens';

interface PendingEntry {
  status: 'pending';
  requestHash: string;
}

interface DoneEntry<T> {
  status: 'done';
  requestHash: string;
  response: T;
}

type Entry<T> = PendingEntry | DoneEntry<T>;

const KEY_PREFIX = 'idemp:producer:';
const LOCK_TTL_SEC = 60;

/**
 * Stripe-style idempotency store: claim → wait/replay → commit → release.
 * On replay verifies that the stored request fingerprint matches the new
 * one; mismatched fingerprint means the same id is reused for a different
 * operation, which surfaces as ConflictException.
 */
@Injectable()
export class IdempotencyService implements OnModuleDestroy {
  private readonly logger = new Logger(IdempotencyService.name);
  private readonly resultTtlSec: number;
  private readonly waitTimeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: ConfigService,
  ) {
    this.resultTtlSec = Number(this.config.get('PRODUCER_IDEMPOTENCY_TTL_SEC', 86400));
    this.waitTimeoutMs = Number(this.config.get('PRODUCER_IDEMPOTENCY_WAIT_TIMEOUT_MS', 10000));
    this.pollIntervalMs = Number(this.config.get('PRODUCER_IDEMPOTENCY_POLL_INTERVAL_MS', 100));
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }

  fingerprint(value: unknown): string {
    return createHash('sha256')
      .update(JSON.stringify(this.canonicalize(value)))
      .digest('hex');
  }

  /**
   * Tries to claim the key for a fresh request. Returns:
   *   - null  → caller acquired the lock and must proceed with the operation,
   *             then call `commit`/`release`.
   *   - T     → the same request has been completed before; replay this body.
   *
   * Throws ConflictException if the id was used for a different request,
   * ServiceUnavailableException on timeout / corrupt state.
   */
  async acquire<T>(id: string, fingerprint: string): Promise<T | null> {
    const key = this.keyFor(id);
    const placeholder: PendingEntry = { status: 'pending', requestHash: fingerprint };
    const claimed = await this.redis.set(
      key,
      JSON.stringify(placeholder),
      'EX',
      LOCK_TTL_SEC,
      'NX',
    );
    if (claimed === 'OK') return null;
    return this.waitForResult<T>(id, key, fingerprint);
  }

  async commit<T>(id: string, fingerprint: string, response: T): Promise<void> {
    const entry: DoneEntry<T> = { status: 'done', requestHash: fingerprint, response };
    await this.redis.set(this.keyFor(id), JSON.stringify(entry), 'EX', this.resultTtlSec);
  }

  async release(id: string): Promise<void> {
    await this.redis.del(this.keyFor(id));
  }

  private async waitForResult<T>(id: string, key: string, expectedHash: string): Promise<T> {
    const deadline = Date.now() + this.waitTimeoutMs;
    while (Date.now() < deadline) {
      const raw = await this.redis.get(key);
      if (raw === null) {
        throw new ServiceUnavailableException(`In-flight request for eventId=${id} disappeared`);
      }
      const entry = this.parseEntry<T>(raw);
      if (!entry) {
        throw new ServiceUnavailableException(`Corrupt idempotency state for eventId=${id}`);
      }
      if (entry.requestHash !== expectedHash) {
        throw new ConflictException(`eventId=${id} was already used for a different request`);
      }
      if (entry.status === 'done') {
        this.logger.log(`Replaying stored result for eventId=${id}`);
        return entry.response;
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
    throw new ServiceUnavailableException(
      `Timed out waiting for in-flight request with eventId=${id}`,
    );
  }

  private parseEntry<T>(raw: string): Entry<T> | null {
    try {
      const parsed = JSON.parse(raw) as Entry<T>;
      if (
        (parsed.status === 'pending' || parsed.status === 'done') &&
        typeof parsed.requestHash === 'string'
      ) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  private canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((v) => this.canonicalize(v));
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      const sortedKeys = Object.keys(obj).sort();
      const result: Record<string, unknown> = {};
      for (const k of sortedKeys) result[k] = this.canonicalize(obj[k]);
      return result;
    }
    return value;
  }

  private keyFor(id: string): string {
    return `${KEY_PREFIX}${id}`;
  }
}
