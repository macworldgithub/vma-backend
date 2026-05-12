import {
  WebSocketGateway,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  WebSocketServer,
  OnGatewayDisconnect,
} from '@nestjs/websockets';

import { Server, Socket } from 'socket.io';
import { RoomService } from '../services/room.service';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class MeetingGateway implements OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  constructor(private readonly roomService: RoomService) {}

  private users = new Map<string, string>();

  // JOIN ROOM
  @SubscribeMessage('join-room')
  async joinRoom(
    @MessageBody() data: any,
    @ConnectedSocket() client: Socket,
  ) {
    const { roomId, userId } = data;

    await this.roomService.joinRoom(roomId, userId);

    client.join(roomId);

    this.users.set(client.id, userId);

    client.to(roomId).emit('user-joined', {
      userId,
    });

    return {
      event: 'joined',
      roomId,
    };
  }

  // WEBRTC SIGNAL
  @SubscribeMessage('signal')
  async signal(
    @MessageBody() data: any,
    @ConnectedSocket() client: Socket,
  ) {
    const { roomId, targetUserId, signal } = data;

    client.to(roomId).emit('signal', {
      from: this.users.get(client.id),
      signal,
      targetUserId,
    });
  }

  // LEAVE
  async handleDisconnect(client: Socket) {
    const userId = this.users.get(client.id);

    this.server.emit('user-left', {
      userId,
    });

    this.users.delete(client.id);
  }
}