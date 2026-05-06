import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({ timestamps: true })
export class User {
  @Prop() name!: string;

  @Prop({ unique: true }) email!: string;

  @Prop() password!: string;

  @Prop({ enum: ['admin', 'staff'], default: 'staff' })
  role!: string;
}

export const UserSchema = SchemaFactory.createForClass(User);