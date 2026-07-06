import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User } from './users.schema';
import * as bcrypt from 'bcryptjs';

@Injectable()
export class UsersService {
  constructor(@InjectModel(User.name) private model: Model<User>) {}

  findByEmail(email: string) {
    return this.model.findOne({ email });
  }

  create(data: any) {
    return this.model.create(data);
  }

  findById(id: string) {
    return this.model.findById(id).select('-password');
  }

  findAll() {
    return this.model.find().select('-password');
  }

  async createByAdmin(data: { name: string; email: string; password: string; role?: string }) {
    const existing = await this.model.findOne({ email: data.email });
    if (existing) {
      throw new BadRequestException('A user with this email already exists');
    }
    const hash = await bcrypt.hash(data.password, 10);
    return this.model.create({
      name: data.name,
      email: data.email,
      password: hash,
      role: data.role || 'staff',
    });
  }

  update(id: string, data: any) {
    return this.model.findByIdAndUpdate(id, data, { new: true }).select('-password');
  }

  async updateSelf(id: string, data: { name?: string; email?: string }) {
    const updateFields: any = {};
    if (data.name) updateFields.name = data.name;
    if (data.email) updateFields.email = data.email;
    return this.model.findByIdAndUpdate(id, updateFields, { new: true }).select('-password');
  }

  remove(id: string) {
    return this.model.findByIdAndDelete(id);
  }
}