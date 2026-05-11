import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class ConnectGoogleDto {
  @ApiProperty()
  @IsString()
  code!: string;
}