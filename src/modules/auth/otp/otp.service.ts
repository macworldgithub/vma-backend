import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Otp } from './otp.schema';
import * as nodemailer from 'nodemailer';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class OtpService {
  constructor(
    @InjectModel(Otp.name) private model: Model<Otp>,
    private config: ConfigService,
  ) {}

  generateOtp() {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  async sendOtp(email: string) {
    const code = this.generateOtp();

    await this.model.create({
      email,
      code,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });

    const transporter = nodemailer.createTransport({
      host: this.config.get('SMTP_HOST'),
      port: this.config.get('SMTP_PORT'),
      secure: this.config.get('SMTP_SECURE') === 'true',
      auth: {
        user: this.config.get('SMTP_USER'),
        pass: this.config.get('SMTP_PASS'),
      },
    });

    await transporter.sendMail({
      to: email,
      subject: 'OTP Verification',
      html: `<h2>Your OTP is ${code}</h2>`,
    });

    return { message: 'OTP sent' };
  }

  async validateOtp(email: string, code: string) {
    const record = await this.model.findOne({ email, code });

    if (!record) return false;
    if (record.expiresAt < new Date()) return false;

    return true;
  }
}