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
} from '@nestjs/swagger';
import { MeetingsService } from './meetings.service';
import { IngestMeetingDto } from './dto/ingest-meeting.dto';

@ApiTags('Meetings')
@ApiBearerAuth()
@Controller('meetings')
export class MeetingsController {
  constructor(private service: MeetingsService) {}

  // INGEST MEETING
  @Post('create')
  @ApiOperation({ summary: 'Create/Ingest a meeting' })
  @ApiBody({ type: IngestMeetingDto })
  @ApiResponse({ status: 201, description: 'Meeting created successfully' })
  ingest(@Body() dto: IngestMeetingDto, @Req() req: any) {
    return this.service.ingestMeeting(dto, req.user?.sub);
  }

  // MY MEETINGS
  @Get('my')
  @ApiOperation({ summary: 'Get logged-in user meetings' })
  @ApiResponse({ status: 200, description: 'List of user meetings' })
  getMy(@Req() req: any) {
    return this.service.getUserMeetings(req.user?.sub);
  }

  // ADMIN ALL
  @Get('all')
  @ApiOperation({ summary: 'Get all meetings (admin only)' })
  @ApiResponse({ status: 200, description: 'List of all meetings' })
  getAll() {
    return this.service.getAllMeetings();
  }

  // SINGLE MEETING
  @Get(':id')
  @ApiOperation({ summary: 'Get meeting by ID' })
  @ApiResponse({ status: 200, description: 'Single meeting data' })
  getById(@Param('id') id: string) {
    return this.service.getById(id);
  }
}
