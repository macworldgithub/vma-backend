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

  findAll() {
    return this.model.find();
  }
}