import { IsString } from 'class-validator';

export class ConsumeDto {
  @IsString()
  roomId!: string;

  @IsString()
  producerId!: string;

  // RtpCapabilities from mediasoup-client Device — complex object
  rtpCapabilities!: any;
}

export class ResumeConsumerDto {
  @IsString()
  roomId!: string;

  @IsString()
  consumerId!: string;
}
