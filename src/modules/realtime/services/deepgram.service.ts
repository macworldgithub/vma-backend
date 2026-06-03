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

interface ActiveConnection {
  client: ListenLiveClient;
  ready: Promise<void>;
  keepAliveTimer?: ReturnType<typeof setInterval>;
  /** Set to true when we're intentionally tearing down so we don't auto-reconnect */
  closing: boolean;
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
      this.logger.warn(
        '[Deepgram] No DEEPGRAM_KEY configured — transcription will not work',
      );
    }
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

    /**
     * Audio parameters must match what the browser sends.
     *
     * The client captures at:
     *   sampleRate  = 16 000 Hz   (set in buildAudioConstraints)
     *   channelCount = 1          (mono)
     *   codec        = opus       (default MediaRecorder codec in Chrome/Firefox)
     *   container    = webm       (MediaRecorder default)
     *
     * Deepgram nova-2 options:
     *   encoding      = "opus"         — explicitly declare the codec
     *   container     = "webm"         — the MediaRecorder wrapping format
     *   sample_rate   = 16000          — must match capture sampleRate
     *   channels      = 1              — must match capture channelCount
     *
     * Leaving these unset forces Deepgram to probe each chunk, which adds
     * latency, occasionally mis-detects the format, and causes the garbled
     * audio / broken transcription you were seeing.
     */
    const connection: ListenLiveClient = this.deepgram.listen.live({
      model: 'nova-2',
      language: 'en',
      punctuate: true,
      smart_format: true,
      interim_results: true,
      // How long (ms) of silence before Deepgram emits a final transcript.
      // 300 ms gives a good balance of responsiveness vs. sentence completion.
      endpointing: 300,
      diarize: true,
      // ✅ Explicit encoding — removes ambiguity and is the main fix for garbled audio
      encoding: 'opus',
      container: 'webm',
      sample_rate: 16000,
      channels: 1,
      // Utterance end detection — emit a final segment after 1 s of post-speech silence
      utterance_end_ms: 1000,
    });

    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('[Deepgram] Connection timed out after 10 s'));
      }, 10_000);

      connection.on(LiveTranscriptionEvents.Open, () => {
        clearTimeout(timeout);
        this.logger.log(`[Deepgram] Stream OPEN  → socket ${socketId}`);
        resolve();
      });

      connection.on(LiveTranscriptionEvents.Error, (err: any) => {
        clearTimeout(timeout);
        this.logger.error(
          `[Deepgram] Error for socket ${socketId}: ${JSON.stringify(err)}`,
        );
        callbacks.onError?.(err);
        reject(err);
      });
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
        this.logger.error(`[Deepgram] Transcript parse error: ${err}`);
      }
    });

    connection.on(LiveTranscriptionEvents.Close, () => {
      this.logger.log(`[Deepgram] Stream CLOSED → socket ${socketId}`);
      const conn = this.connections.get(socketId);
      if (conn && !conn.closing) {
        // Unexpected close — log it; the caller should decide whether to restart
        this.logger.warn(
          `[Deepgram] Unexpected close for ${socketId}. ` +
          `Caller should re-invoke startStream() to reconnect.`,
        );
        callbacks.onError?.(new Error('Deepgram stream closed unexpectedly'));
      }
      this.cleanupConnection(socketId);
    });

    // Send keepAlive every 8 seconds to prevent Deepgram from closing the
    // connection due to inactivity (Deepgram closes after ~10 s of silence).
    const keepAliveTimer = setInterval(() => {
      const conn = this.connections.get(socketId);
      if (!conn || conn.closing) {
        clearInterval(keepAliveTimer);
        return;
      }
      try {
        conn.client.keepAlive();
      } catch {
        // Connection already closed; the Close event handler will clean up
      }
    }, 8_000);

    this.connections.set(socketId, {
      client: connection,
      ready,
      keepAliveTimer,
      closing: false,
    });

    // Wait for the connection to be ready before returning
    try {
      await ready;
    } catch (err) {
      this.logger.error(
        `[Deepgram] Failed to open stream for ${socketId}: ${err}`,
      );
      this.cleanupConnection(socketId);
      throw err;
    }
  }

  // ── Forward raw audio to Deepgram ────────────────────────────────────
  /**
   * Receives a raw Buffer from the gateway (emitted by the browser's
   * MediaRecorder in webm/opus format) and forwards it to Deepgram.
   *
   * IMPORTANT: The caller must only call this AFTER `startStream()` resolves.
   * Sending audio before the WebSocket to Deepgram is open will silently drop
   * chunks and cause the "transcription interrupted" symptom.
   */
  sendAudio(socketId: string, chunk: Buffer): void {
    const conn = this.connections.get(socketId);
    if (!conn || conn.closing) return;

    if (chunk.byteLength === 0) {
      this.logger.verbose(`[Deepgram] Skipping empty chunk for ${socketId}`);
      return;
    }

    try {
      // Cast to `any` to bridge the Node Buffer / DOM Blob type mismatch in the SDK typings
      conn.client.send(chunk as any);
    } catch (err) {
      this.logger.warn(`[Deepgram] sendAudio error for ${socketId}: ${err}`);
    }
  }

  // ── Close one participant's stream ───────────────────────────────────
  async stopStream(socketId: string): Promise<void> {
    const conn = this.connections.get(socketId);
    if (!conn) return;

    // Mark as intentionally closing so the Close event handler doesn't
    // treat this as an unexpected disconnect
    conn.closing = true;

    try {
      conn.client.requestClose();
    } catch {
      // Already closed — ignore
    }

    this.cleanupConnection(socketId);
    this.logger.log(`[Deepgram] Stream stopped for socket ${socketId}`);
  }

  // ── Check whether a stream is active ────────────────────────────────
  isStreamActive(socketId: string): boolean {
    return this.connections.has(socketId);
  }

  // ── Internal cleanup ─────────────────────────────────────────────────
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