import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { MeetingChat } from '../schemas/meeting-chat.schema';

@Injectable()
export class ChatService {
  constructor(
    @InjectModel(MeetingChat.name)
    private chatModel: Model<MeetingChat>,
  ) {}

  /**
   * Save a chat message
   */
  async saveMessage(
    roomId: string,
    userId: string,
    userName: string,
    message: string,
  ) {
    return this.chatModel.create({
      roomId,
      userId,
      userName,
      message,
      sentAt: new Date(),
    });
  }

  /**
   * Get all chat messages for a room
   */
  async getMessages(roomId: string) {
    return this.chatModel
      .find({ roomId })
      .sort({ sentAt: 1 })
      .exec();
  }

  /**
   * Delete all chat messages for a room (cleanup)
   */
  async deleteMessages(roomId: string) {
    return this.chatModel.deleteMany({ roomId });
  }
}
