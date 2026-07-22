import { Injectable, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { Meeting, MeetingStatus } from './schemas/meeting.schema';
import { RoomService } from '../realtime/services/room.service';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class MeetingsService {
  constructor(
    @InjectModel(Meeting.name) private model: Model<Meeting>,
    private roomService: RoomService,
    private configService: ConfigService,
  ) { }

  /**
   * Create a new meeting + room (instant or scheduled)
   */
  async createMeeting(dto: any, userId: string) {
    const isInstant = !dto.scheduledStart;
    const maxParticipants = dto.maxParticipants || 10;

    if (!isInstant) {
      const scheduledDate = new Date(dto.scheduledStart);
      if (scheduledDate.getTime() < Date.now() - 60000) { // 1 min grace
        throw new BadRequestException('Scheduled start time must be in the future');
      }
    }

    // 1. Create the meeting record first (to get _id)
    const meeting = await this.model.create({
      title: dto.title,
      platform: 'vma',
      createdBy: userId,
      hostId: userId,
      source: 'manual',
      provider: 'vma',
      startTime: dto.scheduledStart ? new Date(dto.scheduledStart) : new Date(),
      endTime: dto.scheduledEnd ? new Date(dto.scheduledEnd) : undefined,
      status: isInstant ? MeetingStatus.LIVE : MeetingStatus.SCHEDULED,
      participants: [userId],
      maxParticipants,
      actualStartTime: isInstant ? new Date() : undefined,
    });

    // 2. Create the room linked to this meeting
    const room = await this.roomService.createRoom(
      (meeting as any)._id.toString(),
      userId,
      maxParticipants,
    );

    // 3. Link room back to meeting
    const frontendUrl = this.configService.get('FRONTEND_URL') || 'http://localhost:3000';

    meeting.roomId = room.roomId;
    meeting.meetingCode = room.meetingCode;
    meeting.meetingLink = `${frontendUrl}/meeting/${room.meetingCode}`;
    await meeting.save();

    return {
      meeting,
      roomId: room.roomId,
      meetingCode: room.meetingCode,
      joinUrl: meeting.meetingLink,
    };
  }

  /**
   * Start a scheduled meeting (transition SCHEDULED → LIVE)
   */
  async startMeeting(meetingId: string, userId: string) {
    const meeting = await this.model.findById(meetingId);

    if (!meeting) throw new NotFoundException('Meeting not found');
    if (meeting.hostId !== userId) throw new ForbiddenException('Only the host can start the meeting');

    if (meeting.status !== MeetingStatus.SCHEDULED) {
      throw new BadRequestException(`Cannot start a meeting with status: ${meeting.status}`);
    }

    meeting.status = MeetingStatus.LIVE;
    meeting.actualStartTime = new Date();
    await meeting.save();

    return meeting;
  }

  /**
   * End a live meeting (transition LIVE → ENDED)
   */
  async endMeeting(meetingId: string, userId: string) {
    const meeting = await this.model.findById(meetingId);

    if (!meeting) throw new NotFoundException('Meeting not found');
    if (meeting.hostId !== userId) throw new ForbiddenException('Only the host can end the meeting');

    if (meeting.status !== MeetingStatus.LIVE) {
      throw new BadRequestException(`Cannot end a meeting with status: ${meeting.status}`);
    }

    meeting.status = MeetingStatus.ENDED;
    meeting.actualEndTime = new Date();

    // Calculate duration in seconds
    if (meeting.actualStartTime) {
      meeting.duration = Math.floor(
        (meeting.actualEndTime.getTime() - meeting.actualStartTime.getTime()) / 1000,
      );
    }

    await meeting.save();

    // End the room as well
    if (meeting.roomId) {
      try {
        await this.roomService.endRoom(meeting.roomId, userId);
      } catch {
        // Room may already be ended
      }
    }

    return meeting;
  }

  /**
   * Cancel a meeting
   */
  async cancelMeeting(meetingId: string, userId: string) {
    const meeting = await this.model.findById(meetingId);
    if (!meeting) throw new NotFoundException('Meeting not found');
    if (meeting.hostId !== userId) throw new ForbiddenException('Only the host can cancel');

    meeting.status = MeetingStatus.CANCELLED;
    await meeting.save();

    // If there is an active room, end it
    if (meeting.roomId) {
      try {
        await this.roomService.endRoom(meeting.roomId, userId);
      } catch { }
    }

    return meeting;
  }

  /**
   * Update meeting details
   */
  async updateMeeting(meetingId: string, dto: any, userId: string) {
    const meeting = await this.model.findById(meetingId);
    if (!meeting) throw new NotFoundException('Meeting not found');
    if (meeting.hostId !== userId) throw new ForbiddenException('Only the host can update');

    if (dto.title) meeting.title = dto.title;
    if (dto.startTime) meeting.startTime = new Date(dto.startTime);
    if (dto.endTime) meeting.endTime = new Date(dto.endTime);
    if (dto.maxParticipants) meeting.maxParticipants = dto.maxParticipants;

    await meeting.save();
    return meeting;
  }

  /**
   * Get meeting by short code (for join page)
   */
  async getByCode(meetingCode: string) {
    const query: any = {
      $or: [{ meetingCode }],
    };

    if (isValidObjectId(meetingCode)) {
      query.$or.push({ _id: meetingCode });
    }

    const meeting = await this.model.findOne(query);
    if (!meeting) throw new NotFoundException('Meeting not found');
    return meeting;
  }

  /**
   * Get meeting with current participant data from room
   */
  async getMeetingWithParticipants(meetingId: string) {
    const meeting = await this.model.findById(meetingId);
    if (!meeting) throw new NotFoundException('Meeting not found');

    let participants: any[] = [];
    if (meeting.roomId) {
      participants = await this.roomService.getParticipants(meeting.roomId);
    }

    return {
      meeting,
      liveParticipants: participants,
    };
  }

  /**
   * Ingest a meeting from calendar sync (backward compatible)
   */
  async ingestMeeting(dto: any, userId: string) {
    return this.model.create({
      ...dto,
      createdBy: userId,
      hostId: userId,
      status: MeetingStatus.SCHEDULED,
      source: 'calendar',
    });
  }

  async getUserMeetings(userId: string, email?: string) {
    const query: any = {
      $or: [
        { createdBy: userId },
        { hostId: userId },
        { participants: userId },
      ],
    };
    if (email) {
      query.$or.push({ participants: email });
    }
    return this.model.find(query).sort({ startTime: -1 });
  }

  /**
   * Get all meetings (admin)
   */
  async getAllMeetings() {
    return this.model.find().sort({ startTime: -1 });
  }

  /**
   * Get single meeting by ID
   */
  async getById(id: string) {
    const meeting = await this.model.findById(id);
    if (!meeting) throw new NotFoundException('Meeting not found');
    return meeting;
  }
}
