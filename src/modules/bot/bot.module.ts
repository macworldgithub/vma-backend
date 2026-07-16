import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Meeting, MeetingSchema } from '../meetings/schemas/meeting.schema';
import { User, UserSchema } from '../users/users.schema';
import { MailModule } from '../mail/mail.module';
import { HttpModule } from '@nestjs/axios';
import { BotService } from './bot.service';
import { BotController } from './bot.controller';
import { BotActionController } from './bot.action.controller';

@Module({
  imports: [
    HttpModule,
    MailModule,
    MongooseModule.forFeature([
      { name: Meeting.name, schema: MeetingSchema },
      { name: User.name, schema: UserSchema },
    ]),
  ],
  providers: [BotService],
  controllers: [BotController, BotActionController],
})
export class BotModule { }
