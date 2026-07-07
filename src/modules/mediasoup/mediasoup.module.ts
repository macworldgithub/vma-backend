import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MediasoupService } from './mediasoup.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [MediasoupService],
  exports: [MediasoupService],
})
export class MediasoupModule {}
