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
  ) {}

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
      platform: { $in: ['teams', 'zoom', 'google'] }
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
      return;
    }

    try {
      await this.meetingModel.findByIdAndUpdate(meeting._id, { botStatus: 'joining' }, { runValidators: false });

      const response = await firstValueFrom(
        this.httpService.post(
          `${baseUrl}/bot`,
          {
            meeting_url: meeting.meetingLink,
            bot_name: botName,
            metadata: { meetingId: meeting._id.toString() } 
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
      this.logger.log(`Successfully requested bot for meeting ${meeting._id}. Bot ID: ${botId}`);
      
      await this.meetingModel.findByIdAndUpdate(meeting._id, { 
        recallBotId: botId,
        botStatus: 'joining'
      }, { runValidators: false });

    } catch (error: any) {
      this.logger.error(`Failed to trigger bot for meeting ${meeting._id}`, error.response?.data || error.message);
      await this.meetingModel.findByIdAndUpdate(meeting._id, { botStatus: 'error' }, { runValidators: false });
    }
  }

  private async fetchTranscriptFromRecall(botId: string): Promise<string> {
    const apiKey = this.configService.get<string>('RECALL_API_KEY');
    const baseUrl = this.configService.get<string>('RECALL_BASE_URL');

    if (!apiKey || !baseUrl) {
      throw new InternalServerErrorException('Recall API config missing');
    }

    // Step 1: Retrieve the bot to get its recordings + media_shortcuts
    const botRes = await firstValueFrom(
      this.httpService.get(`${baseUrl}/bot/${botId}/`, {
        headers: { 'Authorization': `Token ${apiKey}` }
      })
    );

    const recordings = botRes.data?.recordings || [];
    if (recordings.length === 0) {
      this.logger.warn(`No recordings found for bot ${botId}`);
      return 'Transcript could not be retrieved from Recall.ai API.';
    }

    // Step 2: Collect transcript download URLs across all recordings
    // (a meeting can produce multiple recordings, e.g. pause/resume)
    const downloadUrls: string[] = recordings
      .map((r: any) => r.media_shortcuts?.transcript?.data?.download_url)
      .filter(Boolean);

    if (downloadUrls.length === 0) {
      this.logger.warn(`No transcript media_shortcut found for bot ${botId}`);
      return 'Transcript could not be retrieved from Recall.ai API.';
    }

    // Step 3: Fetch and merge transcript segments from each download_url
    // download_url is a pre-signed link — no Authorization header needed
    const allLines: string[] = [];

    for (const url of downloadUrls) {
      try {
        const transcriptRes = await firstValueFrom(this.httpService.get(url));
        const segments = transcriptRes.data;

        if (Array.isArray(segments)) {
          const lines = segments
            .map((segment: any) => {
              const speaker = segment.participant?.name || segment.speaker || 'Unknown';
              const text = Array.isArray(segment.words)
                ? segment.words.map((w: any) => w.text || w.word || '').join(' ')
                : (segment.text || '');
              return `${speaker}: ${text.trim()}`;
            })
            .filter((line: string) => line.trim().length > 2);
          allLines.push(...lines);
        }
      } catch (err: any) {
        this.logger.warn(`Failed to download transcript segment: ${err.message}`);
      }
    }

    return allLines.join('\n');
  }

  async processTranscript(botId: string, meeting: any) {
    const apiKey = this.configService.get<string>('RECALL_API_KEY');
    const baseUrl = this.configService.get<string>('RECALL_BASE_URL');
    const microserviceUrl = this.configService.get<string>('VMA_MICROSERVICE_URL');

    if (!microserviceUrl) {
      this.logger.error('VMA_MICROSERVICE_URL is not configured.');
      return;
    }

    try {
      this.logger.log(`Fetching transcript for bot ${botId}...`);

      let transcriptText = '';
      try {
        transcriptText = await this.fetchTranscriptFromRecall(botId);
        this.logger.log(`Transcript fetched. Length: ${transcriptText.length} chars`);
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
      await this.meetingModel.findByIdAndUpdate(meeting._id, { summaryData }, { runValidators: false });

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
