import type { Language } from '@serviceloop/shared';
import { INTERNAL_SAMPLE_RATE, toFrames, type AudioFrame } from '../telephony/audio';
import { EventStream } from '../telephony/events';
import {
  StreamingSpeechError,
  toSynthesisChunks,
  type StreamSynthesizeOptions,
  type StreamTranscribeOptions,
  type StreamingSpeechPort,
  type SynthesisStream,
  type TranscribeStream,
  type TranscriptEvent,
} from './streaming-port';

/**
 * `SarvamStreamingAdapter` — live STT and TTS over Sarvam's websockets
 * (phase 5.2).
 *
 * Chosen for the same reason the batch adapter was: Tamil, Hindi and their
 * code-switched registers are the *first-class* case rather than a language
 * pack, and this system's audio is Tanglish over an 8 kHz line. Surfaces
 * verified against Sarvam's current API documentation (August 2026):
 *
 *   - **STT** `wss://api.sarvam.ai/speech-to-text/ws` with `language_code`,
 *     `model`, `sample_rate` and `vad_signals` as query parameters; audio goes
 *     up as `{ audio, encoding, sample_rate }` with base64 payloads, and
 *     `transcript` events come back down.
 *   - **TTS** `wss://api.sarvam.ai/text-to-speech/ws?model=bulbul:v2`, a single
 *     `config` message and then any number of `text` messages, answering with
 *     `{ type: "audio", data: { audio, content_type } }`.
 *
 * Two things are worth stating plainly rather than discovering at 2 a.m.:
 *
 *   - **The websocket client is Node's own.** Node 22 ships a global
 *     `WebSocket`, so this adapter needs no dependency. The constructor is
 *     injectable all the same, because a deployment behind a proxy that needs
 *     `ws` should be a wiring change and not a fork.
 *   - **A codec we cannot play is an error, not noise.** Bulbul can return MP3.
 *     A telephone leg wants linear PCM, and feeding compressed bytes into it
 *     produces a call of pure static that looks, from every log line, like a
 *     successful synthesis. So the payload is checked and refused.
 */

/** The tag Sarvam wants. Its models are trained on the `-IN` locales. */
export function sarvamLanguageCode(language: Language): string {
  switch (language) {
    case 'ta':
      return 'ta-IN';
    case 'hi':
      return 'hi-IN';
    case 'en':
      return 'en-IN';
  }
}

export type WebSocketLike = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
  addEventListener(type: string, listener: (event: unknown) => void): void;
};

export type WebSocketFactory = (url: string, headers: Record<string, string>) => WebSocketLike;

const defaultWebSocketFactory: WebSocketFactory = (url, headers) =>
  // The options bag is undici's non-standard extension, which is what Node's
  // global client is. A runtime without it still connects; it simply carries no
  // headers, which is why the key is also on the query string below.
  new WebSocket(url, { headers } as unknown as string[]) as unknown as WebSocketLike;

export interface SarvamStreamingConfig {
  readonly apiKey: string;
  readonly sttUrl: string;
  readonly ttsUrl: string;
  readonly sttModel: string;
  readonly ttsModel: string;
  /** Bulbul voice id per language. Configuration, never hardcoded (§10). */
  readonly voices: Readonly<Record<Language, string>>;
  readonly frameMs: number;
  readonly connectTimeoutMs: number;
  readonly webSocketFactory?: WebSocketFactory;
  readonly now?: () => Date;
}

class SarvamTranscribeStream implements TranscribeStream {
  readonly events = new EventStream<TranscriptEvent>();

  private socket: WebSocketLike | null = null;
  private readonly pending: string[] = [];
  private ready = false;
  private closed = false;
  private audioMs = 0;
  private lastFinal = '';

  constructor(
    readonly callId: string,
    private readonly config: SarvamStreamingConfig,
    private readonly options: StreamTranscribeOptions,
    private readonly now: () => Date,
  ) {
    this.connect();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  push(frame: AudioFrame): boolean {
    if (this.closed) return false;

    this.audioMs += frame.durationMs;
    const message = JSON.stringify({
      audio: frame.pcm16.toString('base64'),
      encoding: 'pcm_s16le',
      sample_rate: this.options.sampleRate ?? INTERNAL_SAMPLE_RATE,
    });

    if (!this.ready || this.socket === null) {
      this.pending.push(message);
      // The queue is bounded: a socket that never opens must not turn a call
      // into a memory leak, and thirty seconds of audio is far longer than any
      // connection this adapter would still be waiting on.
      return this.pending.length < 1_500;
    }

    this.socket.send(message);
    return true;
  }

  async drain(): Promise<void> {
    if (this.ready || this.closed) return;
    await this.waitForOpen();
  }

  async end(): Promise<void> {
    if (this.closed) return;
    await this.drain().catch(() => undefined);
    this.socket?.send(JSON.stringify({ event: 'stop' }));
    // Flushed rather than dropped: whatever the recogniser had heard is the
    // caller's last words, and a turn that ends by hanging up still needs them.
    if (this.lastFinal.length === 0) {
      this.events.push({
        kind: 'final',
        text: '',
        confidence: 0,
        languageTag: null,
        at: this.now(),
        audioMs: this.audioMs,
      });
    }
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket?.close(1000, 'turn complete');
    } catch {
      /* A socket that is already gone needs no closing. */
    }
    this.events.close();
  }

