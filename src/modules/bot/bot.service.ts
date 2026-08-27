import { Injectable, Logger, NotFoundException, InternalServerErrorException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
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
    @InjectModel(CalendarToken.name) private tokenModel: Model<CalendarToken>,
    private httpService: HttpService,
    private configService: ConfigService,
    private mailService: MailService,
    private chatService: ChatService,
  ) { }

  @Cron(CronExpression.EVERY_MINUTE)
  async checkUpcomingMeetings() {
    this.logger.debug('Checking for upcoming/live meetings to auto-deploy bot...');
    const now = new Date();
    const tenMinutesFromNow = new Date(now.getTime() + 10 * 60000);
    const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60000);

    const upcomingMeetings = await this.meetingModel.find({
      meetingLink: { $exists: true, $ne: '' },
      $and: [
        {
          $or: [
            { recallBotId: { $exists: false } },
            { recallBotId: null },
            { recallBotId: '' },
          ],
        },
        {
          $or: [
            { botStatus: { $exists: false } },
            { botStatus: { $in: ['none', 'error', null, ''] } },
          ],
        },
        {
          $or: [
            { startTime: { $gte: thirtyMinutesAgo, $lte: tenMinutesFromNow } },
            { startTime: { $lte: now }, endTime: { $gte: now } },
          ],
        },
      ],
    });

    // Deduplicate upcoming meetings by meetingLink so we only attempt one deployment per meeting URL
    const processedLinks = new Set<string>();

    for (const meeting of upcomingMeetings) {
      if (!meeting.meetingLink) continue;
      const normalizedLink = meeting.meetingLink.trim().replace(/\/$/, '');
      if (processedLinks.has(normalizedLink)) {
        continue;
      }
      processedLinks.add(normalizedLink);

      this.logger.log(`Auto-deploying bot for meeting: ${meeting.title} (${meeting._id})`);
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

    if (!meeting.meetingLink) {
      this.logger.error(`Meeting ${meeting._id} missing meetingLink.`);
      return { success: false, reason: 'Missing meeting link' };
    }

    const rawLink = meeting.meetingLink.replace(/&amp;/g, '&').replace(/[\r\n\t]/g, '').trim();
    const cleanLink = rawLink.replace(/\/$/, '');
    const linkVariants = Array.from(new Set([rawLink, cleanLink, cleanLink + '/']));

    // Check if an ACTIVE bot is currently live/ongoing on another meeting using this link
    const now = new Date();
    const activeMeeting = await this.meetingModel.findOne({
      meetingLink: { $in: linkVariants },
      _id: { $ne: meeting._id },
      endTime: { $gte: now },
      botStatus: {
        $in: [
          'joining',
          'joined',
          'recording',
          'bot.joining_call',
          'bot.in_waiting_room',
          'bot.in_call_recording',
          'bot.in_call_not_recording',
        ],
      },
    });

    if (activeMeeting) {
      this.logger.warn(`Bot join skipped for meeting link ${cleanLink}: bot already active on live meeting ${activeMeeting._id}`);
      return { success: false, reason: 'Bot already active or joining on another live meeting' };
    }

    // Atomically transition status to 'joining' for target meeting ID only
    const updateResult = await this.meetingModel.updateOne(
      {
        _id: meeting._id,
        $and: [
          { $or: [{ recallBotId: { $exists: false } }, { recallBotId: null }, { recallBotId: '' }] },
          { $or: [{ botStatus: { $exists: false } }, { botStatus: { $in: ['none', 'error', null, ''] } }] },
        ],
      },
      { $set: { botStatus: 'joining' } },
    );

    if (!updateResult.matchedCount || updateResult.modifiedCount === 0) {
      this.logger.warn(`Bot join skipped for meeting ${meeting._id}: already joining or active.`);
      return { success: false, reason: 'Bot already active or joining' };
    }

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${baseUrl}/bot`,
          {
            meeting_url: rawLink,
            bot_name: botName,
            metadata: { meetingId: meeting._id.toString() },
            automatic_leave: {
              everyone_left_timeout: {
                timeout: 300 // 5 minutes (reduced from 7200/2 hours to send reports faster)
              }
            },
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
      this.logger.log(`Successfully requested bot for meeting link ${cleanLink}. Bot ID: ${botId}`);

      // Update specific target meeting record with recallBotId
      await this.meetingModel.updateOne(
        { _id: meeting._id },
        { $set: { recallBotId: botId, botStatus: 'joining' } },
        { runValidators: false }
      );

      return { success: true, botId };
    } catch (error: any) {
      this.logger.error(`Failed to trigger bot for meeting link ${cleanLink}`, error.response?.data || error.message);
      await this.meetingModel.updateOne(
        { _id: meeting._id, botStatus: 'joining' },
        { $set: { botStatus: 'error' } },
        { runValidators: false }
      );
      return { success: false, error: error.message };
    }
  }

  private isValidRecipientEmail(email?: string): boolean {
    if (!email || typeof email !== 'string') return false;
    const trimmed = email.trim().toLowerCase();
    if (!trimmed.includes('@')) return false;
    // Reject Microsoft Graph synthetic email address alias format (e.g. outlook_719D012E381A18BE@outlook.com)
    if (trimmed.startsWith('outlook_') && trimmed.endsWith('@outlook.com')) return false;
    return true;
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
      await this.meetingModel.updateMany(
        { $or: [{ recallBotId: botId }, { _id: meeting._id }] },
        { $set: { summaryData: { ...summaryData, transcript: transcriptText } } },
        { runValidators: false }
      );

      // 4. Fetch PDF Report
      const pdfRes = await firstValueFrom(
        this.httpService.post(`${microserviceUrl}/report/pdf`, payload, {
          responseType: 'arraybuffer'
        })
      );
      const pdfBuffer = Buffer.from(pdfRes.data);

      // 5. Determine Recipient Email Address
      // Resolution order:
      // Priority 1: Connected Calendar Token email (microsoftEmail / googleEmail) for createdBy / hostId
      // Priority 2: Account email stored on Meeting schema (microsoftAccount / googleAccount)
      // Priority 3: VMA User profile email (User.email)
      // Priority 4: Real meeting.organizerEmail (excluding synthetic outlook_*@outlook.com addresses)
      // Priority 5: Fallback to admin

      let emailAddress = '';
      const userIds = [meeting.createdBy, meeting.hostId].filter(
        (id) => id && isValidObjectId(id),
      );

      // Check CalendarToken for linked user(s)
      if (userIds.length > 0) {
        const tokens = await this.tokenModel.find({ userId: { $in: userIds } });

        // Match meeting provider first if applicable
        if (meeting.provider === 'microsoft') {
          const msToken = tokens.find(
            (t) => t.provider === 'microsoft' && this.isValidRecipientEmail(t.microsoftEmail),
          );
          if (msToken?.microsoftEmail) {
            emailAddress = msToken.microsoftEmail;
          }
        } else if (meeting.provider === 'google') {
          const gToken = tokens.find(
            (t) => t.provider === 'google' && this.isValidRecipientEmail(t.googleEmail),
          );
          if (gToken?.googleEmail) {
            emailAddress = gToken.googleEmail;
          }
        }

        // Check any valid connected token for the user
        if (!emailAddress) {
          for (const t of tokens) {
            if (t.provider === 'microsoft' && this.isValidRecipientEmail(t.microsoftEmail)) {
              emailAddress = t.microsoftEmail!;
              break;
            }
            if (t.provider === 'google' && this.isValidRecipientEmail(t.googleEmail)) {
              emailAddress = t.googleEmail!;
              break;
            }
          }
        }
      }

      // Check stored meeting properties
      if (!emailAddress && this.isValidRecipientEmail(meeting.microsoftAccount)) {
        emailAddress = meeting.microsoftAccount!;
      }
      if (!emailAddress && this.isValidRecipientEmail(meeting.googleAccount)) {
        emailAddress = meeting.googleAccount!;
      }

      // Check VMA User database email
      if (!emailAddress && userIds.length > 0) {
        for (const uid of userIds) {
          const user = await this.userModel.findById(uid);
          if (user && this.isValidRecipientEmail(user.email)) {
            emailAddress = user.email;
            break;
          }
        }
      }

      // Check string createdBy/hostId if they are direct emails
      if (!emailAddress && typeof meeting.createdBy === 'string' && this.isValidRecipientEmail(meeting.createdBy)) {
        emailAddress = meeting.createdBy;
      }
      if (!emailAddress && typeof meeting.hostId === 'string' && this.isValidRecipientEmail(meeting.hostId)) {
        emailAddress = meeting.hostId;
      }

      // Check organizerEmail (only if valid and non-synthetic)
      if (!emailAddress && this.isValidRecipientEmail(meeting.organizerEmail)) {
        emailAddress = meeting.organizerEmail!;
      }

      // Fallback
      if (!emailAddress) {
        emailAddress = 'admin@omnisuiteai.com';
      }

      this.logger.log(`Sending meeting report for ${meeting.title} (${meeting._id}) to: ${emailAddress}`);
      await this.mailService.sendMeetingReport(emailAddress, meeting.title, pdfBuffer);
      this.logger.log(`Finished processing transcript and sent report to ${emailAddress} for meeting ${meeting._id}`);

      // Clear recallBotId and set botStatus to 'none', while logging summary delivery details
      await this.meetingModel.updateMany(
        { $or: [{ recallBotId: botId }, { _id: meeting._id }] },
        {
          $set: {
            botStatus: 'none',
            recallBotId: null,
            summarySentTo: [emailAddress],
            summarySentAt: new Date(),
            summaryStatus: 'sent',
            summaryError: null,
          }
        },
        { runValidators: false }
      );
    } catch (error: any) {
      this.logger.error(`Error processing transcript for bot ${botId}:`, error.message);
      await this.meetingModel.updateMany(
        { $or: [{ recallBotId: botId }, { _id: meeting._id }] },
        {
          $set: {
            summaryStatus: 'failed',
            summaryError: error.message,
          }
        },
        { runValidators: false }
      );
    }
  }


  async getMeetingReportPdf(meetingId: string): Promise<Buffer> {
    const meeting = await this.meetingModel.findById(meetingId);
    if (!meeting) throw new NotFoundException('Meeting not found');

    let transcriptText = '';

    // Check stored summaryData transcript from MongoDB first
    if (meeting.summaryData?.transcript) {
      transcriptText = meeting.summaryData.transcript;
    }
    // Otherwise try fetching directly from Recall if active/available
    else if (meeting.transcriptId || meeting.recallBotId) {
      try {
        transcriptText = await this.fetchTranscriptFromRecall(meeting.transcriptId || meeting.recallBotId);
      } catch (err: any) {
        this.logger.warn(`Could not fetch transcript from Recall: ${err.message}`);
      }
    }

    // Fallback to in-app room chat messages if transcript is still empty
    if (!transcriptText || transcriptText === 'Transcript could not be retrieved from Recall.ai API.') {
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

  async leaveMeetingBot(botId: string) {
    const apiKey = this.configService.get<string>('RECALL_API_KEY');
    const baseUrl = this.configService.get<string>('RECALL_BASE_URL');

    if (!apiKey || !baseUrl) {
      this.logger.error('Recall.ai API Key or Base URL is missing.');
      return;
    }

    try {
      this.logger.log(`Instructing Recall bot ${botId} to leave call...`);
      await firstValueFrom(
        this.httpService.post(
          `${baseUrl}/bot/${botId}/leave_call/`,
          {},
          {
            headers: {
              'Authorization': `Token ${apiKey}`,
              'Content-Type': 'application/json'
            }
          }
        )
      );
      this.logger.log(`Successfully sent leave_call for bot ${botId}`);
    } catch (error: any) {
      this.logger.error(`Failed to send leave_call for bot ${botId}:`, error.response?.data || error.message);
    }
  }
}
