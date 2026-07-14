import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';
import {
  CalendarToken,
  CalendarTokenSchema,
} from './schemas/calendar-token.schema';
import { GoogleCalendarProvider } from './providers/google-calendar.provider';
import { MicrosoftCalendarProvider } from './providers/microsoft-calendar.provider';
import { AuthModule } from '../auth/auth.module';
import { CalendarIngestionService } from './ingestion/calendar-ingestion.service';
import { Meeting, MeetingSchema } from '../meetings/schemas/meeting.schema';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CalendarToken.name, schema: CalendarTokenSchema },
      { name: Meeting.name, schema: MeetingSchema },
    ]),
    AuthModule,
    UsersModule,
  ],
  controllers: [CalendarController],
  providers: [
    CalendarService,
    GoogleCalendarProvider,
    MicrosoftCalendarProvider,
    CalendarIngestionService,
  ],
})
export class CalendarModule { }