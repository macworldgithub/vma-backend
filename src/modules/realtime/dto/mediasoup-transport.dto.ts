import { IsString, IsIn } from 'class-validator';

export class CreateTransportDto {
  @IsString()
  roomId!: string;

  @IsIn(['send', 'recv'])
  direction!: 'send' | 'recv';
}

export class ConnectTransportDto {
  @IsString()
  roomId!: string;

  @IsString()
  transportId!: string;

  // DtlsParameters from mediasoup-client — complex object, validated at runtime
  dtlsParameters!: any;
}
