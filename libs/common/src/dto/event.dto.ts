import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class PublishEventDto {
  @ApiProperty({
    example: 'user.signup',
    description: 'Domain event type — controls routing and notification text',
    minLength: 1,
    maxLength: 128,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  eventType!: string;

  @ApiProperty({
    example: { userId: 42, email: 'a@b.co' },
    description: 'Arbitrary JSON payload describing the event',
  })
  @IsObject()
  payload!: Record<string, unknown>;

  @ApiPropertyOptional({
    example: '550e8400-e29b-41d4-a716-446655440000',
    description: 'Optional client-supplied UUID for idempotency. If omitted, server generates one.',
  })
  @IsOptional()
  @IsString()
  eventId?: string;
}
