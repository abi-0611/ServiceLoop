import type { CallDirection, DtmfDigit } from '@serviceloop/shared';
import { DTMF_DIGITS } from '@serviceloop/shared';
import {
  INTERNAL_FORMAT,
  fromInternalPcm,
  pcmToWav,
  toFrames,
  toInternalPcm,
  totalDurationMs,
  type AudioFormat,
  type AudioFrame,
} from './audio';
import { EventStream } from './events';
import {
  TelephonyError,
  type CallContext,
  type CallEvent,
  type CallSession,
  type RecordingHandle,
  type TelephonyDriverName,
} from './port';

/**
 * The provider-agnostic half of a real telephony adapter (phase 5.1).
 *
 * Exotel and Twilio both stream call media over a WebSocket their side opens
 * *to us*, and both speak a JSON frame protocol that differs only in field
 * names, audio encoding and a couple of control messages. The state machine
 * around those frames — when the media stream is open, what a DTMF digit does,
 * how playback is queued and cut, when the recorder is allowed to write — is
 * identical, and identical is exactly what the port contract demands.
 *
 * So the session lives here and each adapter contributes a `ProviderCodec`:
 * parse an inbound frame, build an outbound one. That split is what makes the
 * codecs unit-testable against captured provider payloads with no socket in
 * sight, which is the only kind of test these adapters can honestly have in CI.
 *
 * **The transport seam.** A `MediaSocket` is injected rather than opened here.
 * The provider dials our public WebSocket endpoint; whatever binds that
 * endpoint hands the socket to `attachMediaSocket`. Writing a WebSocket server
 * into this package would put a network listener inside a library, and the two
 * deployments that need one (the API in staging and in production) already own
 * their HTTP server.
 */

/** The minimum a WebSocket-ish transport has to offer this session. */
export interface MediaSocket {
  send(text: string): void;
  onMessage(handler: (text: string) => void): void;
  onClose(handler: (reason: string) => void): void;
  close(reason?: string): void;
  readonly isOpen: boolean;
}

/** What a provider frame turned out to mean. */
export type DecodedFrame =
  | { readonly kind: 'connected' }
  | {
      readonly kind: 'start';
      readonly streamId: string;
      readonly callSid: string;
      readonly format: AudioFormat;
      readonly from: string | null;
      readonly to: string | null;
      readonly custom: Readonly<Record<string, string>>;
    }
  | { readonly kind: 'media'; readonly payload: Buffer }
  | { readonly kind: 'dtmf'; readonly digit: DtmfDigit }
  | { readonly kind: 'stop'; readonly reason: string }
  | { readonly kind: 'mark'; readonly name: string }
  | { readonly kind: 'ignored'; readonly event: string };

export interface ProviderCodec {
  readonly driver: TelephonyDriverName;
  /** The audio format this provider's leg carries. */
  readonly legFormat: AudioFormat;
  decode(raw: string): DecodedFrame;
  /** One outbound audio message. `payload` is already in the leg's format. */
  encodeMedia(streamId: string, payload: Buffer): string;
  /** Tells the provider to discard everything it has buffered — barge-in. */
  encodeClear(streamId: string): string;
  /** A named checkpoint the provider echoes back once the audio has played. */
  encodeMark(streamId: string, name: string): string;
  /**
   * Bytes per outbound audio message.
   *
   * Exotel refuses anything that is not a multiple of 320 bytes, and a provider
   * that refuses a chunk mid-turn drops the rest of the sentence. This is the
   * number that keeps that from happening.
   */
  readonly chunkBytes: number;
}

export interface ProviderSessionInput {
  readonly callId: string;
  readonly providerCallSid: string;
  readonly direction: CallDirection;
  readonly to: string;
  readonly from: string;
  readonly context: CallContext;
  readonly codec: ProviderCodec;
  readonly frameMs: number;
  readonly now: () => Date;
  /** Places the second leg for a warm handoff, through the provider's REST API. */
  readonly dialAdvisorLeg: (input: {
    readonly callId: string;
    readonly providerCallSid: string;
    readonly number: string;
    readonly whisperWav: Buffer;
  }) => Promise<void>;
  readonly onEnded: (callId: string) => void;
}

export class ProviderCallSession implements CallSession {
  readonly events = new EventStream<CallEvent>();
  readonly callId: string;
  readonly direction: CallDirection;
  readonly to: string;
  readonly from: string;
  readonly startedAt: Date;
  readonly context: CallContext;
  readonly driver: TelephonyDriverName;

