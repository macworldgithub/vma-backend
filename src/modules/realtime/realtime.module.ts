import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule } from '@nestjs/config';

import { MeetingGateway } from './gateways/meeting.gateway';
import { RoomService } from './services/room.service';
import { ChatService } from './services/chat.service';
import { TranscriptService } from './services/transcript.service';
import { DeepgramService } from './services/deepgram.service';
import { MediasoupModule } from '../mediasoup/mediasoup.module';

import { Room, RoomSchema } from './schemas/room.schema';
import { MeetingChat, MeetingChatSchema } from './schemas/meeting-chat.schema';
import { MeetingTranscript, MeetingTranscriptSchema } from './schemas/meeting-transcript.schema';
import { Meeting, MeetingSchema } from '../meetings/schemas/meeting.schema';
import { JwtCommonModule } from 'src/common/jwt.module';

@Module({
  imports: [
    ConfigModule,
    MediasoupModule,
    MongooseModule.forFeature([
      { name: Room.name, schema: RoomSchema },
      { name: MeetingChat.name, schema: MeetingChatSchema },
      { name: MeetingTranscript.name, schema: MeetingTranscriptSchema },
      { name: Meeting.name, schema: MeetingSchema },
    ]),
    JwtCommonModule,
  ],
  providers: [MeetingGateway, RoomService, ChatService, TranscriptService, DeepgramService],
  exports: [RoomService, ChatService, TranscriptService, DeepgramService],
})
export class RealtimeModule {}
