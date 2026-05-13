import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { Meeting, MeetingSchema } from '../meetings/schemas/meeting.schema';
import { User, UserSchema } from '../users/users.schema';
import { Room, RoomSchema } from '../realtime/schemas/room.schema';
import { JwtCommonModule } from 'src/common/jwt.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Meeting.name, schema: MeetingSchema },
      { name: User.name, schema: UserSchema },
      { name: Room.name, schema: RoomSchema },
    ]),
    JwtCommonModule,
  ],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
