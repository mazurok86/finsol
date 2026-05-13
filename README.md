# Finsol — NestJS + RabbitMQ + Telegram microservices

Монорепо из трёх сервисов на NestJS, общающихся через RabbitMQ. Producer принимает HTTP-события и идемпотентно публикует их в брокер, Consumer форвардит в очередь уведомлений, Notification отправляет сообщения в Telegram.

## Архитектура

| Сервис         | Тип             | Назначение                                                                     |
| -------------- | --------------- | ------------------------------------------------------------------------------ |
| `producer`     | HTTP API        | Принимает события (`POST /events`), идемпотентно публикует в RabbitMQ с retry  |
| `consumer`     | RMQ subscriber  | Читает из `events_queue`, форвардит в `notifications_queue`                    |
| `notification` | RMQ subscriber  | Читает из `notifications_queue`, отправляет сообщение в Telegram               |

Принципы:
- **Строгая идемпотентность на границе запроса** (Stripe-style):
  - Тот же `eventId` + тот же payload → идентичное тело ответа, ровно одно сообщение в брокере. Concurrent-запрос дожидается результата первого через короткий polling и отдаёт тот же body.
  - Тот же `eventId` + другой payload → `409 Conflict` (защита от повторного использования id для другой операции).
  - Реализация: атомарный `SET NX` с зашитым SHA-256 хэшем канонизированного payload'а → publish → перезапись `{ status: 'done', requestHash, response }` в Redis (TTL по умолчанию 24ч).
- **Подтверждение доставки** — `noAck: false` + ручной `channel.ack()`, persistent messages, durable queues.
- **Ретраи** — общий RxJS-оператор `retryWithBackoff` (см. ниже) у producer'а, отдельный backoff в consumer'е через re-publish с `retryCount`, в notification — поверх axios с классификацией ошибок Telegram (permanent/transient).
- **Идемпотентный ключ — клиентский, не серверный.** Если клиент не передал `eventId`, producer сгенерирует UUID; повторы такого вызова уникальны и не дедуплицируются.

## Структура репозитория

```
apps/
  producer/        # HTTP + Swagger, публикация в RMQ + Redis-идемпотентность
  consumer/        # RMQ-handler, форвардинг
  notification/    # RMQ-handler, Telegram Bot API
libs/
  common/          # @app/common — DTO, интерфейсы, константы, RxJS-оператор retryWithBackoff
docker-compose.yml
.env.example
```

## Быстрый старт через Docker

1. Скопируйте переменные окружения:
   ```bash
   cp .env.example .env
   ```
