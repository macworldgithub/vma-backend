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
}

@Injectable()
export class DeepgramService implements OnModuleDestroy {
  private readonly logger = new Logger(DeepgramService.name);

  /** One live connection per socket ID */
  private readonly connections = new Map<string, ListenLiveClient>();

  private readonly deepgram;

  constructor(private readonly config: ConfigService) {
    const key = this.config.get<string>('DEEPGRAM_KEY') ?? '';
    this.deepgram = createClient(key);
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
      language: 'en-AU',
      punctuate: true,
      smart_format: true,
      interim_results: true,
      endpointing: 300,
      diarize: true,
      // Let Deepgram auto-detect container format (webm / ogg / mp4)
    });

    connection.on(LiveTranscriptionEvents.Open, () => {
      this.logger.log(`[Deepgram] Stream OPEN  → socket ${socketId}`);
    });

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

    connection.on(LiveTranscriptionEvents.Error, (err: any) => {
      this.logger.error(
        `[Deepgram] Error for socket ${socketId}: ${JSON.stringify(err)}`,
      );
      callbacks.onError?.(err);
    });

    connection.on(LiveTranscriptionEvents.Close, () => {
      this.logger.log(`[Deepgram] Stream CLOSED → socket ${socketId}`);
      this.connections.delete(socketId);
    });

    this.connections.set(socketId, connection);
  }

  // ── Forward raw audio to Deepgram ────────────────────────────────────
  sendAudio(socketId: string, chunk: Buffer): void {
    const conn = this.connections.get(socketId);
    if (!conn) return;
    try {
      conn.send(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
    } catch (err) {
      this.logger.warn(`[Deepgram] sendAudio error for ${socketId}: ${err}`);
    }
  }

  // ── Close one participant's stream ───────────────────────────────────
  async stopStream(socketId: string): Promise<void> {
    const conn = this.connections.get(socketId);
    if (!conn) return;
    try {
      conn.finish();
    } catch {
      // already closed
    }
    this.connections.delete(socketId);
    this.logger.log(`[Deepgram] Stream stopped for socket ${socketId}`);
  }

  // ── Cleanup all streams on module shutdown ───────────────────────────
  async onModuleDestroy() {
    const ids = Array.from(this.connections.keys());
    await Promise.all(ids.map((id) => this.stopStream(id)));
  }
}
