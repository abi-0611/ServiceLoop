import { describe, expect, it, vi } from 'vitest';
import { FailoverSpeechAdapter, type FailoverAlert } from './failover-adapter';
import { GoogleSpeechAdapter, durationToMs } from './google-adapter';
import { MockSpeechAdapter } from './mock-adapter';
import {
  SpeechError,
  countsTowardsFailover,
  toLanguage,
  type SpeechPort,
  type TranscribeInput,
  type Transcript,
} from './port';
import { SarvamSpeechAdapter } from './sarvam-adapter';

/**
 * Phase 4.1 — the speech adapters.
 *
 * The contract suite runs the *same* assertions against all three, which is the
 * point of a port: a caller that works against the mock must work against
 * Sarvam, and the way to know that is to ask them the same questions.
 *
 * Live tests are behind `LIVE_STT_TEST=1` and skipped by default. A suite that
 * silently made network calls would be a suite nobody could run on a train, and
 * one that *claimed* to test a provider it never reached would be worse.
 */

/** A minimal but structurally valid 16 kHz mono WAV, so duration parsing is real. */
function wav(seconds = 1): Buffer {
  const sampleRate = 16_000;
  const dataBytes = sampleRate * 2 * seconds;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

const AUDIO = wav(3);
const TRANSCRIPT = 'Caliper open irukku, part varum 4 maniku.';

function input(overrides: Partial<TranscribeInput> = {}): TranscribeInput {
  return {
    shopId: 'shop-1',
    bytes: AUDIO,
    contentType: 'audio/wav',
    languageHint: 'ta',
    traceId: 'trace-1',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sarvamAdapter(fetchFn: typeof globalThis.fetch): SarvamSpeechAdapter {
  return new SarvamSpeechAdapter(
    {
      apiKey: 'test-key',
      baseUrl: 'https://api.sarvam.ai',
      model: 'saaras:v3',
      timeoutMs: 5_000,
      maxBytes: 10 * 1024 * 1024,
    },
    { fetch: fetchFn },
  );
}

function googleAdapter(fetchFn: typeof globalThis.fetch): GoogleSpeechAdapter {
  return new GoogleSpeechAdapter(
    {
      recognizer: 'projects/p/locations/asia-south1/recognizers/workshop',
      baseUrl: 'https://speech.googleapis.com',
      accessToken: async () => 'test-token',
      model: 'latest_long',
      languageCodes: ['en-IN', 'ta-IN', 'hi-IN'],
      timeoutMs: 5_000,
      maxBytes: 10 * 1024 * 1024,
    },
    { fetch: fetchFn },
  );
}

const SARVAM_OK = {
  request_id: 'req-1',
  transcript: TRANSCRIPT,
  language_code: 'ta-IN',
  language_probability: 0.93,
  timestamps: {
    words: ['Caliper', 'open', 'irukku'],
    start_time_seconds: [0.1, 0.6, 1.0],
    end_time_seconds: [0.55, 0.95, 1.4],
  },
};

const GOOGLE_OK = {
  results: [
    {
      alternatives: [
        {
          transcript: TRANSCRIPT,
          confidence: 0.88,
          words: [
            { word: 'Caliper', startOffset: '0.100s', endOffset: '0.550s' },
            { word: 'open', startOffset: '0.600s', endOffset: '0.950s' },
          ],
        },
      ],
      languageCode: 'ta-IN',
    },
  ],
};

/* -------------------------------------------------------------------------- *
 * The contract, asked of all three
 * -------------------------------------------------------------------------- */

describe.each([
  [
    'MockSpeechAdapter',
    (): SpeechPort => {
      const mock = new MockSpeechAdapter();
      mock.register(AUDIO, { text: TRANSCRIPT, language: 'ta', confidence: 0.93 });
      return mock;
    },
  ],
  ['SarvamSpeechAdapter', (): SpeechPort => sarvamAdapter(async () => jsonResponse(SARVAM_OK))],
  ['GoogleSpeechAdapter', (): SpeechPort => googleAdapter(async () => jsonResponse(GOOGLE_OK))],
])('SpeechPort contract — %s', (_name, build) => {
  it('returns the words, a language, a confidence and a duration', async () => {
    const transcript: Transcript = await build().transcribe(input());

    expect(transcript.text).toContain('Caliper');
    expect(transcript.language).toBe('ta');
    expect(transcript.confidence).toBeGreaterThan(0);
    expect(transcript.confidence).toBeLessThanOrEqual(1);
    // Parsed off the RIFF header, not guessed.
    expect(transcript.durationMs).toBe(3_000);
    expect(transcript.model.length).toBeGreaterThan(0);
  });

  it('reports the language tags it observed', async () => {
    const transcript = await build().transcribe(input());
    expect(transcript.languageTags.length).toBeGreaterThan(0);
    expect(transcript.languageTags[0]).toContain('ta');
  });

  it('refuses empty audio rather than returning empty words', async () => {
    await expect(build().transcribe(input({ bytes: Buffer.alloc(0) }))).rejects.toThrow(SpeechError);
  });
});

/* -------------------------------------------------------------------------- *
 * Provider specifics
 * -------------------------------------------------------------------------- */

describe('SarvamSpeechAdapter', () => {
  it('posts multipart form data with the subscription-key header', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(SARVAM_OK));
    await sarvamAdapter(fetchFn as unknown as typeof globalThis.fetch).transcribe(input());

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.sarvam.ai/speech-to-text');
    expect((init.headers as Record<string, string>)['api-subscription-key']).toBe('test-key');

    const form = init.body as FormData;
    expect(form.get('model')).toBe('saaras:v3');
    expect(form.get('with_timestamps')).toBe('true');
    // Detection, not instruction: the thread's language is a fact about the
    // customer, and a technician's note is often not in it.
    expect(form.get('language_code')).toBe('unknown');
  });

  it('zips the three parallel timestamp arrays into segments', async () => {
    const transcript = await sarvamAdapter(async () => jsonResponse(SARVAM_OK)).transcribe(input());

    expect(transcript.segments).toHaveLength(3);
    expect(transcript.segments[0]).toMatchObject({ startMs: 100, endMs: 550, text: 'Caliper' });
    expect(transcript.segments[0]?.languageTag).toBe('ta-IN');
  });

  it('drops a word whose timestamps disagree rather than emitting a zero-length span', async () => {
    const ragged = {
      ...SARVAM_OK,
      timestamps: { words: ['a', 'b'], start_time_seconds: [0], end_time_seconds: [0.5] },
    };
    const transcript = await sarvamAdapter(async () => jsonResponse(ragged)).transcribe(input());
    expect(transcript.segments).toHaveLength(1);
  });

  it('falls back to a below-threshold confidence when the provider labels nothing', async () => {
    const unlabelled = { request_id: 'r', transcript: TRANSCRIPT };
    const transcript = await sarvamAdapter(async () => jsonResponse(unlabelled)).transcribe(input());

    // 0.8 is deliberately under the 0.85 auto-apply bar: an unlabelled
    // transcript asks a human rather than moving a job card.
    expect(transcript.confidence).toBe(0.8);
    expect(transcript.languageTags).toEqual([]);
  });

  it('refuses an empty transcript rather than producing a silent success', async () => {
    await expect(
      sarvamAdapter(async () => jsonResponse({ transcript: '   ' })).transcribe(input()),
    ).rejects.toThrow(SpeechError);
  });

  it.each([
    [401, 'AUTH_FAILED'],
    [429, 'RATE_LIMITED'],
    [500, 'PROVIDER_UNAVAILABLE'],
    [503, 'PROVIDER_UNAVAILABLE'],
    [413, 'AUDIO_TOO_LARGE'],
    [415, 'UNSUPPORTED_FORMAT'],
  ])('maps HTTP %d onto %s', async (status, kind) => {
    const adapter = sarvamAdapter(async () => new Response('nope', { status }));
    await expect(adapter.transcribe(input())).rejects.toMatchObject({ kind });
  });

  it('reports a network failure as the provider being unavailable', async () => {
    const adapter = sarvamAdapter(async () => {
      throw new Error('ECONNRESET');
    });
    await expect(adapter.transcribe(input())).rejects.toMatchObject({
      kind: 'PROVIDER_UNAVAILABLE',
    });
  });

  it('refuses audio larger than the synchronous endpoint accepts', async () => {
    const adapter = new SarvamSpeechAdapter(
      {
        apiKey: 'k',
        baseUrl: 'https://api.sarvam.ai',
        model: 'saaras:v3',
        timeoutMs: 1_000,
        maxBytes: 100,
      },
      { fetch: async () => jsonResponse(SARVAM_OK) },
    );
    await expect(adapter.transcribe(input())).rejects.toMatchObject({ kind: 'AUDIO_TOO_LARGE' });
  });
});

describe('GoogleSpeechAdapter', () => {
  it('sends the recogniser path, a bearer token and word timings', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(GOOGLE_OK));
    await googleAdapter(fetchFn as unknown as typeof globalThis.fetch).transcribe(input());

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      'https://speech.googleapis.com/v2/projects/p/locations/asia-south1/recognizers/workshop:recognize',
    );
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer test-token');

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    const cfg = body['config'] as Record<string, unknown>;
    expect((cfg['features'] as Record<string, unknown>)['enableWordTimeOffsets']).toBe(true);
    // The hint is promoted to primary; the alternates survive, because a
    // technician's note is routinely not in the customer's language.
    expect(cfg['languageCodes']).toEqual(['ta-IN', 'en-IN', 'hi-IN']);
    expect(body['content']).toBe(AUDIO.toString('base64'));
  });

  it('passes vocabulary hints through as a boosted phrase set', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(GOOGLE_OK));
    await googleAdapter(fetchFn as unknown as typeof globalThis.fetch).transcribe(
      input({ hints: ['TN09BX4432', 'caliper'] }),
    );

    const body = JSON.parse(
      (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>;
    const adaptation = (body['config'] as Record<string, unknown>)['adaptation'] as Record<
      string,
      unknown
    >;
    const phraseSets = adaptation['phraseSets'] as { inlinePhraseSet: { phrases: unknown[] } }[];
    expect(phraseSets[0]?.inlinePhraseSet.phrases).toEqual([
      { value: 'TN09BX4432', boost: 15 },
      { value: 'caliper', boost: 15 },
    ]);
  });

  it('sends no adaptation block when there are no hints', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(GOOGLE_OK));
    await googleAdapter(fetchFn as unknown as typeof globalThis.fetch).transcribe(input());
    const body = JSON.parse(
      (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>;
    expect((body['config'] as Record<string, unknown>)['adaptation']).toBeUndefined();
  });

  it('joins multiple results and averages their confidences', async () => {
    const twoResults = {
      results: [
        { alternatives: [{ transcript: 'Caliper open', confidence: 0.9 }], languageCode: 'ta-IN' },
        { alternatives: [{ transcript: 'part varum', confidence: 0.7 }], languageCode: 'en-IN' },
      ],
    };
    const transcript = await googleAdapter(async () => jsonResponse(twoResults)).transcribe(input());

    expect(transcript.text).toBe('Caliper open part varum');
    expect(transcript.confidence).toBeCloseTo(0.8, 5);
    expect(transcript.languageTags).toEqual(['ta-IN', 'en-IN']);
  });

  it('refuses a response with no alternatives', async () => {
    await expect(
      googleAdapter(async () => jsonResponse({ results: [] })).transcribe(input()),
    ).rejects.toThrow(SpeechError);
  });

  it.each([
    ['1.500s', 1500],
    ['0.100s', 100],
    [{ seconds: 2, nanos: 500_000_000 }, 2500],
    [undefined, 0],
    ['not-a-duration', 0],
  ])('parses the protobuf duration %s as %dms', (value, expected) => {
    expect(durationToMs(value)).toBe(expected);
  });
});

