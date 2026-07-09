// import {
//   WebSocketGateway,
//   SubscribeMessage,
//   MessageBody,
//   ConnectedSocket,
//   WebSocketServer,
//   OnGatewayDisconnect,
//   OnGatewayConnection,
// } from '@nestjs/websockets';

// import { Server, Socket } from 'socket.io';
// import { RoomService } from '../services/room.service';
// import { ChatService } from '../services/chat.service';
// import { JwtService } from '@nestjs/jwt';
// import { Logger } from '@nestjs/common';
// import { SignalDto } from '../dto/signal.dto';
// import { TranscriptService } from '../services/transcript.service';
// import { DeepgramService } from '../services/deepgram.service';

// interface SocketUser {
//   userId: string;
//   userName: string;
//   roomId: string | null;
// }

// @WebSocketGateway({
//   cors: {
//     origin: '*',
//   },
//   namespace: '/',
// })
// export class MeetingGateway implements OnGatewayConnection, OnGatewayDisconnect {
//   @WebSocketServer()
//   server!: Server;

//   private readonly logger = new Logger(MeetingGateway.name);

//   // Track socket → user mapping
//   private socketUsers = new Map<string, SocketUser>();

//   constructor(
//     private readonly roomService: RoomService,
//     private readonly chatService: ChatService,
//     private readonly jwtService: JwtService,
//     private readonly transcriptService: TranscriptService,
//     private readonly deepgramService: DeepgramService,
//   ) {}

//   // ─── CONNECTION AUTHENTICATION ───────────────────────────────────────
//   async handleConnection(client: Socket) {
//     try {
//       const token =
//         (client.handshake.auth?.token as string) ||
//         (client.handshake.headers?.authorization?.split(' ')[1]);

//       if (!token) {
//         this.logger.warn(`Client ${client.id} connected without token`);
//         // Allow connection but mark as unauthenticated
//         this.socketUsers.set(client.id, {
//           userId: '',
//           userName: 'Anonymous',
//           roomId: null,
//         });
//         return;
//       }

//       const payload = this.jwtService.verify(token);
//       this.socketUsers.set(client.id, {
//         userId: payload.sub,
//         userName: payload.name || payload.email || 'User',
//         roomId: null,
//       });

//       this.logger.log(`Client ${client.id} authenticated as user ${payload.sub}`);
//     } catch {
//       this.logger.warn(`Client ${client.id} failed authentication`);
//       this.socketUsers.set(client.id, {
//         userId: '',
//         userName: 'Anonymous',
//         roomId: null,
//       });
//     }
//   }

//   // ─── JOIN ROOM ───────────────────────────────────────────────────────
//   @SubscribeMessage('join-room')
//   async joinRoom(
//     @MessageBody() data: { 
//       roomId: string; 
//       userId?: string; 
//       userName?: string;
//       audioEnabled?: boolean;
//       videoEnabled?: boolean;
//     },
//     @ConnectedSocket() client: Socket,
//   ) {
//     try {
//       const socketUser = this.socketUsers.get(client.id);
//       const userId = data.userId || socketUser?.userId || client.id;
//       const userName = data.userName || socketUser?.userName || 'Anonymous';

//       this.logger.log(`User ${userId} (${userName}) joining room ${data.roomId}`);

//       // Join room in DB
//       const { room, staleParticipant } = await this.roomService.joinRoom(
//         data.roomId,
//         userId,
//         client.id,
//         userName,
//         {
//           audioEnabled: data.audioEnabled,
//           videoEnabled: data.videoEnabled,
//         }
//       );

//       // If there was a stale entry for this user, notify the room that the old connection is gone
//       if (staleParticipant && staleParticipant.socketId !== client.id) {
//         this.logger.log(`Replacing stale socket ${staleParticipant.socketId} for user ${userId}`);
//         client.to(data.roomId).emit('user-left', {
//           userId,
//           socketId: staleParticipant.socketId,
//           userName,
//         });
//       }

//       // Join Socket.IO room
//       client.join(data.roomId);

//       // Update local tracking
//       this.socketUsers.set(client.id, {
//         userId,
//         userName,
//         roomId: data.roomId,
//       });

//       // Get existing participants (everyone except the joiner)
//       const existingParticipants = room.participants
//         .filter((p) => p.userId !== userId)
//         .map((p) => ({
//           userId: p.userId,
//           socketId: p.socketId,
//           userName: p.userName,
//           audioEnabled: p.audioEnabled,
//           videoEnabled: p.videoEnabled,
//           screenSharing: p.screenSharing,
//         }));

//       // Notify existing participants that a new user joined
//       client.to(data.roomId).emit('user-joined', {
//         userId,
//         socketId: client.id,
//         userName,
//         audioEnabled: data.audioEnabled ?? true,
//         videoEnabled: data.videoEnabled ?? true,
//         screenSharing: false,
//       });

//       // Send the joiner the list of everyone already in the room
//       return {
//         event: 'room-joined',
//         data: {
//           roomId: data.roomId,
//           userId,
//           socketId: client.id,
//           participants: existingParticipants,
//           isHost: room.hostId === userId,
//         },
//       };
//     } catch (error: any) {
//       this.logger.error(`Join room error: ${error.message}`);
//       return {
//         event: 'error',
//         data: { message: error.message },
//       };
//     }
//   }

