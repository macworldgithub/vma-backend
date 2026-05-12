import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Participant, ParticipantSchema } from './participant.schema';

export enum RoomStatus {
  WAITING = 'WAITING',
  ACTIVE = 'ACTIVE',
  ENDED = 'ENDED',
}

@Schema({ timestamps: true })
export class Room {
  @Prop({ unique: true, required: true })
  roomId!: string;

  @Prop({ required: true })
  meetingId!: string;

  @Prop({ unique: true, required: true })
  meetingCode!: string;

  @Prop({ required: true })
  hostId!: string;

  @Prop({ required: true })
  createdBy!: string;

  @Prop({ type: [ParticipantSchema], default: [] })
  participants!: Participant[];

  @Prop({ type: String, enum: RoomStatus, default: RoomStatus.WAITING })
  status!: string;

  @Prop({ default: false })
  isLocked!: boolean;

  @Prop({ default: 10 })
  maxParticipants!: number;

  @Prop()
  startedAt?: Date;

  @Prop()
  endedAt?: Date;
}

export const RoomSchema = SchemaFactory.createForClass(Room);