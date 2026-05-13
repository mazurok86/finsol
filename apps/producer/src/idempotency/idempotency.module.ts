import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { IdempotencyService } from './idempotency.service';
import { REDIS_CLIENT } from './idempotency.tokens';

@Module({
  imports: [ConfigModule],
  providers: [
    IdempotencyService,
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Redis({
          host: config.get<string>('REDIS_HOST', 'localhost'),
          port: Number(config.get<number>('REDIS_PORT', 6379)),
          lazyConnect: false,
          maxRetriesPerRequest: 3,
        }),
    },
  ],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}
