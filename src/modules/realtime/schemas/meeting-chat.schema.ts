import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({ timestamps: true })
export class MeetingChat {
  @Prop({ required: true })
  roomId!: string;

  @Prop({ required: true })
  userId!: string;

  @Prop({ required: true })
  userName!: string;

  @Prop({ required: true })
  message!: string;

  @Prop({ default: () => new Date() })
  sentAt!: Date;
}

export const MeetingChatSchema = SchemaFactory.createForClass(MeetingChat);
