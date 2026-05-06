import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsDateString, IsOptional } from 'class-validator';

export class IngestMeetingDto {
  @ApiProperty()
  @IsString()
  title!: string;

  @ApiProperty()
  @IsString()
  platform!: string;

  @ApiProperty()
  @IsString()
  meetingLink!: string;

  @ApiProperty()
  @IsDateString()
  startTime!: Date;

  @ApiProperty()
  @IsDateString()
  endTime!: Date;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  externalEventId?: string;
}