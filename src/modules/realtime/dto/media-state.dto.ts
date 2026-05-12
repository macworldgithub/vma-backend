import { IsString, IsBoolean, IsOptional } from 'class-validator';

export class MediaStateDto {
  @IsString()
  roomId!: string;

  @IsOptional()
  @IsBoolean()
  audioEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  videoEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  screenSharing?: boolean;
}
