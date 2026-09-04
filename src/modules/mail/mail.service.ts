import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
  private transporter: nodemailer.Transporter;
  private readonly logger = new Logger(MailService.name);

  constructor(private configService: ConfigService) {
    this.transporter = nodemailer.createTransport({
      host: this.configService.get<string>('SMTP_HOST'),
      port: this.configService.get<number>('SMTP_PORT'),
      secure: this.configService.get<string>('SMTP_SECURE') === 'true',
      auth: {
        user: this.configService.get<string>('SMTP_USER'),
        pass: this.configService.get<string>('SMTP_PASS'),
      },
    });
  }

  async sendMeetingReport(to: string, meetingTitle: string, pdfBuffer: Buffer) {
    const safeTitle = meetingTitle || 'Meeting';
    
    try {
      await this.transporter.sendMail({
        from: `"OmniSuiteAI Virtual Assistant" <${this.configService.get<string>('SMTP_USER')}>`,
        to,
        subject: `Your Meeting Report: ${safeTitle}`,
        text: `Hi there,\n\nPlease find attached the intelligence report for the meeting "${safeTitle}".\n\nBest,\nOmniSuiteAI VMA`,
        html: `
          <div style="font-family: Arial, sans-serif; color: #333;">
            <h2>Meeting Intelligence Report</h2>
            <p>Hi there,</p>
            <p>Please find attached the intelligence report for your meeting: <strong>${safeTitle}</strong>.</p>
            <p>This report includes the executive summary, action items, and detailed notes.</p>
            <br/>
            <p>Best regards,<br/><strong>OmniSuiteAI VMA</strong></p>
          </div>
        `,
        attachments: [
          {
            filename: `VMA_Report_${safeTitle.replace(/[^\w-]/g, '_')}.pdf`,
            content: pdfBuffer,
          },
        ],
      });
      
      this.logger.log(`Meeting report sent successfully to ${to}`);
    } catch (error) {
      this.logger.error(`Failed to send email to ${to}`, error);
      throw error;
    }
  }

  async sendReportSkippedNotification(to: string, meetingTitle: string, reason?: string) {
    const safeTitle = meetingTitle || 'Meeting';
    const explanation =
      reason ||
      'The virtual assistant was kept in the waiting room or no spoken dialogue was recorded during the call.';

    try {
      await this.transporter.sendMail({
        from: `"OmniSuiteAI Virtual Assistant" <${this.configService.get<string>('SMTP_USER')}>`,
        to,
        subject: `Notice: No Report Generated for ${safeTitle}`,
        text: `Hi there,\n\nNo meeting report was generated for "${safeTitle}" because ${explanation.toLowerCase()}\n\nBest,\nOmniSuiteAI VMA`,
        html: `
          <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
            <h2 style="color: #d97706; margin-top: 0;">Meeting Assistant Notification</h2>
            <p>Hi there,</p>
            <p>No meeting report was generated for your meeting: <strong>${safeTitle}</strong>.</p>
            <div style="background-color: #fffbebfb; border-left: 4px solid #f59e0b; padding: 12px; margin: 16px 0; border-radius: 4px;">
              <p style="margin: 0; color: #92400e;"><strong>Reason:</strong> ${explanation}</p>
            </div>
            <p>If you would like the assistant to record future meetings, please ensure it is admitted from the waiting room when joining.</p>
            <br/>
            <p>Best regards,<br/><strong>OmniSuiteAI VMA</strong></p>
          </div>
        `,
      });

      this.logger.log(`Report skipped notification sent successfully to ${to}`);
    } catch (error) {
      this.logger.error(`Failed to send report skipped notification email to ${to}`, error);
    }
  }
}
