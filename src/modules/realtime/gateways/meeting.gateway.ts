import {
  WebSocketGateway,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  WebSocketServer,
  OnGatewayDisconnect,
  OnGatewayConnection,
} from '@nestjs/websockets';

import { Server, Socket } from 'socket.io';
import { RoomService } from '../services/room.service';
import { ChatService } from '../services/chat.service';
import { JwtService } from '@nestjs/jwt';
import { Logger } from '@nestjs/common';

interface SocketUser {
  userId: string;
  userName: string;
  roomId: string | null;
}

@WebSocketGateway({
  cors: {
    origin: '*',
  },
  namespace: '/',
})
export class MeetingGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(MeetingGateway.name);

  // Track socket → user mapping
  private socketUsers = new Map<string, SocketUser>();

  constructor(
    private readonly roomService: RoomService,
    private readonly chatService: ChatService,
    private readonly jwtService: JwtService,
  ) {}

  // ─── CONNECTION AUTHENTICATION ───────────────────────────────────────
  async handleConnection(client: Socket) {
    try {
      const token =
        (client.handshake.auth?.token as string) ||
        (client.handshake.headers?.authorization?.split(' ')[1]);

      if (!token) {
        this.logger.warn(`Client ${client.id} connected without token`);
        // Allow connection but mark as unauthenticated
        this.socketUsers.set(client.id, {
          userId: '',
          userName: 'Anonymous',
          roomId: null,
        });
        return;
      }

      const payload = this.jwtService.verify(token);
      this.socketUsers.set(client.id, {
        userId: payload.sub,
        userName: payload.name || payload.email || 'User',
        roomId: null,
      });

      this.logger.log(`Client ${client.id} authenticated as user ${payload.sub}`);
    } catch {
      this.logger.warn(`Client ${client.id} failed authentication`);
      this.socketUsers.set(client.id, {
        userId: '',
        userName: 'Anonymous',
        roomId: null,
      });
    }
  }

  // ─── JOIN ROOM ───────────────────────────────────────────────────────
  @SubscribeMessage('join-room')
  async joinRoom(
    @MessageBody() data: { roomId: string; userId?: string; userName?: string },
    @ConnectedSocket() client: Socket,
  ) {
    try {
      const socketUser = this.socketUsers.get(client.id);
      const userId = data.userId || socketUser?.userId || client.id;
      const userName = data.userName || socketUser?.userName || 'Anonymous';

      this.logger.log(`User ${userId} (${userName}) joining room ${data.roomId}`);

      // Join room in DB
      const room = await this.roomService.joinRoom(
        data.roomId,
        userId,
        client.id,
        userName,
      );

      // Join Socket.IO room
      client.join(data.roomId);

      // Update local tracking
      this.socketUsers.set(client.id, {
        userId,
        userName,
        roomId: data.roomId,
      });

      // Get existing participants (everyone except the joiner)
      const existingParticipants = room.participants
        .filter((p) => p.userId !== userId)
        .map((p) => ({
          userId: p.userId,
          socketId: p.socketId,
          userName: p.userName,
          audioEnabled: p.audioEnabled,
          videoEnabled: p.videoEnabled,
          screenSharing: p.screenSharing,
        }));

      // Notify existing participants that a new user joined
      client.to(data.roomId).emit('user-joined', {
        userId,
        socketId: client.id,
        userName,
        audioEnabled: true,
        videoEnabled: true,
        screenSharing: false,
      });

      // Send the joiner the list of everyone already in the room
      return {
        event: 'room-joined',
        data: {
          roomId: data.roomId,
          userId,
          socketId: client.id,
          participants: existingParticipants,
          isHost: room.hostId === userId,
        },
      };
    } catch (error: any) {
      this.logger.error(`Join room error: ${error.message}`);
      return {
        event: 'error',
        data: { message: error.message },
      };
    }
  }

  // ─── WEBRTC SIGNALING: OFFER ─────────────────────────────────────────
  @SubscribeMessage('offer')
  async handleOffer(
    @MessageBody() data: { targetSocketId: string; signal: any; roomId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const socketUser = this.socketUsers.get(client.id);

    this.logger.debug(`Offer from ${client.id} to ${data.targetSocketId}`);

    // Send offer ONLY to the target peer
    this.server.to(data.targetSocketId).emit('offer', {
      fromSocketId: client.id,
      fromUserId: socketUser?.userId,
      fromUserName: socketUser?.userName,
      signal: data.signal,
      roomId: data.roomId,
    });
  }

  // ─── WEBRTC SIGNALING: ANSWER ────────────────────────────────────────
  @SubscribeMessage('answer')
  async handleAnswer(
    @MessageBody() data: { targetSocketId: string; signal: any; roomId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const socketUser = this.socketUsers.get(client.id);

    this.logger.debug(`Answer from ${client.id} to ${data.targetSocketId}`);

    // Send answer ONLY to the target peer
    this.server.to(data.targetSocketId).emit('answer', {
      fromSocketId: client.id,
      fromUserId: socketUser?.userId,
      fromUserName: socketUser?.userName,
      signal: data.signal,
      roomId: data.roomId,
    });
  }

  // ─── WEBRTC SIGNALING: ICE CANDIDATE ─────────────────────────────────
  @SubscribeMessage('ice-candidate')
  async handleIceCandidate(
    @MessageBody() data: { targetSocketId: string; candidate: any; roomId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const socketUser = this.socketUsers.get(client.id);

    // Send ICE candidate ONLY to the target peer
    this.server.to(data.targetSocketId).emit('ice-candidate', {
      fromSocketId: client.id,
      fromUserId: socketUser?.userId,
      candidate: data.candidate,
      roomId: data.roomId,
    });
  }

  // ─── MEDIA STATE CHANGE (mute/unmute/camera) ─────────────────────────
  @SubscribeMessage('media-state-change')
  async handleMediaStateChange(
    @MessageBody() data: {
      roomId: string;
      audioEnabled?: boolean;
      videoEnabled?: boolean;
      screenSharing?: boolean;
    },
    @ConnectedSocket() client: Socket,
  ) {
    const socketUser = this.socketUsers.get(client.id);
    if (!socketUser) return;

    // Update in DB
    await this.roomService.updateMediaState(data.roomId, socketUser.userId, {
      audioEnabled: data.audioEnabled,
      videoEnabled: data.videoEnabled,
      screenSharing: data.screenSharing,
    });

    // Broadcast to everyone else in the room
    client.to(data.roomId).emit('media-state-changed', {
      userId: socketUser.userId,
      socketId: client.id,
      userName: socketUser.userName,
      audioEnabled: data.audioEnabled,
      videoEnabled: data.videoEnabled,
      screenSharing: data.screenSharing,
    });
  }

  // ─── SCREEN SHARING ──────────────────────────────────────────────────
  @SubscribeMessage('screen-share-start')
  async handleScreenShareStart(
    @MessageBody() data: { roomId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const socketUser = this.socketUsers.get(client.id);
    if (!socketUser) return;

    await this.roomService.updateMediaState(data.roomId, socketUser.userId, {
      screenSharing: true,
    });

    client.to(data.roomId).emit('screen-share-started', {
      userId: socketUser.userId,
      socketId: client.id,
      userName: socketUser.userName,
    });
  }

  @SubscribeMessage('screen-share-stop')
  async handleScreenShareStop(
    @MessageBody() data: { roomId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const socketUser = this.socketUsers.get(client.id);
    if (!socketUser) return;

    await this.roomService.updateMediaState(data.roomId, socketUser.userId, {
      screenSharing: false,
    });

    client.to(data.roomId).emit('screen-share-stopped', {
      userId: socketUser.userId,
      socketId: client.id,
      userName: socketUser.userName,
    });
  }

  // ─── CHAT MESSAGE ────────────────────────────────────────────────────
  @SubscribeMessage('chat-message')
  async handleChatMessage(
    @MessageBody() data: { roomId: string; message: string },
    @ConnectedSocket() client: Socket,
  ) {
    const socketUser = this.socketUsers.get(client.id);
    if (!socketUser) return;

    // Persist the message
    const saved = await this.chatService.saveMessage(
      data.roomId,
      socketUser.userId,
      socketUser.userName,
      data.message,
    );

    // Broadcast to EVERYONE in the room (including sender for confirmation)
    this.server.to(data.roomId).emit('chat-message', {
      id: (saved as any)._id,
      userId: socketUser.userId,
      userName: socketUser.userName,
      message: data.message,
      sentAt: saved.sentAt,
    });
  }

  // ─── GET CHAT HISTORY ────────────────────────────────────────────────
  @SubscribeMessage('get-chat-history')
  async handleGetChatHistory(
    @MessageBody() data: { roomId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const messages = await this.chatService.getMessages(data.roomId);
    return {
      event: 'chat-history',
      data: messages,
    };
  }

  // ─── KICK PARTICIPANT (host only) ────────────────────────────────────
  @SubscribeMessage('kick-participant')
  async handleKickParticipant(
    @MessageBody() data: { roomId: string; targetUserId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const socketUser = this.socketUsers.get(client.id);
    if (!socketUser) return;

    try {
      const result = await this.roomService.kickParticipant(
        data.roomId,
        socketUser.userId,
        data.targetUserId,
      );

      // Notify the kicked user
      this.server.to(result.kickedSocketId).emit('kicked', {
        reason: 'You have been removed from the meeting by the host',
      });

      // Force the kicked socket to leave the room
      const kickedSocket = this.server.sockets.sockets.get(result.kickedSocketId);
      if (kickedSocket) {
        kickedSocket.leave(data.roomId);
      }

      // Notify room that user was kicked
      client.to(data.roomId).emit('participant-kicked', {
        userId: data.targetUserId,
      });

      return { event: 'kick-success', data: { targetUserId: data.targetUserId } };
    } catch (error: any) {
      return { event: 'error', data: { message: error.message } };
    }
  }

  // ─── TOGGLE ROOM LOCK (host only) ────────────────────────────────────
  @SubscribeMessage('toggle-lock')
  async handleToggleLock(
    @MessageBody() data: { roomId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const socketUser = this.socketUsers.get(client.id);
    if (!socketUser) return;

    try {
      const result = await this.roomService.toggleLock(data.roomId, socketUser.userId);

      // Notify everyone in the room
      this.server.to(data.roomId).emit('room-locked', {
        isLocked: result.isLocked,
        by: socketUser.userName,
      });

      return { event: 'lock-toggled', data: result };
    } catch (error: any) {
      return { event: 'error', data: { message: error.message } };
    }
  }

  // ─── END MEETING (host only) ─────────────────────────────────────────
  @SubscribeMessage('end-meeting')
  async handleEndMeeting(
    @MessageBody() data: { roomId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const socketUser = this.socketUsers.get(client.id);
    if (!socketUser) return;

    try {
      await this.roomService.endRoom(data.roomId, socketUser.userId);

      // Notify ALL participants that meeting has ended
      this.server.to(data.roomId).emit('meeting-ended', {
        endedBy: socketUser.userName,
        endedAt: new Date(),
      });

      // Remove all sockets from the room
      const sockets = await this.server.in(data.roomId).fetchSockets();
      for (const s of sockets) {
        s.leave(data.roomId);
      }

      return { event: 'meeting-ended', data: { success: true } };
    } catch (error: any) {
      return { event: 'error', data: { message: error.message } };
    }
  }

  // ─── EXPLICIT LEAVE ──────────────────────────────────────────────────
  @SubscribeMessage('leave-room')
  async handleLeaveRoom(
    @MessageBody() data: { roomId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const socketUser = this.socketUsers.get(client.id);
    if (!socketUser) return;

    await this.roomService.leaveRoom(data.roomId, socketUser.userId);

    client.leave(data.roomId);

    // Notify remaining participants
    client.to(data.roomId).emit('user-left', {
      userId: socketUser.userId,
      socketId: client.id,
      userName: socketUser.userName,
    });

    // Update local tracking
    socketUser.roomId = null;

    return { event: 'left-room', data: { roomId: data.roomId } };
  }

  // ─── DISCONNECT ──────────────────────────────────────────────────────
  async handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);

    const socketUser = this.socketUsers.get(client.id);

    // Remove from room in DB (finds room by socketId)
    const result = await this.roomService.leaveRoomBySocketId(client.id);

    if (result) {
      // Notify room participants that user left
      this.server.to(result.room.roomId).emit('user-left', {
        userId: result.userId,
        socketId: client.id,
        userName: result.userName,
      });
    }

    // Clean up local tracking
    this.socketUsers.delete(client.id);
  }
}