import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({ timestamps: true })
export class CalendarToken {
  @Prop()
  userId!: string;

  @Prop()
  provider!: 'google' | 'zoom' | 'vma';

  @Prop()
  accessToken!: string;

  @Prop({ required: false })
  refreshToken?: string;

  @Prop()
  expiryDate!: Date;
}

export const CalendarTokenSchema = SchemaFactory.createForClass(CalendarToken);
