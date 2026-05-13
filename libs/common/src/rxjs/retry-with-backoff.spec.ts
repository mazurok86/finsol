import { defer, lastValueFrom, of, throwError } from 'rxjs';
import { retryWithBackoff } from './retry-with-backoff';

describe('retryWithBackoff', () => {
  it('retries up to count and resolves on success', async () => {
    let attempts = 0;
    const source = defer(() => {
      attempts += 1;
      return attempts < 3 ? throwError(() => new Error('boom')) : of('ok');
    });

    await expect(
      lastValueFrom(source.pipe(retryWithBackoff({ count: 5, baseDelayMs: 1 }))),
    ).resolves.toBe('ok');
    expect(attempts).toBe(3);
  });

  it('rethrows after exhausting count', async () => {
    let attempts = 0;
    const source = defer(() => {
      attempts += 1;
      return throwError(() => new Error('boom'));
    });

    await expect(
      lastValueFrom(source.pipe(retryWithBackoff({ count: 2, baseDelayMs: 1 }))),
    ).rejects.toThrow('boom');
    // initial attempt + 2 retries
    expect(attempts).toBe(3);
  });

  it('reports each retry to onRetry with exponential delay', async () => {
    const onRetry = jest.fn();
    let attempts = 0;
    const source = defer(() => {
      attempts += 1;
      return attempts < 3 ? throwError(() => new Error('boom')) : of('ok');
    });

    await lastValueFrom(source.pipe(retryWithBackoff({ count: 5, baseDelayMs: 10, onRetry })));

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0]?.[1]).toBe(1);
    expect(onRetry.mock.calls[0]?.[2]).toBe(10);
    expect(onRetry.mock.calls[1]?.[1]).toBe(2);
    expect(onRetry.mock.calls[1]?.[2]).toBe(20);
  });
});
