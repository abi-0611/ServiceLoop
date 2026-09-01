import type { CallDirection, DtmfDigit, Language } from '@serviceloop/shared';
import type { AudioFormat, AudioFrame } from './audio';
import type { EventStream } from './events';

/**
 * `TelephonyPort` — a phone line, in one interface (phase 5.1).
 *
 * Three adapters implement it: `BrowserLoopbackTelephonyAdapter` (the console
 * softphone, the whole phase's development surface), `ExotelTelephonyAdapter`
 * (primary, India) and `TwilioTelephonyAdapter` (the documented alternative).
 * The contract test in `telephony.test.ts` runs the identical scripted call
 * lifecycle against the loopback and — behind `LIVE_TEL_TEST=1` — against a
 * real one, because "the sandbox behaves like production" is a claim that has
 * to be executed rather than asserted in a comment.
 *
 * Two decisions shape everything above this file:
 *
 *   - **Audio is 16 kHz mono PCM16 at the boundary, always.** A telco leg is
 *     8 kHz μ-law and a speech model wants 16 kHz PCM16; each adapter converts
 *     at its own edge (`audio.ts`) and nothing upstream knows which leg it is
 *     talking to. That is what lets the voice runtime be written once.
 *   - **Events are typed and queued, never callbacks.** A DTMF digit pressed
 *     while the agent was mid-sentence is the caller approving the work; a
 *     callback the runtime had not registered yet would drop it. `EventStream`
 *     buffers, so the digit is simply the next event.
 */

export type TelephonyDriverName = 'loopback' | 'exotel' | 'twilio';

/** Who ended the leg. `AGENT` means our side hung up on purpose. */
export type HangupBy = 'CALLER' | 'AGENT' | 'PROVIDER';

export type CallEvent =
  | { readonly kind: 'ringing'; readonly callId: string; readonly at: Date }
  | { readonly kind: 'answered'; readonly callId: string; readonly at: Date }
  | {
      readonly kind: 'media_stream_open';
      readonly callId: string;
      readonly format: AudioFormat;
      readonly at: Date;
    }
  /** One frame of far-end audio, already normalised to the internal format. */
  | { readonly kind: 'media'; readonly callId: string; readonly frame: AudioFrame }
  | {
      readonly kind: 'dtmf';
      readonly callId: string;
      readonly digit: DtmfDigit;
      readonly at: Date;
    }
  | { readonly kind: 'media_stream_closed'; readonly callId: string; readonly at: Date }
  | {
      readonly kind: 'bridged';
      readonly callId: string;
      readonly to: string;
      readonly at: Date;
    }
  | {
      readonly kind: 'hangup';
      readonly callId: string;
      readonly by: HangupBy;
      readonly reason: string;
      readonly at: Date;
    }
  | {
      readonly kind: 'failed';
      readonly callId: string;
      readonly code: TelephonyErrorKind;
      readonly reason: string;
      readonly at: Date;
    };

/**
 * What the call is *about*, carried through the port so an adapter's own
 * bookkeeping (an Exotel custom field, a Twilio parameter) can round-trip it.
 *
 * Deliberately not the whole job card: an adapter has no business holding the
 * estimate. It holds the ids that let the runtime load one.
 */
export interface CallContext {
  readonly shopId: string;
  readonly jobCardId: string | null;
  readonly customerId: string | null;
  readonly conversationId: string | null;
  readonly approvalRequestId: string | null;
  readonly escalationId: string | null;
  readonly objective: string;
  readonly language: Language;
  readonly customerName: string | null;
  readonly traceId: string;
}

export interface OriginateInput {
  /** E.164. The adapter is the only thing that sees a real phone number. */
  readonly to: string;
  readonly context: CallContext;
  /** Overrides the configured caller id, for a shop with its own number. */
  readonly from?: string;
  /** Rings for this long before the adapter reports `NO_ANSWER`. */
  readonly ringTimeoutSeconds?: number;
}

