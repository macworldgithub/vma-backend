import { Controller, Post, Req, Headers, Logger, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Meeting } from '../meetings/schemas/meeting.schema';
import { BotService } from './bot.service';
import { Webhook } from 'svix';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

@Controller('webhooks/recall')
export class BotController {
  private readonly logger = new Logger(BotController.name);
  private readonly webhook: Webhook;

  constructor(
    @InjectModel(Meeting.name) private meetingModel: Model<Meeting>,
    private botService: BotService,
    private configService: ConfigService,
  ) {
    this.webhook = new Webhook(this.configService.get<string>('RECALL_WEBHOOK_SECRET') || '');
  }

  @Post()
  async handleRecallWebhook(@Req() req: Request, @Headers() headers: any) {
    let payload: any;

    try {
      // req.body is the raw Buffer here because of the bodyParser.raw() middleware
      payload = this.webhook.verify(req.body, {
        'webhook-id': headers['webhook-id'],
        'webhook-timestamp': headers['webhook-timestamp'],
        'webhook-signature': headers['webhook-signature'],
      });
    } catch (err: any) {
      this.logger.warn(`Webhook signature verification failed: ${err.message}`);
      throw new BadRequestException('Invalid webhook signature');
    }

    this.logger.log(`Received Recall.ai webhook: ${payload.event}`);

    const data = payload.data;
    if (!data) return { received: true };

    const botId = data.bot_id || (data.bot && data.bot.id);
    if (!botId) return { received: true };

    const meeting = await this.meetingModel.findOne({ recallBotId: botId });

    if (!meeting) {
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
        // Bot has left the call, but the transcript may still be processing
        // asynchronously (recallai_streaming in prioritize_accuracy mode uses
        // an async model under the hood). Don't fetch yet — wait for
        // transcript.done below, which fires once the transcript is actually ready.
        this.logger.log(`Bot ${botId} done. Awaiting transcript.done before processing.`);
        await this.meetingModel.findByIdAndUpdate(meeting._id, { botStatus: 'bot.done' }, { runValidators: false });
        break;

      case 'transcript.done':
        this.logger.log(`Transcript ready for Bot ${botId}, processing...`);
        this.botService.processTranscript(botId, meeting).catch((err) => {
          this.logger.error(`Error processing transcript: ${err.message}`);
        });
        break;

      case 'transcript.failed':
        this.logger.error(`Transcript generation failed for Bot ${botId}: ${JSON.stringify(data.data)}`);
        // Fall back to processing anyway so the meeting isn't stuck forever —
        // fetchTranscriptFromRecall will return the "could not be retrieved" placeholder text
        this.botService.processTranscript(botId, meeting).catch((err) => {
          this.logger.error(`Error processing transcript after failure: ${err.message}`);
        });
        break;

      default:
        this.logger.log(`Unhandled Recall.ai webhook event: ${payload.event}`);
    }

    return { received: true };
  }
}