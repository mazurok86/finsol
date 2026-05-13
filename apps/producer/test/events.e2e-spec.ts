import { ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { of } from 'rxjs';
import { RMQ_CLIENTS } from '@app/common';
import { EventsModule } from '../src/events/events.module';
import { REDIS_CLIENT } from '../src/idempotency/idempotency.tokens';

function hashOf(eventType: string, payload: Record<string, unknown>): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(obj)
          .sort()
          .map((k) => [k, canonical(obj[k])]),
      );
    }
    return v;
  };
  return createHash('sha256')
    .update(JSON.stringify({ eventType, payload: canonical(payload) }))
    .digest('hex');
}

describe('Events HTTP API (e2e)', () => {
  let app!: INestApplication;
  const clientMock = {
    emit: jest.fn().mockReturnValue(of(true)),
    connect: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const redisMock = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    quit: jest.fn().mockResolvedValue('OK'),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), EventsModule],
    })
      .overrideProvider(RMQ_CLIENTS.EVENTS)
      .useValue(clientMock)
      .overrideProvider(REDIS_CLIENT)
      .useValue(redisMock)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('POST /events publishes valid event', async () => {
    const res = await request(app.getHttpServer())
      .post('/events')
      .send({ eventType: 'user.signup', payload: { id: 1 } })
      .expect(202);

    expect(res.body).toMatchObject({
      accepted: true,
      eventType: 'user.signup',
    });
    expect(res.body.eventId).toBeDefined();
    expect(clientMock.emit).toHaveBeenCalled();
  });

  it('POST /events replays identical body on duplicate eventId with same payload', async () => {
    const payload = { id: 1 };
    const hash = hashOf('user.signup', payload);
    redisMock.set.mockResolvedValueOnce(null);
    redisMock.get.mockResolvedValueOnce(
      JSON.stringify({
        status: 'done',
        requestHash: hash,
        response: { eventId: 'dup', eventType: 'user.signup' },
      }),
    );
    clientMock.emit.mockClear();

    const res = await request(app.getHttpServer())
      .post('/events')
      .send({ eventId: 'dup', eventType: 'user.signup', payload })
      .expect(202);

    expect(res.body).toEqual({
      accepted: true,
      eventId: 'dup',
      eventType: 'user.signup',
    });
    expect(clientMock.emit).not.toHaveBeenCalled();
  });

  it('POST /events returns 409 when same eventId carries a different payload', async () => {
    redisMock.set.mockResolvedValueOnce(null);
    redisMock.get.mockResolvedValueOnce(
      JSON.stringify({
        status: 'done',
        requestHash: 'previous-different-hash',
        response: { eventId: 'reused', eventType: 'user.signup' },
      }),
    );

    await request(app.getHttpServer())
      .post('/events')
      .send({ eventId: 'reused', eventType: 'user.signup', payload: { other: true } })
      .expect(409);
  });

  it('POST /events rejects payload missing required fields', async () => {
    await request(app.getHttpServer()).post('/events').send({ eventType: '' }).expect(400);
  });

  it('POST /events rejects extra fields', async () => {
    await request(app.getHttpServer())
      .post('/events')
      .send({ eventType: 't', payload: {}, hacker: true })
      .expect(400);
  });
});
