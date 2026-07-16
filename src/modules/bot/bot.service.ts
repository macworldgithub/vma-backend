import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Meeting } from '../meetings/schemas/meeting.schema';
import { User } from '../users/users.schema';
import { MailService } from '../mail/mail.service';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class BotService {
  private readonly logger = new Logger(BotService.name);

  constructor(
    @InjectModel(Meeting.name) private meetingModel: Model<Meeting>,
    @InjectModel(User.name) private userModel: Model<User>,
    private httpService: HttpService,
    private configService: ConfigService,
    private mailService: MailService,
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
      await this.meetingModel.findByIdAndUpdate(meeting._id, { botStatus: 'joining' });

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
      });

    } catch (error: any) {
      this.logger.error(`Failed to trigger bot for meeting ${meeting._id}`, error.response?.data || error.message);
      await this.meetingModel.findByIdAndUpdate(meeting._id, { botStatus: 'error' });
    }
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
      
      // 1. Fetch transcript from Recall.ai (using the bot transcript endpoint)
      // Note: Recall.ai usually requires getting the bot details or transcript URL.
      // Assuming a generic GET /bot/{id}/transcript logic based on standard implementation:
      let transcriptText = '';
      try {
        const transcriptRes = await firstValueFrom(
          this.httpService.get(`${baseUrl}/bot/${botId}/transcript`, {
            headers: { 'Authorization': `Token ${apiKey}` }
          })
        );
        // Assuming Recall returns an array of transcript segments, we format them as a block
        // Or if it returns text directly, we use it.
        const transcriptData = transcriptRes.data;
        if (Array.isArray(transcriptData)) {
          transcriptText = transcriptData.map((t: any) => `${t.speaker}: ${t.text}`).join('\n');
        } else if (typeof transcriptData === 'string') {
          transcriptText = transcriptData;
        } else if (transcriptData.text) {
          transcriptText = transcriptData.text;
        }
      } catch (err: any) {
        this.logger.warn(`Could not fetch transcript directly, using fallback empty transcript. Error: ${err.message}`);
        transcriptText = 'Transcript could not be retrieved from Recall.ai API.';
      }

      if (!transcriptText || transcriptText.trim().length === 0) {
        this.logger.warn(`Transcript is empty for meeting ${meeting._id}`);
        // We still proceed, maybe to send an empty report or error report
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
      await this.meetingModel.findByIdAndUpdate(meeting._id, { summaryData });

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
}
