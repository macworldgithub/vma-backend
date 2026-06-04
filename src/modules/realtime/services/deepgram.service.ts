// import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
// import { ConfigService } from '@nestjs/config';
// import {
//   createClient,
//   LiveTranscriptionEvents,
//   ListenLiveClient,
// } from '@deepgram/sdk';

// interface TranscriptCallbacks {
//   onInterim: (text: string, speaker?: number) => void;
//   onFinal: (text: string, speaker?: number) => void;
//   onError?: (err: any) => void;
//   onClose?: () => void;
// }

// interface ActiveConnection {
//   client: ListenLiveClient;
//   ready: Promise<void>;
//   keepAliveTimer?: ReturnType<typeof setInterval>;
// }

// @Injectable()
// export class DeepgramService implements OnModuleDestroy {
//   private readonly logger = new Logger(DeepgramService.name);

//   /** One live connection per socket ID */
//   private readonly connections = new Map<string, ActiveConnection>();

//   private readonly deepgram;

//   constructor(private readonly config: ConfigService) {
//     const key = this.config.get<string>('DEEPGRAM_KEY') ?? '';
//     if (!key) {
//       this.logger.warn('[Deepgram] No DEEPGRAM_KEY configured — transcription will not work');
//     }
//     this.deepgram = createClient(key);
//   }

//   // ── Open a streaming connection for one participant ──────────────────
//   async startStream(
//     socketId: string,
//     callbacks: TranscriptCallbacks,
//   ): Promise<void> {
//     // Tear down any existing connection first
//     if (this.connections.has(socketId)) {
//       await this.stopStream(socketId);
//     }

//     const connection: ListenLiveClient = this.deepgram.listen.live({
//       model: 'nova-2',
//       language: 'en',
//       punctuate: true,
//       smart_format: true,
//       interim_results: true,
//       endpointing: 300,
//       diarize: true,
//       filler_words: false,
//       channels: 1,
//       // No explicit encoding — Deepgram auto-detects webm/opus from MediaRecorder
//     });

//     // Create a promise that resolves when the WebSocket to Deepgram is open
//     const ready = new Promise<void>((resolve, reject) => {
//       const timeout = setTimeout(() => {
//         reject(new Error('Deepgram connection timed out after 10s'));
//       }, 10000);

//       connection.on(LiveTranscriptionEvents.Open, () => {
//         clearTimeout(timeout);
//         this.logger.log(`[Deepgram] Stream OPEN  → socket ${socketId}`);
//         resolve();
//       });

//       connection.on(LiveTranscriptionEvents.Error, (err: any) => {
//         clearTimeout(timeout);
//         this.logger.error(
//           `[Deepgram] Error for socket ${socketId}: ${JSON.stringify(err)}`,
//         );
//         callbacks.onError?.(err);
//         reject(err);
//       });
//     });

//     connection.on(LiveTranscriptionEvents.Transcript, (data: any) => {
//       try {
//         const alt = data?.channel?.alternatives?.[0];
//         const transcript: string = alt?.transcript ?? '';
//         const isFinal: boolean = data?.is_final === true;
//         const speaker: number | undefined = alt?.words?.[0]?.speaker;

//         if (!transcript.trim()) return;

//         if (isFinal) {
//           callbacks.onFinal(transcript.trim(), speaker);
//         } else {
//           callbacks.onInterim(transcript.trim(), speaker);
//         }
//       } catch (err) {
//         this.logger.error(`[Deepgram] Error parsing transcript: ${err}`);
//       }
//     });

//     connection.on(LiveTranscriptionEvents.Close, () => {
//       this.logger.log(`[Deepgram] Stream CLOSED → socket ${socketId}`);
//       callbacks.onClose?.();
//       this.cleanupConnection(socketId);
//     });