2. Заполните `TELEGRAM_BOT_TOKEN` (получить у [@BotFather](https://t.me/BotFather)) и `TELEGRAM_CHAT_ID` (узнать через [@userinfobot](https://t.me/userinfobot)).

   > ⚠️ После создания бота **обязательно напишите ему `/start`** с того аккаунта, на чей `TELEGRAM_CHAT_ID` будут идти уведомления. Telegram запрещает ботам писать первым.
3. Поднимите весь стек:
   ```bash
   docker compose up --build
   ```
4. Проверьте, что всё поднялось:
   - RabbitMQ UI: http://localhost:15672 (guest/guest)
   - Swagger: http://localhost:3000/api
5. Отправьте тестовое событие:
   ```bash
   curl -X POST http://localhost:3000/events \
     -H 'Content-Type: application/json' \
     -d '{"eventType":"user.signup","payload":{"userId":42,"email":"a@b.co"}}'
   ```
   В Telegram прилетит сообщение от бота.
6. (Опционально) Проверьте идемпотентность — повторный запрос с тем же `eventId` и payload вернёт идентичный ответ и не отправит второе сообщение:
   ```bash
   curl -X POST http://localhost:3000/events \
     -H 'Content-Type: application/json' \
     -d '{"eventId":"550e8400-e29b-41d4-a716-446655440000","eventType":"user.signup","payload":{"userId":42}}'
   # повтор — то же тело, новой записи в Telegram не будет
   curl -X POST http://localhost:3000/events \
     -H 'Content-Type: application/json' \
     -d '{"eventId":"550e8400-e29b-41d4-a716-446655440000","eventType":"user.signup","payload":{"userId":42}}'
   # тот же id, но другой payload → 409 Conflict
   curl -X POST http://localhost:3000/events \
     -H 'Content-Type: application/json' \
     -d '{"eventId":"550e8400-e29b-41d4-a716-446655440000","eventType":"user.signup","payload":{"userId":99}}'
   ```

## Локальный запуск без Docker

Требуется Node.js 22+, RabbitMQ и Redis (можно поднять только их: `docker compose up rabbitmq redis`).

```bash
npm ci
cp .env.example .env
# при локальном запуске поправьте hostname:
#   RABBITMQ_URL=amqp://guest:guest@localhost:5672
#   REDIS_HOST=localhost

# в трёх отдельных терминалах:
npm run start:producer
npm run start:consumer
npm run start:notification
```

## API

### `POST /events`

Тело запроса:

```json
{
  "eventType": "user.signup",
  "payload": { "userId": 42, "email": "a@b.co" },
  "eventId": "550e8400-e29b-41d4-a716-446655440000"
}
```

`eventId` опционален: если не передан, сервер сгенерирует UUID. Передача того же `eventId` повторно — безопасна: producer вернёт идентичное тело и не отправит второе сообщение в брокер.

Ответ (`202 Accepted`):

```json
{
  "accepted": true,
  "eventId": "550e8400-e29b-41d4-a716-446655440000",
  "eventType": "user.signup"
}
```

Коды ответов:

| Код   | Когда                                                                                              |
| ----- | -------------------------------------------------------------------------------------------------- |
| `202` | Событие принято и опубликовано в брокер (либо отдан кэш для повторного `eventId` с тем же payload) |
| `400` | Валидация не прошла (пустой `eventType`, лишние поля и т.п.)                                       |
| `409` | Тот же `eventId` уже использовался для другого payload                                             |
| `503` | Брокер недоступен после ретраев или таймаут ожидания concurrent-запроса                            |

Полная схема — в Swagger по адресу `http://localhost:3000/api`.

## Тесты

```bash
npm test                # все unit-тесты
npm run test:cov        # с покрытием
npm run test:e2e        # e2e на producer HTTP
```

## Переменные окружения

| Переменная                     | Назначение                                          | Default                            |
| ------------------------------ | --------------------------------------------------- | ---------------------------------- |
| `PRODUCER_HTTP_PORT`           | Порт HTTP API producer'а                            | `3000`                             |
| `RABBITMQ_URL`                 | URL подключения к RabbitMQ                          | `amqp://guest:guest@rabbitmq:5672` |
| `RABBITMQ_EVENTS_QUEUE`        | Очередь событий                                     | `events_queue`                     |
| `RABBITMQ_NOTIFICATIONS_QUEUE` | Очередь уведомлений                                 | `notifications_queue`              |
| `PUBLISH_MAX_RETRIES`          | Кол-во ретраев publish в producer'е                 | `5`                                |
| `PUBLISH_RETRY_DELAY_MS`       | Базовая задержка ретрая (экспоненциальная)          | `500`                              |
| `CONSUMER_MAX_RETRIES`         | Кол-во ретраев обработки в consumer'е               | `3`                                |
| `CONSUMER_RETRY_DELAY_MS`      | Базовая задержка между ретраями                     | `1000`                             |
| `NOTIFICATION_MAX_RETRIES`     | Кол-во попыток отправки в Telegram                  | `3`                                |
| `NOTIFICATION_RETRY_DELAY_MS`  | Базовая задержка между ретраями отправки            | `1000`                             |
| `REDIS_HOST` / `REDIS_PORT`    | Подключение к Redis                                 | `redis` / `6379`                   |
| `PRODUCER_IDEMPOTENCY_TTL_SEC` | TTL ответа в Redis после успешной публикации        | `86400`                            |
| `PRODUCER_IDEMPOTENCY_WAIT_TIMEOUT_MS` | Сколько ждать concurrent-запрос с тем же eventId | `10000`                          |
| `PRODUCER_IDEMPOTENCY_POLL_INTERVAL_MS` | Период polling Redis при ожидании             | `100`                              |
| `TELEGRAM_BOT_TOKEN`           | Токен бота от BotFather                             | —                                  |
| `TELEGRAM_CHAT_ID`             | ID чата для уведомлений                             | —                                  |
| `TELEGRAM_API_URL`             | Базовый URL Telegram Bot API                        | `https://api.telegram.org`         |

## Ограничения и направления развития

- Retry в consumer'е и notification использует `setTimeout` + re-publish в исходную очередь. Минус — сообщения, висящие в in-memory таймере на момент SIGTERM, теряются. В продакшене предпочтительнее DLX с TTL (отдельная queue с `x-message-ttl` и `x-dead-letter-exchange`).
- Graceful shutdown включён (`app.enableShutdownHooks()` во всех трёх `main.ts`) — `OnModuleDestroy` корректно закроет Redis и ClientProxy при SIGTERM.
- Идемпотентность строгая: `SET NX` placeholder с хэшем payload + polling. Concurrent с тем же payload дожидается результата (timeout `PRODUCER_IDEMPOTENCY_WAIT_TIMEOUT_MS`) и получает идентичное тело; concurrent с другим payload — сразу `409 Conflict`. Lock TTL 60s (на случай краша producer'а до финальной записи).
- Telegram-чат фиксированный (через env).
