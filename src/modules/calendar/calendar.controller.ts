import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
} from '@nestjs/swagger';
import { CalendarService } from './calendar.service';
import { JwtGuard } from 'src/common/guards/jwt.guard';

@ApiTags('Calendar')
@ApiBearerAuth()
// @UseGuards(JwtGuard)
@Controller('calendar')
export class CalendarController {
  constructor(private readonly calendarService: CalendarService) { }

  // GOOGLE CALLBACK
  @Get('google/callback')
  @ApiOperation({ summary: 'Connect Google Calendar account' })
  @ApiQuery({
    name: 'code',
    required: true,
    example: '4/0AX4XfW...',
    description: 'OAuth authorization code from Google',
  })
  @ApiResponse({ status: 200, description: 'Google calendar connected' })
  @ApiQuery({
    name: 'userId',
    required: true,
    example: 'user-123',
    description: 'User ID for calendar connection',
  })
  async googleCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Req() req: any,
    @Res() res: any,
  ) {
    const isAjax = req.headers['accept']?.includes('application/json') || req.headers['x-requested-with'];

    if (!isAjax) {
      // Direct browser redirect from Google -> redirect to frontend callback page
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      return res.redirect(`${frontendUrl}/calendar/callback?code=${code}&state=${state}`);
    }

    // AJAX request from the frontend -> exchange code, save token and return JSON
    const token = await this.calendarService.connectGoogle(state, code);
    return res.json(token);
  }

  // SYNC ALL EVENTS
  @UseGuards(JwtGuard)
  @Get('sync')
  @ApiOperation({ summary: 'Sync calendar events from providers' })
  @ApiResponse({ status: 200, description: 'Calendar synced successfully' })
  async sync(@Req() req: any) {
    return this.calendarService.syncCalendar(req.user.sub);
  }

  // GET STORED EVENTS
  @UseGuards(JwtGuard)
  @Get('events')
  @ApiOperation({ summary: 'Get stored calendar events' })
  @ApiResponse({ status: 200, description: 'List of calendar events' })
  async getEvents(@Req() req: any) {
    return this.calendarService.getStoredEvents(req.user.sub);
  }

  @UseGuards(JwtGuard)
  @Get('google/url')
  @ApiOperation({ summary: 'Get Google OAuth URL' })
  getGoogleUrl(@Req() req: any) {
    return this.calendarService.getGoogleAuthUrl(req.user.sub);
  }
}
