import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CalendarToken } from './schemas/calendar-token.schema';
import { GoogleCalendarProvider } from './providers/google-calendar.provider';
import { MicrosoftCalendarProvider } from './providers/microsoft-calendar.provider';
import { CalendarIngestionService } from './ingestion/calendar-ingestion.service';
import { UsersService } from '../users/users.service';
import { BotService } from '../bot/bot.service';

@Injectable()
export class CalendarService {
  private readonly logger = new Logger(CalendarService.name);

  constructor(
    @InjectModel(CalendarToken.name)
    private tokenModel: Model<CalendarToken>,
    private googleProvider: GoogleCalendarProvider,
    private microsoftProvider: MicrosoftCalendarProvider,
    private ingestionService: CalendarIngestionService,
    private usersService: UsersService,
    private botService: BotService,
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

  // CONNECT MICROSOFT
  async connectMicrosoft(userId: string, code: string) {
    let tokenDoc;
    try {
      const tokens = await this.microsoftProvider.exchangeCodeForTokens(code);
      this.logger.log(`MICROSOFT TOKENS received for userId=${userId}`);

      // --- Identity mismatch detection ---
      // Look up the VMA user to compare emails
      const vmaUser = await this.usersService.findById(userId);
      if (vmaUser && tokens.microsoftEmail) {
        const vmaEmail = vmaUser.email.toLowerCase().trim();
        const msEmail = tokens.microsoftEmail.toLowerCase().trim();

        if (vmaEmail !== msEmail) {
          this.logger.warn(
            `⚠️  MICROSOFT IDENTITY MISMATCH DETECTED!\n` +
            `   VMA User: ${vmaUser.name} (${vmaEmail})\n` +
            `   Microsoft Account: ${msEmail}\n` +
            `   The calendar will sync events from the Microsoft account (${msEmail}),\n` +
            `   NOT from the VMA user's expected mailbox (${vmaEmail}).`
          );
        }
      }

      tokenDoc = await this.tokenModel.findOneAndUpdate(
        { userId, provider: 'microsoft' },
        {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken || undefined,
          expiryDate: tokens.expiresOn
            ? new Date(tokens.expiresOn)
            : new Date(Date.now() + 3600 * 1000),
          microsoftEmail: tokens.microsoftEmail,
          microsoftUserId: tokens.microsoftUserId,
        },
        { upsert: true, new: true },
      );
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }

      console.error('MICROSOFT CONNECT ERROR:', error);

      // Check if we already have a valid token for this user
      const existingToken = await this.tokenModel.findOne({ userId, provider: 'microsoft' });
      if (existingToken) {
        console.log('Using existing Microsoft Calendar token after duplicate code exchange attempt.');
        tokenDoc = existingToken;
      } else {
        throw error;
      }
    }

    // Trigger immediate calendar sync so meetings are available on dashboard
    try {
      await this.syncCalendar(userId);
    } catch (syncErr) {
      this.logger.error(`Initial sync after Microsoft connect failed for userId=${userId}:`, syncErr);
    }

    return tokenDoc;
  }

