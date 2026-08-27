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
        'openid',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/calendar.readonly',
        'https://www.googleapis.com/auth/calendar.events.readonly'
      ],
      prompt: 'consent',
      state: userId,
    });
  }

  // 🔑 EXCHANGE CODE FOR TOKENS
  async exchangeCodeForTokens(code: string) {
    const { tokens } = await this.oauthClient.getToken(code);
    this.oauthClient.setCredentials(tokens);

    let googleEmail: string | undefined = undefined;
    try {
      const oauth2 = google.oauth2({ version: 'v2', auth: this.oauthClient });
      const userInfo = await oauth2.userinfo.get();
      googleEmail = userInfo.data.email || undefined;
    } catch (_) {
      if (tokens.id_token) {
        try {
          const parts = tokens.id_token.split('.');
          if (parts.length === 3) {
            const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
            googleEmail = payload.email || undefined;
          }
        } catch (e) {}
      }
    }

    return { ...tokens, googleEmail };
  }

  //  FETCH EVENTS
  async fetchEvents(accessToken: string) {
    this.oauthClient.setCredentials({ access_token: accessToken });

    const calendar = google.calendar({
      version: 'v3',
      auth: this.oauthClient,
    });

    const startOfRange = new Date();
    startOfRange.setDate(startOfRange.getDate() - 14);
    startOfRange.setHours(0, 0, 0, 0);

    const endOfRange = new Date();
    endOfRange.setDate(endOfRange.getDate() + 30);

    let allEvents: any[] = [];
    let pageToken = undefined;

    do {
      const res: any = await calendar.events.list({
        calendarId: 'primary',
        timeMin: startOfRange.toISOString(),
        timeMax: endOfRange.toISOString(),
        maxResults: 250,
        singleEvents: true,
        orderBy: 'startTime',
        conferenceDataVersion: 1,
        pageToken: pageToken,
      } as any);

      if (res.data.items) {
        allEvents = allEvents.concat(res.data.items);
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken);

    return allEvents;
  }

  async refreshTokens(refreshToken: string) {
    this.oauthClient.setCredentials({ refresh_token: refreshToken });
    const { credentials } = await this.oauthClient.refreshAccessToken();
    return credentials;
  }
}
