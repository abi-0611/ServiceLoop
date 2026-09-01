import { randomUUID } from 'node:crypto';
import type { CallDirection, DtmfDigit, Language } from '@serviceloop/shared';
import { DTMF_DIGITS } from '@serviceloop/shared';
import {
  INTERNAL_FORMAT,
  concatFrames,
  frameDurationMs,
  pcmToWav,
  toFrames,
  totalDurationMs,
  type AudioFrame,
} from './audio';
import { EventStream } from './events';
import {
  TelephonyError,
  maskNumber,
  type CallEvent,
  type CallSession,
  type InboundCallListener,
  type OriginateInput,
  type RecordingHandle,
  type TelephonyPort,
} from './port';

/**
 * `BrowserLoopbackTelephonyAdapter` — the far end is a browser tab (phase 5.1).
 *
 * This is the development surface the whole phase is built on, and it is
 * written as a complete adapter rather than a test double. It ships the real
 * lifecycle (`ringing → answered → media_stream_open → … → hangup`), real
 * typed DTMF events, a real playback queue with barge-in, a real recording
 * that starts only when told to, and a real two-leg bridge with a whisper. The
 * contract test runs the identical script against it and against a live
 * adapter, so a flow that works here is a flow that works on a telephone.
 *
 * What is *not* real is the transport between the browser and this process:
 * the console posts caller audio and pulls agent audio over ordinary HTTP
 * rather than a media-stream WebSocket. That choice is deliberate and recorded
 * in PROGRESS.md — the port boundary is PCM frames either way, so nothing above
 * this file can tell the difference, and it keeps CI free of a WebSocket server
 * whose only user would be a demo page.
 *
 * The handset half of the API (`answer`, `speak`, `press`, `pullAgentAudio`,
 * `hangUp`) is what the console's `/softphone` page and the demo runner drive.
 * A test can act as the customer with the same four calls a person makes with
 * their thumb.
 */

export interface LoopbackOptions {
  readonly callerId?: string;
  readonly frameMs?: number;
  readonly now?: () => Date;
  readonly newId?: () => string;
  /**
   * Milliseconds between `originate` and the `ringing` event.
   *
   * Zero in tests. A demo wants a beat, because a call that is ringing before
   * the click has finished does not read as a phone call.
   */
  readonly ringDelayMs?: number;
  /**
   * How fast the modelled line plays queued audio, relative to real time.
   *
   * A real telephone plays a four-second sentence in four seconds, and the
   * runtime's barge-in watch runs *for as long as playback lasts* — so the
   * loopback models that rather than draining the instant somebody asks. One is
   * a demo you can listen to; the simulator and CI turn it up so a nine-turn
   * call runs in milliseconds without changing a single behaviour under test.
   * The same seam as the fake clock the rest of this codebase already uses.
   */
  readonly playbackSpeed?: number;
}

/** The far end: what a person's thumb and mouth can do to a call. */
export interface LoopbackHandset {
  readonly callId: string;
  answer(): void;
  /** Speaks: PCM frames in, exactly as a microphone would produce them. */
  speak(frames: readonly AudioFrame[]): void;
  press(digit: DtmfDigit): void;
  /** Everything the agent has said that the handset has not yet played. */
  pullAgentAudio(maxFrames?: number): AudioFrame[];
  /**
   * Milliseconds of agent audio the line has still to deliver.
   *
   * The handset needs this and the queue length will not do: the browser pulls
   * frames ahead to buffer them, so an empty queue means "nothing left to
   * fetch", not "the customer has stopped hearing the agent". A caller — a
   * person or a script — decides whether it is their turn from this number,
   * and speaking while it is above zero is a barge-in.
   */
  remainingMs(): number;
  /** True once the far end has picked up. The softphone's ringing UI reads it. */
  isAnswered(): boolean;
  isEnded(): boolean;
  hangUp(reason?: string): void;
  /** True once the agent bridged this call to an advisor. */
  isBridged(): boolean;
  /** What the advisor leg was whispered before being joined. */
  whisperPcm(): Buffer;
}

interface BridgeState {
  readonly to: string;
  readonly at: Date;
  readonly whisper: Buffer;
}

class LoopbackSession implements CallSession {
  readonly events = new EventStream<CallEvent>();
  readonly driver = 'loopback' as const;

