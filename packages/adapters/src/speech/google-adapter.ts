import {
  SpeechError,
  toLanguage,
  wavDurationMs,
  type SpeechPort,
  type TranscribeInput,
  type Transcript,
  type TranscriptSegment,
} from './port';
import { message, parseBody, toSpeechError, trimSlash } from './sarvam-adapter';

/**
 * `GoogleSpeechAdapter` — the fallback recogniser (phase 4.1).
 *
 * Second, not equal. Google's Indian-language coverage is good and its uptime
 * is excellent, but it wants to be told which languages to expect and it is
 * measurably weaker on the code-mixed, 8 kHz, workshop-noise audio this system
 * actually receives. As a fallback that is the right trade: a transcript that
 * needs an advisor's confirmation beats no transcript at all while Sarvam is
 * down.
 *
 * API surface confirmed against the current Cloud Speech-to-Text v2 docs:
 *   POST https://speech.googleapis.com/v2/{recognizer}:recognize
 *   body { config: { autoDecodingConfig, languageCodes, model, features },
 *          content: <base64 audio> }
 *   returns { results: [ { alternatives: [ { transcript, confidence,
 *              words: [ { word, startOffset, endOffset } ] } ], languageCode } ] }
 */

export interface GoogleSpeechConfig {
  /** `projects/<id>/locations/<loc>/recognizers/<name>` — configuration. */
  readonly recognizer: string;
  readonly baseUrl: string;
  /** A short-lived OAuth access token; the caller owns refreshing it. */
  readonly accessToken: () => Promise<string>;
  readonly model: string;
  /**
   * Languages to expect. Ordered — Google treats the first as primary, and the
   * rest as alternates it may switch to mid-utterance.
   */
  readonly languageCodes: readonly string[];
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

export interface GoogleAdapterOptions {
  readonly fetch?: typeof globalThis.fetch;
}

export class GoogleSpeechAdapter implements SpeechPort {
  readonly driver = 'google' as const;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(
    private readonly config: GoogleSpeechConfig,
    options: GoogleAdapterOptions = {},
  ) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  async transcribe(input: TranscribeInput): Promise<Transcript> {
    if (input.bytes.length === 0) {
      throw new SpeechError('AUDIO_TOO_SHORT', 'The voice note arrived with no audio');
    }
    if (input.bytes.length > this.config.maxBytes) {
      throw new SpeechError(
        'AUDIO_TOO_LARGE',
        `Audio is ${input.bytes.length} bytes; the synchronous endpoint accepts ${this.config.maxBytes}`,
      );
    }

    const body = {
      config: {
        // Let Google sniff the container rather than asserting a sample rate we
        // would have to keep in step with the media pipeline's transcode.
        autoDecodingConfig: {},
        model: this.config.model,
        languageCodes: this.orderedLanguages(input.languageHint),
        features: { enableWordTimeOffsets: true, enableAutomaticPunctuation: true },
        ...(input.hints === undefined || input.hints.length === 0
          ? {}
          : {
              adaptation: {
                phraseSets: [
                  { inlinePhraseSet: { phrases: input.hints.map((value) => ({ value, boost: 15 })) } },
                ],
              },
            }),
      },
      content: input.bytes.toString('base64'),
    };

    const payload = await this.send(body, input);
    const results = Array.isArray(payload['results']) ? payload['results'] : [];

    const parts: string[] = [];
    const segments: TranscriptSegment[] = [];
    const tags: string[] = [];
    let confidenceTotal = 0;
    let confidenceCount = 0;

    for (const result of results) {
      if (typeof result !== 'object' || result === null) continue;
      const row = result as Record<string, unknown>;
      const alternatives = Array.isArray(row['alternatives']) ? row['alternatives'] : [];
      const best = alternatives[0];
      if (typeof best !== 'object' || best === null) continue;

      const alternative = best as Record<string, unknown>;
      const transcript = typeof alternative['transcript'] === 'string' ? alternative['transcript'] : '';
      if (transcript.trim().length === 0) continue;
      parts.push(transcript.trim());

      if (typeof alternative['confidence'] === 'number') {
        confidenceTotal += alternative['confidence'];
        confidenceCount += 1;
      }

      const tag = typeof row['languageCode'] === 'string' ? row['languageCode'] : null;
      if (tag !== null && !tags.includes(tag)) tags.push(tag);

      for (const word of Array.isArray(alternative['words']) ? alternative['words'] : []) {
        if (typeof word !== 'object' || word === null) continue;
        const entry = word as Record<string, unknown>;
        const text = typeof entry['word'] === 'string' ? entry['word'] : null;
        if (text === null) continue;
        segments.push({
          startMs: durationToMs(entry['startOffset']),
          endMs: durationToMs(entry['endOffset']),
          text,
          ...(tag === null ? {} : { languageTag: tag }),
        });
      }
    }

    if (parts.length === 0) {
      throw new SpeechError('UNKNOWN', 'Google returned no transcript alternatives');
    }

    return {
      text: parts.join(' '),
      language: toLanguage(tags[0], input.languageHint ?? 'en'),
      confidence: confidenceCount === 0 ? 0.8 : confidenceTotal / confidenceCount,
      durationMs: wavDurationMs(input.bytes),
      model: this.config.model,
      segments,
      languageTags: tags,
    };
  }

  /**
   * The hint first, then the shop's other languages.
   *
   * Google treats position as priority, so putting the thread's language first
   * is worth doing — but the alternates stay, because a technician's note in
   * the staff group is routinely not in the customer's language at all.
   */
  private orderedLanguages(hint: string | undefined): readonly string[] {
    const configured = [...this.config.languageCodes];
    if (hint === undefined) return configured;

    const preferred = configured.find((code) => code.toLowerCase().startsWith(hint.toLowerCase()));
    if (preferred === undefined) return configured;
    return [preferred, ...configured.filter((code) => code !== preferred)];
  }

  private async send(
    body: unknown,
    input: TranscribeInput,
  ): Promise<Readonly<Record<string, unknown>>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const token = await this.config.accessToken();
      const url = `${trimSlash(this.config.baseUrl)}/v2/${this.config.recognizer}:recognize`;

      const response = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...(input.traceId === undefined ? {} : { 'x-trace-id': input.traceId }),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) throw await toSpeechError(response, 'Google Speech-to-Text');
      return parseBody(response);
    } catch (error) {
      if (error instanceof SpeechError) throw error;
      throw new SpeechError(
        'PROVIDER_UNAVAILABLE',
        `Google Speech-to-Text request failed: ${message(error)}`,
        { cause: message(error) },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Protobuf `Duration` JSON — `"1.500s"` — to milliseconds.
 *
 * Google also emits a `{seconds, nanos}` object shape on some paths, so both
 * are handled; an unrecognised shape becomes 0 rather than NaN, because a NaN
 * in a segment span propagates silently into every consumer that renders it.
 */
export function durationToMs(value: unknown): number {
  if (typeof value === 'string') {
    const seconds = Number(value.replace(/s$/, ''));
    return Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0;
  }
  if (typeof value === 'object' && value !== null) {
    const entry = value as Record<string, unknown>;
    const seconds = typeof entry['seconds'] === 'number' ? entry['seconds'] : Number(entry['seconds'] ?? 0);
    const nanos = typeof entry['nanos'] === 'number' ? entry['nanos'] : 0;
    const total = (Number.isFinite(seconds) ? seconds : 0) * 1000 + nanos / 1_000_000;
    return Math.round(total);
  }
  return 0;
}
