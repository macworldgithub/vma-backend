import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema()
export class Otp {
  @Prop() email!: string;
  @Prop() code!: string;
  @Prop() expiresAt!: Date;
}

export const OtpSchema = SchemaFactory.createForClass(Otp);