  private answeredAt: Date | null = null;
  private endedAt: Date | null = null;
  private mediaOpen = false;
  private recording = false;
  private recordingStartedAt: Date | null = null;
  private recordedPcm: Buffer[] = [];
  private framesSeenBeforeRecording = 0;
  private playbackQueue: AudioFrame[] = [];
  private queuedMs = 0;
  private playbackStartedAt: number | null = null;
  private bridge: BridgeState | null = null;
  private outboundSeq = 0;
  private inboundSeq = 0;

  constructor(
    readonly callId: string,
    readonly direction: CallDirection,
    readonly to: string,
    readonly from: string,
    readonly startedAt: Date,
    readonly context: OriginateInput['context'],
    private readonly frameMs: number,
    private readonly now: () => Date,
    private readonly onEnded: (session: LoopbackSession) => void,
    private readonly playbackSpeed: number,
  ) {}

  isLive(): boolean {
    return this.answeredAt !== null && this.endedAt === null;
  }

  isAnswered(): boolean {
    return this.answeredAt !== null;
  }

  isEnded(): boolean {
    return this.endedAt !== null;
  }

  isRecording(): boolean {
    return this.recording;
  }

  bridgedTo(): BridgeState | null {
    return this.bridge;
  }

  /* ----------------------------------------------------- lifecycle (our side) */

  ring(): void {
    this.events.push({ kind: 'ringing', callId: this.callId, at: this.now() });
  }

  /**
   * The far end picked up.
   *
   * `answered` and `media_stream_open` are two events rather than one because
   * on a real provider they are two: the leg connects, and then the media
   * socket attaches — and the gap between them is where a live call loses its
   * first second of audio if the runtime assumed otherwise.
   */
  answer(): void {
    if (this.answeredAt !== null || this.endedAt !== null) return;
    const at = this.now();
    this.answeredAt = at;
    this.events.push({ kind: 'answered', callId: this.callId, at });
    this.mediaOpen = true;
    this.events.push({
      kind: 'media_stream_open',
      callId: this.callId,
      format: INTERNAL_FORMAT,
      at,
    });
  }

  async play(frames: readonly AudioFrame[]): Promise<void> {
    if (this.endedAt !== null) {
      throw new TelephonyError('CALL_NOT_FOUND', 'The call has already ended', {
        callId: this.callId,
      });
    }
    if (!this.mediaOpen) {
      throw new TelephonyError('NOT_ANSWERED_YET', 'The media stream is not open yet', {
        callId: this.callId,
      });
    }

    // A line that has finished playing starts a fresh window rather than
    // extending the old one. `queuedMs` is measured *from* `playbackStartedAt`,
    // so carrying the previous utterance's milliseconds into the new window
    // would report a two-second sentence as five seconds of audio still to
    // hear — and every turn after the first would hold the barge-in watch open
    // for the sum of everything the agent had ever said.
    if (this.playbackRemainingMs() === 0) {
      this.playbackStartedAt = Date.now();
      this.queuedMs = 0;
    }

    for (const frame of frames) {
      const stamped: AudioFrame = { ...frame, seq: this.outboundSeq };
      this.outboundSeq += 1;
      this.playbackQueue.push(stamped);
      this.capture(stamped);
    }

    this.queuedMs += totalDurationMs(frames);
  }

  /**
   * What the far end has left to hear.
   *
   * Wall clock, not queue length. The browser pulls frames ahead to buffer them
   * — that is what a handset does — so a queue that emptied on `pull` would
   * report the line as finished while the customer was still listening, and
   * barge-in would have nothing left to cut.
   */
  playbackRemainingMs(): number {
    if (this.playbackStartedAt === null || this.queuedMs === 0) return 0;
    const elapsed = (Date.now() - this.playbackStartedAt) * this.playbackSpeed;
    return Math.max(0, Math.round(this.queuedMs - elapsed));
  }

  async stopPlayback(): Promise<number> {
    const dropped = this.playbackRemainingMs();
    this.playbackQueue = [];
    this.queuedMs = 0;
    this.playbackStartedAt = null;
    return dropped;
  }

  /**
   * Joins an advisor leg, after whispering to it alone.
   *
   * The whisper is played to the *advisor's* leg only — the customer must not
   * hear a summary of themselves — which in the loopback is modelled by storing
   * it separately from the playback queue rather than by pretending the
   * customer's handset is deaf for eight seconds.
   */
  async bridgeTo(number: string, whisperAudio: readonly AudioFrame[]): Promise<void> {
    if (!this.isLive()) {
      throw new TelephonyError('NOT_ANSWERED_YET', 'Only a live call can be bridged', {
        callId: this.callId,
      });
    }

    const at = this.now();
    this.bridge = { to: number, at, whisper: concatFrames(whisperAudio) };
    for (const frame of whisperAudio) this.capture(frame);
    this.events.push({ kind: 'bridged', callId: this.callId, to: number, at });
  }