//     // Send keepAlive every 8 seconds to prevent Deepgram from closing
//     // the connection due to inactivity
//     const keepAliveTimer = setInterval(() => {
//       try {
//         connection.keepAlive();
//       } catch {
//         // Connection already closed, timer will be cleared on cleanup
//       }
//     }, 8000);

//     this.connections.set(socketId, { client: connection, ready, keepAliveTimer });

//     // Wait for the connection to be ready before returning
//     try {
//       await ready;
//     } catch (err) {
//       this.logger.error(`[Deepgram] Failed to open stream for ${socketId}: ${err}`);
//       this.cleanupConnection(socketId);
//       throw err;
//     }
//   }

//   // ── Forward raw audio to Deepgram ────────────────────────────────────
//   sendAudio(socketId: string, chunk: Buffer): void {
//     const conn = this.connections.get(socketId);
//     if (!conn) return;
//     try {
//       // Cast chunk to any to avoid TS type mismatch between Node Buffer and DOM socket types
//       conn.client.send(chunk as any);
//     } catch (err) {
//       this.logger.warn(`[Deepgram] sendAudio error for ${socketId}: ${err}`);
//     }
//   }

//   // ── Close one participant's stream ───────────────────────────────────
//   async stopStream(socketId: string): Promise<void> {
//     const conn = this.connections.get(socketId);
//     if (!conn) return;
//     try {
//       conn.client.requestClose();
//     } catch {
//       // already closed
//     }
//     this.cleanupConnection(socketId);
//     this.logger.log(`[Deepgram] Stream stopped for socket ${socketId}`);
//   }

//   private cleanupConnection(socketId: string): void {
//     const conn = this.connections.get(socketId);
//     if (conn?.keepAliveTimer) {
//       clearInterval(conn.keepAliveTimer);
//     }
//     this.connections.delete(socketId);
//   }

//   // ── Cleanup all streams on module shutdown ───────────────────────────
//   async onModuleDestroy() {
//     const ids = Array.from(this.connections.keys());
//     await Promise.all(ids.map((id) => this.stopStream(id)));
//   }
// }

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createClient,
  LiveTranscriptionEvents,
  ListenLiveClient,
} from '@deepgram/sdk';

interface TranscriptCallbacks {
  onInterim: (text: string, speaker?: number) => void;
  onFinal: (text: string, speaker?: number) => void;
  onError?: (err: any) => void;
  onClose?: () => void;
}

interface ActiveConnection {
  client: ListenLiveClient;
  ready: Promise<void>;
  isOpen: boolean;
  keepAliveTimer?: ReturnType<typeof setInterval>;
}

@Injectable()
export class DeepgramService implements OnModuleDestroy {
  private readonly logger = new Logger(DeepgramService.name);

  /** One live connection per socket ID */
  private readonly connections = new Map<string, ActiveConnection>();

  private readonly deepgram;

  constructor(private readonly config: ConfigService) {
    const key = this.config.get<string>('DEEPGRAM_KEY') ?? '';
    if (!key) {
      this.logger.warn('[Deepgram] No DEEPGRAM_KEY configured — transcription will not work');
    }
    this.deepgram = createClient(key);
  }

  // ── Check if a connection exists and is ready ────────────────────────
  isConnected(socketId: string): boolean {
    const conn = this.connections.get(socketId);
    return !!conn && conn.isOpen;
  }

