import { MonoTypeOperatorFunction, timer } from 'rxjs';
import { retry } from 'rxjs/operators';

export interface RetryWithBackoffOptions {
  count: number;
  baseDelayMs: number;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

export function retryWithBackoff<T>(opts: RetryWithBackoffOptions): MonoTypeOperatorFunction<T> {
  return retry<T>({
    count: opts.count,
    delay: (error, attempt) => {
      const delayMs = opts.baseDelayMs * Math.pow(2, attempt - 1);
      opts.onRetry?.(error, attempt, delayMs);
      return timer(delayMs);
    },
  });
}