  // SYNC CALENDAR EVENTS
  async syncCalendar(userId: string) {
    const tokens = await this.tokenModel.find({ userId });

    if (!tokens || tokens.length === 0) {
      return [];
    }

    const results: any[] = [];

    for (const token of tokens) {
      if (token.provider === 'google') {
        try {
          let currentAccessToken = token.accessToken;
          if (token.expiryDate.getTime() < Date.now() + 60000) {
            if (token.refreshToken) {
              const credentials = await this.googleProvider.refreshTokens(token.refreshToken);
              currentAccessToken = credentials.access_token!;
              token.accessToken = currentAccessToken;
              if (credentials.expiry_date) {
                token.expiryDate = new Date(credentials.expiry_date);
              }
              await token.save();
            } else {
              results.push({ provider: 'google', status: 'error', error: 'Token expired and no refresh token available' });
              continue;
            }
          }

          const events = await this.googleProvider.fetchEvents(currentAccessToken);
          const ingestResult = await this.ingestionService.ingestGoogleEvents(userId, events);
          results.push({ provider: 'google', status: 'success', ...ingestResult });
        } catch (error: any) {
          console.error('Failed to sync Google calendar:', error);
          const errorMsg = error.response?.data?.error || error.message || '';
          const isAuthError =
            errorMsg.includes('invalid_grant') ||
            error.status === 400 ||
            error.status === 401 ||
            error.response?.status === 400 ||
            error.response?.status === 401;

          if (isAuthError) {
            await this.tokenModel.deleteOne({ userId, provider: 'google' });
          }
          results.push({ provider: 'google', status: 'error', error: error.message });
        }
      } else if (token.provider === 'microsoft') {
        try {
          let currentAccessToken = token.accessToken;
          if (token.expiryDate.getTime() < Date.now() + 60000) {
            if (token.refreshToken) {
              const credentials = await this.microsoftProvider.refreshTokens(token.refreshToken);

              // Identity Safety Guard: Detect if refreshed token belongs to a different Microsoft account
              if (
                token.microsoftEmail &&
                credentials.microsoftEmail &&
                token.microsoftEmail.toLowerCase().trim() !== credentials.microsoftEmail.toLowerCase().trim()
              ) {
                this.logger.error(
                  `⚠️ MICROSOFT TOKEN IDENTITY MISMATCH on refresh for userId=${userId}!\n` +
                  ` Stored Microsoft Email: ${token.microsoftEmail}\n` +
                  ` Refreshed Token Email: ${credentials.microsoftEmail}\n` +
                  ` Deleting corrupted token document and clearing synced events.`
                );
                await this.tokenModel.deleteOne({ _id: token._id });
                await this.ingestionService.clearCalendarEvents(userId, 'microsoft');
                results.push({
                  provider: 'microsoft',
                  status: 'error',
                  error: 'Token identity mismatch detected. Corrupted token removed. Please reconnect Microsoft Calendar.',
                });
                continue;
              }

              currentAccessToken = credentials.accessToken!;
              token.accessToken = currentAccessToken;
              if (credentials.refreshToken) {
                token.refreshToken = credentials.refreshToken;
              }
              if (credentials.expiresOn) {
                token.expiryDate = new Date(credentials.expiresOn);
              } else {
                token.expiryDate = new Date(Date.now() + 3600 * 1000);
              }
              // IMPORTANT: Never overwrite microsoftEmail/microsoftUserId once set.
              // The MSAL singleton cache is shared across all users and can return
              // a different user's identity during refresh, causing email swap bugs.
              // The identity established at first OAuth connection is the source of truth.
              if (!token.microsoftEmail && credentials.microsoftEmail) {
                token.microsoftEmail = credentials.microsoftEmail;
              }
              if (!token.microsoftUserId && credentials.microsoftUserId) {
                token.microsoftUserId = credentials.microsoftUserId;
              }
              await token.save();
            } else {
              results.push({ provider: 'microsoft', status: 'error', error: 'Token expired and no refresh token available' });
              continue;
            }
          }

          // Log which Microsoft account is being used for sync
          if (token.microsoftEmail) {
            this.logger.log(`Syncing Microsoft calendar for VMA userId=${userId}, Microsoft account=${token.microsoftEmail}`);
          }

          const events = await this.microsoftProvider.fetchEvents(currentAccessToken);
          const ingestResult = await this.ingestionService.ingestMicrosoftEvents(userId, events);
          results.push({
            provider: 'microsoft',
            status: 'success',
            microsoftAccount: token.microsoftEmail || 'unknown',
            ...ingestResult,
          });
        } catch (error: any) {
          console.error('Failed to sync Microsoft calendar:', error);
          const errorMsg = error.message || '';
          const isAuthError =
            errorMsg.includes('invalid_grant') ||
            errorMsg.includes('Expired') ||
            error.status === 400 ||
            error.status === 401 ||
            error.statusCode === 400 ||
            error.statusCode === 401;

          if (isAuthError) {
            await this.tokenModel.deleteOne({ userId, provider: 'microsoft' });
            await this.ingestionService.clearCalendarEvents(userId, 'microsoft');
          }
          results.push({ provider: 'microsoft', status: 'error', error: error.message });
        }
      }
    }

    // Trigger instant auto-deploy for any newly synced upcoming or live meetings
    try {
      await this.botService.checkUpcomingMeetings();
    } catch (botErr: any) {
      this.logger.error(`Auto-deploy bot after calendar sync failed for userId=${userId}:`, botErr);
    }

    return results;
  }

  // STORED EVENTS
  async getStoredEvents(userId: string) {
    const tokens = await this.tokenModel.find({ userId });
    if (!tokens || tokens.length === 0) {
      throw new NotFoundException('No calendar connected');
    }
    const meetings = await this.ingestionService.getMeetingsForUser(userId);
    return {
      count: meetings.length,
      data: meetings,
      connectedProviders: tokens.map((t) => ({
        provider: t.provider,
        microsoftAccount: t.provider === 'microsoft' ? t.microsoftEmail || 'unknown' : undefined,
      })),
    };
  }

  getGoogleAuthUrl(userId: string) {
    return {
      url: this.googleProvider.getAuthUrl(userId),
    };
  }

  async getMicrosoftAuthUrl(userId: string) {
    // Look up the VMA user's email to use as login_hint
    const user = await this.usersService.findById(userId);
    const loginHint = user?.email;

    return {
      url: this.microsoftProvider.getAuthUrl(userId, loginHint),
    };
  }

  // DISCONNECT CALENDAR
  async disconnectProvider(userId: string, provider: 'google' | 'microsoft') {
    const deleted = await this.tokenModel.deleteOne({ userId, provider });
    await this.ingestionService.clearCalendarEvents(userId, provider);
    return {
      status: 'success',
      message: `${provider} calendar disconnected and synced events cleared`,
      deletedCount: deleted.deletedCount,
    };
  }
}

