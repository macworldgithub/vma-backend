import { Injectable, BadRequestException, ForbiddenException, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { Meeting, MeetingStatus } from './schemas/meeting.schema';
import { RoomService } from '../realtime/services/room.service';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class MeetingsService implements OnModuleInit {
  constructor(
    @InjectModel(Meeting.name) private model: Model<Meeting>,
    private roomService: RoomService,
    private configService: ConfigService,
  ) {}

  onModuleInit() {
    // Run cleanup on startup after a 5 second delay to let services initialize
    setTimeout(() => this.cleanupOutdatedMeetings(), 5000);
    // Run cleanup every 10 minutes in the background
    setInterval(() => this.cleanupOutdatedMeetings(), 10 * 60 * 1000);
  }

  /**
   * Automatically remove outdated meetings from both our platform and Google meetings.
   * A meeting is considered outdated if:
   * 1. Google meeting: endTime has passed (plus 5-minute grace period).
   * 2. Google meeting without endTime: startTime is older than 24 hours.
   * 3. Platform meeting (vma): status is ENDED or CANCELLED.
   * 4. Platform meeting (vma): status is SCHEDULED and scheduled endTime has passed (plus 5-minute grace period).
   * 5. Platform meeting (vma): status is SCHEDULED, never started, and startTime is older than 24 hours.
   */
  async cleanupOutdatedMeetings() {
    const now = new Date();
    // 5-minute grace period so users aren't booted out instantly if a meeting runs slightly over
    const graceTime = new Date(now.getTime() - 5 * 60 * 1000);
    
    // Scheduled meetings that were never started and are older than 24 hours
    const staleScheduledTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    try {
      const result = await this.model.deleteMany({
        $or: [
          // 1. Google meetings whose endTime has passed (plus grace period)
          {
            provider: 'google',
            endTime: { $lt: graceTime },
          },
          // 2. Google meetings without endTime where startTime is in the past by 24h
          {
            provider: 'google',
            endTime: { $exists: false },
            startTime: { $lt: staleScheduledTime },
          },
          // 3. Platform meetings (vma) that have ended or been cancelled
          {
            provider: 'vma',
            status: { $in: [MeetingStatus.ENDED, MeetingStatus.CANCELLED] },
          },
          // 4. Platform meetings (vma) whose scheduled endTime has passed (plus grace period)
          {
            provider: 'vma',
            status: MeetingStatus.SCHEDULED,
            endTime: { $lt: graceTime },
          },
          // 5. Platform meetings (vma) scheduled to start over 24h ago but never started
          {
            provider: 'vma',
            status: MeetingStatus.SCHEDULED,
            startTime: { $lt: staleScheduledTime },
          },
        ],
      });

      if (result.deletedCount > 0) {
        console.log(`[MeetingsCleanup] Automatically removed ${result.deletedCount} outdated meetings.`);
      }
    } catch (error) {
      console.error('[MeetingsCleanup] Error automatically removing outdated meetings:', error);
    }
  }

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
      } catch {}
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

  /**
   * Get meetings for a specific user
   */
  async getUserMeetings(userId: string) {
    // Run cleanup to ensure only active/future meetings are returned
    await this.cleanupOutdatedMeetings();

    return this.model.find({
      platform: 'vma',
      $or: [
        { createdBy: userId },
        { hostId: userId },
        { participants: userId },
      ],
    }).sort({ startTime: -1 });
  }

  /**
   * Get all meetings (admin)
   */
  async getAllMeetings() {
    // Run cleanup to ensure only active/future meetings are returned
    await this.cleanupOutdatedMeetings();

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