/* -------------------------------------------------------------------------- *
 * The failover policy
 * -------------------------------------------------------------------------- */

class ScriptedSpeech implements SpeechPort {
  calls = 0;
  constructor(
    readonly driver: 'sarvam' | 'google',
    private readonly script: (call: number) => Transcript | Error,
  ) {}

  async transcribe(): Promise<Transcript> {
    this.calls += 1;
    const outcome = this.script(this.calls);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
}

function transcript(text: string): Transcript {
  return {
    text,
    language: 'ta',
    confidence: 0.9,
    durationMs: 3_000,
    model: 'scripted',
    segments: [],
    languageTags: ['ta-IN'],
  };
}

const unavailable = new SpeechError('PROVIDER_UNAVAILABLE', 'down');

describe('FailoverSpeechAdapter', () => {
  it('stays on the primary for a single failure', async () => {
    const primary = new ScriptedSpeech('sarvam', (call) =>
      call === 1 ? unavailable : transcript('primary'),
    );
    const fallback = new ScriptedSpeech('google', () => transcript('fallback'));
    const adapter = new FailoverSpeechAdapter(primary, fallback);

    await expect(adapter.transcribe(input())).rejects.toThrow(unavailable);
    expect(fallback.calls).toBe(0);

    expect((await adapter.transcribe(input())).text).toBe('primary');
  });

  it('moves to the fallback on the second consecutive failure and alerts once', async () => {
    const alerts: FailoverAlert[] = [];
    const primary = new ScriptedSpeech('sarvam', () => unavailable);
    const fallback = new ScriptedSpeech('google', () => transcript('fallback'));
    const adapter = new FailoverSpeechAdapter(primary, fallback, {
      threshold: 2,
      onAlert: (alert) => alerts.push(alert),
    });

    await expect(adapter.transcribe(input())).rejects.toThrow();
    expect((await adapter.transcribe(input())).text).toBe('fallback');
    expect(adapter.active).toBe('fallback');

    // Subsequent calls stay on the fallback without paging anyone again.
    expect((await adapter.transcribe(input())).text).toBe('fallback');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ from: 'primary', to: 'fallback', consecutiveFailures: 2 });
  });

