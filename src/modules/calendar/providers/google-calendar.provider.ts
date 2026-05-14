import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google } from 'googleapis';

@Injectable()
export class GoogleCalendarProvider {
  private oauthClient;

  constructor(private readonly config: ConfigService) {
    this.oauthClient = new google.auth.OAuth2(
      this.config.get<string>('GOOGLE_CLIENT_ID'),
      this.config.get<string>('GOOGLE_CLIENT_SECRET'),
      this.config.get<string>('GOOGLE_REDIRECT_URI'),
    );
  }

  // 🔗 GET AUTH URL (frontend uses this)
  getAuthUrl(userId: string) {
    return this.oauthClient.generateAuthUrl({
      access_type: 'offline',
      scope: [
        'https://www.googleapis.com/auth/calendar.readonly',
        'https://www.googleapis.com/auth/calendar.events.readonly'
      ],
      prompt: 'consent',
      state: userId,
    });
  }

  //  EXCHANGE CODE FOR TOKENS
  async exchangeCodeForTokens(code: string) {
    const { tokens } = await this.oauthClient.getToken(code);
    return tokens;
  }

  //  FETCH EVENTS
  async fetchEvents(accessToken: string) {
    this.oauthClient.setCredentials({ access_token: accessToken });

    const calendar = google.calendar({
      version: 'v3',
      auth: this.oauthClient,
    });

    const res: any = await calendar.events.list({
      calendarId: 'primary',
      timeMin: new Date().toISOString(),
      maxResults: 50,
      singleEvents: true,
      orderBy: 'startTime',
      conferenceDataVersion: 1,
    } as any);

    return res.data.items || [];
  }

  async refreshTokens(refreshToken: string) {
    this.oauthClient.setCredentials({ refresh_token: refreshToken });
    const { credentials } = await this.oauthClient.refreshAccessToken();
    return credentials;
  }
}
