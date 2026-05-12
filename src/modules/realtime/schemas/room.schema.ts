import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({ timestamps: true })
export class Room {
  @Prop({ unique: true })
  roomId!: string;

  @Prop()
  createdBy!: string;

  @Prop([String])
  participants!: string[];

  @Prop({ default: 'ACTIVE' })
  status!: string;
}

export const RoomSchema = SchemaFactory.createForClass(Room);