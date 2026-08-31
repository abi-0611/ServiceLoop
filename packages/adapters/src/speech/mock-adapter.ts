import { createHash } from 'node:crypto';
import type { Language } from '@serviceloop/shared';
import {
  SpeechError,
  wavDurationMs,
  type SpeechPort,
  type TranscribeInput,
  type Transcript,
  type TranscriptSegment,
} from './port';

/**
 * `MockSpeechAdapter` — deterministic transcription from registered fixtures.
 *
 * Audio is keyed by the sha256 of its bytes. The demo seeds a handful of voice
 * notes with their transcripts; the console simulator registers one the moment
 * a developer records into the mic, so a browser recording becomes a first-class
 * inbound voice note without any speech service existing yet.
 *
 * Unregistered audio raises rather than returning empty text. A silent success
 * here would produce an empty job-card draft that looks like a *model* failure
 * three layers up, and that is a bad afternoon for whoever debugs it.
 */

export interface SpeechFixture {
  readonly text: string;
  readonly language: Language;
  readonly confidence?: number;
  readonly segments?: readonly TranscriptSegment[];
}

export interface MockSpeechOptions {
  readonly model?: string;
  /** Fixtures keyed by the sha256 hex of the audio bytes. */
  readonly fixtures?: Readonly<Record<string, SpeechFixture>>;
}

export class MockSpeechAdapter implements SpeechPort {
  readonly driver = 'mock' as const;

  private readonly byHash = new Map<string, SpeechFixture>();
  private readonly model: string;

  constructor(options: MockSpeechOptions = {}) {
    this.model = options.model ?? 'mock-speech-v1';
    for (const [hash, fixture] of Object.entries(options.fixtures ?? {})) {
      this.byHash.set(hash, fixture);
    }
  }

  /** Registers the words for a specific recording. Returns its content hash. */
  register(bytes: Buffer, fixture: SpeechFixture): string {
    const hash = sha256(bytes);
    this.byHash.set(hash, fixture);
    return hash;
  }

  has(bytes: Buffer): boolean {
    return this.byHash.has(sha256(bytes));
  }

  get size(): number {
    return this.byHash.size;
  }

  async transcribe(input: TranscribeInput): Promise<Transcript> {
    if (input.bytes.length === 0) {
      throw new SpeechError('AUDIO_TOO_SHORT', 'The voice note arrived with no audio');
    }

    const hash = sha256(input.bytes);
    const fixture = this.byHash.get(hash);
    if (fixture === undefined) {
      throw new SpeechError(
        'NO_FIXTURE',
        `No transcript fixture is registered for audio ${hash.slice(0, 12)}`,
        { hash, registered: this.byHash.size, contentType: input.contentType },
      );
    }

    const durationMs = wavDurationMs(input.bytes);
    const segments =
      fixture.segments ??
      // One segment covering the clip. Real adapters return several; callers
      // must not depend on segment *count*, only on the text and the spans.
      ([
        { startMs: 0, endMs: durationMs ?? 0, text: fixture.text },
      ] as const satisfies readonly TranscriptSegment[]);

    return {
      text: fixture.text,
      language: fixture.language,
      confidence: fixture.confidence ?? 0.9,
      durationMs,
      model: this.model,
      segments,
      // A fixture knows exactly one language, so the tag list has exactly one
      // entry. Real adapters report several on a code-switched clip; callers
      // must not depend on the count.
      languageTags: [`${fixture.language}-IN`],
    };
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
