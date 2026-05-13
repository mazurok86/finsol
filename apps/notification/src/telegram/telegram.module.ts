import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { TelegramController } from './telegram.controller';
import { TelegramService } from './telegram.service';

@Module({
  imports: [
    HttpModule.register({
      timeout: 10000,
      maxRedirects: 2,
    }),
  ],
  controllers: [TelegramController],
  providers: [TelegramService],
})
export class TelegramModule {}