  async startRecording(): Promise<void> {
    if (this.recording) return;
    this.recording = true;
    this.recordingStartedAt = this.now();
  }

  async stopRecording(): Promise<RecordingHandle | null> {
    if (!this.recording || this.recordingStartedAt === null) return null;

    const pcm = Buffer.concat(this.recordedPcm);
    const handle: RecordingHandle = {
      callId: this.callId,
      wav: pcmToWav(pcm),
      durationMs: frameDurationMs(pcm),
      startedAt: this.recordingStartedAt,
      stoppedAt: this.now(),
      framesBeforeStart: this.framesSeenBeforeRecording,
    };

    this.recording = false;
    this.recordingStartedAt = null;
    this.recordedPcm = [];

    return handle;
  }

  async hangup(reason: string): Promise<void> {
    this.end('AGENT', reason);
  }

  /* ------------------------------------------------------ the far end's side */

  receive(frames: readonly AudioFrame[]): void {
    if (!this.mediaOpen || this.endedAt !== null) return;

    for (const frame of frames) {
      const stamped: AudioFrame = { ...frame, seq: this.inboundSeq };
      this.inboundSeq += 1;
      this.capture(stamped);
      this.events.push({ kind: 'media', callId: this.callId, frame: stamped });
    }
  }

  press(digit: DtmfDigit): void {
    if (this.endedAt !== null) return;
    this.events.push({ kind: 'dtmf', callId: this.callId, digit, at: this.now() });
  }

  pull(maxFrames: number): AudioFrame[] {
    const taken = this.playbackQueue.splice(0, Math.max(0, maxFrames));
    return taken;
  }

  end(by: 'CALLER' | 'AGENT' | 'PROVIDER', reason: string): void {
    if (this.endedAt !== null) return;
    const at = this.now();
    this.endedAt = at;

    if (this.mediaOpen) {
      this.mediaOpen = false;
      this.events.push({ kind: 'media_stream_closed', callId: this.callId, at });
    }

    this.events.push({ kind: 'hangup', callId: this.callId, by, reason, at });
    this.onEnded(this);
    // Left open for one turn of the loop so a runtime already awaiting `next()`
    // observes the hangup rather than a closed stream.
    setTimeout(() => this.events.close(), 0).unref?.();
  }

  fail(code: 'NO_ANSWER' | 'BUSY' | 'PROVIDER_UNAVAILABLE', reason: string): void {
    if (this.endedAt !== null) return;
    const at = this.now();
    this.events.push({ kind: 'failed', callId: this.callId, code, reason, at });
    this.end('PROVIDER', reason);
  }

  frameMillis(): number {
    return this.frameMs;
  }

  /**
   * The recorder.
   *
   * Every frame in either direction passes here, and exactly one branch writes
   * bytes. Frames seen while recording is off are *counted* and discarded: the
   * count is what makes the phase-5.6 assertion mean something, because "the
   * recording contains nothing from before the notice" is only interesting if
   * there was something to leave out.
   */
  private capture(frame: AudioFrame): void {
    if (!this.recording) {
      this.framesSeenBeforeRecording += 1;
      return;
    }
    this.recordedPcm.push(frame.pcm16);
  }
}

export class BrowserLoopbackTelephonyAdapter implements TelephonyPort {
  readonly driver = 'loopback' as const;
  readonly callerId: string;

  private readonly sessions = new Map<string, LoopbackSession>();
  private readonly ended = new Map<string, LoopbackSession>();
  private readonly listeners = new Set<InboundCallListener>();
  private readonly frameMs: number;
  private readonly ringDelayMs: number;
  private readonly playbackSpeed: number;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(options: LoopbackOptions = {}) {
    this.callerId = options.callerId ?? LOOPBACK_CALLER_ID;
    this.frameMs = options.frameMs ?? 20;
    this.ringDelayMs = options.ringDelayMs ?? 0;
    this.playbackSpeed = options.playbackSpeed ?? 1;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
  }

  async originate(input: OriginateInput): Promise<CallSession> {
    const callId = this.newId();
    const session = new LoopbackSession(
      callId,
      'OUTBOUND',
      input.to,
      input.from ?? this.callerId,
      this.now(),
      input.context,
      this.frameMs,
      this.now,
      (done) => this.retire(done),
      this.playbackSpeed,
    );

    this.sessions.set(callId, session);

    if (this.ringDelayMs === 0) {
      session.ring();
    } else {
      setTimeout(() => session.ring(), this.ringDelayMs).unref?.();
    }

    return session;
  }

