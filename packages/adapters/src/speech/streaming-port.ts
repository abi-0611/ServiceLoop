import type { Language } from '@serviceloop/shared';
import type { AudioFrame } from '../telephony/audio';
import type { EventStream } from '../telephony/events';

/**
 * The streaming half of `SpeechPort` (phase 5.2).
 *
 * Deliberately a *second* interface rather than more methods on the first. The
 * batch port answers "what did this recording say"; this one answers "what is
 * being said, right now, and what should I say back" — and the two have
 * different failure modes, different budgets and different adapters. A voice
 * note that fails can be retried; a live call that stalls has already lost the
 * customer.
 *
 * Three properties the runtime above depends on:
 *
 *   - **Partials arrive before finals.** Early planning starts on a partial
 *     (phase 5.3), which is most of how the 1.2 s budget is met at all.
 *   - **Synthesis is cancellable mid-utterance.** Barge-in is not "stop after
 *     this sentence"; it is "stop now", and an adapter that cannot must say so.
 *   - **Backpressure is explicit.** `push` returns whether the sink wants more.
 *     A telco leg delivers 50 frames a second whatever the recogniser is doing,
 *     and the alternative to saying "wait" is an unbounded buffer that turns a
 *     slow provider into a memory leak.
 */

export interface StreamTranscribeOptions {
  readonly shopId: string;
  readonly callId: string;
  /** The thread's language. A hint — code-switching is expected (L4). */
  readonly languageHint?: Language;
  readonly traceId?: string;
  /** Shop vocabulary: registrations on the floor, part names, technician names. */
  readonly hints?: readonly string[];
  /** The frames' sample rate. Always the port's internal 16 kHz in practice. */
  readonly sampleRate?: number;
}

/**
 * One recogniser output.
 *
 * `audioMs` is the amount of audio consumed when this segment was produced, and
 * it is the anchor the latency markers are measured from: wall-clock alone
 * cannot separate "the model was slow" from "the caller was still talking".
 */
export interface TranscriptEvent {
  readonly kind: 'partial' | 'final';
  readonly text: string;
  readonly confidence: number;
  /** BCP-47 when the provider labels the span; null when it does not. */
  readonly languageTag: string | null;
  readonly at: Date;
  readonly audioMs: number;
}

export interface TranscribeStream {
  readonly callId: string;
  readonly events: EventStream<TranscriptEvent>;
  /**
   * Feeds one frame. `false` means the sink is saturated and the caller should
   * stop pushing until `drain()` resolves.
   */
  push(frame: AudioFrame): boolean;
  drain(): Promise<void>;
  /** No more audio is coming; any buffered partial is flushed as a final. */
  end(): Promise<void>;
  /** Abandons the stream. Nothing further is emitted. */
  close(): void;
  readonly isClosed: boolean;
}

export interface StreamSynthesizeOptions {
  readonly shopId: string;
  readonly callId: string;
  readonly language: Language;
  /** Provider voice id. Configuration, never hardcoded (§10). */
  readonly voiceRef?: string;
  readonly traceId?: string;
  /** Frame size the caller wants back. Matches the telephony leg's. */
  readonly frameMs?: number;
}

export interface SynthesisStream {
  readonly callId: string;
  readonly frames: EventStream<AudioFrame>;
  /**
   * Queues a chunk of text.
   *
   * Chunked rather than whole-utterance because the first sentence is
   * synthesised while the rest is still being planned — that overlap is a large
   * part of the latency budget (phase 5.3).
   */
  write(text: string): Promise<void>;
  end(): Promise<void>;
  /** Barge-in: stop now, drop what is queued. Resolves once nothing more emits. */
  cancel(): Promise<void>;
  /** When the first frame was emitted. Null until it is. */
  firstFrameAt(): Date | null;
  /** Audio produced so far, for the cost meter. */
  synthesisedMs(): number;
  readonly isClosed: boolean;
}

export interface StreamingSpeechPort {
  readonly driver: 'mock' | 'sarvam' | 'google';
  streamTranscribe(options: StreamTranscribeOptions): TranscribeStream;
  streamSynthesize(options: StreamSynthesizeOptions): SynthesisStream;
}

export type StreamingSpeechErrorKind =
  | 'PROVIDER_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'AUTH_FAILED'
  | 'UNSUPPORTED_LANGUAGE'
  | 'STREAM_CLOSED'
  | 'UNKNOWN';

export class StreamingSpeechError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly kind: StreamingSpeechErrorKind,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'StreamingSpeechError';
    this.retryable = kind === 'PROVIDER_UNAVAILABLE' || kind === 'RATE_LIMITED';
  }
}

/**
 * Splits composed copy into synthesis chunks at sentence boundaries.
 *
 * The first chunk is what the 1.2 s budget is actually measured against, so it
 * is kept short on purpose: "So I'll go ahead with the brake pads at ₹2,400."
 * starts playing while the rest of the turn is still arriving from the model.
 * Splitting mid-clause instead would save milliseconds and cost prosody, which
 * on a phone call is a worse trade than it sounds.
 */
export function toSynthesisChunks(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  const parts = trimmed
    .split(/(?<=[.!?।])\s+/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  return parts.length === 0 ? [trimmed] : parts;
}
