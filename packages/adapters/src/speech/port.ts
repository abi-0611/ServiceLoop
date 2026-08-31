import type { Language } from '@serviceloop/shared';

/**
 * `SpeechPort` — audio in, text out.
 *
 * Phase 2 needs only the batch call: an advisor forwards a voice note, the
 * media pipeline stores it and transcodes it to 16 kHz mono WAV, and the intake
 * parser asks for the words. Phase 5 adds the streaming half for live calls and
 * the real Sarvam adapter behind it; that is why `transcribe` takes bytes and
 * returns a whole transcript rather than a stream — the batch shape is stable,
 * and streaming will arrive as a second method rather than a redesign of this
 * one.
 */

export interface TranscribeInput {
  readonly shopId: string;
  /** Prefer the pipeline's 16 kHz mono WAV derivative when one exists. */
  readonly bytes: Buffer;
  readonly contentType: string;
  /** The thread's language. A hint — code-switching is expected (L4). */
  readonly languageHint?: Language;
  readonly traceId?: string;
  /**
   * Words the recogniser should expect (phase 4.1).
   *
   * Registrations on the floor today, the shop's part vocabulary, technician
   * names. A workshop's audio is 8 kHz, echoey and full of proper nouns no
   * general model has seen, and a plate heard as "TN zero nine PX" instead of
   * "BX" is a status signal applied to the wrong car — so the hints are not a
   * nicety, they are what makes the match safe enough to auto-apply.
   */
  readonly hints?: readonly string[];
}

export interface TranscriptSegment {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  /** BCP-47 tag for this span, when the provider labels code-switches. */
  readonly languageTag?: string;
}

export interface Transcript {
  readonly text: string;
  /** The language actually spoken, which may differ from the hint. */
  readonly language: Language;
  /** 0–1. Drives whether the resulting draft is trusted or flagged. */
  readonly confidence: number;
  readonly durationMs: number | null;
  readonly model: string;
  readonly segments: readonly TranscriptSegment[];
  /**
   * Every BCP-47 tag the provider reported, in the order first seen.
   *
   * Plural because a single sentence in this domain routinely is: *"caliper
   * open irukku, part varum 4 maniku"* is Tamil grammar around English nouns
   * and an English numeral. Collapsing that to one language is what makes a
   * recogniser mis-hear the half it decided was not there.
   */
  readonly languageTags: readonly string[];
}

export interface SpeechPort {
  readonly driver: 'mock' | 'sarvam' | 'google' | 'failover';
  transcribe(input: TranscribeInput): Promise<Transcript>;
}

export type SpeechErrorKind =
  | 'NO_FIXTURE'
  | 'UNSUPPORTED_FORMAT'
  | 'AUDIO_TOO_SHORT'
  | 'AUDIO_TOO_LARGE'
  | 'PROVIDER_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'AUTH_FAILED'
  | 'UNKNOWN';

export class SpeechError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly kind: SpeechErrorKind,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'SpeechError';
    this.retryable = kind === 'PROVIDER_UNAVAILABLE' || kind === 'RATE_LIMITED';
  }
}

/**
 * Provider failures that should count towards a failover.
 *
 * `NO_FIXTURE`, `AUDIO_TOO_SHORT` and `UNSUPPORTED_FORMAT` deliberately do not:
 * they are facts about the *audio*, and failing over to a second provider would
 * only ask a different service the same unanswerable question — while quietly
 * consuming the failure budget that exists to detect a real outage.
 */
export function countsTowardsFailover(error: unknown): boolean {
  if (!(error instanceof SpeechError)) return true;
  switch (error.kind) {
    case 'PROVIDER_UNAVAILABLE':
    case 'RATE_LIMITED':
    case 'AUTH_FAILED':
    case 'UNKNOWN':
      return true;
    case 'NO_FIXTURE':
    case 'UNSUPPORTED_FORMAT':
    case 'AUDIO_TOO_SHORT':
    case 'AUDIO_TOO_LARGE':
      return false;
  }
}

/**
 * BCP-47 tag → the launch language it belongs to.
 *
 * Anything else maps to English, which is the honest answer for a workshop:
 * the recogniser heard something it labelled Marathi, and the shop speaks
 * three languages, so the roman-script fallback is the one a human can read.
 */
export function toLanguage(tag: string | null | undefined, fallback: Language = 'en'): Language {
  if (tag === null || tag === undefined) return fallback;
  const primary = tag.toLowerCase().split(/[-_]/)[0];
  switch (primary) {
    case 'ta':
      return 'ta';
    case 'hi':
      return 'hi';
    case 'en':
      return 'en';
    default:
      return fallback;
  }
}

/**
 * Duration from a canonical WAV header.
 *
 * Worth doing rather than guessing: the inbox shows a voice note's length, and
 * an audio file the pipeline could not transcode has no duration at all — which
 * is itself the signal that transcription will fail.
 */
export function wavDurationMs(bytes: Buffer): number | null {
  if (bytes.length < 44) return null;
  if (bytes.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (bytes.toString('ascii', 8, 12) !== 'WAVE') return null;

  let offset = 12;
  let byteRate: number | null = null;

  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === 'fmt ' && body + 16 <= bytes.length) {
      byteRate = bytes.readUInt32LE(body + 8);
    } else if (id === 'data') {
      if (byteRate === null || byteRate === 0) return null;
      const dataBytes = Math.min(size, bytes.length - body);
      return Math.round((dataBytes / byteRate) * 1000);
    }

    // Chunks are word-aligned; an odd size carries a pad byte.
    offset = body + size + (size % 2);
  }

  return null;
}
