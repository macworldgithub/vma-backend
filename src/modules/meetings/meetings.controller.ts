import {
  Controller,
  Post,
  Get,
  Body,
  Req,
  Param,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiBody,
  ApiResponse,
  ApiParam,
} from '@nestjs/swagger';
import { MeetingsService } from './meetings.service';
import { CreateMeetingDto } from './dto/create-meeting.dto';
import { IngestMeetingDto } from './dto/ingest-meeting.dto';
import { JwtGuard } from 'src/common/guards/jwt.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RoomService } from '../realtime/services/room.service';
import { ChatService } from '../realtime/services/chat.service';
import { ConfigService } from '@nestjs/config';

@ApiTags('Meetings')
@ApiBearerAuth()
@Controller('meetings')
export class MeetingsController {
  constructor(
    private service: MeetingsService,
    private roomService: RoomService,
    private chatService: ChatService,
    private configService: ConfigService,
  ) { }

  @Get('ice-servers')
  @ApiOperation({ summary: 'Get STUN/TURN server configuration for WebRTC' })
  @ApiResponse({ status: 200, description: 'ICE server configuration' })
  getIceServers() {
    const servers: any[] = [
      {
        urls: "stun:stun.relay.metered.ca:80",
      },
      {
        urls: "turn:global.relay.metered.ca:80",
        username: "0da55795225b9490c2222dc6",
        credential: "hfVkF8auvkjku7JC",
      },
      {
        urls: "turn:global.relay.metered.ca:80?transport=tcp",
        username: "0da55795225b9490c2222dc6",
        credential: "hfVkF8auvkjku7JC",
      },
      {
        urls: "turn:global.relay.metered.ca:443",
        username: "0da55795225b9490c2222dc6",
        credential: "hfVkF8auvkjku7JC",
      },
      {
        urls: "turns:global.relay.metered.ca:443?transport=tcp",
        username: "0da55795225b9490c2222dc6",
        credential: "hfVkF8auvkjku7JC",
      },
    ];

    return { iceServers: servers };
  }

  // ─── CREATE MEETING (instant or scheduled) ─────────────────────────────
  @UseGuards(JwtGuard)
  @Post('create')
  @ApiOperation({ summary: 'Create a new meeting (instant or scheduled)' })
  @ApiBody({ type: CreateMeetingDto })
  @ApiResponse({ status: 201, description: 'Meeting created with room and join code' })
  create(@Body() dto: CreateMeetingDto, @Req() req: any) {
    return this.service.createMeeting(dto, req.user.sub);
  }

  // ─── INGEST FROM CALENDAR ───────────────────────────────────────────────
  @UseGuards(JwtGuard)
  @Post('ingest')
  @ApiOperation({ summary: 'Ingest a meeting from calendar sync' })
  @ApiBody({ type: IngestMeetingDto })
  @ApiResponse({ status: 201, description: 'Meeting ingested from calendar' })
  ingest(@Body() dto: IngestMeetingDto, @Req() req: any) {
    return this.service.ingestMeeting(dto, req.user.sub);
  }

  // ─── MY MEETINGS ───────────────────────────────────────────────────────
  @UseGuards(JwtGuard)
  @Get('my')
  @ApiOperation({ summary: 'Get logged-in user meetings' })
  @ApiResponse({ status: 200, description: 'List of user meetings' })
  getMy(@Req() req: any) {
    return this.service.getUserMeetings(req.user.sub);
  }

  // ─── ALL MEETINGS (admin) ──────────────────────────────────────────────
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin')
  @Get('all')
  @ApiOperation({ summary: 'Get all meetings (admin only)' })
  @ApiResponse({ status: 200, description: 'List of all meetings' })
  getAll() {
    return this.service.getAllMeetings();
  }

