import { Test } from '@nestjs/testing';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';

describe('EventsController', () => {
  let controller: EventsController;
  let service: { publish: jest.Mock };

  beforeEach(async () => {
    service = { publish: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      controllers: [EventsController],
      providers: [{ provide: EventsService, useValue: service }],
    }).compile();
    controller = moduleRef.get(EventsController);
  });

  it('returns acceptance with the resolved eventId', async () => {
    service.publish.mockResolvedValue({ eventId: 'uuid-1', eventType: 'user.signup' });
    const result = await controller.publish({
      eventType: 'user.signup',
      payload: { id: 1 },
    });
    expect(result).toEqual({
      accepted: true,
      eventId: 'uuid-1',
      eventType: 'user.signup',
    });
    expect(service.publish).toHaveBeenCalledTimes(1);
  });

  it('returns identical body when service replays a cached outcome', async () => {
    service.publish.mockResolvedValue({ eventId: 'fixed', eventType: 'x' });
    const result = await controller.publish({ eventId: 'fixed', eventType: 'x', payload: {} });
    expect(result).toEqual({ accepted: true, eventId: 'fixed', eventType: 'x' });
  });
});
