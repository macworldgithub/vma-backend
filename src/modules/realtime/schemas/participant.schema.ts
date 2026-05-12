import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({ _id: false, timestamps: false })
export class Participant {
  @Prop({ required: true })
  userId!: string;

  @Prop({ required: true })
  socketId!: string;

  @Prop({ default: '' })
  userName!: string;

  @Prop({ default: true })
  audioEnabled!: boolean;

  @Prop({ default: true })
  videoEnabled!: boolean;

  @Prop({ default: false })
  screenSharing!: boolean;

  @Prop({ default: () => new Date() })
  joinedAt!: Date;
}

export const ParticipantSchema = SchemaFactory.createForClass(Participant);
