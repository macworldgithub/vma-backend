import { Controller, Post, Body, Headers, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Meeting } from '../meetings/schemas/meeting.schema';
import { BotService } from './bot.service';

@Controller('webhooks/recall')
export class BotController {
  private readonly logger = new Logger(BotController.name);

  constructor(
    @InjectModel(Meeting.name) private meetingModel: Model<Meeting>,
    private botService: BotService,
  ) {}

  @Post()
  async handleRecallWebhook(@Body() payload: any, @Headers() headers: any) {
    this.logger.log(`Received Recall.ai webhook: ${payload.event}`);
    
    const data = payload.data;
    if (!data) return { received: true };

    const botId = data.bot_id || (data.bot && data.bot.id);
    if (!botId) return { received: true };

    const meeting = await this.meetingModel.findOne({ recallBotId: botId });
    
    if (!meeting) {
       // Maybe we can fall back to metadata if the webhook includes it
       this.logger.warn(`Could not find meeting for Bot ID: ${botId}`);
       return { received: true };
    }

    switch (payload.event) {
      case 'bot.status_change':
        this.logger.log(`Bot ${botId} status changed to ${data.status.code}`);
        await this.meetingModel.findByIdAndUpdate(meeting._id, { botStatus: data.status.code });
        break;
      
      case 'bot.meeting_ended':
        this.logger.log(`Meeting ended for Bot ${botId}`);
        await this.meetingModel.findByIdAndUpdate(meeting._id, { status: 'ENDED' });
        break;

      case 'bot.transcript_ready':
        this.logger.log(`Transcript ready for Bot ${botId}`);
        // Trigger summarization logic asynchronously
        this.botService.processTranscript(botId, meeting).catch((err) => {
          this.logger.error(`Error processing transcript: ${err.message}`);
        });
        break;
        
      default:
        this.logger.log(`Unhandled Recall.ai webhook event: ${payload.event}`);
    }

    return { received: true };
  }
}
