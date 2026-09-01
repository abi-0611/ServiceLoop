import { createHash } from 'node:crypto';
import type { Language } from '@serviceloop/shared';
import {
  INTERNAL_SAMPLE_RATE,
  concatFrames,
  toFrames,
  type AudioFrame,
} from '../telephony/audio';
import { EventStream } from '../telephony/events';
import {
  toSynthesisChunks,
  type StreamSynthesizeOptions,
  type StreamTranscribeOptions,
  type StreamingSpeechPort,
  type SynthesisStream,
  type TranscribeStream,
  type TranscriptEvent,
} from './streaming-port';

/**
 * `MockStreamingSpeechAdapter` — a whole phone call, from fixtures (phase 5.2).
 *
 * The design decision that makes this worth trusting is the same one that made
 * the WhatsApp sandbox worth trusting in phase 2: **nothing takes a shortcut
 * around the port**. The recogniser really is handed PCM frames and really does
 * decode words out of them; the synthesiser really does emit PCM frames a
 * browser can play. There is no side channel carrying the text.
 *
 * It manages that by *encoding* the words into the audio. A fixture utterance
 * is a short header — `SLV1`, a length, and the UTF-8 payload — followed by a
 * tone shaped to the length of the phrase. The header occupies about a
 * millisecond of a 16 kHz stream, which is inaudible, and the tone is what a
 * developer actually hears in the softphone. Frames that carry no header, and
 * whose bytes match no registered fixture, come back as an empty low-confidence
 * final — which is exactly right: a real microphone in a workshop is how the
 * DTMF degradation path (phase 5.5) gets exercised for free.
 *
 * The consequence worth naming: a test can assert what the agent *said* by
 * decoding the audio the telephony port carried, rather than by reading a
 * string the code under test also wrote to a log.
 */

const MAGIC = Buffer.from('SLV1', 'ascii');
/** Words per minute a synthesiser reads at. Used to give fixtures real length. */
const SPEAKING_WPM = 150;
const MIN_UTTERANCE_MS = 320;

export interface FixtureUtterance {
  readonly text: string;
  readonly language: Language;
  readonly confidence?: number;
  /** Overrides the length derived from the word count. */
  readonly durationMs?: number;
}

interface EncodedPayload {
  readonly text: string;
  readonly language: Language;
  readonly confidence: number;
  readonly durationMs: number;
}

export interface MockStreamingOptions {
  readonly model?: string;
  /** Partials per utterance before the final. Two is what a real stream feels like. */
  readonly partialsPerUtterance?: number;
  readonly frameMs?: number;
  readonly now?: () => Date;
  /**
   * Adds a synthetic delay before the first synthesised frame.
   *
   * Zero in CI, where determinism matters more than realism. The voice
   * simulation suite's latency assertions read the *stage markers* the runtime
   * logs, so they measure the pipeline's own arithmetic rather than a sleep.
   */
  readonly firstByteDelayMs?: number;
}

/**
 * Turns a phrase into audio that this adapter can read back.
 *
 * Exported because the simulator's personas, the console softphone and the demo
 * runner all need to *speak* — and every one of them must do it by producing
 * frames, not by handing the recogniser a string.
 */
export function encodeUtterance(utterance: FixtureUtterance): Buffer {
  const words = utterance.text.trim().split(/\s+/u).filter((word) => word.length > 0).length;
  const durationMs =
    utterance.durationMs ?? Math.max(MIN_UTTERANCE_MS, Math.round((words / SPEAKING_WPM) * 60_000));

  const payload: EncodedPayload = {
    text: utterance.text,
    language: utterance.language,
    confidence: utterance.confidence ?? 0.94,
    durationMs,
  };

  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.alloc(6);
  MAGIC.copy(header, 0);
  header.writeUInt16LE(body.length, 4);

  // Sample alignment: the buffer is interpreted as 16-bit samples everywhere
  // else, and an odd-length header would shift every sample after it by a byte.
  const marker = Buffer.concat([header, body]);
  const aligned = marker.length % 2 === 0 ? marker : Buffer.concat([marker, Buffer.alloc(1)]);

  const totalSamples = Math.max(
    aligned.length / 2 + 1,
    Math.round((durationMs / 1000) * INTERNAL_SAMPLE_RATE),
  );
  const pcm = Buffer.alloc(totalSamples * 2);
  aligned.copy(pcm, 0);

  // A quiet 440 Hz tone after the marker, so a developer with the softphone open
  // hears something recognisable as speech-shaped rather than silence.
  for (let index = aligned.length / 2; index < totalSamples; index += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * index) / INTERNAL_SAMPLE_RATE) * 5_000);
    pcm.writeInt16LE(value, index * 2);
  }

  return pcm;
}

