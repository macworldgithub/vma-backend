import { Injectable, Logger, NotFoundException, InternalServerErrorException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Meeting } from '../meetings/schemas/meeting.schema';
import { User } from '../users/users.schema';
import { CalendarToken } from '../calendar/schemas/calendar-token.schema';
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
    @InjectModel(CalendarToken.name) private calendarTokenModel: Model<CalendarToken>,
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
            metadata: { meetingId: meeting._id.toString() },
            recording_config: {
              transcript: {
                provider: {
                  recallai_streaming: {
                    mode: 'prioritize_accuracy',
                    language_code: 'en' // or your target language
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
      console.log(payload, "PAYLOAD")
      // 2. Fetch JSON Summary
      const analysisRes = await firstValueFrom(
        this.httpService.post(`${microserviceUrl}/analyse`, payload)
      );

      const summaryData = analysisRes.data;
      console.log(transcriptText, "Transcript Text")
      console.log(summaryData, "SummaryData")
      // 3. Update Meeting with Summary Data
      await this.meetingModel.findByIdAndUpdate(meeting._id, {
        summaryData: { ...summaryData, transcript: transcriptText }
      }, { runValidators: false });

      // Match speakers to VMA users
      const speakerNames = new Set<string>();
      const speakerRegex = /^(?:\[\d{1,2}:\d{2}\]\s*)?([^:\n]+):/gm;
      let match;
      while ((match = speakerRegex.exec(transcriptText)) !== null) {
        const name = match[1].trim();
        if (name && name.length < 50 && !/^\d{1,2}:\d{2}$/.test(name)) {
          speakerNames.add(name);
        }
      }

      const matchedUserIds: string[] = [];

      // 1. Resolve invited emails from calendar invite list to VMA user IDs
      const inviteeEmails = (meeting.participants || []).filter((p: string) => p.includes('@'));
      if (inviteeEmails.length > 0) {
        try {
          // 1a. Direct match: invitee email matches VMA login email
          const registeredInvitees = await this.userModel.find({
            email: { $in: inviteeEmails }
          });
          matchedUserIds.push(...registeredInvitees.map(u => u._id.toString()));

          // 1b. Microsoft calendar link match: invitee email matches a linked Microsoft account
          const alreadyMatchedEmails = registeredInvitees.map(u => u.email);
          const unmatchedEmails = inviteeEmails.filter((e: string) => !alreadyMatchedEmails.includes(e));
          if (unmatchedEmails.length > 0) {
            const calendarTokens = await this.calendarTokenModel.find({
              microsoftEmail: { $in: unmatchedEmails },
            });
            for (const ct of calendarTokens) {
              this.logger.log(`Resolved Microsoft email ${ct.microsoftEmail} → VMA userId ${ct.userId}`);
              matchedUserIds.push(ct.userId);
            }
          }
        } catch (err: any) {
          this.logger.error(`Error resolving invitee emails to user IDs: ${err.message}`);
        }
      }

      // 2. Resolve speaker names to user IDs with deduplication checks
      if (speakerNames.size > 0) {
        const names = Array.from(speakerNames);
        try {
          const matchedUsers = await this.userModel.find({
            name: { $in: names.map(name => new RegExp(`^${name}$`, 'i')) }
          });

          for (const name of names) {
            const usersWithName = matchedUsers.filter(u => u.name.toLowerCase() === name.toLowerCase());
            if (usersWithName.length === 1) {
              // Only one user has this name, safe to match
              matchedUserIds.push(usersWithName[0]._id.toString());
            } else if (usersWithName.length > 1) {
              // Multiple users have this name. Filter to match only the one whose email is in the invite/participant list
              const actualParticipant = usersWithName.find(u => inviteeEmails.includes(u.email));
              if (actualParticipant) {
                matchedUserIds.push(actualParticipant._id.toString());
              }
            }
          }
        } catch (err: any) {
          this.logger.error(`Error matching speaker names to users: ${err.message}`);
        }
      }

      // Ensure creator and host are in participants list
      if (meeting.createdBy && meeting.createdBy !== 'manual-summon') {
        matchedUserIds.push(meeting.createdBy);
      }
      if (meeting.hostId) {
        matchedUserIds.push(meeting.hostId);
      }

      const updatedParticipants = Array.from(new Set([...(meeting.participants || []), ...matchedUserIds]));

      // Save updated participants list back to the meeting document
      await this.meetingModel.findByIdAndUpdate(meeting._id, {
        participants: updatedParticipants
      }, { runValidators: false });

      // 4. Fetch PDF Report
      const pdfRes = await firstValueFrom(
        this.httpService.post(`${microserviceUrl}/report/pdf`, payload, {
          responseType: 'arraybuffer'
        })
      );
      const pdfBuffer = Buffer.from(pdfRes.data);

      // 5. Send Email to all participants
      const participantIds: string[] = [];
      const participantEmails: string[] = [];
      for (const p of updatedParticipants) {
        if (p.includes('@')) {
          participantEmails.push(p);
        } else {
          participantIds.push(p);
        }
      }

      const users = await this.userModel.find({ _id: { $in: participantIds } });
      const emails = [
        ...users.map(u => u.email),
        ...participantEmails
      ].filter(Boolean);

      if (emails.length === 0) {
        let fallbackEmail = 'admin@omnisuiteai.com';
        if (meeting.createdBy && meeting.createdBy !== 'manual-summon') {
          const user = await this.userModel.findById(meeting.createdBy);
          if (user && user.email) {
            fallbackEmail = user.email;
          }
        }
        emails.push(fallbackEmail);
      }

      const uniqueEmails = Array.from(new Set(emails));
      this.logger.log(`Sending meeting reports to: ${uniqueEmails.join(', ')}`);
      for (const email of uniqueEmails) {
        try {
          await this.mailService.sendMeetingReport(email, meeting.title, pdfBuffer);
        } catch (mailErr: any) {
          this.logger.error(`Failed to send email to ${email}: ${mailErr.message}`);
        }
      }

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
