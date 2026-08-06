import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Meeting, MeetingSchema } from '../meetings/schemas/meeting.schema';
import { User, UserSchema } from '../users/users.schema';
import { MailModule } from '../mail/mail.module';
import { HttpModule } from '@nestjs/axios';
import { BotService } from './bot.service';
import { BotController } from './bot.controller';
import { BotActionController } from './bot.action.controller';
import { JwtCommonModule } from 'src/common/jwt.module';
import { JwtGuard } from 'src/common/guards/jwt.guard';

import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [
    HttpModule,
    MailModule,
    JwtCommonModule,
    forwardRef(() => RealtimeModule),
    MongooseModule.forFeature([
      { name: Meeting.name, schema: MeetingSchema },
      { name: User.name, schema: UserSchema },
    ]),
  ],
  providers: [BotService, JwtGuard],
  controllers: [BotController, BotActionController],
  exports: [BotService],
})
export class BotModule { }