/** Frames for one phrase, in the shape a microphone would deliver them. */
export function utteranceFrames(utterance: FixtureUtterance, frameMs = 20): AudioFrame[] {
  return toFrames(encodeUtterance(utterance), { frameMs });
}

/** Reads a phrase back out of audio, or null when the bytes carry no marker. */
export function decodeUtterance(pcm: Buffer, from = 0): EncodedPayload | null {
  const at = pcm.indexOf(MAGIC, from);
  if (at < 0 || at + 6 > pcm.length) return null;

  const length = pcm.readUInt16LE(at + 4);
  const start = at + 6;
  if (start + length > pcm.length) return null;

  try {
    const parsed: unknown = JSON.parse(pcm.subarray(start, start + length).toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record['text'] !== 'string') return null;

    return {
      text: record['text'],
      language: (record['language'] === 'ta' || record['language'] === 'hi'
        ? record['language']
        : 'en') as Language,
      confidence: typeof record['confidence'] === 'number' ? record['confidence'] : 0.9,
      durationMs: typeof record['durationMs'] === 'number' ? record['durationMs'] : MIN_UTTERANCE_MS,
    };
  } catch {
    return null;
  }
}

/**
 * Every phrase in a buffer, in order.
 *
 * A synthesised *turn* is several chunks and therefore several markers — the
 * first sentence starts playing while the rest is still being written (phase
 * 5.3) — so reading back what the agent said means reading all of them. A
 * decoder that stopped at the first would quietly assert half a sentence.
 */
export function decodeUtterances(pcm: Buffer): EncodedPayload[] {
  const found: EncodedPayload[] = [];
  let cursor = 0;

  for (;;) {
    const at = pcm.indexOf(MAGIC, cursor);
    if (at < 0) break;
    const decoded = decodeUtterance(pcm, at);
    if (decoded === null) {
      cursor = at + MAGIC.length;
      continue;
    }
    found.push(decoded);
    cursor = at + MAGIC.length;
  }

  return found;
}

class MockTranscribeStream implements TranscribeStream {
  readonly events = new EventStream<TranscriptEvent>();

  private buffered: Buffer[] = [];
  private audioMs = 0;
  private decoded: EncodedPayload | null = null;
  private emittedPartials = 0;
  private finalEmitted = false;
  private closed = false;

  constructor(
    readonly callId: string,
    private readonly partials: number,
    private readonly now: () => Date,
    private readonly fixtureByHash: ReadonlyMap<string, FixtureUtterance>,
    private readonly languageHint: Language,
  ) {}

  get isClosed(): boolean {
    return this.closed;
  }

  push(frame: AudioFrame): boolean {
    if (this.closed) return false;

    this.buffered.push(frame.pcm16);
    this.audioMs += frame.durationMs;

    if (this.decoded === null) {
      this.decoded = decodeUtterance(Buffer.concat(this.buffered));
    }

    if (this.decoded !== null) this.maybeEmit();

    // The mock never saturates. A real adapter returns false while its socket
    // buffer is full, and the runtime honours it; saying so here would make the
    // sandbox exercise a path the sandbox cannot actually reach.
    return true;
  }

  async drain(): Promise<void> {
    /* Nothing buffers here; the method exists so the runtime's backpressure
     * handling is exercised identically against every adapter. */
  }

  async end(): Promise<void> {
    if (this.closed || this.finalEmitted) {
      this.closed = true;
      this.events.close();
      return;
    }

    const pcm = Buffer.concat(this.buffered);
    const payload = this.decoded ?? this.fixtureFor(pcm) ?? this.unintelligible();

    this.events.push({
      kind: 'final',
      text: payload.text,
      confidence: payload.confidence,
      languageTag: payload.text.length === 0 ? null : `${payload.language}-IN`,
      at: this.now(),
      audioMs: this.audioMs,
    });

    this.finalEmitted = true;
    this.closed = true;
    this.events.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.events.close();
  }

  /**
   * Emits partials as the utterance's audio arrives, then the final.
   *
   * Prefix-shaped partials, because that is what a streaming recogniser
   * actually produces and because the early-planning path in phase 5.3 reads
   * them: a runtime that only ever saw whole finals would meet its latency
   * budget in this adapter and miss it against Sarvam.
   */
  private maybeEmit(): void {
    const payload = this.decoded;
    if (payload === null || this.finalEmitted) return;

    const progress = Math.min(1, this.audioMs / Math.max(1, payload.durationMs));

    while (this.emittedPartials < this.partials) {
      const threshold = (this.emittedPartials + 1) / (this.partials + 1);
      if (progress < threshold) break;

      const words = payload.text.split(/\s+/u).filter((word) => word.length > 0);
      const take = Math.max(1, Math.round(words.length * threshold));

      this.events.push({
        kind: 'partial',
        text: words.slice(0, take).join(' '),
        // A partial is a guess by construction; reporting the final's
        // confidence on it would let a caller act on something not yet said.
        confidence: Math.min(0.85, payload.confidence * 0.85),
        languageTag: `${payload.language}-IN`,
        at: this.now(),
        audioMs: this.audioMs,
      });
      this.emittedPartials += 1;
    }

    if (progress >= 1) {
      this.events.push({
        kind: 'final',
        text: payload.text,
        confidence: payload.confidence,
        languageTag: `${payload.language}-IN`,
        at: this.now(),
        audioMs: this.audioMs,
      });
      this.finalEmitted = true;
    }
  }

