import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as mediasoup from 'mediasoup';
import { mediaCodecs } from './mediasoup-config';

// ─── Per-peer media state ──────────────────────────────────────────────
export interface PeerMediaState {
  userId: string;
  sendTransport: mediasoup.types.WebRtcTransport | null;
  recvTransport: mediasoup.types.WebRtcTransport | null;
  producers: Map<string, mediasoup.types.Producer>; // producerId → Producer
  consumers: Map<string, mediasoup.types.Consumer>; // consumerId → Consumer
}

// ─── Per-room media state ──────────────────────────────────────────────
export interface RoomMediaState {
  router: mediasoup.types.Router;
  peers: Map<string, PeerMediaState>; // socketId → PeerMediaState
}

@Injectable()
export class MediasoupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MediasoupService.name);

  /** Pool of Mediasoup Workers (one per CPU core) */
  private workers: mediasoup.types.Worker[] = [];
  private nextWorkerIdx = 0;

  /** Room state: roomId → RoomMediaState */
  private rooms = new Map<string, RoomMediaState>();

  // Config
  private listenIp!: string;
  private announcedIp!: string;
  private minPort!: number;
  private maxPort!: number;
  private numWorkers!: number;

  constructor(private readonly config: ConfigService) {}

  // ═══════════════════════════════════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════════════════════════════════

  async onModuleInit() {
    this.listenIp = this.config.get<string>('MEDIASOUP_LISTEN_IP') || '0.0.0.0';
    this.announcedIp = this.config.get<string>('MEDIASOUP_ANNOUNCED_IP') || '';
    this.minPort = parseInt(this.config.get<string>('MEDIASOUP_MIN_PORT') || '40000', 10);
    this.maxPort = parseInt(this.config.get<string>('MEDIASOUP_MAX_PORT') || '49999', 10);
    this.numWorkers = parseInt(this.config.get<string>('MEDIASOUP_NUM_WORKERS') || '2', 10);

    if (!this.announcedIp) {
      this.logger.warn(
        'MEDIASOUP_ANNOUNCED_IP is not set! Remote clients will not be able to connect. ' +
        'Set this to your VPS public IP or domain.',
      );
    }

    this.logger.log(
      `Initialising ${this.numWorkers} Mediasoup Worker(s) — ` +
      `listen=${this.listenIp}, announced=${this.announcedIp || '(not set)'}, ` +
      `ports=${this.minPort}-${this.maxPort}`,
    );

    for (let i = 0; i < this.numWorkers; i++) {
      const worker = await mediasoup.createWorker({
        rtcMinPort: this.minPort,
        rtcMaxPort: this.maxPort,
        logLevel: 'warn',
        logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
      });

      worker.on('died', () => {
        this.logger.error(`Mediasoup Worker DIED (pid ${worker.pid}) — restarting in 2s`);
        setTimeout(() => this.replaceWorker(i), 2000);
      });

      this.workers.push(worker);
      this.logger.log(`Mediasoup Worker created (pid: ${worker.pid}) [${i + 1}/${this.numWorkers}]`);
    }
  }

  async onModuleDestroy() {
    for (const worker of this.workers) {
      worker.close();
    }
    this.rooms.clear();
    this.logger.log('All Mediasoup Workers closed');
  }

  /** Replace a dead worker at the given index */
  private async replaceWorker(index: number) {
    try {
      const worker = await mediasoup.createWorker({
        rtcMinPort: this.minPort,
        rtcMaxPort: this.maxPort,
        logLevel: 'warn',
        logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
      });

      worker.on('died', () => {
        this.logger.error(`Mediasoup Worker DIED (pid ${worker.pid}) — restarting in 2s`);
        setTimeout(() => this.replaceWorker(index), 2000);
      });

      this.workers[index] = worker;
      this.logger.log(`Mediasoup Worker replaced (pid: ${worker.pid}) [index ${index}]`);
    } catch (err) {
      this.logger.error(`Failed to replace Mediasoup Worker: ${err}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Worker round-robin
  // ═══════════════════════════════════════════════════════════════════════

  private getNextWorker(): mediasoup.types.Worker {
    const worker = this.workers[this.nextWorkerIdx];
    this.nextWorkerIdx = (this.nextWorkerIdx + 1) % this.workers.length;
    return worker;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Router (one per room)
  // ═══════════════════════════════════════════════════════════════════════

  async getOrCreateRouter(roomId: string): Promise<mediasoup.types.Router> {
    const existing = this.rooms.get(roomId);
    if (existing) return existing.router;

    const worker = this.getNextWorker();
    const router = await worker.createRouter({ mediaCodecs });

    this.rooms.set(roomId, {
      router,
      peers: new Map(),
    });

    this.logger.log(`Router created for room ${roomId} (worker pid ${worker.pid})`);
    return router;
  }

  getRouter(roomId: string): mediasoup.types.Router | undefined {
    return this.rooms.get(roomId)?.router;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Peer management
  // ═══════════════════════════════════════════════════════════════════════

  getOrCreatePeer(roomId: string, socketId: string, userId: string): PeerMediaState {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`Room ${roomId} does not exist in Mediasoup`);

    let peer = room.peers.get(socketId);
    if (!peer) {
      peer = {
        userId,
        sendTransport: null,
        recvTransport: null,
        producers: new Map(),
        consumers: new Map(),
      };
      room.peers.set(socketId, peer);
    }
    return peer;
  }

  getPeer(roomId: string, socketId: string): PeerMediaState | undefined {
    return this.rooms.get(roomId)?.peers.get(socketId);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // WebRTC Transport
  // ═══════════════════════════════════════════════════════════════════════

  async createWebRtcTransport(
    roomId: string,
    socketId: string,
    direction: 'send' | 'recv',
  ): Promise<mediasoup.types.WebRtcTransport> {
    const router = this.getRouter(roomId);
    if (!router) throw new Error(`No router for room ${roomId}`);

    const peer = this.getPeer(roomId, socketId);
    if (!peer) throw new Error(`No peer state for socket ${socketId} in room ${roomId}`);

    const transport = await router.createWebRtcTransport({
      listenIps: [
        {
          ip: this.listenIp,
          announcedIp: this.announcedIp || undefined,
        },
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: 1_000_000,
    });

    // Track the transport
    if (direction === 'send') {
      // Close existing send transport if any (reconnection scenario)
      if (peer.sendTransport) {
        peer.sendTransport.close();
      }
      peer.sendTransport = transport;
    } else {
      if (peer.recvTransport) {
        peer.recvTransport.close();
      }
      peer.recvTransport = transport;
    }

    this.logger.debug(
      `WebRtcTransport created: room=${roomId}, socket=${socketId}, ` +
      `direction=${direction}, id=${transport.id}`,
    );

    return transport;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Producer
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Get all producers in a room from all peers EXCEPT the given socketId.
   * Used to tell a new joiner what to consume.
   */
  getOtherProducers(
    roomId: string,
    excludeSocketId: string,
  ): { producerId: string; socketId: string; userId: string; kind: string; appData: Record<string, unknown> }[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];

    const result: { producerId: string; socketId: string; userId: string; kind: string; appData: Record<string, unknown> }[] = [];

    for (const [socketId, peer] of room.peers) {
      if (socketId === excludeSocketId) continue;
      for (const [producerId, producer] of peer.producers) {
        if (!producer.closed) {
          result.push({
            producerId,
            socketId,
            userId: peer.userId,
            kind: producer.kind,
            appData: producer.appData as Record<string, unknown>,
          });
        }
      }
    }

    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Cleanup
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Remove a peer from a room — closes all their transports, producers, consumers.
   * Returns the list of producerIds that were closed (so the gateway can notify the room).
   */
  removePeer(roomId: string, socketId: string): string[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];

    const peer = room.peers.get(socketId);
    if (!peer) return [];

    const closedProducerIds: string[] = [];

    // Close all consumers
    for (const consumer of peer.consumers.values()) {
      if (!consumer.closed) consumer.close();
    }

    // Close all producers
    for (const [producerId, producer] of peer.producers) {
      if (!producer.closed) {
        producer.close();
        closedProducerIds.push(producerId);
      }
    }

    // Close transports
    if (peer.sendTransport && !peer.sendTransport.closed) {
      peer.sendTransport.close();
    }
    if (peer.recvTransport && !peer.recvTransport.closed) {
      peer.recvTransport.close();
    }

    room.peers.delete(socketId);
    this.logger.debug(`Peer removed: room=${roomId}, socket=${socketId}`);

    return closedProducerIds;
  }

  /**
   * Close an entire room — closes router and all associated resources.
   */
  closeRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    // Close router (this automatically closes all transports, producers, consumers)
    room.router.close();
    this.rooms.delete(roomId);
    this.logger.log(`Room closed: ${roomId}`);
  }

  /**
   * Check if a room has a router
   */
  hasRoom(roomId: string): boolean {
    return this.rooms.has(roomId);
  }
}