  private connect(): void {
    const url = new URL(this.config.sttUrl);
    url.searchParams.set('model', this.config.sttModel);
    url.searchParams.set(
      'language_code',
      sarvamLanguageCode(this.options.languageHint ?? 'en'),
    );
    url.searchParams.set('sample_rate', String(this.options.sampleRate ?? INTERNAL_SAMPLE_RATE));
    // Sarvam's own endpointing signals. The turn manager still runs its silence
    // timer on top (phase 5.3) — a provider's VAD is a hint about the audio, not
    // a decision about whose turn it is.
    url.searchParams.set('vad_signals', 'true');
    url.searchParams.set('api-subscription-key', this.config.apiKey);

    const factory = this.config.webSocketFactory ?? defaultWebSocketFactory;
    const socket = factory(url.toString(), { 'api-subscription-key': this.config.apiKey });
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.ready = true;
      for (const message of this.pending.splice(0)) socket.send(message);
    });

    socket.addEventListener('message', (event) => {
      this.onMessage(readEventData(event));
    });

    socket.addEventListener('error', () => {
      this.fail('Sarvam closed the recogniser socket');
    });

    socket.addEventListener('close', () => {
      if (!this.closed) this.fail('Sarvam closed the recogniser socket');
    });
  }

  private async waitForOpen(): Promise<void> {
    const deadline = Date.now() + this.config.connectTimeoutMs;
    while (!this.ready && !this.closed && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!this.ready && !this.closed) {
      throw new StreamingSpeechError('PROVIDER_UNAVAILABLE', 'Sarvam did not open the socket', {
        callId: this.callId,
      });
    }
  }

  private onMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;

    const frame = parsed as Record<string, unknown>;
    const type = String(frame['type'] ?? frame['event'] ?? '');
    const data = asRecord(frame['data']);

    if (type === 'transcript' || type === 'partial_transcript') {
      const text = String(data['transcript'] ?? data['text'] ?? '');
      const isFinal = type === 'transcript' && data['is_final'] !== false;
      if (isFinal) this.lastFinal = text;

      this.events.push({
        kind: isFinal ? 'final' : 'partial',
        text,
        confidence: typeof data['confidence'] === 'number' ? data['confidence'] : isFinal ? 0.9 : 0.7,
        languageTag: typeof data['language_code'] === 'string' ? data['language_code'] : null,
        at: this.now(),
        audioMs: this.audioMs,
      });
    }
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.events.push({
      kind: 'final',
      text: this.lastFinal,
      // Zero, not the provider's number: the stream died, so whatever it had
      // said is a fragment, and the turn manager must treat it as a poor turn
      // rather than as somebody's approval.
      confidence: 0,
      languageTag: null,
      at: this.now(),
      audioMs: this.audioMs,
    });
    this.close();
    void reason;
  }
}

class SarvamSynthesisStream implements SynthesisStream {
  readonly frames = new EventStream<AudioFrame>();

  private socket: WebSocketLike | null = null;
  private ready = false;
  private cancelled = false;
  private ended = false;
  private first: Date | null = null;
  private producedMs = 0;
  private seq = 0;
  private readonly pending: string[] = [];

  constructor(
    readonly callId: string,
    private readonly config: SarvamStreamingConfig,
    private readonly options: StreamSynthesizeOptions,
    private readonly now: () => Date,
  ) {
    this.connect();
  }

  get isClosed(): boolean {
    return this.cancelled || this.ended;
  }