  it('does not count a bad recording against the provider', async () => {
    const primary = new ScriptedSpeech(
      'sarvam',
      () => new SpeechError('AUDIO_TOO_SHORT', 'four bytes of silence'),
    );
    const fallback = new ScriptedSpeech('google', () => transcript('fallback'));
    const adapter = new FailoverSpeechAdapter(primary, fallback, { threshold: 2 });

    // One bad voice note must not move a whole shop onto the second-best
    // recogniser.
    await expect(adapter.transcribe(input())).rejects.toThrow();
    await expect(adapter.transcribe(input())).rejects.toThrow();
    expect(adapter.active).toBe('primary');
    expect(fallback.calls).toBe(0);
  });

  it('classifies which errors are the provider’s problem', () => {
    expect(countsTowardsFailover(new SpeechError('PROVIDER_UNAVAILABLE', ''))).toBe(true);
    expect(countsTowardsFailover(new SpeechError('RATE_LIMITED', ''))).toBe(true);
    expect(countsTowardsFailover(new SpeechError('AUTH_FAILED', ''))).toBe(true);
    expect(countsTowardsFailover(new SpeechError('NO_FIXTURE', ''))).toBe(false);
    expect(countsTowardsFailover(new SpeechError('AUDIO_TOO_SHORT', ''))).toBe(false);
    expect(countsTowardsFailover(new SpeechError('UNSUPPORTED_FORMAT', ''))).toBe(false);
  });

