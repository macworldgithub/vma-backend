import { Injectable, BadRequestException } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { JwtService } from '@nestjs/jwt';
import { OtpService } from './otp/otp.service';
import * as bcrypt from 'bcryptjs';
import { UserRole } from './dto/register.dto';

@Injectable()
export class AuthService {
  constructor(
    private users: UsersService,
    private jwt: JwtService,
    private otp: OtpService,
  ) {}

  // STEP 1: SEND OTP
  async initiateSignup(dto: any) {
    const exists = await this.users.findByEmail(dto.email);
    if (exists) throw new BadRequestException('User already exists');

    return this.otp.sendOtp(dto.email);
  }

  // STEP 2: VERIFY OTP + CREATE USER
  async verifyAndCreate(dto: any) {
    const valid = await this.otp.validateOtp(dto.email, dto.code);

    if (!valid) {
      throw new BadRequestException('Invalid or expired OTP');
    }

    const hash = await bcrypt.hash(dto.password, 10);

    await this.users.create({
      email: dto.email,
      password: hash,
      name: dto.name,
      role: dto.role || UserRole.STAFF,
    });

    return { message: 'User registered successfully' };
  }

  // LOGIN
  async login(dto: any) {
    const user = await this.users.findByEmail(dto.email);

    if (!user) throw new BadRequestException('Invalid credentials');

    // Verify role matches
    if (user.role !== dto.role) {
      throw new BadRequestException(`Access denied: User is not registered as ${dto.role}`);
    }

    const match = await bcrypt.compare(dto.password, user.password);

    if (!match) throw new BadRequestException('Invalid credentials');

    const payload = {
      sub: user._id,
      role: user.role,
      email: user.email,
    };

    return {
      access_token: this.jwt.sign(payload),
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    };
  }

  // FORGOT PASSWORD
  async forgotPassword(email: string) {
    const user = await this.users.findByEmail(email);
    if (!user) throw new BadRequestException('User not found');

    return this.otp.sendOtp(email);
  }

  // RESET PASSWORD
  async resetPassword(dto: any) {
    const valid = await this.otp.validateOtp(dto.email, dto.code);
    if (!valid) throw new BadRequestException('Invalid or expired OTP');

    const user = await this.users.findByEmail(dto.email);
    if (!user) throw new BadRequestException('User not found');

    const hash = await bcrypt.hash(dto.password, 10);
    // We need an update method in UsersService
    await (user as any).updateOne({ password: hash });

    return { message: 'Password reset successfully' };
  }
}
