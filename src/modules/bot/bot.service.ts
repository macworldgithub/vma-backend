import { Injectable, Logger, NotFoundException, InternalServerErrorException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Meeting } from '../meetings/schemas/meeting.schema';
import { User } from '../users/users.schema';
import { MailService } from '../mail/mail.service';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { firstValueFrom } from 'rxjs';
import { ChatService } from '../realtime/services/chat.service';

@Injectable()
export class BotService {
  private readonly logger = new Logger(BotService.name);

  constructor(
    @InjectModel(Meeting.name) private meetingModel: Model<Meeting>,
    @InjectModel(User.name) private userModel: Model<User>,
    private httpService: HttpService,
    private configService: ConfigService,
    private mailService: MailService,
    private chatService: ChatService,
  ) { }

  @Cron(CronExpression.EVERY_MINUTE)
  async checkUpcomingMeetings() {
    this.logger.debug('Checking for upcoming meetings to send bot...');
    const now = new Date();
    const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60000);

    const startTimeLimit = new Date(now.getTime() - 15 * 60000);

    const upcomingMeetings = await this.meetingModel.find({
      meetingLink: { $exists: true, $ne: '' },
      botStatus: { $in: ['none', null] },
      startTime: { $gte: startTimeLimit, $lte: fiveMinutesFromNow },
      platform: { $in: ['teams', 'microsoft_teams', 'zoom', 'google', 'google_meet'] }
    });

