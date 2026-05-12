import { IsString, IsObject } from 'class-validator';

export class SignalDto {
  @IsString()
  roomId!: string;

  @IsString()
  targetUserId!: string;

  @IsObject()
  signal!: any;
}