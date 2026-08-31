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

    WORKER_CONCURRENCY: intish(5, 1, 100),
    OUTBOX_BATCH_SIZE: intish(100, 1, 1000),
    OUTBOX_IDLE_BACKOFF_MS: intish(250, 10, 60_000),
    OUTBOX_MAX_ATTEMPTS: intish(5, 1, 25),
    QUEUE_MAX_ATTEMPTS: intish(5, 1, 25),

    DEFAULT_TIMEZONE: z.string().min(1).default('Asia/Kolkata'),
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