  async write(text: string): Promise<void> {
    for (const chunk of toSynthesisChunks(text)) {
      if (this.cancelled) return;
      this.send(JSON.stringify({ type: 'text', data: { text: chunk } }));
    }
  }

  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.send(JSON.stringify({ type: 'flush' }));
  }

  /**
   * Barge-in.
   *
   * The socket is closed rather than merely flagged: Bulbul keeps synthesising
   * whatever it has already accepted, and a stream we stopped reading is a
   * stream that is still being billed. Closing is what actually stops both.
   */
  async cancel(): Promise<void> {
    if (this.cancelled) return;
    this.cancelled = true;
    try {
      this.socket?.close(1000, 'barge-in');
    } catch {
      /* Already gone. */
    }
    this.frames.close();
  }

  firstFrameAt(): Date | null {
    return this.first;
  }

  synthesisedMs(): number {
    return this.producedMs;
  }

  private connect(): void {
    const url = new URL(this.config.ttsUrl);
    url.searchParams.set('model', this.config.ttsModel);
    url.searchParams.set('send_completion_event', 'true');
    url.searchParams.set('api-subscription-key', this.config.apiKey);

    const factory = this.config.webSocketFactory ?? defaultWebSocketFactory;
    const socket = factory(url.toString(), { 'api-subscription-key': this.config.apiKey });
    this.socket = socket;

    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          type: 'config',
          data: {
            language_code: sarvamLanguageCode(this.options.language),
            speaker: this.options.voiceRef ?? this.config.voices[this.options.language],
            model: this.config.ttsModel,
            // The telephony port carries 16 kHz PCM16 and nothing else; asking
            // for the default 22 050 Hz MP3 would mean resampling a decoded
            // stream on every frame of every call.
            speech_sample_rate: String(INTERNAL_SAMPLE_RATE),
            output_audio_codec: 'wav',
            enable_preprocessing: true,
          },
        }),
      );
      this.ready = true;
      for (const message of this.pending.splice(0)) socket.send(message);
    });

    socket.addEventListener('message', (event) => this.onMessage(readEventData(event)));
    socket.addEventListener('error', () => this.frames.close());
    socket.addEventListener('close', () => this.frames.close());
  }

  private send(message: string): void {
    if (this.cancelled) return;
    if (!this.ready || this.socket === null) {
      this.pending.push(message);
      return;
    }
    this.socket.send(message);
  }

  private onMessage(raw: string): void {
    if (this.cancelled) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;

    const frame = parsed as Record<string, unknown>;
    if (String(frame['type'] ?? '') !== 'audio') return;

    const data = asRecord(frame['data']);
    const contentType = String(data['content_type'] ?? 'audio/wav');
    const audio = String(data['audio'] ?? '');
    if (audio.length === 0) return;

    const pcm = decodeLinearAudio(Buffer.from(audio, 'base64'), contentType);
    const produced = toFrames(pcm, {
      frameMs: this.options.frameMs ?? this.config.frameMs,
      startSeq: this.seq,
      startAt: this.now(),
    });

    this.first ??= this.now();
    for (const audioFrame of produced) {
      this.frames.push(audioFrame);
      this.producedMs += audioFrame.durationMs;
      this.seq += 1;
    }
  }
}

export class SarvamStreamingAdapter implements StreamingSpeechPort {
  readonly driver = 'sarvam' as const;
  private readonly now: () => Date;

  constructor(private readonly config: SarvamStreamingConfig) {
    this.now = config.now ?? (() => new Date());
  }

  streamTranscribe(options: StreamTranscribeOptions): TranscribeStream {
    return new SarvamTranscribeStream(options.callId, this.config, options, this.now);
  }

  streamSynthesize(options: StreamSynthesizeOptions): SynthesisStream {
    return new SarvamSynthesisStream(options.callId, this.config, options, this.now);
  }
}

/**
 * Provider audio → the 16 kHz PCM16 the port carries.
 *
 * A RIFF header is stripped; raw PCM passes through. Anything compressed is
 * refused, loudly. The failure this prevents is the nastiest kind: MP3 bytes
 * written straight to a phone leg are perfectly valid audio frames full of
 * static, so every log line reports success while the customer hears noise.
 */
export function decodeLinearAudio(bytes: Buffer, contentType: string): Buffer {
  if (bytes.length >= 44 && bytes.toString('ascii', 0, 4) === 'RIFF') {
    return findWavData(bytes);
  }

  const normalised = contentType.toLowerCase();
  if (normalised.includes('mp3') || normalised.includes('mpeg') || normalised.includes('opus')) {
    throw new StreamingSpeechError(
      'UNKNOWN',
      `The synthesiser returned ${contentType}; a telephony leg carries linear PCM only`,
      { contentType },
    );
  }

  return bytes;
}

function findWavData(bytes: Buffer): Buffer {
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === 'data') {
      return bytes.subarray(offset + 8, Math.min(offset + 8 + size, bytes.length));
    }
    offset += 8 + size + (size % 2);
  }
  return bytes.subarray(44);
}

function readEventData(event: unknown): string {
  if (typeof event !== 'object' || event === null) return '';
  const data = (event as { data?: unknown }).data;
  if (typeof data === 'string') return data;
  if (data instanceof Buffer) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return '';
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
