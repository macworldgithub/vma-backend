import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { MeetingGateway } from './gateways/meeting.gateway';
import { RoomService } from './services/room.service';

import { Room, RoomSchema } from './schemas/room.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: Room.name,
        schema: RoomSchema,
      },
    ]),
  ],
  providers: [MeetingGateway, RoomService],
  exports: [RoomService],
})
export class RealtimeModule {}