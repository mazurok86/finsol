import { Controller } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import { EventMessage, MESSAGE_PATTERNS } from '@app/common';
import { EventsService } from './events.service';

@Controller()
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @EventPattern(MESSAGE_PATTERNS.EVENT_CREATED)
  async handleEvent(@Payload() data: EventMessage, @Ctx() context: RmqContext) {
    await this.eventsService.process(data, context);
  }
}
