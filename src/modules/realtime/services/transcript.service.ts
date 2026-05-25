import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { MeetingTranscript } from '../schemas/meeting-transcript.schema';

@Injectable()
export class TranscriptService {
  constructor(
    @InjectModel(MeetingTranscript.name)
    private transcriptModel: Model<MeetingTranscript>,
  ) {}

  /**
   * Save a transcript segment
   */
  async saveTranscript(
    roomId: string,
    userId: string,
    userName: string,
    text: string,
  ) {
    return this.transcriptModel.create({
      roomId,
      userId,
      userName,
      text,
      timestamp: new Date(),
    });
  }

  /**
   * Get all transcripts for a room ordered by timestamp
   */
  async getTranscripts(roomId: string) {
    return this.transcriptModel
      .find({ roomId })
      .sort({ timestamp: 1 })
      .exec();
  }

  /**
   * Delete all transcripts for a room (cleanup)
   */
  async deleteTranscripts(roomId: string) {
    return this.transcriptModel.deleteMany({ roomId });
  }
}
