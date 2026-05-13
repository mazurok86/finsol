import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { QUEUE_NAMES } from '@app/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const rabbitUrl = process.env.RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5672';
  const queue = process.env.RABBITMQ_EVENTS_QUEUE ?? QUEUE_NAMES.EVENTS;

  const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
    transport: Transport.RMQ,
    options: {
      urls: [rabbitUrl],
      queue,
      queueOptions: { durable: true },
      noAck: false,
      prefetchCount: 10,
    },
  });

  app.useGlobalPipes(new ValidationPipe({ transform: true }));
  app.enableShutdownHooks();

  await app.listen();
  Logger.log(`Consumer is listening on queue "${queue}"`, 'Bootstrap');
}

bootstrap();
