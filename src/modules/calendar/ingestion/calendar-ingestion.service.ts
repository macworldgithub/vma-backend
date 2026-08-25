import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Meeting } from 'src/modules/meetings/schemas/meeting.schema';

@Injectable()
export class CalendarIngestionService {
  private readonly logger = new Logger(CalendarIngestionService.name);

  constructor(
    @InjectModel(Meeting.name)
    private meetingModel: Model<Meeting>,
  ) {}

  async ingestGoogleEvents(userId: string, events: any[]) {
    if (!events || events.length === 0) {
      return { ingested: 0, meetings: [] };
    }

    const validEvents = events.filter((e) => !!e.id);

    const bulkOps = validEvents.map((event) => {
      const rawLink =
        event.hangoutLink ||
        event.conferenceData?.entryPoints?.find((ep) => ep.type === 'video')?.uri ||
        event.conferenceData?.entryPoints?.[0]?.uri ||
        (this.isValidUrl(event.location) ? event.location : '') ||
        this.extractUrl(event.description) ||
        this.findAnyMeetLink(event) ||
        event.htmlLink ||
        '';

      const meetingData = {
        title: event.summary || 'Untitled Meeting',
        platform: this.detectPlatform(rawLink, 'google'),
        meetingLink: rawLink,
        startTime: event.start?.dateTime || event.start?.date,
        endTime: event.end?.dateTime || event.end?.date,
        createdBy: userId,
        hostId: userId,
        participants: event.attendees?.map((a) => a.email) || [],
        externalEventId: event.id,
        source: 'calendar',
        provider: 'google',
        lastSyncedAt: new Date(),
      };

      return {
        updateOne: {
          filter: { externalEventId: event.id, provider: 'google', createdBy: userId },
          update: {
            $set: meetingData,
            $setOnInsert: { botStatus: 'none', recallBotId: null },
          },
          upsert: true,
        },
      };
    });

    if (bulkOps.length > 0) {
      await this.meetingModel.bulkWrite(bulkOps as any[], { ordered: false });
    }

    // Delete stale events outside the incoming set
    const incomingIds = validEvents.map((e) => e.id);
    const syncStartTime = new Date();
    syncStartTime.setDate(syncStartTime.getDate() - 30);
    syncStartTime.setHours(0, 0, 0, 0);

    await this.meetingModel.deleteMany({
      createdBy: userId,
      provider: 'google',
      source: 'calendar',
      startTime: { $gte: syncStartTime },
      ...(incomingIds.length > 0 ? { externalEventId: { $nin: incomingIds } } : {}),
    });

    this.logger.log(`Google calendar sync: upserted ${bulkOps.length} events for userId=${userId}`);
    return { ingested: bulkOps.length };
  }

  async ingestMicrosoftEvents(userId: string, events: any[]) {
    if (!events || events.length === 0) {
      return { ingested: 0, meetings: [] };
    }

    const validEvents = events.filter((e) => !!e.id);

    const parseMSDate = (dateObj: any) => {
      if (!dateObj) return undefined;
      if (dateObj.dateTime) {
        const dt = dateObj.dateTime;
        if (dt.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(dt)) {
          return new Date(dt);
        }
        return new Date(dt + 'Z');
      }
      return dateObj.date ? new Date(dateObj.date) : undefined;
    };

    const bulkOps = validEvents.map((event) => {
      const rawLink = (
        event.onlineMeetingUrl ||
        event.onlineMeeting?.joinUrl ||
        (this.isValidUrl(event.location?.displayName) ? event.location.displayName : '') ||
        this.extractUrl(event.body?.content) ||
        this.findAnyMeetLink(event) ||
        ''
      ).replace(/&amp;/g, '&').replace(/[\r\n\t]/g, '').trim();

      const meetingData = {
        title: event.subject || 'Untitled Meeting',
        platform: this.detectPlatform(rawLink, 'teams'),
        meetingLink: rawLink,
        startTime: parseMSDate(event.start),
        endTime: parseMSDate(event.end),
        createdBy: userId,
        hostId: userId,
        organizerEmail: event.organizer?.emailAddress?.address,
        organizerName: event.organizer?.emailAddress?.name,
        participants:
          event.attendees?.map((a: any) => a.emailAddress?.address).filter(Boolean) || [],
        externalEventId: event.id,
        source: 'calendar',
        provider: 'microsoft',
        lastSyncedAt: new Date(),
      };

      return {
        updateOne: {
          filter: { externalEventId: event.id, provider: 'microsoft', createdBy: userId },
          update: {
            $set: meetingData,
            $setOnInsert: { botStatus: 'none', recallBotId: null },
          },
          upsert: true,
        },
      };
    });

    if (bulkOps.length > 0) {
      await this.meetingModel.bulkWrite(bulkOps as any[], { ordered: false });
    }

    // Delete stale events outside the incoming set
    const incomingIds = validEvents.map((e) => e.id);
    const syncStartTime = new Date();
    syncStartTime.setDate(syncStartTime.getDate() - 30);
    syncStartTime.setHours(0, 0, 0, 0);

    await this.meetingModel.deleteMany({
      createdBy: userId,
      provider: 'microsoft',
      source: 'calendar',
      startTime: { $gte: syncStartTime },
      ...(incomingIds.length > 0 ? { externalEventId: { $nin: incomingIds } } : {}),
    });

    this.logger.log(`Microsoft calendar sync: upserted ${bulkOps.length} events for userId=${userId}`);
    return { ingested: bulkOps.length };
  }

  async getMeetingsForUser(userId: string) {
    const now = new Date();

    return this.meetingModel
      .find({
        createdBy: userId,
        source: 'calendar',
        $or: [{ endTime: { $gte: now } }, { startTime: { $gte: now } }],
      })
      .sort({ startTime: 1 });
  }

  async clearCalendarEvents(userId: string, provider: string) {
    await this.meetingModel.deleteMany({
      createdBy: userId,
      provider: provider,
      source: 'calendar',
    });
    this.logger.log(`Cleared all synced calendar events for userId=${userId}, provider=${provider}`);
  }

  private isValidUrl(text: string): boolean {
    if (!text) return false;
    try {
      new URL(text);
      return true;
    } catch {
      return false;
    }
  }

  private extractUrl(text: string): string | null {
    if (!text) return null;
    const urlRegex = /(https?:\/\/[^\s"'<>]+)/g;
    const match = text.match(urlRegex);
    return match ? match[0].replace(/&amp;/g, '&') : null;
  }

  private findAnyMeetLink(event: any): string | null {
    const str = JSON.stringify(event);
    const match = str.match(/https:\/\/(meet\.google\.com|zoom\.us|teams\.microsoft\.com|teams\.live\.com)\/[^\s"'\\]+/);
    return match ? match[0].replace(/&amp;/g, '&') : null;
  }

  private detectPlatform(link: string, defaultPlatform = 'google'): string {
    if (!link) return defaultPlatform;
    const lowerLink = link.toLowerCase();
    if (lowerLink.includes('teams.microsoft.com') || lowerLink.includes('teams.live.com')) return 'teams';
    if (lowerLink.includes('zoom.us')) return 'zoom';
    if (lowerLink.includes('meet.google.com')) return 'google';
    return defaultPlatform;
  }
}