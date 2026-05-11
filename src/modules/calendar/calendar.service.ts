import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CalendarToken } from './schemas/calendar-token.schema';
import { GoogleCalendarProvider } from './providers/google-calendar.provider';
import { calendar_v3 } from 'googleapis';
import { CalendarIngestionService } from './ingestion/calendar-ingestion.service';

@Injectable()
export class CalendarService {
  constructor(
    @InjectModel(CalendarToken.name)
    private tokenModel: Model<CalendarToken>,
    private googleProvider: GoogleCalendarProvider,
    private ingestionService: CalendarIngestionService,
  ) {}

  // CONNECT GOOGLE
  async connectGoogle(userId: string, code: string) {
    try {
      const tokens = await this.googleProvider.exchangeCodeForTokens(code);
      console.log('GOOGLE TOKENS:', tokens);
      return this.tokenModel.create({
        userId,
        provider: 'google',
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiryDate: tokens.expiry_date
          ? new Date(tokens.expiry_date)
          : new Date(Date.now() + 3600 * 1000),
      });
    } catch (error) {
      console.error('GOOGLE CONNECT ERROR:', error); 

      throw error;
    }
  }

  // SYNC CALENDAR EVENTS
  async syncCalendar(userId: string) {
  const token = await this.tokenModel.findOne({ userId });

  if (!token) {
    return { message: 'No calendar connected' };
  }

  const events = await this.googleProvider.fetchEvents(token.accessToken);

  //  PIPELINE STEP
  return this.ingestionService.ingestGoogleEvents(userId, events);
}

  // STORED EVENTS (later connect to Meeting schema)
  async getStoredEvents(userId: string) {
    return {
      message: 'Connect to Meeting collection later',
      data: [],
    };
  }

  getGoogleAuthUrl(userId: string) {
    return {
      url: this.googleProvider.getAuthUrl(userId),
    };
  }
}
