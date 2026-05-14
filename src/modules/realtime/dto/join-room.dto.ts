import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsBoolean } from 'class-validator';

export class JoinRoomDto {
  @ApiProperty()
  @IsString()
  roomId!: string;

  @ApiProperty()
  @IsString()
  userId!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  userName?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  audioEnabled?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  videoEnabled?: boolean;
}