import { IsString, IsObject, IsIn } from 'class-validator';

export class SignalDto {
  @IsString()
  roomId!: string;

  @IsString()
  targetSocketId!: string;

  @IsIn(['offer', 'answer', 'ice-candidate'])
  type!: 'offer' | 'answer' | 'ice-candidate';

  @IsObject()
  signal!: any; // RTCSessionDescription or RTCIceCandidate
}