import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Meeting, MeetingStatus } from '../meetings/schemas/meeting.schema';
import { User } from '../users/users.schema';
import { Room, RoomStatus } from '../realtime/schemas/room.schema';

@Injectable()
export class DashboardService {
  constructor(
    @InjectModel(Meeting.name) private meetingModel: Model<Meeting>,
    @InjectModel(User.name) private userModel: Model<User>,
    @InjectModel(Room.name) private roomModel: Model<Room>,
  ) { }

  /**
   * Main dashboard stats — single call for the frontend dashboard
   */
  async getStats() {
    const [
      totalUsers,
      activeUsers,
      suspendedUsers,
      totalMeetings,
      activeMeetings,
      scheduledMeetings,
      endedMeetings,
      cancelledMeetings,
      activeRooms,
      totalParticipantsInMeetings,
    ] = await Promise.all([
      this.userModel.countDocuments(),
      this.userModel.countDocuments({ isActive: true }),
      this.userModel.countDocuments({ isActive: false }),
      this.meetingModel.countDocuments(),
      this.meetingModel.countDocuments({ status: MeetingStatus.LIVE }),
      this.meetingModel.countDocuments({ status: MeetingStatus.SCHEDULED }),
      this.meetingModel.countDocuments({ status: MeetingStatus.ENDED }),
      this.meetingModel.countDocuments({ status: MeetingStatus.CANCELLED }),
      this.roomModel.countDocuments({ status: RoomStatus.ACTIVE }),
      this.roomModel.aggregate([
        { $match: { status: RoomStatus.ACTIVE } },
        { $project: { count: { $size: '$participants' } } },
        { $group: { _id: null, total: { $sum: '$count' } } },
      ]),
    ]);

    const participantsOnline =
      totalParticipantsInMeetings.length > 0
        ? totalParticipantsInMeetings[0].total
        : 0;

    return {
      users: {
        total: totalUsers,
        active: activeUsers,
        suspended: suspendedUsers,
      },
      meetings: {
        total: totalMeetings,
        live: activeMeetings,
        scheduled: scheduledMeetings,
        ended: endedMeetings,
        cancelled: cancelledMeetings,
      },
      realtime: {
        activeRooms,
        participantsOnline,
      },
    };
  }

  /**
   * Meeting history chart data — grouped by day for the last N days
   */
  async getMeetingHistory(days: number = 30) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    startDate.setHours(0, 0, 0, 0);

    const history = await this.meetingModel.aggregate([
      {
        $match: {
          createdAt: { $gte: startDate },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$createdAt' },
          },
          total: { $sum: 1 },
          completed: {
            $sum: {
              $cond: [{ $eq: ['$status', MeetingStatus.ENDED] }, 1, 0],
            },
          },
          cancelled: {
            $sum: {
              $cond: [{ $eq: ['$status', MeetingStatus.CANCELLED] }, 1, 0],
            },
          },
          avgDuration: { $avg: '$duration' },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    return history.map((day) => ({
      date: day._id,
      total: day.total,
      completed: day.completed,
      cancelled: day.cancelled,
      avgDurationMinutes: day.avgDuration
        ? Math.round(day.avgDuration / 60)
        : 0,
    }));
  }

  /**
   * Recent meetings list (last 20)
   */
  async getRecentMeetings(limit: number = 20) {
    return this.meetingModel
      .find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .select('title status hostId meetingCode duration createdAt actualStartTime actualEndTime maxParticipants')
      .lean();
  }

  /**
   * Top active users by meeting count
   */
  async getTopUsers(limit: number = 10) {
    const topUsers = await this.meetingModel.aggregate([
      { $group: { _id: '$hostId', meetingsHosted: { $sum: 1 } } },
      { $sort: { meetingsHosted: -1 } },
      { $limit: limit },
    ]);

    return topUsers.map((u) => ({
      userId: u._id,
      meetingsHosted: u.meetingsHosted,
    }));
  }
}
