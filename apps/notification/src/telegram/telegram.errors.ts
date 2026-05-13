import { AxiosError } from 'axios';

export class TelegramPermanentError extends Error {
  readonly errorCode?: number;
  readonly description: string;

  constructor(description: string, errorCode?: number) {
    super(
      `Telegram permanent error${errorCode !== undefined ? ` ${errorCode}` : ''}: ${description}`,
    );
    this.name = 'TelegramPermanentError';
    this.errorCode = errorCode;
    this.description = description;
  }
}

export class TelegramTransientError extends Error {
  readonly errorCode?: number;
  readonly description: string;
  readonly retryAfterSec?: number;

  constructor(description: string, errorCode?: number, retryAfterSec?: number) {
    super(
      `Telegram transient error${errorCode !== undefined ? ` ${errorCode}` : ''}: ${description}`,
    );
    this.name = 'TelegramTransientError';
    this.errorCode = errorCode;
    this.description = description;
    this.retryAfterSec = retryAfterSec;
  }
}

interface TelegramErrorBody {
  ok?: boolean;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

export function classifyAxiosError(
  err: AxiosError,
): TelegramPermanentError | TelegramTransientError {
  const status = err.response?.status;
  const body = err.response?.data as TelegramErrorBody | undefined;
  const errorCode = body?.error_code ?? status;
  const description = body?.description ?? err.message;
  const retryAfter = body?.parameters?.retry_after;

  if (!err.response) {
    return new TelegramTransientError(description, errorCode);
  }

  if (
    status === 408 ||
    status === 409 ||
    status === 429 ||
    (status !== undefined && status >= 500)
  ) {
    return new TelegramTransientError(description, errorCode, retryAfter);
  }

  if (status !== undefined && status >= 400 && status < 500) {
    return new TelegramPermanentError(description, errorCode);
  }

  return new TelegramTransientError(description, errorCode);
}