  // ─── JOIN BY CODE (public-ish — for the join page) ─────────────────────
  @Get('join/:code')
  @ApiOperation({ summary: 'Get meeting info by join code' })
  @ApiParam({ name: 'code', example: 'abc-defg-hij' })
  @ApiResponse({ status: 200, description: 'Meeting info for join page' })
  async getByCode(@Param('code') code: string) {
    const meeting = await this.service.getByCode(code);
    const room = await this.roomService.getRoomByCode(code);

    return {
      meetingId: (meeting as any)._id,
      title: meeting.title,
      hostId: meeting.hostId,
      status: meeting.status,
      startTime: meeting.startTime,
      endTime: meeting.endTime,
      meetingCode: code,
      roomId: room?.roomId,
      roomStatus: room?.status,
      isLocked: room?.isLocked,
      participantCount: room?.participants?.length || 0,
      maxParticipants: meeting.maxParticipants,
    };
  }

  // ─── START MEETING ─────────────────────────────────────────────────────
  @UseGuards(JwtGuard)
  @Post(':id/start')
  @ApiOperation({ summary: 'Start a scheduled meeting (host only)' })
  @ApiParam({ name: 'id', description: 'Meeting ID' })
  @ApiResponse({ status: 200, description: 'Meeting started' })
  start(@Param('id') id: string, @Req() req: any) {
    return this.service.startMeeting(id, req.user.sub);
  }

  // ─── END MEETING ──────────────────────────────────────────────────────
  @UseGuards(JwtGuard)
  @Post(':id/end')
  @ApiOperation({ summary: 'End a live meeting (host only)' })
  @ApiParam({ name: 'id', description: 'Meeting ID' })
  @ApiResponse({ status: 200, description: 'Meeting ended' })
  end(@Param('id') id: string, @Req() req: any) {
    return this.service.endMeeting(id, req.user.sub);
  }

  // ─── CANCEL MEETING ────────────────────────────────────────────────────
  @UseGuards(JwtGuard)
  @Post(':id/cancel')
  @ApiOperation({ summary: 'Cancel a meeting (host only)' })
  @ApiParam({ name: 'id', description: 'Meeting ID' })
  @ApiResponse({ status: 200, description: 'Meeting cancelled' })
  cancel(@Param('id') id: string, @Req() req: any) {
    return this.service.cancelMeeting(id, req.user.sub);
  }

  // ─── UPDATE MEETING ────────────────────────────────────────────────────
  @UseGuards(JwtGuard)
  @Post(':id/update') // Using POST for update to avoid PATCH complexity for now, or just use PATCH
  @ApiOperation({ summary: 'Update meeting details (host only)' })
  @ApiParam({ name: 'id', description: 'Meeting ID' })
  @ApiResponse({ status: 200, description: 'Meeting updated' })
  update(@Param('id') id: string, @Body() dto: any, @Req() req: any) {
    return this.service.updateMeeting(id, dto, req.user.sub);
  }

  // ─── GET MEETING WITH LIVE PARTICIPANTS ───────────────────────────────
  @UseGuards(JwtGuard)
  @Get(':id/live')
  @ApiOperation({ summary: 'Get meeting details with live participant data' })
  @ApiParam({ name: 'id', description: 'Meeting ID' })
  @ApiResponse({ status: 200, description: 'Meeting with live participant info' })
  getLive(@Param('id') id: string) {
    return this.service.getMeetingWithParticipants(id);
  }

  // ─── GET CHAT HISTORY ────────────────────────────────────────────────
  @UseGuards(JwtGuard)
  @Get(':id/chat')
  @ApiOperation({ summary: 'Get chat history for a meeting' })
  @ApiParam({ name: 'id', description: 'Meeting ID' })
  @ApiResponse({ status: 200, description: 'Chat messages for the meeting' })
  async getChat(@Param('id') id: string) {
    const meeting = await this.service.getById(id);
    if (!meeting.roomId) return { messages: [] };
    const messages = await this.chatService.getMessages(meeting.roomId);
    return { messages };
  }

  // ─── SINGLE MEETING BY ID ────────────────────────────────────────────
  @UseGuards(JwtGuard)
  @Get(':id')
  @ApiOperation({ summary: 'Get meeting by ID' })
  @ApiParam({ name: 'id', description: 'Meeting ID' })
  @ApiResponse({ status: 200, description: 'Single meeting data' })
  getById(@Param('id') id: string) {
    return this.service.getById(id);
  }
}
