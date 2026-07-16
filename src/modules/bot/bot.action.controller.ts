import { Controller, Post, Body, Logger, UseGuards, Req } from '@nestjs/common';
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

    // Create an ad-hoc meeting in the database first
    const newMeeting = await this.meetingModel.create({
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

    // Trigger the bot immediately
    await this.botService.joinMeeting(newMeeting);

    return {
      message: 'Bot summoned successfully',
      meetingId: newMeeting._id,
    };
  }
}
