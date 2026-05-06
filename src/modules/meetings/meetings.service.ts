import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Meeting } from './schemas/meeting.schema';

@Injectable()
export class MeetingsService {
  constructor(@InjectModel(Meeting.name) private model: Model<Meeting>) {}

  async ingestMeeting(dto: any, userId: string) {
    return this.model.create({
      ...dto,
      createdBy: userId,
      status: 'SCHEDULED',
      source: 'calendar',
    });
  }

  async getUserMeetings(userId: string) {
    return this.model.find({ createdBy: userId });
  }

  async getAllMeetings() {
    return this.model.find();
  }

  async getById(id: string) {
    return this.model.findById(id);
  }
}
