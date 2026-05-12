import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsNumber, IsDateString, Min, Max } from 'class-validator';

export class CreateMeetingDto {
  @ApiProperty({ example: 'Team Standup', description: 'Meeting title' })
  @IsString()
  title!: string;

  @ApiProperty({
    example: '2026-05-12T10:00:00.000Z',
    required: false,
    description: 'Scheduled start time (omit for instant meeting)',
  })
  @IsOptional()
  @IsDateString()
  scheduledStart?: string;

  @ApiProperty({
    example: '2026-05-12T11:00:00.000Z',
    required: false,
    description: 'Scheduled end time',
  })
  @IsOptional()
  @IsDateString()
  scheduledEnd?: string;

  @ApiProperty({
    example: 10,
    required: false,
    default: 10,
    description: 'Maximum number of participants',
  })
  @IsOptional()
  @IsNumber()
  @Min(2)
  @Max(50)
  maxParticipants?: number;
}
