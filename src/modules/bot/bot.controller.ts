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
        this.logger.log(`Bot ${botId} status changed to ${payload.event}`);
        await this.meetingModel.updateOne(
          { _id: meeting._id },
          { $set: { botStatus: payload.event } },
          { runValidators: false }
        );
        break;

      case 'bot.in_call_recording':
      case 'bot.in_call_not_recording':
        this.logger.log(`Bot ${botId} status changed to ${payload.event} — marking meeting LIVE`);
        await this.meetingModel.updateOne(
          { _id: meeting._id },
          {
            $set: { botStatus: payload.event, status: 'LIVE', botJoinedAt: new Date() },
          },
          { runValidators: false }
        );
        break;

      case 'bot.call_ended': {
        const now = new Date();
        const botWasRecording = [
          'bot.in_call_recording',
          'bot.in_call_not_recording',
          'LIVE',
        ].includes(meeting.botStatus || '') || meeting.status === 'LIVE';

        // If the bot was actually recording/in-call, treat this as the true end of the meeting.
        // Do NOT reset to 'none' — that would cause the cron to re-deploy immediately.
        if (botWasRecording) {
          this.logger.log(
            `Meeting ${meeting._id} ended (bot was recording). Marking ENDED and awaiting transcript.`
          );
          await this.meetingModel.updateOne(
            { _id: meeting._id, recallBotId: botId },
            {
              $set: { status: 'ENDED', botStatus: 'call_ended', botLeftAt: now },
              $addToSet: { previousBotIds: botId },
            },
            { runValidators: false },
          );
        } else {
          // Bot never got into the call (e.g. kicked from waiting room or brief network drop).
          // Only allow re-deploy if still within the scheduled window.
          const stillWithinSchedule = meeting.endTime && now < new Date(meeting.endTime);
          if (stillWithinSchedule) {
            this.logger.log(
              `Meeting ${meeting._id} bot kicked before recording (waiting room). Releasing lock for possible redeploy.`
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
            this.logger.log(`Meeting ${meeting._id} ended (past scheduled time). Marking ENDED.`);
            await this.meetingModel.updateOne(
              { _id: meeting._id },
              { $set: { status: 'ENDED', botStatus: 'call_ended', botLeftAt: now } },
              { runValidators: false },
            );
          }
        }
        break;
      }

      case 'bot.done':
        this.logger.log(`Bot ${botId} done. Awaiting transcript.done before processing.`);
        await this.meetingModel.updateOne(
          { _id: meeting._id },
          { $set: { botStatus: 'bot.done', botLeftAt: new Date(), status: 'ENDED' } },
          { runValidators: false }
        );
        break;

      case 'transcript.done': {
        const transcriptId = data.transcript?.id;
        if (transcriptId) {
          await this.meetingModel.updateOne(
            { _id: meeting._id },
            { $set: { transcriptId, transcriptSource: 'transcript.done' } },
            { runValidators: false },
          );
        }
        this.logger.log(`transcript.done received for bot ${botId}. Processing transcript...`);
        this.botService.processTranscript(botId, meeting, transcriptId).catch((err) => {
          this.logger.error(`Error processing transcript: ${err.message}`);
        });
        break;
      }

      case 'recording.done': {
        // recording.done fires reliably in the Recall.ai EU region even when transcript.done
        // does not (e.g. when transcription_options are not supported). We use this as a
        // fallback trigger to fetch the transcript directly from the bot endpoint.
        this.logger.log(`recording.done received for bot ${botId}. Checking if transcript still needed...`);
        const latestMeeting = await this.meetingModel.findById(meeting._id);
        const alreadyProcessed = ['processing', 'sent', 'skipped_empty_transcript'].includes(
          latestMeeting?.summaryStatus || '',
        );
        if (!alreadyProcessed) {
          this.logger.log(`Triggering transcript processing via bot endpoint for bot ${botId}`);
          // Small delay to let Recall.ai finalise the recording artifact before we poll
          setTimeout(() => {
            this.botService.processTranscript(botId, meeting, undefined).catch((err) => {
              this.logger.error(`Error processing transcript on recording.done: ${err.message}`);
            });
          }, 15000); // 15 second delay
        } else {
          this.logger.log(`Transcript already handled for meeting ${meeting._id}, skipping recording.done trigger.`);
        }
        break;
      }

      case 'transcript.failed': {
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
        break;
      }

      default:
        this.logger.log(`Unhandled Recall.ai webhook event: ${payload.event}`);
    }

    return { received: true };
  }
}