  it('surfaces the primary’s error when both providers are down', async () => {
    const primaryError = new SpeechError('AUTH_FAILED', 'sarvam key revoked');
    const primary = new ScriptedSpeech('sarvam', () => primaryError);
    const fallback = new ScriptedSpeech('google', () => unavailable);
    const adapter = new FailoverSpeechAdapter(primary, fallback, { threshold: 1 });

    // The primary's error is the actionable one; the fallback being down is a
    // footnote the alert already carries.
    await expect(adapter.transcribe(input())).rejects.toThrow('sarvam key revoked');
  });

  it('probes the primary again after the cool-off, and returns traffic when it answers', async () => {
    let clock = 0;
    const alerts: FailoverAlert[] = [];
    const primary = new ScriptedSpeech('sarvam', (call) =>
      call <= 2 ? unavailable : transcript('primary is back'),
    );
    const fallback = new ScriptedSpeech('google', () => transcript('fallback'));
    const adapter = new FailoverSpeechAdapter(primary, fallback, {
      threshold: 2,
      probeAfterMs: 60_000,
      now: () => clock,
      onAlert: (alert) => alerts.push(alert),
    });

    await expect(adapter.transcribe(input())).rejects.toThrow();
    expect((await adapter.transcribe(input())).text).toBe('fallback');

    clock += 30_000;
    expect((await adapter.transcribe(input())).text).toBe('fallback');

    clock += 40_000;
    expect((await adapter.transcribe(input())).text).toBe('primary is back');
    expect(adapter.active).toBe('primary');
    expect(alerts.map((alert) => alert.to)).toEqual(['fallback', 'primary']);
  });

