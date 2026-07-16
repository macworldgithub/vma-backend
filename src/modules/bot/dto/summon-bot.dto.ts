import { IsString, IsUrl, IsNotEmpty } from 'class-validator';

export class SummonBotDto {
  @IsString()
  @IsNotEmpty()
  title: string;

  @IsUrl()
  @IsNotEmpty()
  meetingLink: string;

  @IsString()
  @IsNotEmpty()
  platform: string; // teams, zoom, google
}
