import { IsString, IsIn, IsOptional, IsObject } from 'class-validator';

export class ProduceDto {
  @IsString()
  roomId!: string;

  @IsString()
  transportId!: string;

  @IsIn(['audio', 'video'])
  kind!: 'audio' | 'video';

  // RtpParameters from mediasoup-client — complex object
  rtpParameters!: any;

  @IsOptional()
  @IsObject()
  appData?: Record<string, any>;
}

export class CloseProducerDto {
  @IsString()
  roomId!: string;

  @IsString()
  producerId!: string;
}

export class PauseResumeProducerDto {
  @IsString()
  roomId!: string;

  @IsString()
  producerId!: string;
}