  it('reaches past a stale breaker rather than losing a voice note', async () => {
    const primary = new ScriptedSpeech('sarvam', (call) =>
      call <= 2 ? unavailable : transcript('primary'),
    );
    const fallback = new ScriptedSpeech('google', (call) =>
      call === 1 ? transcript('fallback') : unavailable,
    );
    const adapter = new FailoverSpeechAdapter(primary, fallback, {
      threshold: 2,
      probeAfterMs: 10 * 60_000,
      now: () => 0,
    });

    await expect(adapter.transcribe(input())).rejects.toThrow();
    expect((await adapter.transcribe(input())).text).toBe('fallback');
    // Fallback now down, primary still inside its cool-off: try it anyway.
    expect((await adapter.transcribe(input())).text).toBe('primary');
  });
});

describe('toLanguage', () => {
  it.each([
    ['ta-IN', 'ta'],
    ['hi', 'hi'],
    ['en-US', 'en'],
    ['mr-IN', 'en'],
    [null, 'en'],
    [undefined, 'en'],
  ] as const)('maps %s onto %s', (tag, expected) => {
    expect(toLanguage(tag)).toBe(expected);
  });
});

/* -------------------------------------------------------------------------- *
 * Live tests — opt in with LIVE_STT_TEST=1
 * -------------------------------------------------------------------------- */

const live = process.env['LIVE_STT_TEST'] === '1';

describe.skipIf(!live)('live speech providers', () => {
  it('transcribes a recorded fixture through Sarvam', async () => {
    const apiKey = process.env['SARVAM_API_KEY'];
    expect(apiKey, 'SARVAM_API_KEY is required for LIVE_STT_TEST=1').toBeDefined();

    const adapter = new SarvamSpeechAdapter({
      apiKey: apiKey as string,
      baseUrl: process.env['SARVAM_BASE_URL'] ?? 'https://api.sarvam.ai',
      model: process.env['SARVAM_STT_MODEL'] ?? 'saaras:v3',
      timeoutMs: 60_000,
      maxBytes: 10 * 1024 * 1024,
    });

    const result = await adapter.transcribe(input({ bytes: wav(2) }));
    expect(typeof result.text).toBe('string');
  });
});
