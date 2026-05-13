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
    let token = await this.tokenModel.findOne({ userId });

    if (!token) {
      return { message: 'No calendar connected' };
    }

    // Check if token is expired (or close to it)
    if (token.expiryDate.getTime() < Date.now() + 60000) {
      if (token.refreshToken) {
        const credentials = await this.googleProvider.refreshTokens(token.refreshToken);
        token.accessToken = credentials.access_token!;
        if (credentials.expiry_date) {
          token.expiryDate = new Date(credentials.expiry_date);
        }
        await token.save();
      } else {
        return { message: 'Token expired and no refresh token available' };
      }
    }

    const events = await this.googleProvider.fetchEvents(token.accessToken);

    //  PIPELINE STEP
    return this.ingestionService.ingestGoogleEvents(userId, events);
  }

  // STORED EVENTS
  async getStoredEvents(userId: string) {
    const meetings = await this.ingestionService.getMeetingsForUser(userId);
    return {
      count: meetings.length,
      data: meetings,
    };
  }

  getGoogleAuthUrl(userId: string) {
    return {
      url: this.googleProvider.getAuthUrl(userId),
    };
  }
}