  private socket: MediaSocket | null = null;
  private streamId: string | null = null;
  private answeredAt: Date | null = null;
  private endedAt: Date | null = null;
  private mediaOpen = false;
  private recording = false;
  private recordingStartedAt: Date | null = null;
  private recordedPcm: Buffer[] = [];
  private framesSeenBeforeRecording = 0;
  private queuedMs = 0;
  private markSeq = 0;
  private inboundSeq = 0;
  private bridgedTo: string | null = null;

  constructor(private readonly input: ProviderSessionInput) {
    this.callId = input.callId;
    this.direction = input.direction;
    this.to = input.to;
    this.from = input.from;
    this.context = input.context;
    this.driver = input.codec.driver;
    this.startedAt = input.now();
  }

  get providerCallSid(): string {
    return this.input.providerCallSid;
  }

  isLive(): boolean {
    return this.answeredAt !== null && this.endedAt === null;
  }

  isRecording(): boolean {
    return this.recording;
  }

  /** Called by whatever owns the WebSocket endpoint the provider dialled. */
  attachMediaSocket(socket: MediaSocket): void {
    this.socket = socket;
    socket.onMessage((raw) => this.onFrame(raw));
    socket.onClose((reason) => this.end('PROVIDER', reason));
  }

  /**
   * A provider status callback said the leg connected.
   *
   * Separate from `start`, because the two genuinely are: the leg answers, and
   * some time later the media socket attaches. Treating them as one event is
   * how a live call loses its opening syllable.
   */
  markRinging(): void {
    this.events.push({ kind: 'ringing', callId: this.callId, at: this.input.now() });
  }

  markAnswered(): void {
    if (this.answeredAt !== null) return;
    this.answeredAt = this.input.now();
    this.events.push({ kind: 'answered', callId: this.callId, at: this.answeredAt });
  }

  markFailed(code: 'NO_ANSWER' | 'BUSY' | 'PROVIDER_UNAVAILABLE', reason: string): void {
    if (this.endedAt !== null) return;
    this.events.push({ kind: 'failed', callId: this.callId, code, reason, at: this.input.now() });
    this.end('PROVIDER', reason);
  }

  async play(frames: readonly AudioFrame[]): Promise<void> {
    const socket = this.socket;
    if (socket === null || !this.mediaOpen || this.streamId === null) {
      throw new TelephonyError('NOT_ANSWERED_YET', 'The media stream is not open yet', {
        callId: this.callId,
      });
    }

    for (const frame of frames) this.capture(frame);

    const legBytes = fromInternalPcm(
      Buffer.concat(frames.map((frame) => frame.pcm16)),
      this.input.codec.legFormat,
    );

    const { chunkBytes } = this.input.codec;
    for (let offset = 0; offset < legBytes.length; offset += chunkBytes) {
      const slice = legBytes.subarray(offset, Math.min(offset + chunkBytes, legBytes.length));
      // Padded rather than truncated: a short final chunk is silently dropped by
      // Exotel's 320-byte rule, which loses the last syllable of the turn.
      const chunk =
        slice.length === chunkBytes
          ? Buffer.from(slice)
          : Buffer.concat([slice, Buffer.alloc(chunkBytes - slice.length)]);
      socket.send(this.input.codec.encodeMedia(this.streamId, chunk));
    }

    this.queuedMs += totalDurationMs(frames);
    this.markSeq += 1;
    socket.send(this.input.codec.encodeMark(this.streamId, `turn-${this.markSeq}`));
  }

  playbackRemainingMs(): number {
    return this.queuedMs;
  }

  /**
   * Barge-in.
   *
   * Both providers buffer audio their side, so cutting means telling *them* to
   * discard it — a local queue flush would stop nothing the customer is
   * currently hearing. The returned figure is what we believe was still
   * unplayed, which is an estimate and is named as one: the exact number is
   * knowable only from the mark the provider will now never echo.
   */
  async stopPlayback(): Promise<number> {
    const dropped = this.queuedMs;
    this.queuedMs = 0;
    if (this.socket !== null && this.streamId !== null) {
      this.socket.send(this.input.codec.encodeClear(this.streamId));
    }
    return dropped;
  }

