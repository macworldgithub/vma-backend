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

      // 🔍 1. Check if already exists
      const existing = await this.meetingModel.findOne({
        externalEventId: event.id,
        provider: 'google',
        createdBy: userId,
      });

      // 🧠 2. Normalize event → Meeting format
      const meetingData = {
        title: event.summary || 'Untitled Meeting',
        platform: 'google',
        meetingLink: event.hangoutLink || '',
        startTime: event.start?.dateTime || event.start?.date,
        endTime: event.end?.dateTime || event.end?.date,
        createdBy: userId,
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

    return {
      ingested: results.length,
      meetings: results,
    };
  }

  async getMeetingsForUser(userId: string) {
    return this.meetingModel.find({
      createdBy: userId,
      source: 'calendar',
    }).sort({ startTime: -1 });
  }
}