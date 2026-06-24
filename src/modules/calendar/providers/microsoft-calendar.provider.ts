import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConfidentialClientApplication } from '@azure/msal-node';
import 'isomorphic-fetch';
import { Client } from '@microsoft/microsoft-graph-client';

@Injectable()
export class MicrosoftCalendarProvider {
  private msalClient: ConfidentialClientApplication;

  constructor(private config: ConfigService) {
    this.msalClient = new ConfidentialClientApplication({
      auth: {
        clientId: this.config.get<string>('MICROSOFT_CLIENT_ID') || process.env.MICROSOFT_CLIENT_ID!,
        clientSecret: this.config.get<string>('MICROSOFT_CLIENT_SECRET') || process.env.MICROSOFT_CLIENT_SECRET!,
        authority: `https://login.microsoftonline.com/${this.config.get<string>('MICROSOFT_TENANT_ID') || process.env.MICROSOFT_TENANT_ID || 'common'}`,
      },
    });
  }

  // Helper to extract refresh token from MSAL cache
  private getRefreshTokenFromCache(): string | undefined {
    try {
      const serialized = this.msalClient.getTokenCache().serialize();
      const cache = JSON.parse(serialized);
      if (cache.RefreshToken) {
        const keys = Object.keys(cache.RefreshToken);
        if (keys.length > 0) {
          return cache.RefreshToken[keys[0]].secret;
        }
      }
    } catch (e) {
      console.error('Error extracting refresh token from MSAL cache:', e);
    }
    return undefined;
  }

  // 🔗 GET AUTH URL (frontend uses this)
  getAuthUrl(userId: string) {
    const clientId = this.config.get<string>('MICROSOFT_CLIENT_ID') || process.env.MICROSOFT_CLIENT_ID!;
    const redirectUri = this.config.get<string>('MICROSOFT_REDIRECT_URI') || process.env.MICROSOFT_REDIRECT_URI!;
    
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      response_mode: 'query',
      scope: 'offline_access User.Read Calendars.Read OnlineMeetings.Read',
      state: userId,
    });

    return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`;
  }

  //  EXCHANGE CODE FOR TOKENS
  async exchangeCodeForTokens(code: string) {
    const redirectUri = this.config.get<string>('MICROSOFT_REDIRECT_URI') || process.env.MICROSOFT_REDIRECT_URI!;
    const tokenResponse = await this.msalClient.acquireTokenByCode({
      code,
      scopes: [
        'offline_access',
        'User.Read',
        'Calendars.Read',
        'OnlineMeetings.Read',
      ],
      redirectUri,
    });

    if (!tokenResponse) {
      throw new Error('Failed to exchange code for Microsoft tokens');
    }

    const refreshToken = this.getRefreshTokenFromCache();

    return {
      accessToken: tokenResponse.accessToken,
      refreshToken: refreshToken,
      expiresOn: tokenResponse.expiresOn,
    };
  }

  //  REFRESH TOKENS
  async refreshTokens(refreshToken: string) {
    const tokenResponse = await this.msalClient.acquireTokenByRefreshToken({
      refreshToken,
      scopes: [
        'offline_access',
        'User.Read',
        'Calendars.Read',
        'OnlineMeetings.Read',
      ],
    });

    if (!tokenResponse) {
      throw new Error('Failed to refresh Microsoft tokens');
    }

    const newRefreshToken = this.getRefreshTokenFromCache() || refreshToken;

    return {
      accessToken: tokenResponse.accessToken,
      refreshToken: newRefreshToken,
      expiresOn: tokenResponse.expiresOn,
    };
  }

  //  FETCH EVENTS
  async fetchEvents(accessToken: string) {
    const client = Client.init({
      authProvider: (done) => {
        done(null, accessToken);
      },
    });

    const events = await client
      .api('/me/events')
      .top(50)
      .orderby('start/dateTime')
      .get();

    return events.value || [];
  }
}