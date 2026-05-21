import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
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
  ) { }

  // CONNECT GOOGLE
  async connectGoogle(userId: string, code: string) {
    try {
      const tokens = await this.googleProvider.exchangeCodeForTokens(code);
      console.log('GOOGLE TOKENS:', tokens);
      return await this.tokenModel.findOneAndUpdate(
        { userId, provider: 'google' },
        {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiryDate: tokens.expiry_date
            ? new Date(tokens.expiry_date)
            : new Date(Date.now() + 3600 * 1000),
        },
        { upsert: true, new: true },
      );
    } catch (error) {
      console.error('GOOGLE CONNECT ERROR:', error);

      // Check if we already have a valid token for this user (handles duplicate StrictMode requests)
      const existingToken = await this.tokenModel.findOne({ userId, provider: 'google' });
      if (existingToken && existingToken.refreshToken) {
        console.log('Using existing Google Calendar token after duplicate code exchange attempt.');
        return existingToken;
      }

      throw error;
    }
  }

  // SYNC CALENDAR EVENTS
  async syncCalendar(userId: string) {
    const token = await this.tokenModel.findOne({ userId });

    if (!token) {
      return { message: 'No calendar connected' };
    }

    // Check if token is expired (or close to it)
    if (token.expiryDate.getTime() < Date.now() + 60000) {
      if (token.refreshToken) {
        try {
          const credentials = await this.googleProvider.refreshTokens(token.refreshToken);
          token.accessToken = credentials.access_token!;
          if (credentials.expiry_date) {
            token.expiryDate = new Date(credentials.expiry_date);
          }
          await token.save();
        } catch (error: any) {
          console.error('Failed to refresh Google token:', error);
          const errorMsg = error.response?.data?.error || error.message || '';
          const isAuthError =
            errorMsg.includes('invalid_grant') ||
            error.status === 400 ||
            error.status === 401 ||
            error.response?.status === 400 ||
            error.response?.status === 401;

          if (isAuthError) {
            await this.tokenModel.deleteOne({ userId });
            throw new UnauthorizedException(
              'Google Calendar connection has been revoked or expired. Please reconnect.',
            );
          }
          throw error;
        }
      } else {
        return { message: 'Token expired and no refresh token available' };
      }
    }

    try {
      const events = await this.googleProvider.fetchEvents(token.accessToken);
      //  PIPELINE STEP
      return this.ingestionService.ingestGoogleEvents(userId, events);
    } catch (error: any) {
      console.error('Failed to fetch Google events:', error);
      const errorMsg = error.response?.data?.error || error.message || '';
      const isAuthError =
        errorMsg.includes('invalid_grant') ||
        error.status === 400 ||
        error.status === 401 ||
        error.response?.status === 400 ||
        error.response?.status === 401;

      if (isAuthError) {
        await this.tokenModel.deleteOne({ userId });
        throw new UnauthorizedException(
          'Google Calendar connection has been revoked or expired. Please reconnect.',
        );
      }
      throw error;
    }
  }

  // STORED EVENTS
  async getStoredEvents(userId: string) {
    const token = await this.tokenModel.findOne({ userId });
    if (!token) {
      throw new NotFoundException('No calendar connected');
    }
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