//   // ─── WEBRTC SIGNALING: OFFER ─────────────────────────────────────────
//   @SubscribeMessage('offer')
//   async handleOffer(
//     @MessageBody() data: SignalDto,
//     @ConnectedSocket() client: Socket,
//   ) {
//     const socketUser = this.socketUsers.get(client.id);
//     this.logger.log(`[SIGNAL] Offer: ${client.id} -> ${data.targetSocketId} (Room: ${data.roomId})`);

//     // Send offer ONLY to the target peer
//     this.server.to(data.targetSocketId).emit('offer', {
//       fromSocketId: client.id,
//       fromUserId: socketUser?.userId,
//       fromUserName: socketUser?.userName,
//       signal: data.signal,
//       roomId: data.roomId,
//     });
//   }

//   // ─── WEBRTC SIGNALING: ANSWER ────────────────────────────────────────
//   @SubscribeMessage('answer')
//   async handleAnswer(
//     @MessageBody() data: SignalDto,
//     @ConnectedSocket() client: Socket,
//   ) {
//     const socketUser = this.socketUsers.get(client.id);
//     this.logger.log(`[SIGNAL] Answer: ${client.id} -> ${data.targetSocketId} (Room: ${data.roomId})`);

//     // Send answer ONLY to the target peer
//     this.server.to(data.targetSocketId).emit('answer', {
//       fromSocketId: client.id,
//       fromUserId: socketUser?.userId,
//       fromUserName: socketUser?.userName,
//       signal: data.signal,
//       roomId: data.roomId,
//     });
//   }

//   // ─── WEBRTC SIGNALING: ICE CANDIDATE ─────────────────────────────────
//   @SubscribeMessage('ice-candidate')
//   async handleIceCandidate(
//     @MessageBody() data: SignalDto,
//     @ConnectedSocket() client: Socket,
//   ) {
//     const socketUser = this.socketUsers.get(client.id);
//     this.logger.debug(`[SIGNAL] ICE: ${client.id} -> ${data.targetSocketId}`);

//     // Send ICE candidate ONLY to the target peer
//     this.server.to(data.targetSocketId).emit('ice-candidate', {
//       fromSocketId: client.id,
//       fromUserId: socketUser?.userId,
//       candidate: data.signal, // In SignalDto, we use signal property for both SD and candidates
//       roomId: data.roomId,
//     });
//   }

//   // ─── MEDIA STATE CHANGE (mute/unmute/camera) ─────────────────────────
//   @SubscribeMessage('media-state-change')
//   async handleMediaStateChange(
//     @MessageBody() data: {
//       roomId: string;
//       audioEnabled?: boolean;
//       videoEnabled?: boolean;
//       screenSharing?: boolean;
//     },
//     @ConnectedSocket() client: Socket,
//   ) {
//     const socketUser = this.socketUsers.get(client.id);
//     if (!socketUser) return;

//     // Update in DB
//     await this.roomService.updateMediaState(data.roomId, socketUser.userId, {
//       audioEnabled: data.audioEnabled,
//       videoEnabled: data.videoEnabled,
//       screenSharing: data.screenSharing,
//     });

//     // Broadcast to everyone else in the room
//     client.to(data.roomId).emit('media-state-changed', {
//       userId: socketUser.userId,
//       socketId: client.id,
//       userName: socketUser.userName,
//       audioEnabled: data.audioEnabled,
//       videoEnabled: data.videoEnabled,
//       screenSharing: data.screenSharing,
//     });
//   }

//   // ─── SCREEN SHARING ──────────────────────────────────────────────────
//   @SubscribeMessage('screen-share-start')
//   async handleScreenShareStart(
//     @MessageBody() data: { roomId: string },
//     @ConnectedSocket() client: Socket,
//   ) {
//     const socketUser = this.socketUsers.get(client.id);
//     if (!socketUser) return;

//     await this.roomService.updateMediaState(data.roomId, socketUser.userId, {
//       screenSharing: true,
//     });

//     client.to(data.roomId).emit('screen-share-started', {
//       userId: socketUser.userId,
//       socketId: client.id,
//       userName: socketUser.userName,
//     });
//   }

//   @SubscribeMessage('screen-share-stop')
//   async handleScreenShareStop(
//     @MessageBody() data: { roomId: string },
//     @ConnectedSocket() client: Socket,
//   ) {
//     const socketUser = this.socketUsers.get(client.id);
//     if (!socketUser) return;

//     await this.roomService.updateMediaState(data.roomId, socketUser.userId, {
//       screenSharing: false,
//     });

//     client.to(data.roomId).emit('screen-share-stopped', {
//       userId: socketUser.userId,
//       socketId: client.id,
//       userName: socketUser.userName,
//     });
//   }

