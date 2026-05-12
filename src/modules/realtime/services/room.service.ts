import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Room } from '../schemas/room.schema';
import { randomUUID } from 'crypto';

@Injectable()
export class RoomService {
  constructor(
    @InjectModel(Room.name)
    private roomModel: Model<Room>,
  ) {}

  async createRoom(userId: string) {
    const roomId = randomUUID();

    const room = await this.roomModel.create({
      roomId,
      createdBy: userId,
      participants: [userId],
    });

    return {
      roomId,
      joinUrl: `http://localhost:5000/meeting/${roomId}`,
      room,
    };
  }

  async joinRoom(roomId: string, userId: string) {
    const room = await this.roomModel.findOne({ roomId });

    if (!room) {
      throw new Error('Room not found');
    }

    if (!room.participants.includes(userId)) {
      room.participants.push(userId);
      await room.save();
    }

    return room;
  }

  async leaveRoom(roomId: string, userId: string) {
    const room = await this.roomModel.findOne({ roomId });

    if (!room) return;

    room.participants = room.participants.filter(
      (p) => p !== userId,
    );

    await room.save();
  }
}