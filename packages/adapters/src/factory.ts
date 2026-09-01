import { type Env, selectAdapters } from '@serviceloop/config';
import { ConfigurationError, type LlmTaskClass } from '@serviceloop/shared';
import {
  LlmTextDraftExtractor,
  VoiceNoteDraftExtractor,
} from './intake/draft-extractors';
import { AdapterDraftExtraction } from './intake/extraction';
import { WhatsAppChannelSender, WhatsAppMediaFetcher } from './whatsapp/channel-sender';
import { AnthropicLlmAdapter } from './llm/anthropic-adapter';
import {
  BestEffortUsageSink,
  MeteredLlmPort,
  type LlmUsageSink,
} from './llm/metering';
import type { LlmPort } from './llm/port';
import { SandboxLlmAdapter } from './llm/sandbox-adapter';
import { FixtureOcrAdapter } from './ocr/fixture-adapter';
import type { OcrPort } from './ocr/port';
import { VisionLlmOcrAdapter } from './ocr/vision-llm-adapter';
import { FailoverSpeechAdapter, type FailoverAlert } from './speech/failover-adapter';
import { GoogleSpeechAdapter } from './speech/google-adapter';
import { MockSpeechAdapter } from './speech/mock-adapter';
import type { SpeechPort } from './speech/port';
import { SarvamSpeechAdapter } from './speech/sarvam-adapter';
import { GoogleStreamingSpeechAdapter } from './speech/google-streaming-adapter';
import { MockStreamingSpeechAdapter } from './speech/mock-streaming-adapter';
import { SarvamStreamingAdapter } from './speech/sarvam-streaming-adapter';
import type { StreamingSpeechPort } from './speech/streaming-port';
import { BrowserLoopbackTelephonyAdapter } from './telephony/loopback-adapter';
import { ExotelTelephonyAdapter } from './telephony/exotel-adapter';
import { TwilioTelephonyAdapter } from './telephony/twilio-adapter';
import type { TelephonyPort } from './telephony/port';
import { MockPaymentsAdapter } from './payments/mock-adapter';
import type { PaymentsPort } from './payments/port';
import { RazorpayPaymentsAdapter } from './payments/razorpay-adapter';
import { InMemoryNotifier, LoggingNotifier, type LogSink } from './notifier/sandbox-notifiers';
import type { NotifierPort } from './notifier/port';
import { InMemoryStorage } from './storage/in-memory-storage';
import type { StoragePort } from './storage/port';
import { S3Storage } from './storage/s3-storage';
import { MetaCloudWhatsAppAdapter } from './whatsapp/meta-cloud-adapter';
import type { WhatsAppPort } from './whatsapp/port';
import {
  InMemoryTokenBucketStore,
  RedisTokenBucketStore,
  WhatsAppRateLimiter,
  type EvalCapableRedis,
  type TokenBucketStore,
} from './whatsapp/rate-limiter';
import { SandboxWhatsAppAdapter } from './whatsapp/sandbox-adapter';

/**
 * Adapter construction from the validated environment. This is the only place
 * that decides which implementation of a port is live, so the boot log
 * (`formatAdapterSelection`) and the wiring can never disagree.
 */

export function createStoragePort(env: Env): StoragePort {
  const selection = selectAdapters(env).find((entry) => entry.port === 'storage');
  if (selection !== undefined && !selection.implemented) {
    throw new ConfigurationError(
      `No storage adapter is implemented for STORAGE_DRIVER=${env.STORAGE_DRIVER}`,
      { driver: env.STORAGE_DRIVER },
    );
  }

  if (env.STORAGE_DRIVER === 'memory') return new InMemoryStorage(env.S3_BUCKET);

  return new S3Storage({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    bucket: env.S3_BUCKET,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  });
}

