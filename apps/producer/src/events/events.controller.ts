import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PublishEventDto } from '@app/common';
import { EventsService } from './events.service';

@ApiTags('events')
@Controller('events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Publish a domain event to the message broker' })
  @ApiResponse({
    status: HttpStatus.ACCEPTED,
    description: 'Event accepted for publishing',
    schema: {
      example: {
        accepted: true,
        eventId: '550e8400-e29b-41d4-a716-446655440000',
        eventType: 'user.signup',
      },
    },
  })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Validation failed' })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'eventId was already used for a different request',
  })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description:
      'Broker unavailable after retries, or timed out waiting for an in-flight duplicate',
  })
  async publish(@Body() dto: PublishEventDto) {
    const outcome = await this.eventsService.publish(dto);
    return { accepted: true, ...outcome };
  }
}