//   // ─── CHAT MESSAGE ────────────────────────────────────────────────────
//   @SubscribeMessage('chat-message')
//   async handleChatMessage(
//     @MessageBody() data: { roomId: string; message: string },
//     @ConnectedSocket() client: Socket,
//   ) {
//     const socketUser = this.socketUsers.get(client.id);
//     if (!socketUser) return;

//     // Persist the message
//     const saved = await this.chatService.saveMessage(
//       data.roomId,
//       socketUser.userId,
//       socketUser.userName,
//       data.message,
//     );

//     // Broadcast to EVERYONE in the room (including sender for confirmation)
//     this.server.to(data.roomId).emit('chat-message', {
//       id: (saved as any)._id,
//       userId: socketUser.userId,
//       userName: socketUser.userName,
//       message: data.message,
//       sentAt: saved.sentAt,
//     });
//   }

//   // ─── GET CHAT HISTORY ────────────────────────────────────────────────
//   @SubscribeMessage('get-chat-history')
//   async handleGetChatHistory(
//     @MessageBody() data: { roomId: string },
//     @ConnectedSocket() client: Socket,
//   ) {
//     const messages = await this.chatService.getMessages(data.roomId);
//     return {
//       event: 'chat-history',
//       data: messages,
//     };
//   }

//   // ─── START DEEPGRAM TRANSCRIPTION ────────────────────────────────────
//   @SubscribeMessage('start-transcription')
//   async handleStartTranscription(
//     @MessageBody() data: { roomId: string },
//     @ConnectedSocket() client: Socket,
//   ) {
//     const socketUser = this.socketUsers.get(client.id);
//     if (!socketUser) return;

//     this.logger.log(
//       `[Deepgram] Starting stream for ${socketUser.userName} in room ${data.roomId}`,
//     );

//     await this.deepgramService.startStream(client.id, {
//       onInterim: (text: string) => {
//         // Broadcast live subtitle to entire room (including sender)
//         this.server.to(data.roomId).emit('new-transcript-interim', {
//           userId: socketUser.userId,
//           userName: socketUser.userName,
//           text,
//         });
//       },
//       onFinal: async (text: string) => {
//         // Persist and broadcast final transcript to entire room
//         const saved = await this.transcriptService.saveTranscript(
//           data.roomId,
//           socketUser.userId,
//           socketUser.userName,
//           text,
//         );
//         this.server.to(data.roomId).emit('new-transcript', {
//           id: (saved as any)._id,
//           userId: socketUser.userId,
//           userName: socketUser.userName,
//           text,
//           timestamp: (saved as any).timestamp,
//         });
//       },
//       onError: (err: any) => {
//         this.logger.error(
//           `[Deepgram] Stream error for ${client.id}: ${JSON.stringify(err)}`,
//         );
//       },
//       onClose: () => {
//         this.logger.warn(`[Deepgram] Stream closed for ${client.id}, notifying client to restart...`);
//         client.emit('transcription-disconnected');
//       },
//     });

//     return { event: 'transcription-started', data: { success: true } };
//   }

//   // ─── AUDIO CHUNK → DEEPGRAM ───────────────────────────────────────────
//   @SubscribeMessage('audio-chunk')
//   handleAudioChunk(
//     @MessageBody() data: any,
//     @ConnectedSocket() client: Socket,
//   ) {
//     // data arrives as Buffer, ArrayBuffer, or wrapped object depending on transport
//     const chunk = Buffer.isBuffer(data)
//       ? data
//       : data instanceof ArrayBuffer
//         ? Buffer.from(data)
//         : Buffer.from(data as any);

//     this.deepgramService.sendAudio(client.id, chunk);
//   }

//   // ─── STOP DEEPGRAM TRANSCRIPTION ─────────────────────────────────────
//   @SubscribeMessage('stop-transcription')
//   async handleStopTranscription(
//     @ConnectedSocket() client: Socket,
//   ) {
//     await this.deepgramService.stopStream(client.id);
//     return { event: 'transcription-stopped', data: { success: true } };
//   }

//   // ─── SUBMIT TRANSCRIPT (legacy / manual fallback) ────────────────────
//   @SubscribeMessage('submit-transcript')
//   async handleSubmitTranscript(
//     @MessageBody() data: { roomId: string; text: string },
//     @ConnectedSocket() client: Socket,
//   ) {
//     const socketUser = this.socketUsers.get(client.id);
//     if (!socketUser) return;

//     const saved = await this.transcriptService.saveTranscript(
//       data.roomId,
//       socketUser.userId,
//       socketUser.userName,
//       data.text,
//     );

//     this.server.to(data.roomId).emit('new-transcript', {
//       id: (saved as any)._id,
//       userId: socketUser.userId,
//       userName: socketUser.userName,
//       text: data.text,
//       timestamp: saved.timestamp,
//     });
//   }

//   // ─── SUBMIT INTERIM TRANSCRIPT (legacy / manual fallback) ────────────
//   @SubscribeMessage('submit-transcript-interim')
//   async handleSubmitTranscriptInterim(
//     @MessageBody() data: { roomId: string; text: string },
//     @ConnectedSocket() client: Socket,
//   ) {
//     const socketUser = this.socketUsers.get(client.id);
//     if (!socketUser) return;

