import { ConfigurationError } from '@serviceloop/shared';
import { z } from 'zod';
import { loadDotEnvOnce } from './dotenv';

/**
 * The single environment gate (master §5 / phase 1.1).
 *
 * Every app imports environment values from here and nowhere else. The schema
 * is parsed once at boot and the result is deep-frozen, so a running process
 * cannot observe two different views of its configuration.
 *
 * Defaults are development/DEMO_MODE defaults. Production tightens them through
 * `superRefine` below: secrets that are safe to ship as dev placeholders are
 * rejected outright when `NODE_ENV=production`.
 */

const booleanish = (defaultValue: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .default(defaultValue)
    .transform((value, ctx) => {
      if (typeof value === 'boolean') return value;
      const normalised = value.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(normalised)) return true;
      if (['0', 'false', 'no', 'off', ''].includes(normalised)) return false;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Expected a boolean-ish value (true/false/1/0/yes/no), received "${value}"`,
      });
      return z.NEVER;
    });

const intish = (defaultValue: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(defaultValue);

/**
 * A comma-separated list. Empty and whitespace-only entries are dropped rather
 * than becoming an empty-string origin, which would match nothing and look
 * like a configuration that was applied when it was not.
 */
const csv = () =>
  z
    .string()
    .optional()
    .transform((raw): readonly string[] =>
      raw === undefined
        ? []
        : raw
            .split(',')
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
    );

const base64Key = (bytes: number) =>
  z.string().refine(
    (value) => {
      try {
        return Buffer.from(value, 'base64').length === bytes;
      } catch {
        return false;
      }
    },
    { message: `Expected a base64-encoded ${bytes}-byte key` },
  );

/**
 * The retired-key ring: `{"<keyId>":"<base64 32-byte key>"}`.
 *
 * Parsed rather than merely stored, so a malformed ring fails at boot instead
 * of at the first read of a row written under a rotated key - which would be
 * days later, on a customer lookup, in production.
 */
const keyRingJson = () =>
  z
    .string()
    .optional()
    .transform((raw, ctx): Readonly<Record<string, string>> => {
      if (raw === undefined || raw.trim() === '') return {};
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'PII_KEY_RING is not valid JSON',
        });
        return z.NEVER;
      }
      const result = z.record(z.string().min(1), base64Key(32)).safeParse(parsed);
      if (!result.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `PII_KEY_RING must map key ids to base64 32-byte keys: ${result.error.issues
            .map((issue) => issue.message)
            .join('; ')}`,
        });
        return z.NEVER;
      }
      return result.data;
    });

/** Development placeholders. Refused in production by the refinement below. */
export const DEV_JWT_SECRET = 'dev-only-jwt-secret-change-me-0123456789abcdef';
export const DEV_PII_KEY = Buffer.alloc(32, 7).toString('base64');
export const DEV_BLIND_INDEX_KEY = Buffer.alloc(32, 11).toString('base64');
export const DEV_GATE_PASS_SECRET = 'dev-only-gate-pass-secret-change-me-0123456789';

export const StorageDriverSchema = z.enum(['memory', 's3', 'gcs']);
export type StorageDriver = z.infer<typeof StorageDriverSchema>;

export const NotifierDriverSchema = z.enum(['log', 'memory', 'sms']);
export type NotifierDriver = z.infer<typeof NotifierDriverSchema>;

export const WhatsAppDriverSchema = z.enum(['sandbox', 'meta']);
export type WhatsAppDriver = z.infer<typeof WhatsAppDriverSchema>;

export const LlmDriverSchema = z.enum(['sandbox', 'anthropic']);
export type LlmDriver = z.infer<typeof LlmDriverSchema>;

export const SpeechDriverSchema = z.enum(['mock', 'sarvam', 'google']);
export type SpeechDriver = z.infer<typeof SpeechDriverSchema>;

export const PaymentsDriverSchema = z.enum(['mock', 'razorpay']);
export type PaymentsDriver = z.infer<typeof PaymentsDriverSchema>;

/**
 * Telephony (phase 5). `loopback` is the browser softphone in the console —
 * a complete adapter, not a stub, and the surface the whole phase is built on.
 */
export const TelephonyDriverSchema = z.enum(['loopback', 'exotel', 'twilio']);
export type TelephonyDriver = z.infer<typeof TelephonyDriverSchema>;

/** The streaming half of the speech port (phase 5.2). */
export const StreamingSpeechDriverSchema = z.enum(['mock', 'sarvam', 'google']);
export type StreamingSpeechDriver = z.infer<typeof StreamingSpeechDriverSchema>;

/**
 * Upload scanning (phase 7.1). `none` is a *port-abstracted* no-op rather than
 * an absent port: the scan call site exists in the media pipeline either way,
 * so turning ClamAV on is a configuration change and not a code change.
 */
export const AntivirusDriverSchema = z.enum(['none', 'clamav']);
export type AntivirusDriver = z.infer<typeof AntivirusDriverSchema>;

/**
 * The SMS rung (phase 7.3). `sandbox` records the message and returns a
 * receipt; `dlt` posts to a TRAI-DLT-registered provider with the entity id,
 * the registered header and the registered template id on the wire.
 */
export const SmsDriverSchema = z.enum(['sandbox', 'dlt']);
export type SmsDriver = z.infer<typeof SmsDriverSchema>;

/**
 * WhatsApp conversation pricing in *paise per conversation*, by category.
 *
 * Paise, not rupees, for the same reason every other amount in this codebase is
 * an integer of the smallest unit: a margin report that accumulates floating
 * point over ten thousand conversations disagrees with itself.
 */
export const WaPricingSchema = z.object({
  MARKETING: z.number().int().min(0),
  UTILITY: z.number().int().min(0),
  AUTHENTICATION: z.number().int().min(0),
  SERVICE: z.number().int().min(0),
});
export type WaPricing = z.infer<typeof WaPricingSchema>;

/**
 * Meta's published India rates as of the 2026 card, in paise. They move; that
 * is why the table is configuration and this is only the shipped default.
 */
export const DEFAULT_WA_PRICING: WaPricing = {
  MARKETING: 78,
  UTILITY: 11,
  AUTHENTICATION: 12,
  /** Service conversations are free on the current India card. */
  SERVICE: 0,
};

/** Per-model prices in USD per million tokens, for the `llm_usage` meter. */
export const LlmPricingSchema = z.record(
  z.string().min(1),
  z.object({
    inputPerMTokUsd: z.number().min(0),
    outputPerMTokUsd: z.number().min(0),
  }),
);
export type LlmPricing = z.infer<typeof LlmPricingSchema>;

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    /** Master §5: DEMO_MODE forces every sandbox adapter and seeds the demo shop. */
    DEMO_MODE: booleanish(true),
    SERVICE_NAME: z.string().min(1).default('serviceloop'),
    APP_VERSION: z.string().min(1).default('0.1.0'),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

    DATABASE_URL: z
      .string()
      .url()
      .default('postgres://serviceloop:serviceloop@localhost:5432/serviceloop'),
    DATABASE_POOL_MAX: intish(10, 1, 200),
    DATABASE_STATEMENT_TIMEOUT_MS: intish(15_000, 100),

    REDIS_URL: z.string().url().default('redis://localhost:6379'),

    API_PORT: intish(3001, 1, 65_535),
    API_BASE_URL: z.string().url().default('http://localhost:3001'),
    CONSOLE_URL: z.string().url().default('http://localhost:3000'),
    WORKERS_METRICS_PORT: intish(9101, 1, 65_535),

    JWT_SECRET: z.string().min(32).default(DEV_JWT_SECRET),
    JWT_ACCESS_TTL_SECONDS: intish(900, 60, 3600),
    REFRESH_TTL_SECONDS: intish(60 * 60 * 24 * 30, 3600),
    OTP_TTL_SECONDS: intish(300, 60, 1800),
    OTP_MAX_ATTEMPTS: intish(5, 1, 20),
    OTP_RESEND_COOLDOWN_SECONDS: intish(30, 0, 600),

    /** AES-256-GCM key for PII at rest. Rotation plan: see schema comment on `customers`. */
    PII_ENCRYPTION_KEY: base64Key(32).default(DEV_PII_KEY),
    PII_KEY_ID: z.string().min(1).default('dev-1'),
    /**
     * Retired PII keys, kept only so ciphertext written under them can still be
     * read (phase 7.1 - documented key rotation with a dual-key decrypt window).
     *
     * A JSON object of keyId to base64 key. `PII_KEY_ID` names the key new
     * writes use; every ciphertext carries the id it was written with, so a
     * rotation is: add the new key to the ring *and* to `PII_ENCRYPTION_KEY`,
     * flip `PII_KEY_ID`, let the re-encryption job drain, then drop the old
     * entry. The window exists because the alternative - one key, flipped
     * atomically - makes every row written a millisecond before the flip
     * permanently unreadable.
     */
    PII_KEY_RING: keyRingJson(),
    /** HMAC key for the deterministic blind index that makes phone lookup possible. */
    BLIND_INDEX_KEY: base64Key(32).default(DEV_BLIND_INDEX_KEY),

    STORAGE_DRIVER: StorageDriverSchema.default('s3'),
    S3_ENDPOINT: z.string().url().default('http://localhost:9000'),
    S3_REGION: z.string().min(1).default('us-east-1'),
    S3_ACCESS_KEY_ID: z.string().min(1).default('serviceloop'),
    S3_SECRET_ACCESS_KEY: z.string().min(1).default('serviceloop'),
    S3_BUCKET: z.string().min(1).default('serviceloop-media'),
    S3_FORCE_PATH_STYLE: booleanish(true),
    GCS_BUCKET: z.string().min(1).optional(),
    GCS_PROJECT_ID: z.string().min(1).optional(),

    NOTIFIER_DRIVER: NotifierDriverSchema.default('log'),
    SMS_PROVIDER_API_KEY: z.string().min(1).optional(),

    /**
     * Model ids are configuration, never hardcoded (master §10), and they are
     * chosen per **task class** rather than per call site (phase 3.1): a caller
     * asks for `AGENT` or `JUDGE` work and the adapter resolves the id. That is
     * what lets a shop run a cheap classifier next to an expensive agent
     * without a single model string appearing anywhere in the code.
     */
    LLM_DRIVER: LlmDriverSchema.default('sandbox'),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    ANTHROPIC_BASE_URL: z.string().url().default('https://api.anthropic.com'),
    ANTHROPIC_VERSION: z.string().min(1).default('2023-06-01'),
    LLM_AGENT_MODEL: z.string().min(1).default('claude-sonnet-5'),
    LLM_CLASSIFY_MODEL: z.string().min(1).default('claude-haiku-4-5-20251001'),
    /** Typed-document extraction, including reading a photographed job card. */
    LLM_EXTRACT_MODEL: z.string().min(1).default('claude-sonnet-5'),
    /** The claim-anchoring judge (phase 3.5). Cheap and high-volume. */
    LLM_JUDGE_MODEL: z.string().min(1).default('claude-haiku-4-5-20251001'),
    /**
     * Sampling temperature per task class. Unset means "send no temperature at
     * all", which is the one request shape every current model accepts — see the
     * note on `AnthropicLlmAdapter`. Set one only when a shop has a model that
     * takes it and a reason to move it.
     */
    LLM_AGENT_TEMPERATURE: z.coerce.number().min(0).max(1).optional(),
    LLM_CLASSIFY_TEMPERATURE: z.coerce.number().min(0).max(1).optional(),
    LLM_EXTRACT_TEMPERATURE: z.coerce.number().min(0).max(1).optional(),
    LLM_JUDGE_TEMPERATURE: z.coerce.number().min(0).max(1).optional(),
    LLM_MAX_OUTPUT_TOKENS: intish(4096, 256, 64_000),
    LLM_TIMEOUT_MS: intish(60_000, 1_000, 600_000),
    /** Retries for retryable failures only; a refusal is never retried. */
    LLM_MAX_RETRIES: intish(3, 0, 10),
    LLM_RETRY_BASE_MS: intish(500, 10, 60_000),
    LLM_RETRY_MAX_DELAY_MS: intish(20_000, 100, 120_000),
    /**
     * Model prices, as JSON: `{"<model id>":{"inputPerMTokUsd":3,"outputPerMTokUsd":15}}`.
     *
     * Prices are not hardcoded (master §10) and they drift, so an unpriced model
     * meters its tokens with a **null** cost rather than a confidently wrong
     * number. A spend report that says "unknown" is actionable; one that quietly
     * uses last year's rate is not.
     */
    LLM_PRICING_JSON: z
      .string()
      .default('{}')
      .transform((value, ctx) => {
        try {
          const parsed: unknown = JSON.parse(value);
          return LlmPricingSchema.parse(parsed);
        } catch (error) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Expected a JSON object of model id → {inputPerMTokUsd, outputPerMTokUsd}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
          return z.NEVER;
        }
      }),

    /* --- WhatsApp (phase 2.1) --------------------------------------------- */
    WHATSAPP_DRIVER: WhatsAppDriverSchema.default('sandbox'),
    WHATSAPP_ACCESS_TOKEN: z.string().min(1).optional(),
    WHATSAPP_PHONE_NUMBER_ID: z.string().min(1).optional(),
    WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().min(1).optional(),
    /** App secret for X-Hub-Signature-256 verification on every webhook POST. */
    WHATSAPP_APP_SECRET: z.string().min(1).optional(),
    /** Echoed during the GET subscription handshake. */
    WHATSAPP_VERIFY_TOKEN: z.string().min(1).optional(),
    WHATSAPP_GRAPH_VERSION: z
      .string()
      .regex(/^v\d+\.\d+$/, 'Expected a Graph API version such as v23.0')
      .default('v23.0'),
    /** Per-shop send budget, shaped before a burst can trip Meta throttling. */
    WHATSAPP_SEND_BURST: intish(20, 1, 500),
    WHATSAPP_SEND_PER_SECOND: intish(10, 1, 200),

    /* --- Media pipeline (phase 2.4) --------------------------------------- */
    MEDIA_MAX_IMAGE_BYTES: intish(5 * 1024 * 1024, 1024),
    MEDIA_MAX_AUDIO_BYTES: intish(16 * 1024 * 1024, 1024),
    MEDIA_MAX_VIDEO_BYTES: intish(16 * 1024 * 1024, 1024),
    MEDIA_MAX_DOCUMENT_BYTES: intish(20 * 1024 * 1024, 1024),
    /** Longest edge kept after normalisation; OCR needs detail, storage does not. */
    MEDIA_MAX_DIMENSION_PX: intish(2200, 320, 8000),
    MEDIA_THUMBNAIL_PX: intish(320, 64, 1024),
    /** Optional ffmpeg binary; without it only PCM/WAV audio is transcodable. */
    FFMPEG_PATH: z.string().min(1).optional(),

    /* --- Speech (port in phase 2.7, real batch adapters in phase 4.1) ----- */
    SPEECH_DRIVER: SpeechDriverSchema.default('mock'),
    SARVAM_API_KEY: z.string().min(1).optional(),
    SARVAM_BASE_URL: z.string().url().default('https://api.sarvam.ai'),
    /** Model id, never hardcoded (§10). `saaras:v3` is the current default. */
    SARVAM_STT_MODEL: z.string().min(1).default('saaras:v3'),
    /**
     * Google Cloud Speech-to-Text v2, the configured fallback.
     *
     * A full recogniser resource name — `projects/<id>/locations/<loc>/
     * recognizers/<name>` — because v2 addresses a *recognizer*, not a project,
     * and the recogniser is where the model and language defaults live.
     */
    GOOGLE_SPEECH_RECOGNIZER: z.string().min(1).optional(),
    GOOGLE_SPEECH_BASE_URL: z.string().url().default('https://speech.googleapis.com'),
    GOOGLE_SPEECH_MODEL: z.string().min(1).default('latest_long'),
    /** Ordered: the first is primary, the rest are alternates it may switch to. */
    GOOGLE_SPEECH_LANGUAGES: z
      .string()
      .default('en-IN,ta-IN,hi-IN')
      .transform((value) =>
        value
          .split(',')
          .map((code) => code.trim())
          .filter((code) => code.length > 0),
      ),
    /**
     * A pre-minted OAuth access token.
     *
     * Deliberately not a service-account key file: minting tokens from a
     * private key is the deployment's job (workload identity on Cloud Run), and
     * a JSON key sitting in an env var is the credential most likely to end up
     * in a log. Absent, the Google adapter is simply not available.
     */
    GOOGLE_SPEECH_ACCESS_TOKEN: z.string().min(1).optional(),
    SPEECH_TIMEOUT_MS: intish(30_000, 1_000, 300_000),
    SPEECH_MAX_BYTES: intish(10 * 1024 * 1024, 1024),
    /** Consecutive provider failures before traffic moves to the fallback. */
    SPEECH_FAILOVER_THRESHOLD: intish(2, 1, 10),
    SPEECH_FAILOVER_PROBE_MS: intish(5 * 60_000, 10_000, 60 * 60_000),

    /* --- Payments (phase 4.9) -------------------------------------------- */
    PAYMENTS_DRIVER: PaymentsDriverSchema.default('mock'),
    RAZORPAY_KEY_ID: z.string().min(1).optional(),
    RAZORPAY_KEY_SECRET: z.string().min(1).optional(),
    /** Verifies X-Razorpay-Signature over the *raw* webhook body. */
    RAZORPAY_WEBHOOK_SECRET: z.string().min(1).optional(),
    RAZORPAY_BASE_URL: z.string().url().default('https://api.razorpay.com'),
    PAYMENTS_TIMEOUT_MS: intish(20_000, 1_000, 120_000),

    /* --- Gate pass (phase 4.10) ------------------------------------------ */
    /**
     * HMAC key for gate-pass tokens.
     *
     * Separate from `JWT_SECRET` on purpose: a gate pass is a bearer capability
     * that a customer forwards to whoever collects the car, and it must not be
     * signed with the key that mints staff sessions. Rotating one must not
     * invalidate the other.
     */
    GATE_PASS_SECRET: z.string().min(32).default(DEV_GATE_PASS_SECRET),


    /* --- Telephony & voice (phase 5) -------------------------------------- */
    /**
     * Which handset the `TelephonyPort` is wired to.
     *
     * `loopback` is the browser softphone in the console: the far end is a
     * developer's microphone and an on-screen keypad, and no telco account
     * exists anywhere. It is a complete adapter rather than a stub — the same
     * PCM frame interface, the same typed call events, the same recording
     * lifecycle — which is what lets the whole phase be built and demoed before
     * a single Exotel credential is issued.
     */
    TELEPHONY_DRIVER: TelephonyDriverSchema.default('loopback'),
    /** The number a customer sees. Also the caller id Exotel/Twilio dial from. */
    TELEPHONY_CALLER_ID: z.string().min(1).optional(),
    /** Where the provider posts call events. Public, signature-verified.  */
    TELEPHONY_WEBHOOK_BASE_URL: z.string().url().optional(),
    /**
     * Shared secret the provider signs its callbacks with.
     *
     * Separate from `JWT_SECRET` and `GATE_PASS_SECRET` for the same reason
     * those are separate from each other: three different parties hold three
     * different capabilities, and rotating one must not invalidate the others.
     */
    TELEPHONY_WEBHOOK_SECRET: z.string().min(16).optional(),
    TELEPHONY_TIMEOUT_MS: intish(15_000, 1_000, 120_000),

    /** Exotel (primary, India). `subdomain` differs per account region. */
    EXOTEL_ACCOUNT_SID: z.string().min(1).optional(),
    EXOTEL_API_KEY: z.string().min(1).optional(),
    EXOTEL_API_TOKEN: z.string().min(1).optional(),
    EXOTEL_SUBDOMAIN: z.string().min(1).default('api.exotel.com'),
    /**
     * The Exotel *app* (flow) id that hands the leg to our media stream.
     *
     * Exotel routes an outgoing call through an App Bazaar flow rather than
     * accepting inline instructions, so the flow is configuration: a shop that
     * re-publishes its flow gets a new id and no code changes.
     */
    EXOTEL_FLOW_APP_ID: z.string().min(1).optional(),

    /** Twilio, the documented alternative behind the same contract. */
    TWILIO_ACCOUNT_SID: z.string().min(1).optional(),
    TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
    TWILIO_BASE_URL: z.string().url().default('https://api.twilio.com'),

    /**
     * The instant off switch (phase 5.7).
     *
     * True reverts every `VOICE_OR_ADVISOR` rung to an advisor task and refuses
     * every origination, without a deploy. It is an env flag *and* a shop-config
     * flag: the env one is the platform's brake, the config one is the shop's,
     * and either alone is enough to stop a call.
     */
    VOICE_KILL_SWITCH: booleanish(false),
    /** Speech-end to speech-start. The phase's own number is 1.2 seconds. */
    VOICE_LATENCY_BUDGET_MS: intish(1_200, 200, 10_000),
    /** Silence after a final transcript that ends the caller's turn. */
    VOICE_ENDPOINT_SILENCE_MS: intish(700, 100, 5_000),
    /** Longest the line may be silent before a comfort filler is played. */
    VOICE_MAX_DEAD_AIR_MS: intish(3_000, 500, 15_000),
    /** Barge-in must cut synthesis within this. Asserted by the loopback tests. */
    VOICE_BARGE_IN_CUTOFF_MS: intish(300, 50, 2_000),
    /** Agent turns per call before the graceful exit fires. */
    VOICE_MAX_TURNS: intish(12, 2, 40),
    /** Wall clock for a whole call, including the greeting and the close. */
    VOICE_MAX_CALL_SECONDS: intish(240, 30, 1_800),
    /** How long after an unanswered call the single retry is scheduled. */
    VOICE_RETRY_AFTER_MINUTES: intish(20, 1, 24 * 60),
    /** Recording + transcript retention. Phase 7 wires the deletion cascade. */
    VOICE_RECORDING_RETENTION_DAYS: intish(180, 1, 3_650),

    /**
     * Per-second price estimates for the cost meter, in paise.
     *
     * Estimates, and named as such: the authoritative number arrives on the
     * provider's invoice weeks later, while the cap has to decide *now* whether
     * this shop may place another call. A meter that waited for the true figure
     * would be a meter that never stopped anything.
     */
    VOICE_TELCO_PAISE_PER_MINUTE: intish(60, 0, 100_000),
    VOICE_STT_PAISE_PER_MINUTE: intish(50, 0, 100_000),
    VOICE_TTS_PAISE_PER_MINUTE: intish(80, 0, 100_000),
    /** Platform-wide daily ceiling across every shop. Alert, then halt. */
    VOICE_PLATFORM_DAILY_CAP_PAISE: intish(500_000, 0, 1_000_000_000),
    /** Fraction of a cap at which the alert fires, before the halt. */
    VOICE_COST_ALERT_RATIO: z.coerce.number().min(0.1).max(1).default(0.8),

    /* --- Streaming speech (phase 5.2) ------------------------------------- */
    /**
     * The streaming half of `SpeechPort`.
     *
     * Defaults to `mock` and is forced there by DEMO_MODE, so CI transcribes a
     * whole call from fixtures with no credential and no network — which is what
     * makes the voice simulation suite a required check rather than a nightly
     * one.
     */
    SPEECH_STREAM_DRIVER: StreamingSpeechDriverSchema.default('mock'),
    /** Sarvam's realtime websocket base. Verified against current docs at wiring. */
    SARVAM_STREAM_URL: z.string().url().default('wss://api.sarvam.ai/speech-to-text/ws'),
    SARVAM_STREAM_STT_MODEL: z.string().min(1).default('saarika:v2.5'),
    SARVAM_TTS_MODEL: z.string().min(1).default('bulbul:v2'),
    /** Bulbul voice ids per language. Never hardcoded (§10). */
    SARVAM_TTS_VOICE_TA: z.string().min(1).default('anushka'),
    SARVAM_TTS_VOICE_HI: z.string().min(1).default('anushka'),
    SARVAM_TTS_VOICE_EN: z.string().min(1).default('anushka'),
    GOOGLE_STREAM_RECOGNIZER: z.string().min(1).optional(),
    /** Frame size on the wire. 20 ms is what every telco stack emits. */
    VOICE_FRAME_MS: intish(20, 10, 60),
    /**
     * How fast the browser softphone's modelled line plays queued audio.
     *
     * One — real time — is the default and the only honest setting for a demo
     * somebody is listening to: a ten-second greeting takes ten seconds. CI
     * turns it up so a whole call runs in under a second, which changes no
     * behaviour under test and only shortens the wait for audio the runtime has
     * already queued. The same seam as the fake clock the rest of this codebase
     * uses, and it applies to the loopback adapter alone — a telephone company
     * does not take instructions about how fast to play a sentence.
     */
    VOICE_LOOPBACK_PLAYBACK_SPEED: intish(1, 1, 100),

    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
    OTEL_SERVICE_NAME: z.string().min(1).optional(),

    /**
     * How often the worker looks for quiet-hours holds that have come due.
     *
     * Polling rather than a delayed job: a shop that changes its quiet hours,
     * or a customer who opts out overnight, must be honoured by a message that
     * was deferred hours earlier — which only works if the due set is re-read.
     */
    DEFERRED_SEND_POLL_MS: intish(30_000, 1_000, 600_000),
    DEFERRED_SEND_BATCH_SIZE: intish(50, 1, 500),

    /**
     * The phase-4 sentinels, polling for the same reason the quiet-hours drain
     * does: each depends on state that can change between scheduling and
     * firing, so the due set is re-read every pass.
     *
     * Five minutes for the silent bay — the window it dedupes on is measured in
     * hours, so a tighter scan buys nothing and a looser one delays a nudge
     * past the point it would have helped.
     */
    SILENT_BAY_SCAN_MS: intish(5 * 60_000, 10_000, 60 * 60_000),
    REMINDER_SCAN_MS: intish(60_000, 10_000, 60 * 60_000),

    /**
     * The phase-6 sentinels.
     *
     * Slower than phase 4's on purpose. Retention is measured in weeks: the
     * tightest thing any of these scans for is a re-pitch whose horizon passed
     * this morning, and scanning for that every minute would spend a database
     * pass a minute to move a message forward by seconds. Fifteen minutes for
     * the trigger engine and the feedback ask, two for the stuck-approval
     * stream because that one is an *exception* an owner is waiting on, and
     * five for the fold-and-brief pass, which is what decides how close to the
     * shop's configured digest time the brief actually lands.
     */
    RETENTION_SCAN_MS: intish(15 * 60_000, 10_000, 6 * 60 * 60_000),
    RETENTION_BATCH_SIZE: intish(50, 1, 500),
    FEEDBACK_SCAN_MS: intish(15 * 60_000, 10_000, 6 * 60 * 60_000),
    ALERT_SCAN_MS: intish(2 * 60_000, 10_000, 60 * 60_000),
    DIGEST_SCAN_MS: intish(5 * 60_000, 10_000, 60 * 60_000),

    WORKER_CONCURRENCY: intish(5, 1, 100),
    OUTBOX_BATCH_SIZE: intish(100, 1, 1000),
    OUTBOX_IDLE_BACKOFF_MS: intish(250, 10, 60_000),
    OUTBOX_MAX_ATTEMPTS: intish(5, 1, 25),
    QUEUE_MAX_ATTEMPTS: intish(5, 1, 25),

    DEFAULT_TIMEZONE: z.string().min(1).default('Asia/Kolkata'),

    /* ===================================================================
     * Phase 7 - production hardening.
     * =================================================================== */

    /**
     * Which deployment this process believes it is. Only `prod` turns on the
     * adapter allow-list check; `staging` is explicitly allowed to run a mixed
     * real/sandbox matrix, which is the whole point of having one.
     */
    DEPLOY_ENV: z.enum(['local', 'staging', 'prod']).default('local'),

    /**
     * The adapters production is permitted to boot with, as `port:Adapter`
     * pairs - `whatsapp:MetaCloudWhatsAppAdapter,llm:AnthropicLlmAdapter`.
     *
     * A belt to `NODE_ENV=production`'s braces, and it fails in the opposite
     * direction: the `superRefine` rules below say "not the sandbox", this says
     * "exactly this one". The difference matters the day somebody adds a third
     * WhatsApp adapter and a typo in a deploy script selects it.
     */
    ADAPTER_ALLOWLIST: csv(),

    /** Comma-separated origins the API answers CORS for. Defaults to the console. */
    CORS_ALLOWED_ORIGINS: csv(),
    /**
     * Trusted reverse-proxy hops. Cloud Run puts exactly one in front of us;
     * counting wrong means either trusting a client-supplied `X-Forwarded-For`
     * (so a rate limit is per-attacker-header rather than per-attacker) or
     * rate-limiting the load balancer as a single client.
     */
    TRUST_PROXY_HOPS: intish(1, 0, 10),

    RATE_LIMIT_ENABLED: booleanish(true),
    RATE_LIMIT_WINDOW_MS: intish(60_000, 1_000, 3_600_000),
    /** Per client address, per window, across every route. */
    RATE_LIMIT_GLOBAL_MAX: intish(600, 1, 1_000_000),
    /** The OTP endpoints. Deliberately tiny: this is where accounts are taken. */
    RATE_LIMIT_AUTH_MAX: intish(10, 1, 10_000),
    /**
     * Provider webhooks. Generous, because a Meta redelivery storm after an
     * outage is legitimate traffic and dropping it loses customer messages -
     * but not unbounded, because the endpoint is public.
     */
    RATE_LIMIT_WEBHOOK_MAX: intish(3_000, 1, 1_000_000),
    /** Per authenticated shop, per window. Stops one tenant starving the rest. */
    RATE_LIMIT_SHOP_MAX: intish(1_200, 1, 1_000_000),

    /**
     * Permits fetching loopback and private addresses. True only in the dev
     * stack, where MinIO genuinely is on `localhost`.
     */
    SSRF_ALLOW_PRIVATE: booleanish(false),

    ANTIVIRUS_DRIVER: AntivirusDriverSchema.default('none'),
    CLAMAV_HOST: z.string().min(1).default('localhost'),
    CLAMAV_PORT: intish(3310, 1, 65_535),
    CLAMAV_TIMEOUT_MS: intish(20_000, 1_000, 300_000),
    /**
     * What to do when the scanner itself is unreachable.
     *
     * `false` (fail-open) accepts the upload and flags it; `true` (fail-closed)
     * refuses it. The default is fail-open, and that is a considered choice
     * rather than laziness: this is a workshop's customer sending a photo of a
     * dashboard light, and a clamd restart that silently swallows the intake
     * photo costs a real job card. A shop handling documents flips it.
     */
    ANTIVIRUS_FAIL_CLOSED: booleanish(false),

    /* --- DPDP data-principal workflows (7.2) ---------------------------- */

    /** How long an export archive's signed link stays valid. */
    DPDP_EXPORT_TTL_HOURS: intish(72, 1, 720),
    /** Published on the privacy notice as the grievance officer. */
    DPDP_GRIEVANCE_NAME: z.string().min(1).default('The Owner'),
    DPDP_GRIEVANCE_EMAIL: z.string().email().default('privacy@example.com'),
    DPDP_GRIEVANCE_PHONE: z.string().min(1).default('+910000000000'),
    /**
     * Statutory retention for tax records, in years. GST law requires invoices
     * to survive a deletion request; the row survives *pseudonymised*, which is
     * the carve-out documented in `docs/privacy/retention.md`.
     */
    DPDP_INVOICE_RETENTION_YEARS: intish(8, 1, 30),
    PRIVACY_NOTICE_URL: z.string().url().default('http://localhost:3000/privacy'),
    /**
     * How often the worker looks for approved requests whose grace window has
     * elapsed. Two minutes rather than the fifteen the retention scan uses:
     * somebody is waiting on the other end of this one, and the pass is a
     * single indexed query that returns nothing on almost every tick.
     */
    DPDP_SCAN_MS: intish(2 * 60_000, 10_000, 60 * 60_000),
    /** Requests executed per pass. A cascade is expensive; a burst of them more so. */
    DPDP_BATCH_SIZE: intish(5, 1, 50),

    /* --- SMS / DLT fallback (7.3) --------------------------------------- */

    SMS_DRIVER: SmsDriverSchema.default('sandbox'),
    SMS_PROVIDER_BASE_URL: z.string().url().default('https://api.sms-provider.example'),
    /** DLT-registered sender id ("header"), assigned by the operator. */
    SMS_SENDER_ID: z.string().min(3).max(11).optional(),
    /** The principal entity id from the TRAI DLT registry. */
    SMS_DLT_ENTITY_ID: z.string().min(1).optional(),
    SMS_TIMEOUT_MS: intish(15_000, 1_000, 120_000),
    /**
     * May the OutboundGate drop to SMS when WhatsApp is unreachable?
     *
     * A kill switch rather than a preference: SMS costs money per message and
     * carries no buttons, so a shop that would rather wait for WhatsApp to come
     * back turns this off and the ladder falls through to an advisor task.
     */
    SMS_FALLBACK_ENABLED: booleanish(true),
    /** Consecutive WhatsApp send failures before the channel is called down. */
    CHANNEL_FAILOVER_THRESHOLD: intish(3, 1, 50),
    /** How long the channel stays marked down before it is probed again. */
    CHANNEL_FAILOVER_PROBE_MS: intish(60_000, 5_000, 60 * 60_000),

    /**
     * WhatsApp conversation pricing, in paise per 24-hour conversation, by
     * category. Configuration rather than code because Meta reprices by market
     * without asking, and a redeploy to correct a margin figure is a redeploy
     * nobody does.
     */
    WA_PRICING_JSON: z
      .string()
      .optional()
      .transform((raw, ctx) => {
        if (raw === undefined) return DEFAULT_WA_PRICING;
        try {
          return WaPricingSchema.parse(JSON.parse(raw));
        } catch (error) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `WA_PRICING_JSON is not a valid pricing table: ${String(error)}`,
          });
          return z.NEVER;
        }
      }),

    /* --- Observability (7.4) -------------------------------------------- */

    OTEL_ENABLED: booleanish(false),
    /** 0-1. Sampled at the root span, so a trace is whole or absent. */
    OTEL_TRACES_SAMPLER_RATIO: z.coerce.number().min(0).max(1).default(1),
    /**
     * Full message bodies in the logs, until this instant.
     *
     * A timestamp rather than a boolean, and that is the entire design: a debug
     * flag somebody flips at 02:00 to chase a bug is a flag that is still on
     * three months later, quietly writing customers' messages to a log sink.
     * This one expires whether or not anybody remembers it.
     */
    LOG_FULL_BODIES_UNTIL: z.coerce.date().optional(),
    /** Fraction of eligible records logged in full while the window is open. */
    LOG_FULL_BODY_SAMPLE_RATIO: z.coerce.number().min(0).max(1).default(0.05),

    /* --- Backups (7.5) --------------------------------------------------- */

    BACKUP_BUCKET: z.string().min(1).optional(),
    BACKUP_PREFIX: z.string().min(1).default('serviceloop/pg'),
    /** Nightly dumps older than this are pruned by the backup script. */
    BACKUP_RETENTION_DAYS: intish(30, 1, 3_650),
  })
  .superRefine((value, ctx) => {
    // Selecting the live WhatsApp adapter without its credentials is a boot
    // failure in every environment: a half-configured channel that accepts
    // sends and drops them is worse than no channel at all.
    if (value.WHATSAPP_DRIVER === 'meta') {
      const required = [
        'WHATSAPP_ACCESS_TOKEN',
        'WHATSAPP_PHONE_NUMBER_ID',
        'WHATSAPP_APP_SECRET',
        'WHATSAPP_VERIFY_TOKEN',
      ] as const;
      for (const key of required) {
        if (value[key] === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required when WHATSAPP_DRIVER=meta`,
          });
        }
      }
    }

    // A live speech driver with no credential accepts voice notes and silently
    // loses every one of them — the same half-configured-channel failure the
    // WhatsApp check above exists to prevent, in every environment.
    if (value.SPEECH_DRIVER === 'sarvam' && value.SARVAM_API_KEY === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SARVAM_API_KEY'],
        message: 'SARVAM_API_KEY is required when SPEECH_DRIVER=sarvam',
      });
    }
    if (value.SPEECH_DRIVER === 'google') {
      for (const key of ['GOOGLE_SPEECH_RECOGNIZER', 'GOOGLE_SPEECH_ACCESS_TOKEN'] as const) {
        if (value[key] === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required when SPEECH_DRIVER=google`,
          });
        }
      }
    }
    if (value.PAYMENTS_DRIVER === 'razorpay') {
      for (const key of [
        'RAZORPAY_KEY_ID',
        'RAZORPAY_KEY_SECRET',
        'RAZORPAY_WEBHOOK_SECRET',
      ] as const) {
        if (value[key] === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required when PAYMENTS_DRIVER=razorpay`,
          });
        }
      }
    }

    // A live telephony driver with no credentials would accept an origination
    // and drop it — a customer whose ladder believes it called them and never
    // did, which is worse than a rung that honestly raised an advisor task.
    if (value.TELEPHONY_DRIVER === 'exotel') {
      for (const key of [
        'EXOTEL_ACCOUNT_SID',
        'EXOTEL_API_KEY',
        'EXOTEL_API_TOKEN',
        'EXOTEL_FLOW_APP_ID',
        'TELEPHONY_CALLER_ID',
      ] as const) {
        if (value[key] === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required when TELEPHONY_DRIVER=exotel`,
          });
        }
      }
    }
    if (value.TELEPHONY_DRIVER === 'twilio') {
      for (const key of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TELEPHONY_CALLER_ID'] as const) {
        if (value[key] === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required when TELEPHONY_DRIVER=twilio`,
          });
        }
      }
    }
    // A provider callback is authenticated by its signature and nothing else,
    // so a live driver without the secret has an unauthenticated webhook.
    if (value.TELEPHONY_DRIVER !== 'loopback' && value.TELEPHONY_WEBHOOK_SECRET === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TELEPHONY_WEBHOOK_SECRET'],
        message: 'TELEPHONY_WEBHOOK_SECRET is required when a live telephony driver is selected',
      });
    }
    if (value.SPEECH_STREAM_DRIVER === 'sarvam' && value.SARVAM_API_KEY === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SARVAM_API_KEY'],
        message: 'SARVAM_API_KEY is required when SPEECH_STREAM_DRIVER=sarvam',
      });
    }
    if (value.SPEECH_STREAM_DRIVER === 'google' && value.GOOGLE_STREAM_RECOGNIZER === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['GOOGLE_STREAM_RECOGNIZER'],
        message: 'GOOGLE_STREAM_RECOGNIZER is required when SPEECH_STREAM_DRIVER=google',
      });
    }

    // A DLT adapter with no entity id or header is a fallback rung that would
    // be rejected by the operator on its first message - which is precisely the
    // moment WhatsApp is already down, so the failure would be invisible until
    // it mattered most.
    if (value.SMS_DRIVER === 'dlt') {
      for (const key of ['SMS_SENDER_ID', 'SMS_DLT_ENTITY_ID', 'SMS_PROVIDER_API_KEY'] as const) {
        if (value[key] === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required when SMS_DRIVER=dlt`,
          });
        }
      }
    }

    // The active key must itself be in the ring under its own id, or a value
    // written this minute would be unreadable by the very next process to boot.
    const ring = value.PII_KEY_RING;
    const ringed = ring[value.PII_KEY_ID];
    if (ringed !== undefined && ringed !== value.PII_ENCRYPTION_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PII_KEY_RING'],
        message: `PII_KEY_RING["${value.PII_KEY_ID}"] disagrees with PII_ENCRYPTION_KEY; the active key id must name the active key`,
      });
    }

    if (value.NODE_ENV !== 'production') return;

    if (value.DEMO_MODE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DEMO_MODE'],
        message: 'DEMO_MODE must be false in production',
      });
    }
    if (value.JWT_SECRET === DEV_JWT_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_SECRET'],
        message: 'JWT_SECRET still holds the development placeholder',
      });
    }
    if (value.PII_ENCRYPTION_KEY === DEV_PII_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PII_ENCRYPTION_KEY'],
        message: 'PII_ENCRYPTION_KEY still holds the development placeholder',
      });
    }
    if (value.BLIND_INDEX_KEY === DEV_BLIND_INDEX_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BLIND_INDEX_KEY'],
        message: 'BLIND_INDEX_KEY still holds the development placeholder',
      });
    }
    if (value.GATE_PASS_SECRET === DEV_GATE_PASS_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['GATE_PASS_SECRET'],
        message: 'GATE_PASS_SECRET still holds the development placeholder',
      });
    }
    if (value.TELEPHONY_DRIVER === 'loopback') {
      // The loopback adapter's far end is a browser tab. In production that is
      // a shop whose voice rungs ring a page nobody has open.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TELEPHONY_DRIVER'],
        message:
          'TELEPHONY_DRIVER must be "exotel" or "twilio" in production: the loopback adapter rings a browser tab, not a customer',
      });
    }
    if (value.PAYMENTS_DRIVER === 'mock') {
      // A mock payment link collects no money and settles every card it
      // touches. In production that is a vehicle released against a payment
      // that never happened.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PAYMENTS_DRIVER'],
        message:
          'PAYMENTS_DRIVER must be "razorpay" in production: the mock adapter settles cards without collecting anything',
      });
    }
    if (value.STORAGE_DRIVER === 'gcs' && value.GCS_BUCKET === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['GCS_BUCKET'],
        message: 'GCS_BUCKET is required when STORAGE_DRIVER=gcs',
      });
    }
    if (value.NOTIFIER_DRIVER === 'sms' && value.SMS_PROVIDER_API_KEY === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SMS_PROVIDER_API_KEY'],
        message: 'SMS_PROVIDER_API_KEY is required when NOTIFIER_DRIVER=sms',
      });
    }
    if (value.WHATSAPP_DRIVER === 'sandbox') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['WHATSAPP_DRIVER'],
        message: 'WHATSAPP_DRIVER must be "meta" in production: the sandbox never reaches a customer',
      });
    }
    if (value.LLM_DRIVER === 'anthropic' && value.ANTHROPIC_API_KEY === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ANTHROPIC_API_KEY'],
        message: 'ANTHROPIC_API_KEY is required when LLM_DRIVER=anthropic',
      });
    }
    if (value.NOTIFIER_DRIVER !== 'sms') {
      // The sandbox notifiers print OTP codes so a developer can sign in.
      // Allowing them in production would write live credentials to the logs.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['NOTIFIER_DRIVER'],
        message:
          'NOTIFIER_DRIVER must be "sms" in production: the sandbox notifiers print OTP codes',
      });
    }

    /* --- phase 7 production floors ------------------------------------- */

    if (value.DEPLOY_ENV !== 'prod') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DEPLOY_ENV'],
        message:
          'DEPLOY_ENV must be "prod" when NODE_ENV=production: the adapter allow-list and the alert routing key off it',
      });
    }
    if (value.ADAPTER_ALLOWLIST.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ADAPTER_ALLOWLIST'],
        message:
          'ADAPTER_ALLOWLIST is required in production: every live adapter must be named explicitly, so a deploy cannot select one by accident',
      });
    }
    if (value.SSRF_ALLOW_PRIVATE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SSRF_ALLOW_PRIVATE'],
        message:
          'SSRF_ALLOW_PRIVATE must be false in production: it is the dev-stack escape hatch for MinIO on localhost',
      });
    }
    if (!value.RATE_LIMIT_ENABLED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RATE_LIMIT_ENABLED'],
        message: 'RATE_LIMIT_ENABLED must be true in production',
      });
    }
    if (value.LOG_FULL_BODIES_UNTIL !== undefined && value.LOG_LEVEL === 'trace') {
      // Either alone is defensible. Together they are every message body in the
      // log sink with no sampling in front of them.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['LOG_FULL_BODIES_UNTIL'],
        message:
          'LOG_FULL_BODIES_UNTIL cannot be combined with LOG_LEVEL=trace in production: pick the sampled window or the verbose level, not both',
      });
    }
    if (value.CORS_ALLOWED_ORIGINS.some((origin) => origin === '*')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ALLOWED_ORIGINS'],
        message: 'CORS_ALLOWED_ORIGINS cannot contain "*": the API answers with credentials',
      });
    }
  });

export type Env = Readonly<z.infer<typeof EnvSchema>>;

export class EnvValidationError extends ConfigurationError {
  constructor(issues: z.ZodIssue[]) {
    const lines = issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `  • ${path}: ${issue.message}`;
    });
    super(
      [
        'Invalid environment configuration — refusing to boot.',
        ...lines,
        'See .env.example for the full documented variable list.',
      ].join('\n'),
      { issues: issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) },
    );
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** Pure parse — used by tests and by `getEnv()`. Never memoised. */
export function loadEnv(source: NodeJS.ProcessEnv | Record<string, unknown> = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) throw new EnvValidationError(result.error.issues);
  return deepFreeze(result.data);
}

let cached: Env | null = null;

/**
 * Memoised process-wide environment. Call once at boot; safe to call again.
 * The repo-root `.env` is folded in first, without overriding anything the
 * process was actually started with.
 */
export function getEnv(): Env {
  if (cached === null) {
    loadDotEnvOnce();
    cached = loadEnv();
  }
  return cached;
}

/** Test-only seam so a suite can exercise alternative configurations. */
export function resetEnvCache(): void {
  cached = null;
}

export function isDemoMode(env: Env = getEnv()): boolean {
  return env.DEMO_MODE;
}
