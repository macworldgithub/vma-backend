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

    // Auto-fix any meeting records contaminated by past recurring meeting webhooks
    // (e.g. where botLeftAt is before startTime or future meetings were pre-marked as ENDED/done)
    try {
      // Case A: Reset future meetings that were incorrectly pre-marked as ENDED/done
      await this.meetingModel.updateMany(
        {
          $or: [
            // Bot left before the meeting even started (recurring contamination)
            {
              botLeftAt: { $exists: true, $ne: null },
              $expr: { $lt: ['$botLeftAt', '$startTime'] },
            },
            // Future meeting incorrectly marked as ENDED/done
            {
              startTime: { $gt: now },
              $or: [
                { botStatus: { $in: ['bot.done', 'call_ended', 'done'] } },
                { status: 'ENDED' },
              ],
            },
          ],
        },
        {
          $set: { botStatus: 'none', status: 'SCHEDULED', recallBotId: null },
          $unset: { botLeftAt: 1, botJoinedAt: 1 },
        },
      );

      // Case B: Auto-mark meetings as ENDED if their endTime has passed but status is still
      // SCHEDULED or LIVE and no active bot is running. This prevents the cron from
      // re-deploying a bot to a meeting that has already finished.
      await this.meetingModel.updateMany(
        {
          endTime: { $lt: now },
          status: { $in: ['SCHEDULED', 'LIVE'] },
          $or: [
            { recallBotId: null },
            { recallBotId: { $exists: false } },
            { botStatus: { $in: ['none', 'error', 'call_ended', 'bot.done', null, ''] } },
          ],
        },
        {
          $set: { status: 'ENDED' },
        },
      );
    } catch (err: any) {
      this.logger.error('Error auto-sanitizing contaminated recurring meetings:', err.message);
    }

    // CRITICAL GUARD: Only auto-deploy bot if:
    // 1) The meeting is an internal/manual meeting (source != 'calendar'), OR
    // 2) The user is explicitly the organizer of the calendar meeting (isOrganizer === true).
    // NEVER auto-deploy bots to external meetings where the user is just an attendee!
    const upcomingMeetings = await this.meetingModel.find({
      meetingLink: { $exists: true, $ne: '' },
      status: { $ne: 'ENDED' },
      $or: [
        { source: { $ne: 'calendar' } },
        { isOrganizer: true },
      ],
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

      this.logger.log(`Auto-deploying bot for hosted meeting: ${meeting.title} (${meeting._id})`);
      await this.joinMeeting(meeting);
    }
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async retryPendingOrFailedReports() {
    this.logger.debug('Checking for pending or failed meeting reports to auto-retry...');
    try {
      const candidates = await this.meetingModel.find({
        $and: [
          {
            $or: [
              { summaryStatus: { $in: ['failed', 'none', 'pending'] } },
              { summaryStatus: { $exists: false } },
              {
                summaryStatus: 'processing',
                summaryProcessingStartedAt: { $lt: new Date(Date.now() - 10 * 60 * 1000) },
              },
            ],
          },
          {
            $or: [
              { transcriptId: { $exists: true, $nin: [null, ''] } },
              { recallBotId: { $exists: true, $nin: [null, ''] } },
            ],
          },
          {
            $or: [
              { summaryRetryCount: { $exists: false } },
              { summaryRetryCount: { $lt: 5 } },
            ],
          },
        ],
      });

      if (!candidates || candidates.length === 0) return;

      for (const meeting of candidates) {
        // Only retry if meeting ended or bot status is bot.done / call_ended
        const isEnded =
          meeting.status === 'ENDED' ||
          ['bot.done', 'call_ended', 'done'].includes(meeting.botStatus || '');

        if (!isEnded) continue;

        const effectiveBotId = meeting.recallBotId || (meeting as any).previousBotIds?.[0] || 'legacy';
        this.logger.log(
          `Auto-retrying report processing for meeting: ${meeting.title} (${meeting._id}), attempt #${(meeting.summaryRetryCount || 0) + 1}`,
        );

        await this.processTranscript(effectiveBotId, meeting, meeting.transcriptId);
      }
    } catch (err: any) {
      this.logger.error('Error during auto-retry of meeting reports:', err?.message || err);
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
      this.logger.log(`Requesting Recall bot for meeting link: ${cleanLink}`);
      const response = await firstValueFrom(
        this.httpService.post(
          `${baseUrl}/bot/`,
          {
            meeting_url: cleanLink,
            bot_name: botName,
          },
          {
            headers: {
              Authorization: `Token ${apiKey}`,
              'Content-Type': 'application/json',
            },
          },
        ),
      );

      const botId = response.data.id;
      this.logger.log(`Successfully requested bot for meeting link ${cleanLink}. Bot ID: ${botId}`);

      // Update specific target meeting record with recallBotId
      await this.meetingModel.updateOne(
        { _id: meeting._id },
        { $set: { recallBotId: botId, botStatus: 'joining' } },
        { runValidators: false },
      );

      return { success: true, botId };
    } catch (error: any) {
      this.logger.error(`Failed to trigger bot for meeting link ${cleanLink}`, error.response?.data || error.message);
      await this.meetingModel.updateOne(
        { _id: meeting._id, botStatus: 'joining' },
        { $set: { botStatus: 'error' } },
        { runValidators: false },
      );
      return { success: false, error: error.message };
    }
  }

  async removeBot(meetingId: string) {
    const meeting = await this.meetingModel.findById(meetingId);
    if (!meeting) {
      throw new NotFoundException('Meeting not found');
    }

    const botId = meeting.recallBotId;
    if (botId) {
      const apiKey = this.configService.get<string>('RECALL_API_KEY');
      const baseUrl = this.configService.get<string>('RECALL_BASE_URL');

      if (!apiKey || !baseUrl) {
        throw new InternalServerErrorException('Recall API config missing');
      }

      try {
        await firstValueFrom(
          this.httpService.post(`${baseUrl}/bot/${botId}/leave_call/`, null, {
            headers: {
              Authorization: `Token ${apiKey}`,
              'Content-Type': 'application/json',
            },
          }),
        );
      } catch (error: any) {
        if (error.response?.status !== 404) {
          this.logger.error(
            `Failed to remove bot ${botId} via leave_call: ${JSON.stringify(error.response?.data || error.message)}`,
          );
          throw new InternalServerErrorException('Bot could not be removed from the call');
        }
      }
    }

    await this.meetingModel.updateOne(
      { _id: meeting._id },
      {
        $set: { botStatus: 'uninvited', recallBotId: null, botLeftAt: new Date() },
        ...(botId ? { $addToSet: { previousBotIds: botId } } : {}),
      },
      { runValidators: false },
    );

    return { message: 'Bot removed from meeting', meetingId: meeting._id };
  }

  private isValidRecipientEmail(email?: string): boolean {
    if (!email || typeof email !== 'string') return false;
    const trimmed = email.trim().toLowerCase();
    if (!trimmed.includes('@')) return false;
    // Reject Microsoft Graph synthetic email address alias format (e.g. outlook_719D012E381A18BE@outlook.com)
    if (trimmed.startsWith('outlook_') && trimmed.endsWith('@outlook.com')) return false;
    return true;
  }

  private async resolveRecipientEmail(meeting: any): Promise<string> {
    let emailAddress = '';

    // Priority 1: If organizerEmail is explicitly provided, non-synthetic, and valid
    // This ensures meeting reports for calendar meetings are ALWAYS sent to the organizer (e.g., Sarah)
    if (this.isValidRecipientEmail(meeting.organizerEmail)) {
      emailAddress = meeting.organizerEmail!.trim().toLowerCase();
      this.logger.log(`Resolved recipient email from organizerEmail: ${emailAddress} for meeting ${meeting._id}`);
      return emailAddress;
    }

    // Priority 2: For in-app VMA meetings or meetings with a valid hostId
    // Check hostId user first (the creator/host of the meeting)
    if (meeting.hostId && isValidObjectId(meeting.hostId)) {
      const hostUser = await this.userModel.findById(meeting.hostId);
      if (hostUser && this.isValidRecipientEmail(hostUser.email)) {
        emailAddress = hostUser.email.trim().toLowerCase();
      } else {
        const hostToken = await this.tokenModel.findOne({ userId: meeting.hostId });
        if (hostToken?.microsoftEmail && this.isValidRecipientEmail(hostToken.microsoftEmail)) {
          emailAddress = hostToken.microsoftEmail.trim().toLowerCase();
        } else if (hostToken?.googleEmail && this.isValidRecipientEmail(hostToken.googleEmail)) {
          emailAddress = hostToken.googleEmail.trim().toLowerCase();
        }
      }

      if (emailAddress) {
        this.logger.log(`Resolved recipient email from hostId (${meeting.hostId}): ${emailAddress}`);
        return emailAddress;
      }
    }

    // Priority 3: Check createdBy user
    if (meeting.createdBy && isValidObjectId(meeting.createdBy)) {
      const creatorUser = await this.userModel.findById(meeting.createdBy);
      if (creatorUser && this.isValidRecipientEmail(creatorUser.email)) {
        emailAddress = creatorUser.email.trim().toLowerCase();
      } else {
        const creatorToken = await this.tokenModel.findOne({ userId: meeting.createdBy });
        if (creatorToken?.microsoftEmail && this.isValidRecipientEmail(creatorToken.microsoftEmail)) {
          emailAddress = creatorToken.microsoftEmail.trim().toLowerCase();
        } else if (creatorToken?.googleEmail && this.isValidRecipientEmail(creatorToken.googleEmail)) {
          emailAddress = creatorToken.googleEmail.trim().toLowerCase();
        }
      }

      if (emailAddress) {
        this.logger.log(`Resolved recipient email from createdBy (${meeting.createdBy}): ${emailAddress}`);
        return emailAddress;
      }
    }

    // Priority 4: If isOrganizer !== false, check stored provider accounts
    if (meeting.isOrganizer !== false) {
      if (this.isValidRecipientEmail(meeting.microsoftAccount)) {
        emailAddress = meeting.microsoftAccount!.trim().toLowerCase();
      } else if (this.isValidRecipientEmail(meeting.googleAccount)) {
        emailAddress = meeting.googleAccount!.trim().toLowerCase();
      }
    }

    // Priority 5: Check string createdBy/hostId if direct email string
    if (!emailAddress && typeof meeting.createdBy === 'string' && this.isValidRecipientEmail(meeting.createdBy)) {
      emailAddress = meeting.createdBy.trim().toLowerCase();
    }
    if (!emailAddress && typeof meeting.hostId === 'string' && this.isValidRecipientEmail(meeting.hostId)) {
      emailAddress = meeting.hostId.trim().toLowerCase();
    }

    // Fallback
    if (!emailAddress) {
      emailAddress = 'admin@omnisuiteai.com';
    }

    return emailAddress;
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
        headers: { Authorization: `Token ${apiKey}` },
      }),
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
      this.logger.log(`Processing transcript for Bot ${botId} on meeting ${meeting.title} (${meeting._id})`);

      await this.meetingModel.updateOne(
        { _id: meeting._id },
        {
          $set: {
            summaryStatus: 'processing',
            summaryProcessingStartedAt: new Date(),
          },
        },
        { runValidators: false },
      );

      // 1. Fetch Raw Transcript
      let transcriptText = '';
      try {
        transcriptText = await this.fetchTranscriptFromRecall(transcriptId || meeting.transcriptId);
      } catch (transcriptErr: any) {
        this.logger.warn(`Recall transcript fetch failed: ${transcriptErr.message}. Fallback to chat/empty.`);
        transcriptText = '';
      }

      const cleanTranscript = (transcriptText || '')
        .replace(/Transcript could not be retrieved.*/gi, '')
        .replace(/\(Empty transcript\)/gi, '')
        .trim();

      if (!cleanTranscript || cleanTranscript.length < 20) {
        const reason =
          'No transcript recorded (bot was not admitted to call or meeting had no spoken words).';
        this.logger.warn(
          `Skipping summary generation and email report for meeting ${meeting._id}: ${reason}`,
        );
        await this.meetingModel.updateOne(
          { _id: meeting._id },
          {
            $set: {
              summaryStatus: 'skipped_empty_transcript',
              summaryError: reason,
            },
          },
          { runValidators: false },
        );

        // Send informational email notification to host explaining why report was skipped
        try {
          const recipientEmail = await this.resolveRecipientEmail(meeting);
          if (recipientEmail && recipientEmail !== 'admin@omnisuiteai.com') {
            await this.mailService.sendReportSkippedNotification(
              recipientEmail,
              meeting.title,
              'The virtual assistant was kept in the waiting room or no spoken dialogue was recorded during the call.',
            );
          }
        } catch (emailErr: any) {
          this.logger.warn(`Could not send report skipped email notification: ${emailErr.message}`);
        }

        return;
      }

      this.logger.log(`Calling microservice for analysis and PDF generation...`);
      const payload = {
        transcript: transcriptText,
        meeting_title: meeting.title,
        meeting_date: meeting.startTime?.toISOString() || new Date().toISOString(),
      };
      // 2. Fetch JSON Summary
      const analysisRes = await firstValueFrom(
        this.httpService.post(`${microserviceUrl}/analyse`, payload),
      );

      const summaryData = analysisRes.data;
      // 3. Update Meeting with Summary Data
      await this.meetingModel.updateMany(
        { $or: [{ recallBotId: botId }, { _id: meeting._id }] },
        { $set: { summaryData: { ...summaryData, transcript: transcriptText } } },
        { runValidators: false },
      );

      // 4. Fetch PDF Report
      const pdfRes = await firstValueFrom(
        this.httpService.post(`${microserviceUrl}/report/pdf`, payload, {
          responseType: 'arraybuffer',
        }),
      );
      const pdfBuffer = Buffer.from(pdfRes.data);

      // 5. Determine Recipient Email Address (ALWAYS resolved to Organizer/Host)
      const emailAddress = await this.resolveRecipientEmail(meeting);

      this.logger.log(`Sending meeting report for ${meeting.title} (${meeting._id}) to: ${emailAddress}`);
      await this.mailService.sendMeetingReport(emailAddress, meeting.title, pdfBuffer);
      this.logger.log(`Finished processing transcript and sent report to ${emailAddress} for meeting ${meeting._id}`);

      // Record summary sent
      await this.meetingModel.updateOne(
        { _id: meeting._id },
        {
          $addToSet: { summarySentTo: emailAddress },
          $set: {
            summarySentAt: new Date(),
            summaryStatus: 'sent',
            summaryError: null,
          },
        },
        { runValidators: false },
      );

      // Release lock if this bot is still active
      const lockRelease = await this.meetingModel.updateOne(
        { _id: meeting._id, recallBotId: botId },
        { $set: { botStatus: 'none', recallBotId: null } },
        { runValidators: false },
      );
      if (lockRelease.matchedCount === 0) {
        this.logger.log(
          `Skipped lock release for bot ${botId} on meeting ${meeting._id} - a newer bot is already active.`,
        );
      }
    } catch (error: any) {
      this.logger.error(`Error processing transcript for bot ${botId}:`, error.message);
      await this.meetingModel.updateMany(
        { $or: [{ recallBotId: botId }, { _id: meeting._id }] },
        {
          $set: {
            summaryStatus: 'failed',
            summaryError: error.message,
          },
          $inc: { summaryRetryCount: 1 },
        },
        { runValidators: false },
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
        responseType: 'arraybuffer',
      }),
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
              Authorization: `Token ${apiKey}`,
              'Content-Type': 'application/json',
            },
          },
        ),
      );
      this.logger.log(`Successfully sent leave_call for bot ${botId}`);
    } catch (error: any) {
      this.logger.error(`Failed to send leave_call for bot ${botId}:`, error.response?.data || error.message);
    }
  }
}