  /**
   * A customer rings the shop.
   *
   * Answered immediately, because a published line that rings out is a customer
   * who calls a competitor. The inbound listener is given a live session with
   * its media stream already open.
   */
  async ringIn(input: {
    readonly from: string;
    readonly context: OriginateInput['context'];
    readonly to?: string;
  }): Promise<CallSession> {
    const callId = this.newId();
    const session = new LoopbackSession(
      callId,
      'INBOUND',
      input.to ?? this.callerId,
      input.from,
      this.now(),
      input.context,
      this.frameMs,
      this.now,
      (done) => this.retire(done),
      this.playbackSpeed,
    );

    this.sessions.set(callId, session);
    session.ring();
    session.answer();

    for (const listener of [...this.listeners]) {
      await listener(session);
    }

    return session;
  }

  onInboundCall(listener: InboundCallListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  activeSessions(): readonly CallSession[] {
    return [...this.sessions.values()];
  }

  session(callId: string): CallSession | null {
    return this.sessions.get(callId) ?? this.ended.get(callId) ?? null;
  }

  async shutdown(reason: string): Promise<void> {
    for (const session of [...this.sessions.values()]) {
      session.end('PROVIDER', reason);
    }
  }

  /* --------------------------------------------------------------- the handset */

  /**
   * The far end of a call, as a person would use it.
   *
   * This is the console softphone's whole API surface, and the demo runner's.
   * A test that wants to be a customer picks up the handset and speaks.
   */
  handset(callId: string): LoopbackHandset {
    const session = this.sessions.get(callId) ?? this.ended.get(callId);
    if (session === undefined) {
      throw new TelephonyError('CALL_NOT_FOUND', `No loopback call ${callId}`, { callId });
    }

    return {
      callId,
      answer: () => session.answer(),
      speak: (frames) => session.receive(frames),
      press: (digit) => session.press(digit),
      pullAgentAudio: (maxFrames = 1_000) => session.pull(maxFrames),
      remainingMs: () => session.playbackRemainingMs(),
      isAnswered: () => session.isAnswered(),
      isEnded: () => session.isEnded(),
      hangUp: (reason = 'The caller hung up') => session.end('CALLER', reason),
      isBridged: () => session.bridgedTo() !== null,
      whisperPcm: () => session.bridgedTo()?.whisper ?? Buffer.alloc(0),
    };
  }

  /** Simulates a customer who did not pick up, so the retry rung can be tested. */
  noAnswer(callId: string): void {
    const session = this.sessions.get(callId);
    if (session === undefined || session.isAnswered()) return;
    session.fail('NO_ANSWER', 'The customer did not answer');
  }

  busy(callId: string): void {
    const session = this.sessions.get(callId);
    if (session === undefined || session.isAnswered()) return;
    session.fail('BUSY', 'The line was busy');
  }

  /** Simulates the media socket dropping mid-call (phase 5.7's failure path). */
  breakMedia(callId: string, reason = 'The media stream dropped'): void {
    const session = this.sessions.get(callId);
    if (session === undefined) return;
    session.fail('PROVIDER_UNAVAILABLE', reason);
  }

  /** Frames for one utterance, in the shape a microphone would deliver them. */
  framesFor(pcm16: Buffer, startAt = this.now()): AudioFrame[] {
    return toFrames(pcm16, { frameMs: this.frameMs, startAt });
  }

  get frameMillis(): number {
    return this.frameMs;
  }

  private retire(session: LoopbackSession): void {
    this.sessions.delete(session.callId);
    this.ended.set(session.callId, session);
    // A finished call is kept only long enough for the console to render its
    // last state; an unbounded map of them is a leak in a long-lived process.
    if (this.ended.size > 200) {
      const oldest = this.ended.keys().next();
      if (oldest.done !== true) this.ended.delete(oldest.value);
    }
  }
}

/** The number the softphone shows as "the shop", masked in every log line. */
export const LOOPBACK_CALLER_ID = '+911140000000';

export function isDtmfDigit(value: string): value is DtmfDigit {
  return (DTMF_DIGITS as readonly string[]).includes(value);
}

/** Convenience for the demo: a persona's language, defaulted safely. */
export function languageOrDefault(value: string | null | undefined): Language {
  return value === 'ta' || value === 'hi' ? value : 'en';
}

export { maskNumber };