export function createNotifierPort(env: Env, sink?: LogSink): NotifierPort {
  if (env.DEMO_MODE || env.NOTIFIER_DRIVER !== 'sms') {
    return env.NOTIFIER_DRIVER === 'memory' ? new InMemoryNotifier() : new LoggingNotifier(sink);
  }

  throw new ConfigurationError(
    'The SMS notifier adapter is not wired yet; set NOTIFIER_DRIVER=log or enable DEMO_MODE',
    { driver: env.NOTIFIER_DRIVER },
  );
}

/**
 * The send budget is shared by every API instance and worker, so it belongs in
 * Redis. Without a client (tests, the demo runner) it degrades to a
 * process-local bucket, which is still a correct limit for a single process.
 */
export function createWhatsAppRateLimiter(env: Env, redis?: EvalCapableRedis): WhatsAppRateLimiter {
  const store: TokenBucketStore =
    redis === undefined ? new InMemoryTokenBucketStore() : new RedisTokenBucketStore(redis);

  return new WhatsAppRateLimiter(store, {
    policy: {
      capacity: env.WHATSAPP_SEND_BURST,
      refillPerSecond: env.WHATSAPP_SEND_PER_SECOND,
    },
  });
}

export interface WhatsAppFactoryOptions {
  readonly redis?: EvalCapableRedis;
  readonly rateLimiter?: WhatsAppRateLimiter;
  /**
   * Where model-usage rows go (phase 3.1). Supplying it wraps the LLM port in
   * the meter; omitting it is only correct for callers with no database, which
   * in practice means a unit test.
   */
  readonly llmUsageSink?: LlmUsageSink;
  readonly onLlmSinkError?: (error: unknown) => void;
}

export function createWhatsAppPort(env: Env, options: WhatsAppFactoryOptions = {}): WhatsAppPort {
  const rateLimiter = options.rateLimiter ?? createWhatsAppRateLimiter(env, options.redis);

  const selection = selectAdapters(env).find((entry) => entry.port === 'whatsapp');
  if (selection?.sandbox !== false) {
    return new SandboxWhatsAppAdapter({ rateLimiter });
  }

  // The env schema refuses to boot with WHATSAPP_DRIVER=meta and a missing
  // credential, so reaching here with an undefined value is impossible; the
  // explicit check keeps that guarantee visible rather than implied by a cast.
  const missing = (
    ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN'] as const
  ).filter((key) => env[key] === undefined);
  if (missing.length > 0) {
    throw new ConfigurationError(
      `WHATSAPP_DRIVER=meta is selected but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set`,
      { missing },
    );
  }

  return new MetaCloudWhatsAppAdapter(
    {
      accessToken: env.WHATSAPP_ACCESS_TOKEN as string,
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID as string,
      businessAccountId: env.WHATSAPP_BUSINESS_ACCOUNT_ID ?? '',
      appSecret: env.WHATSAPP_APP_SECRET as string,
      verifyToken: env.WHATSAPP_VERIFY_TOKEN as string,
      graphVersion: env.WHATSAPP_GRAPH_VERSION,
    },
    { rateLimiter },
  );
}

/**
 * The LLM port. DEMO_MODE forces the sandbox even when a key is present, for
 * the same reason WhatsApp does: a developer must not be able to spend a
 * shop's model budget — or send a customer a generated message — by accident.
 */
export function modelsByTaskClass(env: Env): Readonly<Record<LlmTaskClass, string>> {
  return {
    AGENT: env.LLM_AGENT_MODEL,
    CLASSIFY: env.LLM_CLASSIFY_MODEL,
    EXTRACT: env.LLM_EXTRACT_MODEL,
    JUDGE: env.LLM_JUDGE_MODEL,
  };
}

function temperaturesByTaskClass(env: Env): Partial<Readonly<Record<LlmTaskClass, number>>> {
  return {
    ...(env.LLM_AGENT_TEMPERATURE === undefined ? {} : { AGENT: env.LLM_AGENT_TEMPERATURE }),
    ...(env.LLM_CLASSIFY_TEMPERATURE === undefined
      ? {}
      : { CLASSIFY: env.LLM_CLASSIFY_TEMPERATURE }),
    ...(env.LLM_EXTRACT_TEMPERATURE === undefined ? {} : { EXTRACT: env.LLM_EXTRACT_TEMPERATURE }),
    ...(env.LLM_JUDGE_TEMPERATURE === undefined ? {} : { JUDGE: env.LLM_JUDGE_TEMPERATURE }),
  };
}

