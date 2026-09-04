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

    // top of handleRecallWebhook — was: findOne({ recallBotId: botId })
    const meeting = await this.meetingModel.findOne({
      $or: [{ recallBotId: botId }, { previousBotIds: botId }],
    });

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
        await this.meetingModel.updateOne(
          { _id: meeting._id },
          { $set: { botStatus: payload.event }, $setOnInsert: { botJoinedAt: new Date() } },
          { runValidators: false }
        );
        break;

      case 'bot.call_ended':
        const now = new Date();
        const stillWithinSchedule = meeting.endTime && now < new Date(meeting.endTime);

        if (stillWithinSchedule) {
          this.logger.log(
            `Meeting ${meeting._id} call ended before scheduled endTime — releasing bot lock so it can redeploy if the host rejoins.`
          );
          await this.meetingModel.updateOne(
            { _id: meeting._id, recallBotId: botId },
            {
              $set: { botStatus: 'none', recallBotId: null, botLeftAt: now },
              $addToSet: { previousBotIds: botId },
              $inc: { redeployCount: 1 },
            },
            { runValidators: false },
          );
        } else {
          this.logger.log(`Meeting ended for Bot ${botId}`);
          await this.meetingModel.updateOne(
            { _id: meeting._id },
            { $set: { status: 'ENDED', botStatus: 'call_ended', botLeftAt: now } },
            { runValidators: false },
          );
        }
        break;

      case 'bot.done':
        this.logger.log(`Bot ${botId} done. Awaiting transcript.done before processing.`);
        await this.meetingModel.updateOne(
          { _id: meeting._id },
          { $set: { botStatus: 'bot.done', botLeftAt: new Date() } },
          { runValidators: false }
        );
        break;

      case 'transcript.done':
        const transcriptId = data.transcript?.id;
        if (transcriptId) {
          // target by meeting._id
          await this.meetingModel.updateOne(
            { _id: meeting._id },
            { $set: { transcriptId } },
            { runValidators: false },
          );
        }
        this.botService.processTranscript(botId, meeting, transcriptId).catch((err) => {
          this.logger.error(`Error processing transcript: ${err.message}`);
        });
        break;

      case 'transcript.failed':
        {
          const transcriptId = data.transcript?.id;
          this.logger.error(`Transcript generation failed for Bot ${botId}: ${JSON.stringify(data.data)}`);
          await this.meetingModel.updateOne(
            { _id: meeting._id },
            {
              $set: {
                botErrorLog: JSON.stringify(data.data || {}),
                summaryStatus: 'failed',
                summaryError: 'Transcript generation failed on Recall.ai',
              },
            },
            { runValidators: false }
          );
        }
        break;

      default:
        this.logger.log(`Unhandled Recall.ai webhook event: ${payload.event}`);
    }

    return { received: true };
  }
}