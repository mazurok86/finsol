import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Observable, defer, of, throwError } from 'rxjs';
import { AxiosError, AxiosResponse } from 'axios';
import { TelegramService } from './telegram.service';
import { TelegramPermanentError, TelegramTransientError } from './telegram.errors';

describe('TelegramService', () => {
  let service: TelegramService;
  let http: { post: jest.Mock };

  beforeEach(async () => {
    http = { post: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        TelegramService,
        { provide: HttpService, useValue: http },
        {
          provide: ConfigService,
          useValue: {
            get: (k: string, def?: unknown) => {
              const map: Record<string, unknown> = {
                TELEGRAM_BOT_TOKEN: 'token-xyz',
                TELEGRAM_CHAT_ID: '12345',
                TELEGRAM_API_URL: 'https://api.telegram.org',
              };
              return map[k] ?? def;
            },
          },
        },
      ],
    }).compile();
    service = moduleRef.get(TelegramService);
    service.onModuleInit();
  });

  const okResponse: AxiosResponse = {
    data: { ok: true },
    status: 200,
    statusText: 'OK',
    headers: {},
    config: {} as never,
  };

  function axiosError(status: number, body: unknown): AxiosError {
    const err = new Error(`HTTP ${status}`) as AxiosError;
    err.isAxiosError = true;
    err.response = {
      status,
      statusText: '',
      headers: {},
      config: {} as never,
      data: body,
    };
    return err;
  }

  /**
   * Wraps each subscription in a fresh defer() so retry's resubscribe is
   * observable as an incremented call count.
   */
  function mockSequence(...factories: Array<() => Observable<unknown>>) {
    let i = 0;
    const counter = { calls: 0 };
    http.post.mockImplementation(() =>
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

  it('calls Telegram Bot API with chat_id and formatted text', async () => {
    http.post.mockReturnValue(of(okResponse));

    await service.sendMessage({
      eventId: 'e-1',
      eventType: 'user.signup',
      text: 'hello',
      occurredAt: '2024-01-01T00:00:00Z',
    });

    const [url, body] = http.post.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/bottoken-xyz/sendMessage');
    expect(body.chat_id).toBe('12345');
    expect(body.text).toContain('user.signup');
    expect(body.text).toContain('hello');
  });

  it('escapes HTML special characters in user-provided text', async () => {
    http.post.mockReturnValue(of(okResponse));
    await service.sendMessage({
      eventId: 'e-2',
      eventType: 'a<b>',
      text: 'x & y < z',
      occurredAt: 'now',
    });
    const body = http.post.mock.calls[0][1];
    expect(body.text).toContain('a&lt;b&gt;');
    expect(body.text).toContain('x &amp; y &lt; z');
  });

  it('retries on transient errors before succeeding', async () => {
    const counter = mockSequence(
      () => throwError(() => new Error('net')),
      () => of(okResponse),
    );
    await service.sendMessage({
      eventId: 'e-3',
      eventType: 't',
      text: 't',
      occurredAt: 'now',
    });
    expect(counter.calls).toBe(2);
  });

  it('throws TelegramTransientError on persistent 5xx after exhausting retries', async () => {
    const counter = mockSequence(() => throwError(() => axiosError(500, { description: 'oops' })));
    await expect(
      service.sendMessage({ eventId: 'e-4', eventType: 't', text: 't', occurredAt: 'now' }),
    ).rejects.toBeInstanceOf(TelegramTransientError);
    // 1 initial + 2 retries
    expect(counter.calls).toBe(3);
  });

  it('does not retry on permanent 400 chat not found', async () => {
    const counter = mockSequence(() =>
      throwError(() =>
        axiosError(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' }),
      ),
    );
    await expect(
      service.sendMessage({ eventId: 'e-5', eventType: 't', text: 't', occurredAt: 'now' }),
    ).rejects.toBeInstanceOf(TelegramPermanentError);
    expect(counter.calls).toBe(1);
  });

  it('does not retry on permanent 403 bot blocked', async () => {
    const counter = mockSequence(() =>
      throwError(() =>
        axiosError(403, { ok: false, error_code: 403, description: 'Forbidden: bot was blocked' }),
      ),
    );
    await expect(
      service.sendMessage({ eventId: 'e-6', eventType: 't', text: 't', occurredAt: 'now' }),
    ).rejects.toBeInstanceOf(TelegramPermanentError);
    expect(counter.calls).toBe(1);
  });

  it('throws TelegramTransientError with retryAfterSec on 429', async () => {
    mockSequence(() =>
      throwError(() =>
        axiosError(429, {
          ok: false,
          error_code: 429,
          description: 'Too Many Requests',
          parameters: { retry_after: 1 },
        }),
      ),
    );
    try {
      await service.sendMessage({
        eventId: 'e-7',
        eventType: 't',
        text: 't',
        occurredAt: 'now',
      });
      fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TelegramTransientError);
      expect((err as TelegramTransientError).retryAfterSec).toBe(1);
    }
  }, 15000);

  it('throws TelegramPermanentError when bot is not configured', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        TelegramService,
        { provide: HttpService, useValue: http },
        {
          provide: ConfigService,
          useValue: { get: (_: string, def?: unknown) => def },
        },
      ],
    }).compile();
    const unconfigured = moduleRef.get(TelegramService);
    unconfigured.onModuleInit();
    await expect(
      unconfigured.sendMessage({
        eventId: 'e-8',
        eventType: 't',
        text: 't',
        occurredAt: 'now',
      }),
    ).rejects.toBeInstanceOf(TelegramPermanentError);
  });
});