export function createLlmPort(env: Env): LlmPort {
  const selection = selectAdapters(env).find((entry) => entry.port === 'llm');

  if (selection?.sandbox !== false) {
    return new SandboxLlmAdapter({ models: modelsByTaskClass(env) });
  }

  if (env.ANTHROPIC_API_KEY === undefined) {
    throw new ConfigurationError(
      'LLM_DRIVER=anthropic is selected but ANTHROPIC_API_KEY is not set',
      { driver: env.LLM_DRIVER },
    );
  }

  return new AnthropicLlmAdapter({
    apiKey: env.ANTHROPIC_API_KEY,
    baseUrl: env.ANTHROPIC_BASE_URL,
    models: modelsByTaskClass(env),
    temperatures: temperaturesByTaskClass(env),
    maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS,
    timeoutMs: env.LLM_TIMEOUT_MS,
    retry: {
      maxRetries: env.LLM_MAX_RETRIES,
      baseDelayMs: env.LLM_RETRY_BASE_MS,
      maxDelayMs: env.LLM_RETRY_MAX_DELAY_MS,
    },
  });
}

/**
 * The LLM port with metering attached.
 *
 * Every composition root uses this rather than `createLlmPort` directly, so a
 * model call that is not metered is a call that had to be deliberately
 * unwrapped. Metering never fails a customer-facing send: the sink is
 * best-effort by construction.
 */
export function createMeteredLlmPort(
  env: Env,
  sink: LlmUsageSink,
  onSinkError?: (error: unknown) => void,
): LlmPort {
  return new MeteredLlmPort(createLlmPort(env), new BestEffortUsageSink(sink, onSinkError), {
    pricing: env.LLM_PRICING_JSON,
  });
}

/**
 * The OCR port.
 *
 * With a live model, the vision adapter reads real photographs. In DEMO_MODE
 * the fixture adapter is returned instead — deterministic, and it refuses an
 * unregistered image rather than inventing a card. The eval harness registers
 * the golden set into the instance it is handed.
 */
export function createOcrPort(env: Env, llm: LlmPort): OcrPort {
  const selection = selectAdapters(env).find((entry) => entry.port === 'ocr');
  if (selection?.sandbox !== false) return new FixtureOcrAdapter();
  return new VisionLlmOcrAdapter(llm);
}

export interface SpeechFactoryOptions {
  /** Where a failover transition is reported. Wired to the logger at boot. */
  readonly onFailover?: (alert: FailoverAlert) => void;
}

/**
 * The speech port (phase 4.1).
 *
 * DEMO_MODE forces the mock, so CI and every demo run transcribe from fixtures
 * with no credential and no network. With `SPEECH_DRIVER=sarvam` and a Google
 * recogniser also configured, the two are wrapped in the failover policy; with
 * only one configured there is nothing to fail over to and the adapter is
 * returned bare rather than pretending to have a spare.
 */
