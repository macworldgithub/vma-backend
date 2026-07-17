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
      case 'bot.joining_call':
      case 'bot.in_waiting_room':
      case 'bot.in_call_recording':
      case 'bot.in_call_not_recording':
        this.logger.log(`Bot ${botId} status changed to ${payload.event}`);
        await this.meetingModel.findByIdAndUpdate(meeting._id, { botStatus: payload.event }, { runValidators: false });
        break;
      
      case 'bot.call_ended':
        this.logger.log(`Meeting ended for Bot ${botId}`);
        await this.meetingModel.findByIdAndUpdate(meeting._id, { status: 'ENDED' }, { runValidators: false });
        break;

      case 'bot.done':
        this.logger.log(`Processing complete for Bot ${botId}, fetching transcript...`);
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
