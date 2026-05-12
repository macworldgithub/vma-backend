import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { MeetingGateway } from './gateways/meeting.gateway';
import { RoomService } from './services/room.service';
import { ChatService } from './services/chat.service';

import { Room, RoomSchema } from './schemas/room.schema';
import { MeetingChat, MeetingChatSchema } from './schemas/meeting-chat.schema';
import { JwtCommonModule } from 'src/common/jwt.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Room.name, schema: RoomSchema },
      { name: MeetingChat.name, schema: MeetingChatSchema },
    ]),
    JwtCommonModule,
  ],
  providers: [MeetingGateway, RoomService, ChatService],
  exports: [RoomService, ChatService],
})
export class RealtimeModule {}