export function createSpeechPort(env: Env, options: SpeechFactoryOptions = {}): SpeechPort {
  const selection = selectAdapters(env).find((entry) => entry.port === 'speech');
  if (selection?.sandbox !== false) return new MockSpeechAdapter();

  const google = createGoogleSpeechAdapter(env);

  if (env.SPEECH_DRIVER === 'google') {
    if (google === null) {
      throw new ConfigurationError(
        'SPEECH_DRIVER=google requires GOOGLE_SPEECH_RECOGNIZER and GOOGLE_SPEECH_ACCESS_TOKEN',
        { driver: env.SPEECH_DRIVER },
      );
    }
    return google;
  }

  if (env.SARVAM_API_KEY === undefined) {
    throw new ConfigurationError('SPEECH_DRIVER=sarvam is selected but SARVAM_API_KEY is not set', {
      driver: env.SPEECH_DRIVER,
    });
  }

  const sarvam = new SarvamSpeechAdapter({
    apiKey: env.SARVAM_API_KEY,
    baseUrl: env.SARVAM_BASE_URL,
    model: env.SARVAM_STT_MODEL,
    timeoutMs: env.SPEECH_TIMEOUT_MS,
    maxBytes: env.SPEECH_MAX_BYTES,
  });

  if (google === null) return sarvam;

  return new FailoverSpeechAdapter(sarvam, google, {
    threshold: env.SPEECH_FAILOVER_THRESHOLD,
    probeAfterMs: env.SPEECH_FAILOVER_PROBE_MS,
    ...(options.onFailover === undefined ? {} : { onAlert: options.onFailover }),
  });
}

function createGoogleSpeechAdapter(env: Env): GoogleSpeechAdapter | null {
  if (env.GOOGLE_SPEECH_RECOGNIZER === undefined) return null;
  if (env.GOOGLE_SPEECH_ACCESS_TOKEN === undefined) return null;

  const token = env.GOOGLE_SPEECH_ACCESS_TOKEN;
  return new GoogleSpeechAdapter({
    recognizer: env.GOOGLE_SPEECH_RECOGNIZER,
    baseUrl: env.GOOGLE_SPEECH_BASE_URL,
    // Wrapped in a function because a real deployment mints a short-lived token
    // per call from workload identity; the env value is the development shape.
    accessToken: () => Promise.resolve(token),
    model: env.GOOGLE_SPEECH_MODEL,
    languageCodes: env.GOOGLE_SPEECH_LANGUAGES,
    timeoutMs: env.SPEECH_TIMEOUT_MS,
    maxBytes: env.SPEECH_MAX_BYTES,
  });
}

/**
 * The payments port (phase 4.9).
 *
 * DEMO_MODE forces the mock, which is a real adapter rather than a stub: it
 * mints a link, holds an in-process ledger, and emits correctly-shaped webhook
 * payloads when the sandbox simulates a success or a failure — so the whole
 * reconcile path is exercised in CI with no Razorpay account in existence.
 */
export function createPaymentsPort(env: Env): PaymentsPort {
  const selection = selectAdapters(env).find((entry) => entry.port === 'payments');
  if (selection?.sandbox !== false) return new MockPaymentsAdapter();

  const missing = (['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'] as const)
    .filter((key) => env[key] === undefined);
  if (missing.length > 0) {
    throw new ConfigurationError(
      `PAYMENTS_DRIVER=razorpay is selected but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set`,
      { missing },
    );
  }

  return new RazorpayPaymentsAdapter({
    keyId: env.RAZORPAY_KEY_ID as string,
    keySecret: env.RAZORPAY_KEY_SECRET as string,
    webhookSecret: env.RAZORPAY_WEBHOOK_SECRET as string,
    baseUrl: env.RAZORPAY_BASE_URL,
    timeoutMs: env.PAYMENTS_TIMEOUT_MS,
  });
}


/**
 * The telephony port (phase 5.1).
 *
 * DEMO_MODE forces the browser loopback for the same reason it forces the
 * WhatsApp sandbox and the mock payments adapter: a developer with an Exotel
 * token in their shell must not be able to ring a real customer by clicking a
 * button in the console. The loopback is a complete adapter, so nothing about
 * the phase is untestable without a telco account.
 */
