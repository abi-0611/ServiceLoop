import type { Language } from '@serviceloop/shared';
import {
  SpeechError,
  toLanguage,
  wavDurationMs,
  type SpeechPort,
  type TranscribeInput,
  type Transcript,
  type TranscriptSegment,
} from './port';

/**
 * `SarvamSpeechAdapter` — the primary recogniser (phase 4.1).
 *
 * Sarvam is the primary rather than Google for one reason that matters more
 * than benchmark numbers: it is trained on Indian code-mixed speech and on
 * 8 kHz telephone-grade audio, which is exactly what a WhatsApp voice note
 * recorded next to an impact wrench is. A general model asked to pick *one*
 * language for *"caliper open irukku, part varum 4 maniku"* will pick one and
 * mangle the other half; this one is built for the sentence as spoken (L4).
 *
 * API surface confirmed against the current Sarvam docs:
 *   POST https://api.sarvam.ai/speech-to-text
 *   header  api-subscription-key
 *   body    multipart/form-data — file, model, language_code, with_timestamps
 *   returns { request_id, transcript, language_code, language_probability,
 *             timestamps: { words[], start_time_seconds[], end_time_seconds[] } }
 */

export interface SarvamSpeechConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  /** Model id — configuration, never hardcoded (master §10). */
  readonly model: string;
  readonly timeoutMs: number;
  /** Sarvam's own cap. Larger audio must go through their batch API. */
  readonly maxBytes: number;
}

export interface SarvamAdapterOptions {
  readonly fetch?: typeof globalThis.fetch;
}