    for (const meeting of upcomingMeetings) {
      this.logger.log(`Triggering bot for meeting: ${meeting.title} (${meeting.id})`);
      await this.joinMeeting(meeting);
    }
  }

  async joinMeeting(meeting: any) {
    const apiKey = this.configService.get<string>('RECALL_API_KEY');
    const baseUrl = this.configService.get<string>('RECALL_BASE_URL');
    const botName = this.configService.get<string>('BOT_NAME', 'Patterson Cheney Virtual Assistant');

    if (!apiKey || !baseUrl) {
      this.logger.error('Recall.ai API Key or Base URL is missing.');
      return { success: false, reason: 'Missing API credentials' };
    }

    // Atomically transition status to 'joining' only if no bot has been spawned yet and not currently joining
    const lockedMeeting = await this.meetingModel.findOneAndUpdate(
      {
        _id: meeting._id,
        $and: [
          { $or: [{ recallBotId: { $exists: false } }, { recallBotId: null }, { recallBotId: '' }] },
          { $or: [{ botStatus: { $exists: false } }, { botStatus: { $in: ['none', 'error', null, ''] } }] }
        ]
      },
      { botStatus: 'joining' },
      { new: true, runValidators: false }
    );

    if (!lockedMeeting) {
      this.logger.warn(`Bot join skipped for meeting ${meeting._id}: already joining, joined, or recallBotId exists.`);
      return { success: false, reason: 'Bot already active or joining' };
    }

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${baseUrl}/bot`,
          {
            meeting_url: lockedMeeting.meetingLink,
            bot_name: botName,
            metadata: { meetingId: lockedMeeting._id.toString() },
            recording_config: {
              transcript: {
                provider: {
                  recallai_streaming: {
                    mode: 'prioritize_accuracy',
                    language_code: 'en'
                  }
                }
              }
            }
          },
          {
            headers: {
              'Authorization': `Token ${apiKey}`,
              'Content-Type': 'application/json'
            }
          }
        )
      );

      const botId = response.data.id;
      this.logger.log(`Successfully requested bot for meeting ${lockedMeeting._id}. Bot ID: ${botId}`);

      await this.meetingModel.findByIdAndUpdate(lockedMeeting._id, {
        recallBotId: botId,
        botStatus: 'joining'
      }, { runValidators: false });

      return { success: true, botId };
    } catch (error: any) {
      this.logger.error(`Failed to trigger bot for meeting ${lockedMeeting._id}`, error.response?.data || error.message);
      await this.meetingModel.findByIdAndUpdate(lockedMeeting._id, { botStatus: 'error' }, { runValidators: false });
      return { success: false, error: error.message };
    }
  }

  private async fetchTranscriptFromRecall(transcriptId?: string): Promise<string> {
    const apiKey = this.configService.get<string>('RECALL_API_KEY');
    const baseUrl = this.configService.get<string>('RECALL_BASE_URL');

    if (!apiKey || !baseUrl) {
      throw new InternalServerErrorException('Recall API config missing');
    }
    if (!transcriptId) {
      this.logger.warn('No transcript ID provided; cannot fetch transcript.');
      return 'Transcript could not be retrieved from Recall.ai API.';
    }

    // Step 1: Retrieve the transcript object to get its pre-signed download_url
    const transcriptRes = await firstValueFrom(
      this.httpService.get(`${baseUrl}/transcript/${transcriptId}/`, {
        headers: { 'Authorization': `Token ${apiKey}` }
      })
    );

    const downloadUrl = transcriptRes.data?.data?.download_url;
    if (!downloadUrl) {
      this.logger.warn(`No download_url on transcript ${transcriptId}`);
      return 'Transcript could not be retrieved from Recall.ai API.';
    }

    // Step 2: Fetch the actual transcript segments (pre-signed URL, no auth header needed)
    const segmentsRes = await firstValueFrom(this.httpService.get(downloadUrl));
    const segments = segmentsRes.data;

    if (!Array.isArray(segments)) {
      return 'Transcript could not be retrieved from Recall.ai API.';
    }

    const lines = segments
      .map((segment: any) => {
        const speaker = segment.participant?.name || segment.speaker || segment.name || 'Unknown';
        const text = Array.isArray(segment.words)
          ? segment.words.map((w: any) => w.text || w.word || '').join(' ')
          : (segment.text || '');

        const startTimeRaw = segment.start_time ?? (segment.words?.[0]?.start_time ?? 0);
        const minutes = Math.floor(startTimeRaw / 60);
        const seconds = Math.floor(startTimeRaw % 60).toString().padStart(2, '0');
        const timestamp = `${minutes}:${seconds}`;

        return `[${timestamp}] ${speaker}: ${text.trim()}`;
      })
      .filter((line: string) => !line.endsWith(': '));

    return lines.join('\n');
  }

  async processTranscript(botId: string, meeting: any, transcriptId?: string) {
    const microserviceUrl = this.configService.get<string>('VMA_MICROSERVICE_URL');

    if (!microserviceUrl) {
      this.logger.error('VMA_MICROSERVICE_URL is not configured.');
      return;
    }

    try {
      this.logger.log(`Fetching transcript for bot ${botId}...`);

      let transcriptText = '';
      try {
        transcriptText = await this.fetchTranscriptFromRecall(transcriptId ?? meeting.transcriptId);
      } catch (err: any) {
        this.logger.warn(`Could not fetch transcript for bot ${botId}: ${err.message}`);
        transcriptText = 'Transcript could not be retrieved from Recall.ai API.';
      }

      if (!transcriptText || transcriptText.trim().length === 0) {
        this.logger.warn(`Transcript is empty for meeting ${meeting._id}`);
        transcriptText = "(Empty transcript)";
      }

      this.logger.log(`Calling microservice for analysis and PDF generation...`);
      const payload = {
        transcript: transcriptText,
        meeting_title: meeting.title,
        meeting_date: meeting.startTime?.toISOString() || new Date().toISOString(),
      };
      // 2. Fetch JSON Summary
      const analysisRes = await firstValueFrom(
        this.httpService.post(`${microserviceUrl}/analyse`, payload)
      );

      const summaryData = analysisRes.data;
      // 3. Update Meeting with Summary Data
      await this.meetingModel.findByIdAndUpdate(meeting._id, {
        summaryData: { ...summaryData, transcript: transcriptText }
      }, { runValidators: false });

      // 4. Fetch PDF Report
      const pdfRes = await firstValueFrom(
        this.httpService.post(`${microserviceUrl}/report/pdf`, payload, {
          responseType: 'arraybuffer'
        })
      );
      const pdfBuffer = Buffer.from(pdfRes.data);

      // 5. Send Email
      let emailAddress = 'admin@omnisuiteai.com'; // fallback

      if (meeting.createdBy && meeting.createdBy !== 'manual-summon') {
        const user = await this.userModel.findById(meeting.createdBy);
        if (user && user.email) {
          emailAddress = user.email;
        }
      }

      await this.mailService.sendMeetingReport(emailAddress, meeting.title, pdfBuffer);
      this.logger.log(`Finished processing transcript for meeting ${meeting._id}`);

    } catch (error: any) {
      this.logger.error(`Error processing transcript for bot ${botId}:`, error.message);
    }
  }


  async getMeetingReportPdf(meetingId: string): Promise<Buffer> {
    const meeting = await this.meetingModel.findById(meetingId);
    if (!meeting) throw new NotFoundException('Meeting not found');

    let transcriptText = '';

    if (meeting.recallBotId) {
      try {
        transcriptText = await this.fetchTranscriptFromRecall(meeting.recallBotId);
      } catch (err: any) {
        this.logger.warn(`Could not fetch transcript from Recall: ${err.message}`);
        transcriptText = 'Transcript could not be retrieved from Recall.ai API.';
      }
    } else {
      // Fetch from ChatService
      if (meeting.roomId) {
        const messages = await this.chatService.getMessages(meeting.roomId);
        transcriptText = messages.length > 0
          ? messages.map(m => `[${new Date(m.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}] ${m.userName}: ${m.message}`).join('\n')
          : 'No messages available.';
      } else {
        transcriptText = 'No transcript available.';
      }
    }

    const microserviceUrl = this.configService.get<string>('VMA_MICROSERVICE_URL');
    if (!microserviceUrl) throw new InternalServerErrorException('Microservice URL not configured');

    const payload = {
      transcript: transcriptText || '(Empty transcript)',
      meeting_title: meeting.title,
      meeting_date: meeting.startTime?.toISOString() || new Date().toISOString(),
    };

    const pdfRes = await firstValueFrom(
      this.httpService.post(`${microserviceUrl}/report/pdf`, payload, {
        responseType: 'arraybuffer'
      })
    );

    return Buffer.from(pdfRes.data);
  }
}
