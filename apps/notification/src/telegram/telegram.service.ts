import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosError } from 'axios';
import { lastValueFrom, throwError, timer } from 'rxjs';
import { catchError, retry } from 'rxjs/operators';
import { NotificationMessage } from '@app/common';
import {
  TelegramPermanentError,
  TelegramTransientError,
  classifyAxiosError,
} from './telegram.errors';

@Injectable()
export class TelegramService implements OnModuleInit {
  private readonly logger = new Logger(TelegramService.name);
  private botToken!: string;
  private chatId!: string;
  private apiUrl!: string;

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    const chatId = this.config.get<string>('TELEGRAM_CHAT_ID');
    if (!token || !chatId) {
      this.logger.warn(
        'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not set — Telegram delivery will fail',
      );
    }
    this.botToken = token ?? '';
    this.chatId = chatId ?? '';
    this.apiUrl = this.config.get<string>('TELEGRAM_API_URL', 'https://api.telegram.org');
  }

  async sendMessage(notification: NotificationMessage): Promise<void> {
    if (!this.botToken || !this.chatId) {
      throw new TelegramPermanentError('Telegram bot is not configured');
    }

    const url = `${this.apiUrl}/bot${this.botToken}/sendMessage`;
    const text = this.formatText(notification);

    await lastValueFrom(
      this.http
        .post(url, {
          chat_id: this.chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        })
        .pipe(
          retry({
            count: 2,
            delay: (err, attempt) => {
              const classified =
                err instanceof TelegramPermanentError || err instanceof TelegramTransientError
                  ? err
                  : classifyAxiosError(err as AxiosError);
              if (classified instanceof TelegramPermanentError) {
                return throwError(() => classified);
              }
              if (classified.retryAfterSec) {
                return timer(classified.retryAfterSec * 1000);
              }
              return timer(500 * Math.pow(2, attempt - 1));
            },
          }),
          catchError((err: unknown) => {
            if (err instanceof TelegramPermanentError || err instanceof TelegramTransientError) {
              return throwError(() => err);
            }
            return throwError(() => classifyAxiosError(err as AxiosError));
          }),
        ),
    );
  }

  private formatText(n: NotificationMessage): string {
    return [
      `<b>${this.escapeHtml(n.eventType)}</b>`,
      `<i>${this.escapeHtml(n.occurredAt)}</i>`,
      '',
      this.escapeHtml(n.text),
    ].join('\n');
  }

  private escapeHtml(input: string): string {
    return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
