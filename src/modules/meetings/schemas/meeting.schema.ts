import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({ timestamps: true })
export class Meeting {
  @Prop() title!: string;

  @Prop() platform!: string; // teams | zoom | google

  @Prop() meetingLink!: string;

  @Prop() startTime!: Date;

  @Prop() endTime!: Date;

  @Prop({ default: 'SCHEDULED' })
  status!: string;

  @Prop() createdBy!: string; // userId

  @Prop([String])
  participants!: string[];

  @Prop()
  externalEventId!: string; // calendar event ID

  @Prop()
  source!: string; // calendar | manual | bot
}

export const MeetingSchema = SchemaFactory.createForClass(Meeting);