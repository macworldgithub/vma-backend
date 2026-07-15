import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConfidentialClientApplication } from '@azure/msal-node';
import 'isomorphic-fetch';
import { Client } from '@microsoft/microsoft-graph-client';

export interface MicrosoftTokenResult {
  accessToken: string;
  refreshToken?: string;
  expiresOn: Date | null;
  /** The email (UPN) of the Microsoft account that actually authenticated */
  microsoftEmail?: string;
  /** The Object ID (oid) of the Microsoft account that actually authenticated */
  microsoftUserId?: string;
}

@Injectable()
export class MicrosoftCalendarProvider {
  private msalClient: ConfidentialClientApplication;
  private readonly logger = new Logger(MicrosoftCalendarProvider.name);

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
      this.logger.error('Error extracting refresh token from MSAL cache:', e);
    }
    return undefined;
  }

  /**
   * Decode the payload of a JWT without verifying the signature.
   * We only need the claims (upn, oid, unique_name) for identity tracking.
   */
  private decodeJwtPayload(token: string): Record<string, any> | null {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
      return JSON.parse(payload);
    } catch (e) {
      this.logger.warn('Failed to decode JWT payload:', e);
      return null;
    }
  }

  // 🔗 GET AUTH URL (frontend uses this)
  // loginHint pre-fills the Microsoft sign-in page with the expected user email
  getAuthUrl(userId: string, loginHint?: string) {
    const clientId = this.config.get<string>('MICROSOFT_CLIENT_ID') || process.env.MICROSOFT_CLIENT_ID!;
    const redirectUri = this.config.get<string>('MICROSOFT_REDIRECT_URI') || process.env.MICROSOFT_REDIRECT_URI!;
    
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      response_mode: 'query',
      scope: 'offline_access User.Read Calendars.Read OnlineMeetings.Read',
      state: userId,
      prompt: 'select_account',
    });

    // Pre-fill the login prompt with the user's email so they don't
    // accidentally sign in with a different (e.g. admin) account
    if (loginHint) {
      params.set('login_hint', loginHint);
    }

    return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`;
  }

  //  EXCHANGE CODE FOR TOKENS
  async exchangeCodeForTokens(code: string): Promise<MicrosoftTokenResult> {
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

    // Extract the actual Microsoft identity from the access token
    const claims = this.decodeJwtPayload(tokenResponse.accessToken);
    const microsoftEmail = tokenResponse.account?.username || claims?.upn || claims?.unique_name || claims?.preferred_username || undefined;
    const microsoftUserId = tokenResponse.account?.homeAccountId || claims?.oid || undefined;

    if (microsoftEmail) {
      this.logger.log(`Microsoft OAuth completed for: ${microsoftEmail} (oid: ${microsoftUserId})`);
    } else {
      this.logger.warn('Could not extract Microsoft email from access token claims');
    }

    return {
      accessToken: tokenResponse.accessToken,
      refreshToken: refreshToken,
      expiresOn: tokenResponse.expiresOn,
      microsoftEmail,
      microsoftUserId,
    };
  }

  //  REFRESH TOKENS
  async refreshTokens(refreshToken: string): Promise<MicrosoftTokenResult> {
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

    const claims = this.decodeJwtPayload(tokenResponse.accessToken);
    const microsoftEmail = tokenResponse.account?.username || claims?.upn || claims?.unique_name || claims?.preferred_username || undefined;
    const microsoftUserId = tokenResponse.account?.homeAccountId || claims?.oid || undefined;

    return {
      accessToken: tokenResponse.accessToken,
      refreshToken: newRefreshToken,
      expiresOn: tokenResponse.expiresOn,
      microsoftEmail,
      microsoftUserId,
    };
  }

  //  FETCH EVENTS
  async fetchEvents(accessToken: string) {
    const client = Client.init({
      authProvider: (done) => {
        done(null, accessToken);
      },
    });

    const startOfRange = new Date();
    startOfRange.setDate(startOfRange.getDate() - 30);
    startOfRange.setHours(0, 0, 0, 0);

    const endOfRange = new Date();
    endOfRange.setFullYear(endOfRange.getFullYear() + 1);

    let allEvents: any[] = [];
    
    let response = await client
      .api('/me/calendarView')
      .query({
        startDateTime: startOfRange.toISOString(),
        endDateTime: endOfRange.toISOString(),
      })
      .top(100)
      .orderby('start/dateTime')
      .get();

    if (response.value) {
      allEvents = allEvents.concat(response.value);
    }

    while (response['@odata.nextLink']) {
      response = await client.api(response['@odata.nextLink']).get();
      if (response.value) {
        allEvents = allEvents.concat(response.value);
      }
    }

    return allEvents;
  }
}