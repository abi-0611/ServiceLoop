import type { Language } from '@serviceloop/shared';
import { INTERNAL_SAMPLE_RATE, pcmToWav, toFrames, type AudioFrame } from '../telephony/audio';
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
 * `GoogleStreamingSpeechAdapter` — the fallback, and honest about what it is
 * (phase 5.2).
 *
 * Google's true streaming recogniser is `StreamingRecognize`, which is gRPC.
 * Bringing a gRPC stack into this package to serve a fallback would be a large
 * dependency for a path that runs when Sarvam is down, so this adapter does the
 * next best thing and says so in its name and in the boot log: it **windows**.
 * Audio is buffered into short windows, each window is transcribed through the
 * v2 REST `recognize` endpoint, and each window's result is emitted as a
 * partial; the concatenation is the final.
 *
 * The consequence is real and must not be hidden: first-token latency is a
 * window rather than a hundred milliseconds, so a call served by this adapter
 * feels slower and the comfort filler fires more often. That is a worse call
 * than Sarvam gives and a much better one than no call at all, which is the
 * trade a fallback exists to make. The turn manager needs no special case — it
 * reads the same partial/final events either way.
 *
 * Synthesis has no such compromise. Cloud Text-to-Speech is a plain REST call
 * that returns LINEAR16, and synthesising sentence by sentence is exactly the
 * chunking the latency budget wants anyway.
 */

export interface GoogleStreamingConfig {
  /** `projects/<id>/locations/<loc>/recognizers/<name>`. */
  readonly recognizer: string;
  readonly speechBaseUrl: string;
  readonly ttsBaseUrl: string;
  readonly accessToken: () => Promise<string>;
  readonly model: string;
  readonly languageCodes: readonly string[];
  /** Milliseconds of audio per recognition window. */
  readonly windowMs: number;
  readonly frameMs: number;
  readonly timeoutMs: number;
  readonly voices: Readonly<Record<Language, string>>;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}

export function googleLanguageCode(language: Language): string {
  switch (language) {
    case 'ta':
      return 'ta-IN';
    case 'hi':
      return 'hi-IN';
    case 'en':
      return 'en-IN';
  }
}

class WindowedTranscribeStream implements TranscribeStream {
  readonly events = new EventStream<TranscriptEvent>();

  private buffer: Buffer[] = [];
  private bufferedMs = 0;
  private audioMs = 0;
  private accumulated: string[] = [];
  private inflight = 0;
  private closed = false;
  private lastConfidence = 0;

  constructor(
    readonly callId: string,
    private readonly config: GoogleStreamingConfig,
    private readonly options: StreamTranscribeOptions,
    private readonly now: () => Date,
    private readonly recognise: (pcm: Buffer, languages: readonly string[]) => Promise<
      { readonly text: string; readonly confidence: number; readonly languageCode: string | null }
    >,
  ) {}

  get isClosed(): boolean {
    return this.closed;
  }

  push(frame: AudioFrame): boolean {
    if (this.closed) return false;

    this.buffer.push(frame.pcm16);
    this.bufferedMs += frame.durationMs;
    this.audioMs += frame.durationMs;

    if (this.bufferedMs >= this.config.windowMs) this.flushWindow('partial');

    // Backpressure is real here: each window is an HTTP round trip, and a
    // caller that keeps pushing while three are in flight is queueing audio the
    // recogniser will report on long after the turn ended.
    return this.inflight < 3;
  }

