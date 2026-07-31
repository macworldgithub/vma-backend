import { Controller, Post, Body, Logger, UseGuards, Req, Get, Param, Res } from '@nestjs/common';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { BotService } from './bot.service';
import { SummonBotDto } from './dto/summon-bot.dto';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Meeting } from '../meetings/schemas/meeting.schema';

@Controller('bot')
@UseGuards(JwtGuard)
export class BotActionController {
  private readonly logger = new Logger(BotActionController.name);

  constructor(
    private readonly botService: BotService,
    @InjectModel(Meeting.name) private meetingModel: Model<Meeting>,
  ) {}

  @Post('summon')
  async summonBot(@Body() dto: SummonBotDto, @Req() req: any) {
    this.logger.log(`Manual summon requested for: ${dto.meetingLink}`);

    const userId = req.user.sub || req.user.id || req.user._id;
    let targetMeeting;

    if (dto.meetingId) {
      targetMeeting = await this.meetingModel.findById(dto.meetingId);
      if (!targetMeeting) {
        // Fallback to creating if not found
        targetMeeting = await this.meetingModel.create({
          title: dto.title,
          platform: dto.platform,
          meetingLink: dto.meetingLink,
          source: 'manual',
          provider: 'vma',
          status: 'LIVE',
          createdBy: userId,
          hostId: userId,
          startTime: new Date(),
          endTime: new Date(Date.now() + 60 * 60 * 1000), // Default 1 hr duration
        });
      } else {
        // Update status to LIVE if it's currently SCHEDULED
        if (targetMeeting.status === 'SCHEDULED') {
          targetMeeting.status = 'LIVE';
          await targetMeeting.save();
        }
      }
    } else {
      // Check if an existing meeting with this link already exists
      targetMeeting = await this.meetingModel.findOne({
        meetingLink: dto.meetingLink,
      });

      // Normalize platform value so it is consistent with the cron filter
      const normalizedPlatform = dto.platform === 'microsoft_teams'
        ? 'teams'
        : dto.platform === 'google_meet'
          ? 'google'
          : dto.platform;

      if (!targetMeeting) {
        // Create an ad-hoc meeting in the database
        targetMeeting = await this.meetingModel.create({
          title: dto.title,
          platform: normalizedPlatform,
          meetingLink: dto.meetingLink,
          source: 'manual',
          provider: 'vma',
          status: 'LIVE',
          createdBy: userId,
          hostId: userId,
          startTime: new Date(),
          endTime: new Date(Date.now() + 60 * 60 * 1000), // Default 1 hr duration
        });
      }
    }

    // Check if bot is currently active (joining / in call)
    if (['joining', 'joined', 'recording', 'bot.joining_call', 'bot.in_waiting_room', 'bot.in_call_recording', 'bot.in_call_not_recording'].includes(targetMeeting.botStatus)) {
      this.logger.log(`Bot already active for meeting ${targetMeeting._id}`);
      return {
        message: 'Bot is already in the meeting',
        meetingId: targetMeeting._id,
      };
    }

    // Reset stale botStatus so the atomic lock inside joinMeeting() does not
    // silently block re-deployment of a previously-used meeting link.
    if (
      targetMeeting.recallBotId ||
      (targetMeeting.botStatus && !['none', 'error', null, '', undefined].includes(targetMeeting.botStatus))
    ) {
      this.logger.log(`Resetting stale bot state for meeting ${targetMeeting._id} (was: ${targetMeeting.botStatus})`);
      await this.meetingModel.findByIdAndUpdate(
        targetMeeting._id,
        { botStatus: 'none', recallBotId: null },
        { runValidators: false }
      );
      targetMeeting = await this.meetingModel.findById(targetMeeting._id);
    }

    // Trigger the bot and check the result — do NOT silently swallow failures
    const result = await this.botService.joinMeeting(targetMeeting);

    if (!result?.success) {
      this.logger.warn(`joinMeeting() failed for meeting ${targetMeeting._id}: ${result?.reason || result?.error}`);
      return {
        message: result?.reason || result?.error || 'Bot could not be deployed. Please try again.',
        meetingId: targetMeeting._id,
        success: false,
      };
    }

    return {
      message: 'Bot summoned successfully',
      meetingId: targetMeeting._id,
      success: true,
    };
  }

  @Get('meeting/:id/report')
  async downloadReport(@Param('id') id: string, @Res() res: any) {
    try {
      const pdfBuffer = await this.botService.getMeetingReportPdf(id);
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="Meeting-Report-${id}.pdf"`,
      });
      res.send(pdfBuffer);
    } catch (error) {
      this.logger.error(`Failed to download report for meeting ${id}:`, error);
      res.status(500).send('Failed to generate report');
    }
  }
}
