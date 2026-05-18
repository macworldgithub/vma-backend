import { Injectable, BadRequestException, ForbiddenException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Room, RoomStatus } from '../schemas/room.schema';
import { Meeting, MeetingStatus } from '../../meetings/schemas/meeting.schema';
import { randomUUID } from 'crypto';

@Injectable()
export class RoomService {
  constructor(
    @InjectModel(Room.name)
    private roomModel: Model<Room>,
    @InjectModel(Meeting.name)
    private meetingModel: Model<Meeting>,
  ) {}

  /**
   * Generate a short meeting code like "abc-defg-hij"
   */
  generateMeetingCode(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz';
    const seg = (len: number) =>
      Array.from({ length: len }, () =>
        chars.charAt(Math.floor(Math.random() * chars.length)),
      ).join('');
    return `${seg(3)}-${seg(4)}-${seg(3)}`;
  }

  /**
   * Create a new room linked to a meeting
   */
  async createRoom(
    meetingId: string,
    hostId: string,
    maxParticipants: number = 10,
  ) {
    const roomId = randomUUID();
    const meetingCode = this.generateMeetingCode();

    const room = await this.roomModel.create({
      roomId,
      meetingId,
      meetingCode,
      hostId,
      createdBy: hostId,
      participants: [],
      status: RoomStatus.WAITING,
      maxParticipants,
    });

    return room;
  }

  /**
   * Add a participant to the room
   */
  async joinRoom(
    roomId: string,
    userId: string,
    socketId: string,
    userName: string = '',
    initialState?: { audioEnabled?: boolean; videoEnabled?: boolean },
  ) {
    const room = await this.roomModel.findOne({ roomId });

    if (!room) {
      throw new BadRequestException('Room not found');
    }

    if (room.status === RoomStatus.ENDED) {
      throw new BadRequestException('This meeting has ended');
    }

    if (room.isLocked) {
      throw new BadRequestException('This meeting is locked');
    }

    // Check capacity
    if (room.participants.length >= room.maxParticipants) {
      throw new BadRequestException('Meeting is at maximum capacity');
    }

    // Identify stale entries for this user
    const staleParticipant = room.participants.find((p) => p.userId === userId);

    // Remove any stale entries for this user (e.g. reconnecting)
    room.participants = room.participants.filter(
      (p) => p.userId !== userId,
    );

    // Add participant
    room.participants.push({
      userId,
      socketId,
      userName,
      audioEnabled: initialState?.audioEnabled ?? true,
      videoEnabled: initialState?.videoEnabled ?? true,
      screenSharing: false,
      joinedAt: new Date(),
    });

    // Start the room if this is the first participant
    if (room.status === RoomStatus.WAITING) {
      room.status = RoomStatus.ACTIVE;
      room.startedAt = new Date();
    }

    await room.save();
    return { room, staleParticipant };
  }

  /**
   * Remove a participant from the room
   */
  async leaveRoom(roomId: string, userId: string) {
    const room = await this.roomModel.findOne({ roomId });
    if (!room) return null;

    room.participants = room.participants.filter(
      (p) => p.userId !== userId,
    );

    // Auto-end if no participants remain
    if (room.participants.length === 0 && room.status === RoomStatus.ACTIVE) {
      room.status = RoomStatus.ENDED;
      room.endedAt = new Date();

      // Sync with Meeting status
      await this.meetingModel.updateOne(
        { _id: room.meetingId },
        { status: MeetingStatus.ENDED, actualEndTime: new Date() }
      );
    }

    await room.save();
    return room;
  }

  /**
   * Remove a participant by socketId (used on disconnect)
   */
  async leaveRoomBySocketId(socketId: string) {
    const room = await this.roomModel.findOne({
      'participants.socketId': socketId,
    });

    if (!room) return null;

    const participant = room.participants.find((p) => p.socketId === socketId);
    if (!participant) return null;

    room.participants = room.participants.filter(
      (p) => p.socketId !== socketId,
    );

    // Auto-end if no participants remain
    if (room.participants.length === 0 && room.status === RoomStatus.ACTIVE) {
      room.status = RoomStatus.ENDED;
      room.endedAt = new Date();

      // Sync with Meeting status
      await this.meetingModel.updateOne(
        { _id: room.meetingId },
        { status: MeetingStatus.ENDED, actualEndTime: new Date() }
      );
    }

    await room.save();

    return {
      room,
      userId: participant.userId,
      userName: participant.userName,
    };
  }

  /**
   * End the room (host only)
   */
  async endRoom(roomId: string, userId: string) {
    const room = await this.roomModel.findOne({ roomId });

    if (!room) {
      throw new BadRequestException('Room not found');
    }

    if (room.hostId !== userId) {
      throw new ForbiddenException('Only the host can end the meeting');
    }

    room.status = RoomStatus.ENDED;
    room.endedAt = new Date();
    room.participants = [];
    await room.save();

    // Sync with Meeting status
    await this.meetingModel.updateOne(
      { _id: room.meetingId },
      { status: MeetingStatus.ENDED, actualEndTime: new Date() }
    );

    return room;
  }

  /**
   * Kick a participant (host only)
   */
  async kickParticipant(roomId: string, hostId: string, targetUserId: string) {
    const room = await this.roomModel.findOne({ roomId });

    if (!room) {
      throw new BadRequestException('Room not found');
    }

    if (room.hostId !== hostId) {
      throw new ForbiddenException('Only the host can kick participants');
    }

    const target = room.participants.find((p) => p.userId === targetUserId);
    if (!target) {
      throw new BadRequestException('Participant not found');
    }

    room.participants = room.participants.filter(
      (p) => p.userId !== targetUserId,
    );

    await room.save();

    return { room, kickedSocketId: target.socketId };
  }

  /**
   * Update media state for a participant
   */
  async updateMediaState(
    roomId: string,
    userId: string,
    state: { audioEnabled?: boolean; videoEnabled?: boolean; screenSharing?: boolean },
  ) {
    const room = await this.roomModel.findOne({ roomId });
    if (!room) return null;

    const participant = room.participants.find((p) => p.userId === userId);
    if (!participant) return null;

    if (state.audioEnabled !== undefined) participant.audioEnabled = state.audioEnabled;
    if (state.videoEnabled !== undefined) participant.videoEnabled = state.videoEnabled;
    if (state.screenSharing !== undefined) participant.screenSharing = state.screenSharing;

    await room.save();
    return participant;
  }

  /**
   * Get room by meeting code
   */
  async getRoomByCode(meetingCode: string) {
    return this.roomModel.findOne({ meetingCode });
  }

  /**
   * Get room by roomId
   */
  async getRoomById(roomId: string) {
    return this.roomModel.findOne({ roomId });
  }

  /**
   * Get current participants for a room
   */
  async getParticipants(roomId: string) {
    const room = await this.roomModel.findOne({ roomId });
    if (!room) return [];
    return room.participants;
  }

  /**
   * Toggle room lock (host only)
   */
  async toggleLock(roomId: string, hostId: string) {
    const room = await this.roomModel.findOne({ roomId });

    if (!room) throw new BadRequestException('Room not found');
    if (room.hostId !== hostId) throw new ForbiddenException('Only the host can lock/unlock');

    room.isLocked = !room.isLocked;
    await room.save();

    return { isLocked: room.isLocked };
  }
}