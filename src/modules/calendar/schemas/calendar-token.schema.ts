import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({ timestamps: true })
export class CalendarToken {
  @Prop()
  userId!: string;

  @Prop()
  provider!: 'google' | 'microsoft' | 'zoom' | 'vma';

  @Prop()
  accessToken!: string;

  @Prop({ required: false })
  refreshToken?: string;

  @Prop()
  expiryDate!: Date;

  /** The email (UPN) of the Microsoft account that actually authenticated */
  @Prop({ required: false })
  microsoftEmail?: string;

  /** The Object ID (oid) of the Microsoft account that actually authenticated */
  @Prop({ required: false })
  microsoftUserId?: string;

  /** The email of the Google account that actually authenticated */
  @Prop({ required: false })
  googleEmail?: string;
}

export const CalendarTokenSchema = SchemaFactory.createForClass(CalendarToken);
