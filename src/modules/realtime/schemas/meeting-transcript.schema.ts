import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({ timestamps: true })
export class MeetingTranscript {
  @Prop({ required: true, index: true })
  roomId!: string;

  @Prop({ required: true })
  userId!: string;

  @Prop({ required: true })
  userName!: string;

  @Prop({ required: true })
  text!: string;

  @Prop({ default: () => new Date() })
  timestamp!: Date;
}

export const MeetingTranscriptSchema = SchemaFactory.createForClass(MeetingTranscript);