//     client.to(data.roomId).emit('new-transcript-interim', {
//       userId: socketUser.userId,
//       userName: socketUser.userName,
//       text: data.text,
//     });
//   }

//   // ─── GET TRANSCRIPT HISTORY ──────────────────────────────────────────
//   @SubscribeMessage('get-transcript-history')
//   async handleGetTranscriptHistory(
//     @MessageBody() data: { roomId: string },
//     @ConnectedSocket() client: Socket,
//   ) {
//     const transcripts = await this.transcriptService.getTranscripts(data.roomId);
//     return {
//       event: 'transcript-history',
//       data: transcripts,
//     };
//   }

//   // ─── KICK PARTICIPANT (host only) ────────────────────────────────────
//   @SubscribeMessage('kick-participant')
//   async handleKickParticipant(
//     @MessageBody() data: { roomId: string; targetUserId: string },
//     @ConnectedSocket() client: Socket,
//   ) {
//     const socketUser = this.socketUsers.get(client.id);
//     if (!socketUser) return;

//     try {
//       const result = await this.roomService.kickParticipant(
//         data.roomId,
//         socketUser.userId,
//         data.targetUserId,
//       );

//       // Notify the kicked user
//       this.server.to(result.kickedSocketId).emit('kicked', {
//         reason: 'You have been removed from the meeting by the host',
//       });

//       // Force the kicked socket to leave the room
//       const kickedSocket = this.server.sockets.sockets.get(result.kickedSocketId);
//       if (kickedSocket) {
//         kickedSocket.leave(data.roomId);
//       }

//       // Notify room that user was kicked
//       client.to(data.roomId).emit('participant-kicked', {
//         userId: data.targetUserId,
//       });

//       return { event: 'kick-success', data: { targetUserId: data.targetUserId } };
//     } catch (error: any) {
//       return { event: 'error', data: { message: error.message } };
//     }
//   }

//   // ─── TOGGLE ROOM LOCK (host only) ────────────────────────────────────
//   @SubscribeMessage('toggle-lock')
//   async handleToggleLock(
//     @MessageBody() data: { roomId: string },
//     @ConnectedSocket() client: Socket,
//   ) {
//     const socketUser = this.socketUsers.get(client.id);
//     if (!socketUser) return;

//     try {
//       const result = await this.roomService.toggleLock(data.roomId, socketUser.userId);

//       // Notify everyone in the room
//       this.server.to(data.roomId).emit('room-locked', {
//         isLocked: result.isLocked,
//         by: socketUser.userName,
//       });

//       return { event: 'lock-toggled', data: result };
//     } catch (error: any) {
//       return { event: 'error', data: { message: error.message } };
//     }
//   }

//   // ─── END MEETING (host only) ─────────────────────────────────────────
//   @SubscribeMessage('end-meeting')
//   async handleEndMeeting(
//     @MessageBody() data: { roomId: string },
//     @ConnectedSocket() client: Socket,
//   ) {
//     const socketUser = this.socketUsers.get(client.id);
//     if (!socketUser) return;

//     try {
//       await this.roomService.endRoom(data.roomId, socketUser.userId);

//       // Notify ALL participants that meeting has ended
//       this.server.to(data.roomId).emit('meeting-ended', {
//         endedBy: socketUser.userName,
//         endedAt: new Date(),
//       });

//       // Remove all sockets from the room
//       const sockets = await this.server.in(data.roomId).fetchSockets();
//       for (const s of sockets) {
//         s.leave(data.roomId);
//       }

//       return { event: 'meeting-ended', data: { success: true } };
//     } catch (error: any) {
//       return { event: 'error', data: { message: error.message } };
//     }
//   }

//   // ─── EXPLICIT LEAVE ──────────────────────────────────────────────────
//   @SubscribeMessage('leave-room')
//   async handleLeaveRoom(
//     @MessageBody() data: { roomId: string },
//     @ConnectedSocket() client: Socket,
//   ) {
//     const socketUser = this.socketUsers.get(client.id);
//     if (!socketUser) return;

//     await this.roomService.leaveRoom(data.roomId, socketUser.userId);

//     client.leave(data.roomId);

//     // Notify remaining participants
//     client.to(data.roomId).emit('user-left', {
//       userId: socketUser.userId,
//       socketId: client.id,
//       userName: socketUser.userName,
//     });

//     // Update local tracking
//     socketUser.roomId = null;

//     return { event: 'left-room', data: { roomId: data.roomId } };
//   }

//   // ─── DISCONNECT ──────────────────────────────────────────────────────
//   async handleDisconnect(client: Socket) {
//     this.logger.log(`Client disconnected: ${client.id}`);

//     // Stop any active Deepgram stream for this socket
//     await this.deepgramService.stopStream(client.id);

//     // Remove from room in DB (finds room by socketId)
//     const result = await this.roomService.leaveRoomBySocketId(client.id);

//     if (result) {
//       // Notify room participants that user left
//       this.server.to(result.room.roomId).emit('user-left', {
//         userId: result.userId,
//         socketId: client.id,
//         userName: result.userName,
//       });
//     }