  async drain(): Promise<void> {
    const deadline = Date.now() + this.config.timeoutMs;
    while (this.inflight > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async end(): Promise<void> {
    if (this.closed) return;
    if (this.bufferedMs > 0) this.flushWindow('partial');
    await this.drain();

    this.events.push({
      kind: 'final',
      text: this.accumulated.join(' ').trim(),
      confidence: this.lastConfidence,
      languageTag: null,
      at: this.now(),
      audioMs: this.audioMs,
    });

    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.events.close();
  }

  private flushWindow(kind: 'partial'): void {
    const pcm = Buffer.concat(this.buffer);
    this.buffer = [];
    this.bufferedMs = 0;
    if (pcm.length === 0) return;

    this.inflight += 1;
    const audioMsAtSend = this.audioMs;

    void this.recognise(pcm, this.orderedLanguages())
      .then((result) => {
        if (this.closed || result.text.length === 0) return;
        this.accumulated.push(result.text);
        this.lastConfidence = result.confidence;
        this.events.push({
          kind,
          text: this.accumulated.join(' ').trim(),
          confidence: result.confidence,
          languageTag: result.languageCode,
          at: this.now(),
          audioMs: audioMsAtSend,
        });
      })
      .catch(() => {
        // A failed window is a gap in the transcript, not the end of the call.
        // The turn manager sees a shorter partial and, if it keeps happening,
        // the poor-turn counter drops the call to the keypad (phase 5.5).
      })
      .finally(() => {
        this.inflight -= 1;
      });
  }

  private orderedLanguages(): readonly string[] {
    const hint = this.options.languageHint;
    if (hint === undefined) return this.config.languageCodes;
    const primary = googleLanguageCode(hint);
    return [primary, ...this.config.languageCodes.filter((code) => code !== primary)];
  }
}

class GoogleSynthesisStream implements SynthesisStream {
  readonly frames = new EventStream<AudioFrame>();

  private cancelled = false;
  private ended = false;
  private first: Date | null = null;
  private producedMs = 0;
  private seq = 0;

  constructor(
    readonly callId: string,
    private readonly options: StreamSynthesizeOptions,
    private readonly frameMs: number,
    private readonly now: () => Date,
    private readonly synthesise: (text: string, language: Language, voice?: string) => Promise<Buffer>,
  ) {}

  get isClosed(): boolean {
    return this.cancelled || this.ended;
  }

  async write(text: string): Promise<void> {
    for (const chunk of toSynthesisChunks(text)) {
      if (this.cancelled) return;

      const pcm = await this.synthesise(chunk, this.options.language, this.options.voiceRef);
      // Re-checked after the await, not only before it: barge-in most often
      // lands while a chunk is in flight, and emitting it on return is exactly
      // the agent talking over the customer that barge-in exists to stop.
      if (this.cancelled) return;

      this.first ??= this.now();
      for (const frame of toFrames(pcm, {
        frameMs: this.frameMs,
        startSeq: this.seq,
        startAt: this.now(),
      })) {
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
    this.frames.close();
  }

  firstFrameAt(): Date | null {
    return this.first;
  }

  synthesisedMs(): number {
    return this.producedMs;
  }
}

export class GoogleStreamingSpeechAdapter implements StreamingSpeechPort {
  readonly driver = 'google' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly config: GoogleStreamingConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.now = config.now ?? (() => new Date());
  }

  streamTranscribe(options: StreamTranscribeOptions): TranscribeStream {
    return new WindowedTranscribeStream(
      options.callId,
      this.config,
      options,
      this.now,
      (pcm, languages) => this.recognise(pcm, languages, options.hints ?? []),
    );
  }

  streamSynthesize(options: StreamSynthesizeOptions): SynthesisStream {
    return new GoogleSynthesisStream(
      options.callId,
      options,
      options.frameMs ?? this.config.frameMs,
      this.now,
      (text, language, voice) => this.synthesise(text, language, voice),
    );
  }

  private async recognise(
    pcm: Buffer,
    languages: readonly string[],
    hints: readonly string[],
  ): Promise<{ readonly text: string; readonly confidence: number; readonly languageCode: string | null }> {
    const body = {
      config: {
        // An explicit WAV wrapper rather than `explicitDecodingConfig`: one
        // header is cheaper to keep correct than a sample-rate field that has
        // to stay in step with whatever the telephony leg negotiated.
        autoDecodingConfig: {},
        model: this.config.model,
        languageCodes: languages,
        features: { enableAutomaticPunctuation: true },
        ...(hints.length === 0
          ? {}
          : {
              adaptation: {
                phraseSets: [
                  { inlinePhraseSet: { phrases: hints.map((value) => ({ value, boost: 15 })) } },
                ],
              },
            }),
      },
      content: pcmToWav(pcm, INTERNAL_SAMPLE_RATE).toString('base64'),
    };

    const parsed = await this.post(
      `${trimTrailingSlash(this.config.speechBaseUrl)}/v2/${this.config.recognizer}:recognize`,
      body,
    );

    const results = Array.isArray((parsed as Record<string, unknown>)['results'])
      ? ((parsed as Record<string, unknown>)['results'] as unknown[])
      : [];

    const parts: string[] = [];
    let confidence = 0;
    let languageCode: string | null = null;

    for (const entry of results) {
      const result = asRecord(entry);
      const alternatives = Array.isArray(result['alternatives']) ? result['alternatives'] : [];
      const best = asRecord(alternatives[0]);
      const transcript = typeof best['transcript'] === 'string' ? best['transcript'].trim() : '';
      if (transcript.length === 0) continue;
      parts.push(transcript);
      if (typeof best['confidence'] === 'number') confidence = Math.max(confidence, best['confidence']);
      if (typeof result['languageCode'] === 'string') languageCode ??= result['languageCode'];
    }

    return {
      text: parts.join(' '),
      // Google omits confidence on some models. 0.8 is the same figure the batch
      // adapter uses for an unlabelled result: below the auto-apply bar on
      // purpose, so an unscored transcript asks a human rather than acting.
      confidence: confidence === 0 && parts.length > 0 ? 0.8 : confidence,
      languageCode,
    };
  }

  private async synthesise(text: string, language: Language, voice?: string): Promise<Buffer> {
    const parsed = await this.post(`${trimTrailingSlash(this.config.ttsBaseUrl)}/v1/text:synthesize`, {
      input: { text },
      voice: {
        languageCode: googleLanguageCode(language),
        name: voice ?? this.config.voices[language],
      },
      audioConfig: {
        audioEncoding: 'LINEAR16',
        sampleRateHertz: INTERNAL_SAMPLE_RATE,
      },
    });

    const content = (parsed as Record<string, unknown>)['audioContent'];
    if (typeof content !== 'string' || content.length === 0) {
      throw new StreamingSpeechError('UNKNOWN', 'Google returned no audio for the turn');
    }

    const bytes = Buffer.from(content, 'base64');
    // LINEAR16 comes back wrapped in a RIFF container.
    return bytes.toString('ascii', 0, 4) === 'RIFF' ? bytes.subarray(44) : bytes;
  }

  private async post(url: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const token = await this.config.accessToken();
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();
      if (!response.ok) {
        throw new StreamingSpeechError(
          response.status === 401 || response.status === 403
            ? 'AUTH_FAILED'
            : response.status === 429
              ? 'RATE_LIMITED'
              : 'PROVIDER_UNAVAILABLE',
          `Google refused the request (${response.status})`,
          { status: response.status, body: text.slice(0, 300) },
        );
      }

      return JSON.parse(text) as unknown;
    } catch (error) {
      if (error instanceof StreamingSpeechError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new StreamingSpeechError('PROVIDER_UNAVAILABLE', 'Google timed out');
      }
      throw new StreamingSpeechError(
        'UNKNOWN',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