  // ── Open a streaming connection for one participant ──────────────────
  async startStream(
    socketId: string,
    callbacks: TranscriptCallbacks,
  ): Promise<void> {
    // Tear down any existing connection first
    if (this.connections.has(socketId)) {
      await this.stopStream(socketId);
    }

    const connection: ListenLiveClient = this.deepgram.listen.live({
      model: 'nova-2',
      language: 'en',
      punctuate: true,
      smart_format: true,
      interim_results: true,
      endpointing: 300,
      diarize: true,
      filler_words: false,
      channels: 1,
      encoding: 'opus',
      sample_rate: 48000,
      // Explicitly tell Deepgram the encoding and sample rate to avoid
      // auto-detection failures that cause empty transcripts.
    });

    // Wrap the connection entry — isOpen will be flipped once the WS opens
    const entry: ActiveConnection = {
      client: connection,
      ready: Promise.resolve(), // replaced below
      isOpen: false,
    };

    // Create a promise that resolves when the WebSocket to Deepgram is open
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Deepgram connection timed out after 10 s'));
      }, 10_000);

      connection.on(LiveTranscriptionEvents.Open, () => {
        clearTimeout(timeout);
        entry.isOpen = true;
        this.logger.log(`[Deepgram] Stream OPEN  → socket ${socketId}`);
        resolve();
      });

      connection.on(LiveTranscriptionEvents.Error, (err: any) => {
        clearTimeout(timeout);
        entry.isOpen = false;
        this.logger.error(
          `[Deepgram] Error for socket ${socketId}: ${JSON.stringify(err)}`,
        );
        callbacks.onError?.(err);
        reject(err);
      });
    });

    entry.ready = ready;

    connection.on(LiveTranscriptionEvents.Transcript, (data: any) => {
      try {
        const alt = data?.channel?.alternatives?.[0];
        const transcript: string = alt?.transcript ?? '';
        const isFinal: boolean = data?.is_final === true;
        const speaker: number | undefined = alt?.words?.[0]?.speaker;

        if (!transcript.trim()) return;

        if (isFinal) {
          callbacks.onFinal(transcript.trim(), speaker);
        } else {
          callbacks.onInterim(transcript.trim(), speaker);
        }
      } catch (err) {
        this.logger.error(`[Deepgram] Error parsing transcript: ${err}`);
      }
    });

    connection.on(LiveTranscriptionEvents.Close, () => {
      this.logger.log(`[Deepgram] Stream CLOSED → socket ${socketId}`);
      entry.isOpen = false;
      callbacks.onClose?.();
      this.cleanupConnection(socketId);
    });

    // Send keepAlive every 8 seconds to prevent Deepgram from closing
    // the connection due to inactivity
    entry.keepAliveTimer = setInterval(() => {
      try {
        if (entry.isOpen) {
          connection.keepAlive();
        }
      } catch {
        // Connection already closed, timer will be cleared on cleanup
      }
    }, 8000);

    this.connections.set(socketId, entry);

    // Wait for the connection to be ready before returning
    try {
      await ready;
    } catch (err) {
      this.logger.error(`[Deepgram] Failed to open stream for ${socketId}: ${err}`);
      this.cleanupConnection(socketId);
      throw err;
    }
  }

  // ── Forward raw audio to Deepgram ────────────────────────────────────
  sendAudio(socketId: string, chunk: Buffer): void {
    const conn = this.connections.get(socketId);
    if (!conn || !conn.isOpen) return;
    try {
      // Cast chunk to any to avoid TS type mismatch between Node Buffer and DOM socket types
      conn.client.send(chunk as any);
    } catch (err) {
      this.logger.warn(`[Deepgram] sendAudio error for ${socketId}: ${err}`);
    }
  }

  // ── Close one participant's stream ───────────────────────────────────
  async stopStream(socketId: string): Promise<void> {
    const conn = this.connections.get(socketId);
    if (!conn) return;
    conn.isOpen = false;
    try {
      conn.client.requestClose();
    } catch {
      // already closed
    }
    this.cleanupConnection(socketId);
    this.logger.log(`[Deepgram] Stream stopped for socket ${socketId}`);
  }

  private cleanupConnection(socketId: string): void {
    const conn = this.connections.get(socketId);
    if (conn?.keepAliveTimer) {
      clearInterval(conn.keepAliveTimer);
    }
    this.connections.delete(socketId);
  }

  // ── Cleanup all streams on module shutdown ───────────────────────────
  async onModuleDestroy() {
    const ids = Array.from(this.connections.keys());
    await Promise.all(ids.map((id) => this.stopStream(id)));
  }
}
