import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiQuery,
} from '@nestjs/swagger';
import { DashboardService } from './dashboard.service';
import { JwtGuard } from 'src/common/guards/jwt.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { Roles } from 'src/common/decorators/roles.decorator';

@ApiTags('Dashboard')
@ApiBearerAuth()
@UseGuards(JwtGuard, RolesGuard)
@Roles('admin')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  // ─── MAIN STATS ─────────────────────────────────────────────────────
  @Get('stats')
  @ApiOperation({ summary: 'Get dashboard stats (admin only)' })
  @ApiResponse({
    status: 200,
    description: 'Dashboard statistics — users, meetings, realtime activity',
  })
  getStats() {
    return this.dashboardService.getStats();
  }

  // ─── MEETING HISTORY (chart data) ──────────────────────────────────
  @Get('meeting-history')
  @ApiOperation({ summary: 'Get meeting history grouped by day (admin only)' })
  @ApiQuery({
    name: 'days',
    required: false,
    example: 30,
    description: 'Number of days to look back (default: 30)',
  })
  @ApiResponse({
    status: 200,
    description: 'Daily meeting counts for chart rendering',
  })
  getMeetingHistory(@Query('days') days?: string) {
    return this.dashboardService.getMeetingHistory(
      days ? parseInt(days, 10) : 30,
    );
  }

  // ─── RECENT MEETINGS ──────────────────────────────────────────────
  @Get('recent-meetings')
  @ApiOperation({ summary: 'Get recent meetings (admin only)' })
  @ApiQuery({
    name: 'limit',
    required: false,
    example: 20,
    description: 'Number of meetings to return (default: 20)',
  })
  @ApiResponse({ status: 200, description: 'List of recent meetings' })
  getRecentMeetings(@Query('limit') limit?: string) {
    return this.dashboardService.getRecentMeetings(
      limit ? parseInt(limit, 10) : 20,
    );
  }

  // ─── TOP USERS ────────────────────────────────────────────────────
  @Get('top-users')
  @ApiOperation({ summary: 'Get top users by meetings hosted (admin only)' })
  @ApiQuery({
    name: 'limit',
    required: false,
    example: 10,
    description: 'Number of users to return (default: 10)',
  })
  @ApiResponse({ status: 200, description: 'Top users by meeting count' })
  getTopUsers(@Query('limit') limit?: string) {
    return this.dashboardService.getTopUsers(
      limit ? parseInt(limit, 10) : 10,
    );
  }
}
