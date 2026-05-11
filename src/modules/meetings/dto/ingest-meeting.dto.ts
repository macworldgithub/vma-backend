import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsDateString, IsOptional } from 'class-validator';

export class IngestMeetingDto {
  @ApiProperty({
    example: 'Weekly Sync Meeting',
  })
  @IsString()
  title!: string;

  @ApiProperty({
    example: 'zoom',
  })
  @IsString()
  platform!: string;

  @ApiProperty({
    example: 'https://zoom.us/j/123456789',
  })
  @IsString()
  meetingLink!: string;

  @ApiProperty({
    example: '2026-05-06T10:00:00.000Z',
  })
  @IsDateString()
  startTime!: Date;

  @ApiProperty({
    example: '2026-05-06T11:00:00.000Z',
  })
  @IsDateString()
  endTime!: Date;

  @ApiProperty({
    required: false,
    example: 'google-event-id-123',
  })
  @IsOptional()
  @IsString()
  externalEventId?: string;
}
