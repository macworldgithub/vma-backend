import {
  Controller,
  Post,
  Get,
  Body,
  Req,
  Param,
  UseGuards,
} from '@nestjs/common';
import { MeetingsService } from './meetings.service';
import { IngestMeetingDto } from './dto/ingest-meeting.dto';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('Meetings')
@ApiBearerAuth()
@Controller('meetings')
export class MeetingsController {
  constructor(private service: MeetingsService) {}

  // INGEST MEETING
  @Post('ingest')
  ingest(@Body() dto: IngestMeetingDto, @Req() req: any) {
    return this.service.ingestMeeting(dto, req.user?.sub);
  }

  //  MY MEETINGS
  @Get('my')
  getMy(@Req() req: any) {
    return this.service.getUserMeetings(req.user?.sub);
  }

  //  ADMIN ALL
  @Get('all')
  getAll() {
    return this.service.getAllMeetings();
  }

  //  SINGLE
  @Get(':id')
  getById(@Param('id') id: string) {
    return this.service.getById(id);
  }
}