export class SarvamSpeechAdapter implements SpeechPort {
  readonly driver = 'sarvam' as const;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(
    private readonly config: SarvamSpeechConfig,
    options: SarvamAdapterOptions = {},
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
        { bytes: input.bytes.length },
      );
    }

    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(input.bytes)], { type: input.contentType }),
      'voice-note.wav',
    );
    form.append('model', this.config.model);
    // `unknown` asks Sarvam to detect rather than be told. The thread's language
    // is a *hint* about the customer, and a technician's note in the staff group
    // is often not in it at all — passing it as a constraint would make the
    // recogniser force Tamil onto a sentence spoken in Hindi.
    form.append('language_code', 'unknown');
    form.append('with_timestamps', 'true');

    // `input.hints` is deliberately **not** sent.
    //
    // Sarvam's synchronous speech-to-text endpoint has no vocabulary-boost
    // parameter — the current API takes file, model, language_code, mode,
    // with_timestamps and input_audio_codec, and nothing else. Inventing a
    // field would either be ignored or rejected, and silently dropping the
    // hints without saying so is how a caller ends up believing the plate
    // vocabulary is being applied when it is not. Google's adapter does support
    // them, so a shop that depends on boosting registrations should run the
    // fallback as primary and accept the code-mixing trade.

    const response = await this.send(form, input);
    const payload = await parseBody(response);

    const transcript = typeof payload['transcript'] === 'string' ? payload['transcript'] : '';
    if (transcript.trim().length === 0) {
      throw new SpeechError('UNKNOWN', 'Sarvam returned an empty transcript', {
        requestId: payload['request_id'],
      });
    }

    const tag = typeof payload['language_code'] === 'string' ? payload['language_code'] : null;
    const probability =
      typeof payload['language_probability'] === 'number' ? payload['language_probability'] : null;

    return {
      text: transcript,
      language: toLanguage(tag, input.languageHint ?? 'en'),
      // The provider reports how sure it is of the *language*, not of the
      // words. Using it as the transcript confidence would be a category
      // error, so an unlabelled response falls back to a deliberately
      // unremarkable 0.8 — below the 0.85 auto-apply bar, which means an
      // unlabelled transcript asks a human rather than moving a job card.
      confidence: probability ?? 0.8,
      durationMs: wavDurationMs(input.bytes),
      model: this.config.model,
      segments: toSegments(payload, tag),
      languageTags: tag === null ? [] : [tag],
    };
  }

  private async send(form: FormData, input: TranscribeInput): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await this.fetchFn(`${trimSlash(this.config.baseUrl)}/speech-to-text`, {
        method: 'POST',
        headers: {
          'api-subscription-key': this.config.apiKey,
          ...(input.traceId === undefined ? {} : { 'x-trace-id': input.traceId }),
        },
        body: form,
        signal: controller.signal,
      });

      if (!response.ok) throw await toSpeechError(response, 'Sarvam');
      return response;
    } catch (error) {
      if (error instanceof SpeechError) throw error;
      // An abort is a timeout, and a timeout is the provider being unavailable
      // as far as the failover policy is concerned.
      throw new SpeechError('PROVIDER_UNAVAILABLE', `Sarvam request failed: ${message(error)}`, {
        cause: message(error),
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Sarvam returns three parallel arrays rather than an array of objects.
 *
 * Zipped defensively: a response where the arrays disagree in length yields the
 * words it can place and drops the rest, because a segment with a missing end
 * time would render as a zero-length span in the console.
 */
function toSegments(
  payload: Readonly<Record<string, unknown>>,
  tag: string | null,
): readonly TranscriptSegment[] {
  const timestamps = payload['timestamps'];
  if (typeof timestamps !== 'object' || timestamps === null) return [];

  const stamps = timestamps as Record<string, unknown>;
  const words = Array.isArray(stamps['words']) ? stamps['words'] : [];
  const starts = Array.isArray(stamps['start_time_seconds']) ? stamps['start_time_seconds'] : [];
  const ends = Array.isArray(stamps['end_time_seconds']) ? stamps['end_time_seconds'] : [];

  const segments: TranscriptSegment[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const start = starts[index];
    const end = ends[index];
    if (typeof word !== 'string' || typeof start !== 'number' || typeof end !== 'number') continue;
    segments.push({
      startMs: Math.round(start * 1000),
      endMs: Math.round(end * 1000),
      text: word,
      ...(tag === null ? {} : { languageTag: tag }),
    });
  }
  return segments;
}

export async function parseBody(response: Response): Promise<Readonly<Record<string, unknown>>> {
  const text = await response.text();
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new SpeechError('UNKNOWN', 'The speech provider returned a body that is not JSON', {
      body: text.slice(0, 400),
    });
  }
}

/**
 * HTTP status → the failure taxonomy the failover policy reads.
 *
 * 429 and 5xx are the provider's problem and count towards a failover; 401 and
 * 403 are ours and count too, because a shop with a revoked key needs the
 * fallback *and* the alert. A 4xx about the audio is the audio's problem and
 * deliberately does not.
 */
export async function toSpeechError(response: Response, provider: string): Promise<SpeechError> {
  const body = await response.text().catch(() => '');
  const detail = body.slice(0, 400);

  if (response.status === 401 || response.status === 403) {
    return new SpeechError('AUTH_FAILED', `${provider} rejected the credentials`, {
      status: response.status,
      detail,
    });
  }
  if (response.status === 429) {
    return new SpeechError('RATE_LIMITED', `${provider} is rate limiting this shop`, {
      status: response.status,
      detail,
    });
  }
  if (response.status >= 500) {
    return new SpeechError('PROVIDER_UNAVAILABLE', `${provider} returned ${response.status}`, {
      status: response.status,
      detail,
    });
  }
  if (response.status === 413) {
    return new SpeechError('AUDIO_TOO_LARGE', `${provider} refused the audio as too large`, {
      status: response.status,
      detail,
    });
  }
  if (response.status === 415) {
    return new SpeechError('UNSUPPORTED_FORMAT', `${provider} cannot decode this audio format`, {
      status: response.status,
      detail,
    });
  }
  return new SpeechError('UNKNOWN', `${provider} returned ${response.status}`, {
    status: response.status,
    detail,
  });
}

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { Language };
