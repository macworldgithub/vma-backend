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
}