  async bridgeTo(number: string, whisperAudio: readonly AudioFrame[]): Promise<void> {
    if (!this.isLive()) {
      throw new TelephonyError('NOT_ANSWERED_YET', 'Only a live call can be bridged', {
        callId: this.callId,
      });
    }

    for (const frame of whisperAudio) this.capture(frame);

    await this.input.dialAdvisorLeg({
      callId: this.callId,
      providerCallSid: this.input.providerCallSid,
      number,
      whisperWav: pcmToWav(Buffer.concat(whisperAudio.map((frame) => frame.pcm16))),
    });

    this.bridgedTo = number;
    this.events.push({ kind: 'bridged', callId: this.callId, to: number, at: this.input.now() });
  }

  async startRecording(): Promise<void> {
    if (this.recording) return;
    this.recording = true;
    this.recordingStartedAt = this.input.now();
  }

  async stopRecording(): Promise<RecordingHandle | null> {
    if (!this.recording || this.recordingStartedAt === null) return null;

    const pcm = Buffer.concat(this.recordedPcm);
    const handle: RecordingHandle = {
      callId: this.callId,
      wav: pcmToWav(pcm),
      durationMs: Math.round((pcm.length / 2 / INTERNAL_FORMAT.sampleRate) * 1000),
      startedAt: this.recordingStartedAt,
      stoppedAt: this.input.now(),
      framesBeforeStart: this.framesSeenBeforeRecording,
    };

    this.recording = false;
    this.recordingStartedAt = null;
    this.recordedPcm = [];

    return handle;
  }

  async hangup(reason: string): Promise<void> {
    this.socket?.close(reason);
    this.end('AGENT', reason);
  }

  bridgedNumber(): string | null {
    return this.bridgedTo;
  }

  /* ------------------------------------------------------------- the protocol */

  /** Exposed for the codec tests: one provider frame in, port events out. */
  onFrame(raw: string): void {
    let decoded: DecodedFrame;
    try {
      decoded = this.input.codec.decode(raw);
    } catch (error) {
      this.events.push({
        kind: 'failed',
        callId: this.callId,
        code: 'MEDIA_STREAM_FAILED',
        reason: error instanceof Error ? error.message : 'Unparseable provider frame',
        at: this.input.now(),
      });
      return;
    }

    switch (decoded.kind) {
      case 'connected':
        return;

      case 'start': {
        this.streamId = decoded.streamId;
        this.mediaOpen = true;
        this.markAnswered();
        this.events.push({
          kind: 'media_stream_open',
          callId: this.callId,
          format: decoded.format,
          at: this.input.now(),
        });
        return;
      }

      case 'media': {
        const pcm = toInternalPcm(decoded.payload, this.input.codec.legFormat);
        const frames = toFrames(pcm, {
          frameMs: this.input.frameMs,
          startSeq: this.inboundSeq,
          startAt: this.input.now(),
        });
        this.inboundSeq += frames.length;
        for (const frame of frames) {
          this.capture(frame);
          this.events.push({ kind: 'media', callId: this.callId, frame });
        }
        return;
      }

      case 'dtmf':
        this.events.push({
          kind: 'dtmf',
          callId: this.callId,
          digit: decoded.digit,
          at: this.input.now(),
        });
        return;

      case 'mark':
        // The provider finished playing a turn. Everything queued before it has
        // now been heard, which is the only truthful moment to zero the figure.
        this.queuedMs = 0;
        return;

      case 'stop':
        this.end('CALLER', decoded.reason);
        return;

      case 'ignored':
        return;
    }
  }

  private end(by: 'CALLER' | 'AGENT' | 'PROVIDER', reason: string): void {
    if (this.endedAt !== null) return;
    const at = this.input.now();
    this.endedAt = at;

    if (this.mediaOpen) {
      this.mediaOpen = false;
      this.events.push({ kind: 'media_stream_closed', callId: this.callId, at });
    }

    this.events.push({ kind: 'hangup', callId: this.callId, by, reason, at });
    this.input.onEnded(this.callId);
    setTimeout(() => this.events.close(), 0).unref?.();
  }

  private capture(frame: AudioFrame): void {
    if (!this.recording) {
      this.framesSeenBeforeRecording += 1;
      return;
    }
    this.recordedPcm.push(frame.pcm16);
  }
}

export function asDtmfDigit(value: string): DtmfDigit | null {
  const trimmed = value.trim();
  return (DTMF_DIGITS as readonly string[]).includes(trimmed) ? (trimmed as DtmfDigit) : null;
}