//     // Clean up local tracking
//     this.socketUsers.delete(client.id);
//   }
// }
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
import { TranscriptService } from '../services/transcript.service';
import { DeepgramService } from '../services/deepgram.service';
import { MediasoupService } from '../../mediasoup/mediasoup.service';

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
    private readonly transcriptService: TranscriptService,
    private readonly deepgramService: DeepgramService,
    private readonly mediasoupService: MediasoupService,
  ) { }

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
    @MessageBody() data: {
      roomId: string;
      userId?: string;
      userName?: string;
      audioEnabled?: boolean;
      videoEnabled?: boolean;
    },
    @ConnectedSocket() client: Socket,
  ) {
    try {
      const socketUser = this.socketUsers.get(client.id);
      const userId = data.userId || socketUser?.userId || client.id;
      const userName = data.userName || socketUser?.userName || 'Anonymous';

      this.logger.log(`User ${userId} (${userName}) joining room ${data.roomId}`);

      // Join room in DB
      const { room, staleParticipant } = await this.roomService.joinRoom(
        data.roomId,
        userId,
        client.id,
        userName,
        {
          audioEnabled: data.audioEnabled,
          videoEnabled: data.videoEnabled,
        }
      );

      // If there was a stale entry for this user, notify the room that the old connection is gone
      if (staleParticipant && staleParticipant.socketId !== client.id) {
        this.logger.log(`Replacing stale socket ${staleParticipant.socketId} for user ${userId}`);
        client.to(data.roomId).emit('user-left', {
          userId,
          socketId: staleParticipant.socketId,
          userName,
        });
      }

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
        audioEnabled: data.audioEnabled ?? true,
        videoEnabled: data.videoEnabled ?? true,
        screenSharing: false,
      });

      // ─── Mediasoup: ensure router exists and register peer ───────────
      const router = await this.mediasoupService.getOrCreateRouter(data.roomId);
      this.mediasoupService.getOrCreatePeer(data.roomId, client.id, userId);

      // If there was a stale Mediasoup peer (e.g., reconnection), clean it up
      if (staleParticipant && staleParticipant.socketId !== client.id) {
        this.mediasoupService.removePeer(data.roomId, staleParticipant.socketId);
      }

      // Get existing producers from other peers so the joiner knows what to consume
      const existingProducers = this.mediasoupService.getOtherProducers(data.roomId, client.id);

      // Send the joiner the list of everyone already in the room
      return {
        event: 'room-joined',
        data: {
          roomId: data.roomId,
          userId,
          socketId: client.id,
          participants: existingParticipants,
          isHost: room.hostId === userId,
          routerRtpCapabilities: router.rtpCapabilities,
          existingProducers,
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

  // ═══════════════════════════════════════════════════════════════════════
  // MEDIASOUP SFU SIGNALING
  // ═══════════════════════════════════════════════════════════════════════

  // ─── GET ROUTER RTP CAPABILITIES ────────────────────────────────────
  @SubscribeMessage('getRouterRtpCapabilities')
  async handleGetRouterRtpCapabilities(
    @MessageBody() data: { roomId: string },
    @ConnectedSocket() client: Socket,
  ) {
    try {
      const router = await this.mediasoupService.getOrCreateRouter(data.roomId);
      return {
        event: 'routerRtpCapabilities',
        data: router.rtpCapabilities,
      };
    } catch (error: any) {
      this.logger.error(`getRouterRtpCapabilities error: ${error.message}`);
      return { event: 'error', data: { message: error.message } };
    }
  }

  // ─── CREATE WEBRTC TRANSPORT (send or recv) ─────────────────────────
  @SubscribeMessage('createWebRtcTransport')
  async handleCreateWebRtcTransport(
    @MessageBody() data: { roomId: string; direction: 'send' | 'recv' },
    @ConnectedSocket() client: Socket,
  ) {
    try {
      const socketUser = this.socketUsers.get(client.id);
      if (!socketUser) throw new Error('Not authenticated');

      // Ensure peer state exists
      this.mediasoupService.getOrCreatePeer(data.roomId, client.id, socketUser.userId);

      const transport = await this.mediasoupService.createWebRtcTransport(
        data.roomId,
        client.id,
        data.direction,
      );

      return {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
        iceServers: this.mediasoupService.getIceServers(),
      };
    } catch (error: any) {
      this.logger.error(`createWebRtcTransport error: ${error.message}`);
      return { event: 'error', data: { message: error.message } };
    }
  }

  // ─── CONNECT WEBRTC TRANSPORT ───────────────────────────────────────
  @SubscribeMessage('connectWebRtcTransport')
  async handleConnectWebRtcTransport(
    @MessageBody() data: { roomId: string; transportId: string; dtlsParameters: any },
    @ConnectedSocket() client: Socket,
  ) {
    try {
      const peer = this.mediasoupService.getPeer(data.roomId, client.id);
      if (!peer) throw new Error('Peer not found');

      // Find the transport (could be send or recv)
      const transport =
        peer.sendTransport?.id === data.transportId
          ? peer.sendTransport
          : peer.recvTransport?.id === data.transportId
            ? peer.recvTransport
            : null;

      if (!transport) throw new Error(`Transport ${data.transportId} not found`);

      await transport.connect({ dtlsParameters: data.dtlsParameters });
      this.logger.debug(`[WebRTC] Transport connected successfully: ${data.transportId}`);

      return { success: true };
    } catch (error: any) {
      this.logger.error(`connectWebRtcTransport error: ${error.message}`);
      return { event: 'error', data: { message: error.message } };
    }
  }

  // ─── PRODUCE (start sending a media track) ──────────────────────────
  @SubscribeMessage('produce')
  async handleProduce(
    @MessageBody() data: {
      roomId: string;
      transportId: string;
      kind: 'audio' | 'video';
      rtpParameters: any;
      appData?: Record<string, any>;
    },
    @ConnectedSocket() client: Socket,
  ) {
    try {
      const socketUser = this.socketUsers.get(client.id);
      if (!socketUser) throw new Error('Not authenticated');

      const peer = this.mediasoupService.getPeer(data.roomId, client.id);
      if (!peer) throw new Error('Peer not found');

      if (!peer.sendTransport || peer.sendTransport.id !== data.transportId) {
        throw new Error('Send transport not found or ID mismatch');
      }

      const producer = await peer.sendTransport.produce({
        kind: data.kind,
        rtpParameters: data.rtpParameters,
        appData: { ...data.appData, userId: socketUser.userId, userName: socketUser.userName },
      });

      // Track it
      peer.producers.set(producer.id, producer);

      // Handle close
      producer.on('transportclose', () => {
        this.logger.debug(`[WebRTC] Producer transport closed: ${producer.id}`);
        producer.close();
        peer.producers.delete(producer.id);
      });

      this.logger.debug(`[WebRTC] Produced ${data.kind} track (id: ${producer.id}) on transport ${data.transportId}`);

      // Notify all other participants in the room about the new producer
      client.to(data.roomId).emit('newProducer', {
        producerId: producer.id,
        socketId: client.id,
        userId: socketUser.userId,
        userName: socketUser.userName,
        kind: producer.kind,
        appData: producer.appData,
      });

      this.logger.log(
        `[SFU] Producer created: room=${data.roomId}, user=${socketUser.userId}, ` +
        `kind=${data.kind}, producerId=${producer.id}`,
      );

      return { id: producer.id, producerId: producer.id };
    } catch (error: any) {
      this.logger.error(`produce error: ${error.message}`);
      return { event: 'error', data: { message: error.message } };
    }
  }

  // ─── CONSUME (start receiving a remote producer) ────────────────────
  @SubscribeMessage('consume')
  async handleConsume(
    @MessageBody() data: { roomId: string; producerId: string; rtpCapabilities: any },
    @ConnectedSocket() client: Socket,
  ) {
    try {
      const router = this.mediasoupService.getRouter(data.roomId);
      if (!router) throw new Error('Router not found');

      const peer = this.mediasoupService.getPeer(data.roomId, client.id);
      if (!peer) throw new Error('Peer not found');

      if (!peer.recvTransport) throw new Error('Recv transport not created yet');

      // Check if the router can consume this producer with the given RTP capabilities
      if (!router.canConsume({ producerId: data.producerId, rtpCapabilities: data.rtpCapabilities })) {
        throw new Error('Cannot consume — incompatible RTP capabilities');
      }

      const consumer = await peer.recvTransport.consume({
        producerId: data.producerId,
        rtpCapabilities: data.rtpCapabilities,
        paused: true, // Start paused — client must call resumeConsumer
      });

      // Track the consumer
      peer.consumers.set(consumer.id, consumer);

      // Handle close
      consumer.on('transportclose', () => {
        this.logger.debug(`[WebRTC] Consumer transport closed: ${consumer.id}`);
        peer.consumers.delete(consumer.id);
      });
      consumer.on('producerclose', () => {
        this.logger.debug(`[WebRTC] Producer closed, closing consumer: ${consumer.id}`);
        peer.consumers.delete(consumer.id);
        client.emit('producerClosed', { producerId: data.producerId, socketId: client.id });
      });
      consumer.on('producerpause', () => {
        client.emit('consumerPaused', { consumerId: consumer.id });
      });
      consumer.on('producerresume', () => {
        client.emit('consumerResumed', { consumerId: consumer.id });
      });

      this.logger.debug(
        `[SFU] Consumer created: room=${data.roomId}, ` +
        `consumerId=${consumer.id}, producerId=${data.producerId}`,
      );

      return {
        id: consumer.id,
        consumerId: consumer.id,
        producerId: data.producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        appData: consumer.appData,
      };
    } catch (error: any) {
      this.logger.error(`consume error: ${error.message}`);
      return { event: 'error', data: { message: error.message } };
    }
  }

  // ─── RESUME CONSUMER ────────────────────────────────────────────────
  @SubscribeMessage('resumeConsumer')
  async handleResumeConsumer(
    @MessageBody() data: { roomId: string; consumerId: string },
    @ConnectedSocket() client: Socket,
  ) {
    try {
      const peer = this.mediasoupService.getPeer(data.roomId, client.id);
      if (!peer) throw new Error('Peer not found');

      const consumer = peer.consumers.get(data.consumerId);
      if (!consumer) throw new Error('Consumer not found');

      await consumer.resume();

      return { consumerId: data.consumerId };
    } catch (error: any) {
      this.logger.error(`resumeConsumer error: ${error.message}`);
      return { event: 'error', data: { message: error.message } };
    }
  }

  // ─── PAUSE PRODUCER (mute without closing) ──────────────────────────
  @SubscribeMessage('pauseProducer')
  async handlePauseProducer(
    @MessageBody() data: { roomId: string; producerId: string },
    @ConnectedSocket() client: Socket,
  ) {
    try {
      const peer = this.mediasoupService.getPeer(data.roomId, client.id);
      if (!peer) throw new Error('Peer not found');

      const producer = peer.producers.get(data.producerId);
      if (!producer) throw new Error('Producer not found');

      await producer.pause();

      // Notify other peers (their consumers will emit 'producerpause' event)
      this.logger.debug(`[SFU] Producer paused: ${data.producerId}`);

      return { producerId: data.producerId };
    } catch (error: any) {
      this.logger.error(`pauseProducer error: ${error.message}`);
      return { event: 'error', data: { message: error.message } };
    }
  }

  // ─── RESUME PRODUCER (unmute) ───────────────────────────────────────
  @SubscribeMessage('resumeProducer')
  async handleResumeProducer(
    @MessageBody() data: { roomId: string; producerId: string },
    @ConnectedSocket() client: Socket,
  ) {
    try {
      const peer = this.mediasoupService.getPeer(data.roomId, client.id);
      if (!peer) throw new Error('Peer not found');

      const producer = peer.producers.get(data.producerId);
      if (!producer) throw new Error('Producer not found');

      await producer.resume();

      this.logger.debug(`[SFU] Producer resumed: ${data.producerId}`);

      return { producerId: data.producerId };
    } catch (error: any) {
      this.logger.error(`resumeProducer error: ${error.message}`);
      return { event: 'error', data: { message: error.message } };
    }
  }

  // ─── CLOSE PRODUCER (stop sharing a track) ──────────────────────────
  @SubscribeMessage('closeProducer')
  async handleCloseProducer(
    @MessageBody() data: { roomId: string; producerId: string },
    @ConnectedSocket() client: Socket,
  ) {
    try {
      const socketUser = this.socketUsers.get(client.id);
      const peer = this.mediasoupService.getPeer(data.roomId, client.id);
      if (!peer) throw new Error('Peer not found');

      const producer = peer.producers.get(data.producerId);
      if (!producer) throw new Error('Producer not found');

      producer.close();
      peer.producers.delete(data.producerId);

      // Notify other peers that this producer is gone
      client.to(data.roomId).emit('producerClosed', {
        producerId: data.producerId,
        socketId: client.id,
        userId: socketUser?.userId,
      });

      this.logger.log(`[SFU] Producer closed: ${data.producerId}`);

      return { producerId: data.producerId };
    } catch (error: any) {
      this.logger.error(`closeProducer error: ${error.message}`);
      return { event: 'error', data: { message: error.message } };
    }
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

  // ─── START DEEPGRAM TRANSCRIPTION ────────────────────────────────────
  @SubscribeMessage('start-transcription')
  async handleStartTranscription(
    @MessageBody() data: { roomId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const socketUser = this.socketUsers.get(client.id);
    if (!socketUser) {
      client.emit('transcription-error', { message: 'Not authenticated' });
      return;
    }

    this.logger.log(
      `[Deepgram] Starting stream for ${socketUser.userName} (${client.id}) in room ${data.roomId}`,
    );

    try {
      await this.deepgramService.startStream(client.id, {
        onInterim: (text: string) => {
          // Broadcast live subtitle to entire room (including sender)
          this.server.to(data.roomId).emit('new-transcript-interim', {
            userId: socketUser.userId,
            userName: socketUser.userName,
            text,
          });
        },
        onFinal: async (text: string) => {
          // Persist and broadcast final transcript to entire room
          try {
            const saved = await this.transcriptService.saveTranscript(
              data.roomId,
              socketUser.userId,
              socketUser.userName,
              text,
            );
            this.server.to(data.roomId).emit('new-transcript', {
              id: (saved as any)._id,
              userId: socketUser.userId,
              userName: socketUser.userName,
              text,
              timestamp: (saved as any).timestamp,
            });
          } catch (err) {
            this.logger.error(
              `[Deepgram] Failed to save/broadcast final transcript for ${client.id}: ${err}`,
            );
          }
        },
        onError: (err: any) => {
          this.logger.error(
            `[Deepgram] Stream error for ${client.id}: ${JSON.stringify(err)}`,
          );
        },
        onClose: () => {
          this.logger.warn(
            `[Deepgram] Stream closed for ${client.id}, notifying client to restart…`,
          );
          client.emit('transcription-disconnected');
        },
      });

      // ★ FIX: Emit the event explicitly so the client's `.once('transcription-started')`
      // always fires, regardless of how NestJS serialises the return value.
      client.emit('transcription-started', { success: true });
      this.logger.log(`[Deepgram] Stream ready — emitted transcription-started to ${client.id}`);

    } catch (err: any) {
      this.logger.error(
        `[Deepgram] Failed to open stream for ${client.id}: ${err?.message ?? err}`,
      );
      // ★ FIX: Tell the client so it can retry instead of hanging forever.
      client.emit('transcription-error', {
        message: err?.message ?? 'Failed to open Deepgram stream',
      });
    }
  }

  // ─── AUDIO CHUNK → DEEPGRAM ───────────────────────────────────────────
  @SubscribeMessage('audio-chunk')
  handleAudioChunk(
    @MessageBody() data: any,
    @ConnectedSocket() client: Socket,
  ) {
    // ★ FIX: Guard — only forward if there is an active Deepgram connection
    if (!this.deepgramService.isConnected(client.id)) return;

    // data arrives as Buffer, ArrayBuffer, or wrapped object depending on transport
    const chunk = Buffer.isBuffer(data)
      ? data
      : data instanceof ArrayBuffer
        ? Buffer.from(data)
        : Buffer.from(data as any);

    this.deepgramService.sendAudio(client.id, chunk);
  }

  // ─── STOP DEEPGRAM TRANSCRIPTION ─────────────────────────────────────
  @SubscribeMessage('stop-transcription')
  async handleStopTranscription(
    @ConnectedSocket() client: Socket,
  ) {
    await this.deepgramService.stopStream(client.id);
    return { event: 'transcription-stopped', data: { success: true } };
  }

  // ─── SUBMIT TRANSCRIPT (legacy / manual fallback) ────────────────────
  @SubscribeMessage('submit-transcript')
  async handleSubmitTranscript(
    @MessageBody() data: { roomId: string; text: string },
    @ConnectedSocket() client: Socket,
  ) {
    const socketUser = this.socketUsers.get(client.id);
    if (!socketUser) return;

    const saved = await this.transcriptService.saveTranscript(
      data.roomId,
      socketUser.userId,
      socketUser.userName,
      data.text,
    );

    this.server.to(data.roomId).emit('new-transcript', {
      id: (saved as any)._id,
      userId: socketUser.userId,
      userName: socketUser.userName,
      text: data.text,
      timestamp: saved.timestamp,
    });
  }

  // ─── SUBMIT INTERIM TRANSCRIPT (legacy / manual fallback) ────────────
  @SubscribeMessage('submit-transcript-interim')
  async handleSubmitTranscriptInterim(
    @MessageBody() data: { roomId: string; text: string },
    @ConnectedSocket() client: Socket,
  ) {
    const socketUser = this.socketUsers.get(client.id);
    if (!socketUser) return;

    client.to(data.roomId).emit('new-transcript-interim', {
      userId: socketUser.userId,
      userName: socketUser.userName,
      text: data.text,
    });
  }

  // ─── GET TRANSCRIPT HISTORY ──────────────────────────────────────────
  @SubscribeMessage('get-transcript-history')
  async handleGetTranscriptHistory(
    @MessageBody() data: { roomId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const transcripts = await this.transcriptService.getTranscripts(data.roomId);
    return {
      event: 'transcript-history',
      data: transcripts,
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

      // Close the entire Mediasoup room (router + all transports/producers/consumers)
      this.mediasoupService.closeRoom(data.roomId);

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

    // Stop Deepgram stream when user explicitly leaves
    await this.deepgramService.stopStream(client.id);

    // Clean up Mediasoup peer state (transports, producers, consumers)
    const closedProducerIds = this.mediasoupService.removePeer(data.roomId, client.id);
    for (const producerId of closedProducerIds) {
      client.to(data.roomId).emit('producerClosed', {
        producerId,
        socketId: client.id,
        userId: socketUser.userId,
      });
    }

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

  // ─── RAISE HAND ──────────────────────────────────────────────────────
  @SubscribeMessage('raise-hand')
  handleRaiseHand(
    @MessageBody() data: { roomId: string; raisedHand: boolean; userId: string; userName: string },
    @ConnectedSocket() client: Socket,
  ) {
    const socketUser = this.socketUsers.get(client.id);
    if (!socketUser) return;

    // Broadcast to everyone ELSE in the room (sender already updated their own state locally)
    client.to(data.roomId).emit('raise-hand', {
      userId: socketUser.userId,
      socketId: client.id,
      userName: socketUser.userName,
      raisedHand: data.raisedHand,
    });
  }

  // ─── DISCONNECT ──────────────────────────────────────────────────────
  async handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);

    // Stop any active Deepgram stream for this socket
    await this.deepgramService.stopStream(client.id);

    // Remove from room in DB (finds room by socketId)
    const result = await this.roomService.leaveRoomBySocketId(client.id);

    if (result) {
      // Clean up Mediasoup peer state
      const closedProducerIds = this.mediasoupService.removePeer(result.room.roomId, client.id);
      for (const producerId of closedProducerIds) {
        this.server.to(result.room.roomId).emit('producerClosed', {
          producerId,
          socketId: client.id,
          userId: result.userId,
        });
      }

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