export interface RecordingHandle {
  readonly callId: string;
  /** 16-bit mono WAV, ready for `StoragePort`. */
  readonly wav: Buffer;
  readonly durationMs: number;
  readonly startedAt: Date;
  readonly stoppedAt: Date;
  /**
   * Frames the session handled while recording was off.
   *
   * None of them are in `wav` — that is the phase-5.6 property. The count is
   * reported because the assertion is only worth anything if there was
   * something to leave out: a caller who says "hello?" during the notice
   * produces frames the recorder saw and deliberately did not keep, and a test
   * that cannot distinguish that from an empty line is not testing anything.
   */
  readonly framesBeforeStart: number;
}

/**
 * One live call.
 *
 * The session is the handle the voice runtime holds; it is created by
 * `originate` or handed to the inbound listener, and it is dead once `hangup`
 * resolves or a `hangup` event arrives.
 */
export interface CallSession {
  readonly callId: string;
  readonly direction: CallDirection;
  readonly to: string;
  readonly from: string;
  readonly startedAt: Date;
  readonly context: CallContext;
  readonly driver: TelephonyDriverName;
  readonly events: EventStream<CallEvent>;

  /** True between `answered` and `hangup`. */
  isLive(): boolean;

  /**
   * Queues agent audio towards the far end.
   *
   * Resolves when the frames are *accepted*, not when they are heard — a
   * synthesiser that outran the line would otherwise block the turn loop. What
   * has actually been played is `playbackRemainingMs`.
   */
  play(frames: readonly AudioFrame[]): Promise<void>;

  /** Milliseconds of queued audio not yet delivered to the far end. */
  playbackRemainingMs(): number;

  /**
   * Barge-in. Drops everything queued and returns the milliseconds discarded.
   *
   * The return value is what the phase-5.3 test asserts against: a customer who
   * starts talking must stop hearing the agent within 300 ms, and "we called
   * stop" is not evidence that anything stopped.
   */
  stopPlayback(): Promise<number>;

  /** Joins a second leg, playing `whisperAudio` to it alone before joining. */
  bridgeTo(number: string, whisperAudio: readonly AudioFrame[]): Promise<void>;

  /** Recording starts here and nowhere else — after the notice, never before. */
  startRecording(): Promise<void>;
  stopRecording(): Promise<RecordingHandle | null>;
  isRecording(): boolean;

  hangup(reason: string): Promise<void>;
}

export type InboundCallListener = (session: CallSession) => void | Promise<void>;

export interface TelephonyPort {
  readonly driver: TelephonyDriverName;
  /** The number this port dials from, for the audit record. */
  readonly callerId: string;

  originate(input: OriginateInput): Promise<CallSession>;

  /**
   * Registers the handler an arriving call is given to.
   *
   * Returns an unsubscribe function rather than taking a single handler slot:
   * the API registers the real one and a test registers its own, and a port
   * that silently replaced the first with the second would make the test pass
   * while production went unanswered.
   */
  onInboundCall(listener: InboundCallListener): () => void;

  /** Live sessions, for the console's call list and for graceful shutdown. */
  activeSessions(): readonly CallSession[];

  session(callId: string): CallSession | null;

  /** Ends every live call. Called on kill-switch and on process shutdown. */
  shutdown(reason: string): Promise<void>;
}

export type TelephonyErrorKind =
  | 'NO_ANSWER'
  | 'BUSY'
  | 'INVALID_NUMBER'
  | 'PROVIDER_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'AUTH_FAILED'
  | 'MEDIA_STREAM_FAILED'
  | 'CALL_NOT_FOUND'
  | 'NOT_ANSWERED_YET'
  | 'UNKNOWN';

export class TelephonyError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly kind: TelephonyErrorKind,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'TelephonyError';
    this.retryable =
      kind === 'PROVIDER_UNAVAILABLE' || kind === 'RATE_LIMITED' || kind === 'NO_ANSWER';
  }
}

/** Last four digits only. Every log line and console row uses this. */
export function maskNumber(number: string): string {
  const digits = number.replace(/\D/g, '');
  if (digits.length <= 4) return `••••${digits}`;
  return `••••${digits.slice(-4)}`;
}