  private fixtureFor(pcm: Buffer): EncodedPayload | null {
    const fixture = this.fixtureByHash.get(sha256(pcm));
    if (fixture === undefined) return null;
    return {
      text: fixture.text,
      language: fixture.language,
      confidence: fixture.confidence ?? 0.9,
      durationMs: fixture.durationMs ?? MIN_UTTERANCE_MS,
    };
  }

  /**
   * Audio nobody registered and nothing encoded.
   *
   * An empty transcript at 0.15 confidence rather than a throw: on a real line
   * this is a lorry going past, and the correct behaviour is the one the shop
   * will actually meet — two of these in a row and the call drops to the keypad
   * (phase 5.5), which is a better outcome than an exception.
   */
  private unintelligible(): EncodedPayload {
    return { text: '', language: this.languageHint, confidence: 0.15, durationMs: this.audioMs };
  }
}

class MockSynthesisStream implements SynthesisStream {
  readonly frames = new EventStream<AudioFrame>();

  private first: Date | null = null;
  private producedMs = 0;
  private seq = 0;
  private cancelled = false;
  private ended = false;

  constructor(
    readonly callId: string,
    private readonly language: Language,
    private readonly frameMs: number,
    private readonly now: () => Date,
    private readonly firstByteDelayMs: number,
  ) {}

  get isClosed(): boolean {
    return this.cancelled || this.ended;
  }

  async write(text: string): Promise<void> {
    if (this.isClosed) return;

    for (const chunk of toSynthesisChunks(text)) {
      // Re-checked per chunk: this is what barge-in actually cuts. A turn
      // cancelled after its first sentence must never synthesise its second,
      // and a loop that only checked on entry would.
      if (this.cancelled) return;

      if (this.first === null && this.firstByteDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.firstByteDelayMs));
        if (this.cancelled) return;
      }

      const pcm = encodeUtterance({ text: chunk, language: this.language });
      const produced = toFrames(pcm, {
        frameMs: this.frameMs,
        startSeq: this.seq,
        startAt: this.now(),
      });

      this.first ??= this.now();

      for (const frame of produced) {
        this.frames.push(frame);
        this.producedMs += frame.durationMs;
        this.seq += 1;
      }
    }
  }

  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.frames.close();
  }

  async cancel(): Promise<void> {
    if (this.cancelled) return;
    this.cancelled = true;
    this.frames.drain();
    this.frames.close();
  }

  firstFrameAt(): Date | null {
    return this.first;
  }

  synthesisedMs(): number {
    return this.producedMs;
  }
}

export class MockStreamingSpeechAdapter implements StreamingSpeechPort {
  readonly driver = 'mock' as const;

  private readonly fixtures = new Map<string, FixtureUtterance>();
  private readonly partials: number;
  private readonly frameMs: number;
  private readonly now: () => Date;
  private readonly firstByteDelayMs: number;

  constructor(options: MockStreamingOptions = {}) {
    this.partials = options.partialsPerUtterance ?? 2;
    this.frameMs = options.frameMs ?? 20;
    this.now = options.now ?? (() => new Date());
    this.firstByteDelayMs = options.firstByteDelayMs ?? 0;
  }

  /** Registers words for a specific recording — a browser mic capture, say. */
  register(pcm: Buffer, fixture: FixtureUtterance): string {
    const hash = sha256(pcm);
    this.fixtures.set(hash, fixture);
    return hash;
  }

  streamTranscribe(options: StreamTranscribeOptions): TranscribeStream {
    return new MockTranscribeStream(
      options.callId,
      this.partials,
      this.now,
      this.fixtures,
      options.languageHint ?? 'en',
    );
  }

  streamSynthesize(options: StreamSynthesizeOptions): SynthesisStream {
    return new MockSynthesisStream(
      options.callId,
      options.language,
      options.frameMs ?? this.frameMs,
      this.now,
      this.firstByteDelayMs,
    );
  }

  /** What a set of frames actually said. The property tests read this. */
  static heard(frames: readonly AudioFrame[]): string {
    return decodeUtterances(concatFrames(frames))
      .map((payload) => payload.text)
      .join(' ');
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
