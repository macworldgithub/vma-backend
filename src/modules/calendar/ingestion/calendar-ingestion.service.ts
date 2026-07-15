import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Meeting } from 'src/modules/meetings/schemas/meeting.schema';

@Injectable()
export class CalendarIngestionService {
  constructor(
    @InjectModel(Meeting.name)
    private meetingModel: Model<Meeting>,
  ) {}

  async ingestGoogleEvents(userId: string, events: any[]) {
    const results: Meeting[] = [];

    for (const event of events) {
      if (!event.id) continue;

      console.log('DEBUG: RAW GOOGLE EVENT:', JSON.stringify(event, null, 2));

      // 🔍 1. Check if already exists
      const existing = await this.meetingModel.findOne({
        externalEventId: event.id,
        provider: 'google',
        createdBy: userId,
      });

      // 🧠 2. Normalize event → Meeting format
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

      let saved;

      // 🔄 3. UPSERT logic
      if (existing) {
        saved = await this.meetingModel.findByIdAndUpdate(
          existing._id,
          meetingData,
          { new: true },
        );
      } else {
        saved = await this.meetingModel.create(meetingData);
      }

      results.push(saved);
    }

    // 🗑 4. DELETE events that no longer exist in the provider
    // We only delete events that match the sync window (e.g., from 30 days ago)
    const incomingIds = events.map((e) => e.id).filter(Boolean);
    const syncStartTime = new Date();
    syncStartTime.setDate(syncStartTime.getDate() - 30);
    syncStartTime.setHours(0, 0, 0, 0);

    if (incomingIds.length > 0) {
      await this.meetingModel.deleteMany({
        createdBy: userId,
        provider: 'google',
        source: 'calendar',
        startTime: { $gte: syncStartTime },
        externalEventId: { $nin: incomingIds },
      });
    } else {
      // If no incoming events at all, but we fetched successfully, it means calendar is empty for this period
      await this.meetingModel.deleteMany({
        createdBy: userId,
        provider: 'google',
        source: 'calendar',
        startTime: { $gte: syncStartTime },
      });
    }

    return {
      ingested: results.length,
      meetings: results,
    };
  }

  async ingestMicrosoftEvents(userId: string, events: any[]) {
    const results: Meeting[] = [];

    for (const event of events) {
      if (!event.id) continue;

      console.log('DEBUG: RAW MICROSOFT EVENT:', JSON.stringify(event, null, 2));

      // 🔍 1. Check if already exists
      const existing = await this.meetingModel.findOne({
        externalEventId: event.id,
        provider: 'microsoft',
        createdBy: userId,
      });

      // 🧠 2. Normalize event → Meeting format
      const rawLink =
        event.onlineMeetingUrl ||
        event.onlineMeeting?.joinUrl ||
        (this.isValidUrl(event.location?.displayName) ? event.location.displayName : '') ||
        this.extractUrl(event.body?.content) ||
        this.findAnyMeetLink(event) ||
        '';

      const parseMSDate = (dateObj: any) => {
        if (!dateObj) return undefined;
        if (dateObj.dateTime) {
          const dt = dateObj.dateTime;
          return new Date(dt.endsWith('Z') ? dt : dt + 'Z');
        }
        return dateObj.date ? new Date(dateObj.date) : undefined;
      };

      const meetingData = {
        title: event.subject || 'Untitled Meeting',
        platform: this.detectPlatform(rawLink, 'teams'),
        meetingLink: rawLink,
        startTime: parseMSDate(event.start),
        endTime: parseMSDate(event.end),
        createdBy: userId,
        hostId: userId,
        participants: event.attendees?.map((a: any) => a.emailAddress?.address).filter(Boolean) || [],
        externalEventId: event.id,
        source: 'calendar',
        provider: 'microsoft',
        lastSyncedAt: new Date(),
      };

      let saved;

      // 🔄 3. UPSERT logic
      if (existing) {
        saved = await this.meetingModel.findByIdAndUpdate(
          existing._id,
          meetingData,
          { new: true },
        );
      } else {
        saved = await this.meetingModel.create(meetingData);
      }

      results.push(saved);
    }

    // 🗑 4. DELETE events that no longer exist in the provider
    const incomingIds = events.map((e) => e.id).filter(Boolean);
    const syncStartTime = new Date();
    syncStartTime.setDate(syncStartTime.getDate() - 30);
    syncStartTime.setHours(0, 0, 0, 0);

    if (incomingIds.length > 0) {
      await this.meetingModel.deleteMany({
        createdBy: userId,
        provider: 'microsoft',
        source: 'calendar',
        startTime: { $gte: syncStartTime },
        externalEventId: { $nin: incomingIds },
      });
    } else {
      await this.meetingModel.deleteMany({
        createdBy: userId,
        provider: 'microsoft',
        source: 'calendar',
        startTime: { $gte: syncStartTime },
      });
    }

    return {
      ingested: results.length,
      meetings: results,
    };
  }

  async getMeetingsForUser(userId: string) {
    const now = new Date();

    return this.meetingModel.find({
      createdBy: userId,
      source: 'calendar',
      $or: [
        { endTime: { $gte: now } },
        { startTime: { $gte: now } }
      ]
    }).sort({ startTime: 1 });
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
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const match = text.match(urlRegex);
    return match ? match[0] : null;
  }

  private findAnyMeetLink(event: any): string | null {
    const str = JSON.stringify(event);
    const match = str.match(/https:\/\/(meet\.google\.com|zoom\.us|teams\.microsoft\.com)\/[^\s"']+/);
    return match ? match[0] : null;
  }

  private detectPlatform(link: string, defaultPlatform = 'google'): string {
    if (!link) return defaultPlatform;
    const lowerLink = link.toLowerCase();
    if (lowerLink.includes('teams.microsoft.com')) return 'teams';
    if (lowerLink.includes('zoom.us')) return 'zoom';
    if (lowerLink.includes('meet.google.com')) return 'google';
    return defaultPlatform;
  }
}