import { IsString } from 'class-validator';

export class ChatMessageDto {
  @IsString()
  roomId!: string;

  @IsString()
  message!: string;
}
