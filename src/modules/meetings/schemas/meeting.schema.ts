import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

export enum MeetingStatus {
  SCHEDULED = 'SCHEDULED',
  LIVE = 'LIVE',
  ENDED = 'ENDED',
  CANCELLED = 'CANCELLED',
}

@Schema({ timestamps: true })
export class Meeting {
  @Prop({ required: true })
  title!: string;

  @Prop({ default: 'vma' })
  platform!: string; // teams | zoom | google | vma

  @Prop()
  meetingLink!: string;

  @Prop()
  startTime!: Date;

  @Prop()
  endTime!: Date;

  @Prop({ type: String, enum: MeetingStatus, default: MeetingStatus.SCHEDULED })
  status!: string;

  @Prop({ required: true })
  createdBy!: string; // userId

  @Prop({ required: true })
  hostId!: string; // userId of meeting host

  @Prop([String])
  participants!: string[];

  @Prop()
  externalEventId!: string; // calendar event ID

  @Prop({ default: 'manual' })
  source!: string; // calendar | manual | bot

  @Prop({ default: 'vma' })
  provider!: string; // google | zoom | vma

  @Prop()
  lastSyncedAt!: Date;

  // --- New fields for room linkage ---

  @Prop()
  recallBotId?: string;

  @Prop({ default: 'none' })
  botStatus?: string;


  @Prop()
  roomId!: string;

  @Prop({ unique: true, sparse: true })
  meetingCode!: string;

  @Prop()
  duration?: number; // duration in seconds

  @Prop()
  actualStartTime?: Date;

  @Prop()
  actualEndTime?: Date;

  @Prop({ type: Object })
  summaryData?: any;

  @Prop({ default: 10 })
  maxParticipants!: number;

  @Prop()
  transcriptId?: string;
}

export const MeetingSchema = SchemaFactory.createForClass(Meeting);