export function createTelephonyPort(
  env: Env,
  options: TelephonyFactoryOptions = {},
): TelephonyPort {
  const selection = selectAdapters(env).find((entry) => entry.port === 'telephony');

  if (selection?.sandbox !== false) {
    return new BrowserLoopbackTelephonyAdapter({
      ...(env.TELEPHONY_CALLER_ID === undefined ? {} : { callerId: env.TELEPHONY_CALLER_ID }),
      frameMs: env.VOICE_FRAME_MS,
      playbackSpeed: options.playbackSpeed ?? env.VOICE_LOOPBACK_PLAYBACK_SPEED,
      ...(options.ringDelayMs === undefined ? {} : { ringDelayMs: options.ringDelayMs }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  // The env schema refuses to boot a live driver with a missing credential, so
  // these can only be defined here; the explicit check keeps the guarantee
  // visible rather than implied by a cast.
  const callerId = required(env.TELEPHONY_CALLER_ID, 'TELEPHONY_CALLER_ID');
  const webhookBaseUrl = env.TELEPHONY_WEBHOOK_BASE_URL ?? env.API_BASE_URL;

  if (env.TELEPHONY_DRIVER === 'twilio') {
    return new TwilioTelephonyAdapter({
      accountSid: required(env.TWILIO_ACCOUNT_SID, 'TWILIO_ACCOUNT_SID'),
      authToken: required(env.TWILIO_AUTH_TOKEN, 'TWILIO_AUTH_TOKEN'),
      callerId,
      webhookBaseUrl,
      baseUrl: env.TWILIO_BASE_URL,
      timeoutMs: env.TELEPHONY_TIMEOUT_MS,
      frameMs: env.VOICE_FRAME_MS,
    });
  }

  return new ExotelTelephonyAdapter({
    accountSid: required(env.EXOTEL_ACCOUNT_SID, 'EXOTEL_ACCOUNT_SID'),
    apiKey: required(env.EXOTEL_API_KEY, 'EXOTEL_API_KEY'),
    apiToken: required(env.EXOTEL_API_TOKEN, 'EXOTEL_API_TOKEN'),
    subdomain: env.EXOTEL_SUBDOMAIN,
    flowAppId: required(env.EXOTEL_FLOW_APP_ID, 'EXOTEL_FLOW_APP_ID'),
    callerId,
    webhookBaseUrl,
    timeoutMs: env.TELEPHONY_TIMEOUT_MS,
    frameMs: env.VOICE_FRAME_MS,
  });
}

/**
 * The streaming speech port (phase 5.2).
 *
 * DEMO_MODE forces the mock, which transcribes and synthesises real PCM frames
 * from fixtures — so a whole call runs in CI with no credential and no network,
 * which is what makes `pnpm sim:voice` a required check rather than a nightly
 * one.
 */
export function createStreamingSpeechPort(env: Env): StreamingSpeechPort {
  const selection = selectAdapters(env).find((entry) => entry.port === 'speech-stream');

  if (selection?.sandbox !== false) {
    return new MockStreamingSpeechAdapter({ frameMs: env.VOICE_FRAME_MS });
  }

  if (env.SPEECH_STREAM_DRIVER === 'google') {
    const recognizer = required(env.GOOGLE_STREAM_RECOGNIZER, 'GOOGLE_STREAM_RECOGNIZER');
    const token = required(env.GOOGLE_SPEECH_ACCESS_TOKEN, 'GOOGLE_SPEECH_ACCESS_TOKEN');

    return new GoogleStreamingSpeechAdapter({
      recognizer,
      speechBaseUrl: env.GOOGLE_SPEECH_BASE_URL,
      ttsBaseUrl: 'https://texttospeech.googleapis.com',
      accessToken: () => Promise.resolve(token),
      model: env.GOOGLE_SPEECH_MODEL,
      languageCodes: env.GOOGLE_SPEECH_LANGUAGES,
      // A shorter window would cost a round trip per syllable and a longer one
      // would put the first partial past the whole latency budget. Half a
      // second is the point at which the filler covers the gap.
      windowMs: 500,
      frameMs: env.VOICE_FRAME_MS,
      timeoutMs: env.SPEECH_TIMEOUT_MS,
      voices: { en: 'en-IN-Wavenet-D', ta: 'ta-IN-Wavenet-A', hi: 'hi-IN-Wavenet-D' },
    });
  }

  return new SarvamStreamingAdapter({
    apiKey: required(env.SARVAM_API_KEY, 'SARVAM_API_KEY'),
    sttUrl: env.SARVAM_STREAM_URL,
    ttsUrl: 'wss://api.sarvam.ai/text-to-speech/ws',
    sttModel: env.SARVAM_STREAM_STT_MODEL,
    ttsModel: env.SARVAM_TTS_MODEL,
    voices: {
      en: env.SARVAM_TTS_VOICE_EN,
      ta: env.SARVAM_TTS_VOICE_TA,
      hi: env.SARVAM_TTS_VOICE_HI,
    },
    frameMs: env.VOICE_FRAME_MS,
    connectTimeoutMs: env.TELEPHONY_TIMEOUT_MS,
  });
}

export interface TelephonyFactoryOptions {
  readonly ringDelayMs?: number;
  readonly now?: () => Date;
  /**
   * Overrides `VOICE_LOOPBACK_PLAYBACK_SPEED` for one port.
   *
   * Ignored by the live adapters, which have no say in how fast a telephone
   * company plays a sentence.
   */
  readonly playbackSpeed?: number;
}

/** Everything the voice layer needs, built once from the validated environment. */
export interface VoicePorts {
  readonly telephony: TelephonyPort;
  readonly speech: StreamingSpeechPort;
}

export function createVoicePorts(env: Env, options: TelephonyFactoryOptions = {}): VoicePorts {
  return {
    telephony: createTelephonyPort(env, options),
    speech: createStreamingSpeechPort(env),
  };
}

function required(value: string | undefined, key: string): string {
  if (value === undefined) {
    throw new ConfigurationError(`${key} is required for the selected driver`, { key });
  }
  return value;
}

export interface DraftExtractors {
  readonly photo: OcrPort;
  readonly text: LlmTextDraftExtractor;
  readonly voice: VoiceNoteDraftExtractor;
}

/** The three intake on-ramps, wired to whichever adapters are live. */
export function createDraftExtractors(
  env: Env,
  ports: { readonly llm: LlmPort; readonly speech: SpeechPort; readonly ocr?: OcrPort },
): DraftExtractors {
  const text = new LlmTextDraftExtractor(ports.llm);
  return {
    photo: ports.ocr ?? createOcrPort(env, ports.llm),
    text,
    voice: new VoiceNoteDraftExtractor(ports.speech, text),
  };
}

/**
 * Everything phase 2 needs, built once from the validated environment.
 *
 * Three composition roots want this exact set — the API, the workers and the
 * demo runner — and each assembling it by hand is how they drift: one ends up
 * on the fixture OCR adapter while another is on the live one, and a bug
 * reproduces in only one of them.
 */
export interface ChannelPorts {
  readonly whatsapp: WhatsAppPort;
  readonly sender: WhatsAppChannelSender;
  readonly mediaFetch: WhatsAppMediaFetcher;
  readonly llm: LlmPort;
  readonly speech: SpeechPort;
  readonly ocr: OcrPort;
  readonly extraction: AdapterDraftExtraction;
  readonly rateLimiter: WhatsAppRateLimiter;
}

export function createChannelPorts(env: Env, options: WhatsAppFactoryOptions = {}): ChannelPorts {
  const rateLimiter = options.rateLimiter ?? createWhatsAppRateLimiter(env, options.redis);
  const whatsapp = createWhatsAppPort(env, { ...options, rateLimiter });

  const llm =
    options.llmUsageSink === undefined
      ? createLlmPort(env)
      : createMeteredLlmPort(env, options.llmUsageSink, options.onLlmSinkError);
  const speech = createSpeechPort(env);
  const extractors = createDraftExtractors(env, { llm, speech });

  return {
    whatsapp,
    sender: new WhatsAppChannelSender(whatsapp),
    mediaFetch: new WhatsAppMediaFetcher(whatsapp),
    llm,
    speech,
    ocr: extractors.photo,
    extraction: new AdapterDraftExtraction(extractors.photo, extractors.text, extractors.voice),
    rateLimiter,
  };
}
