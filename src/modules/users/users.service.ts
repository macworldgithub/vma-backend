import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User } from './users.schema';

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
    return this.model.find();
  }

  update(id: string, data: any) {
    return this.model.findByIdAndUpdate(id, data, { new: true }).select('-password');
  }

  remove(id: string) {
    return this.model.findByIdAndDelete(id);
  }
}