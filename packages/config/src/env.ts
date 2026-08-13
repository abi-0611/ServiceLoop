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

export const StorageDriverSchema = z.enum(['memory', 's3', 'gcs']);
export type StorageDriver = z.infer<typeof StorageDriverSchema>;

export const NotifierDriverSchema = z.enum(['log', 'memory', 'sms']);
export type NotifierDriver = z.infer<typeof NotifierDriverSchema>;

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

    /** Model ids are configuration, never hardcoded (master §10). */
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    LLM_AGENT_MODEL: z.string().min(1).default('claude-sonnet-5'),
    LLM_CLASSIFIER_MODEL: z.string().min(1).default('claude-haiku-4-5-20251001'),
    LLM_VISION_MODEL: z.string().min(1).default('claude-sonnet-5'),

    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
    OTEL_SERVICE_NAME: z.string().min(1).optional(),

    WORKER_CONCURRENCY: intish(5, 1, 100),
    OUTBOX_BATCH_SIZE: intish(100, 1, 1000),
    OUTBOX_IDLE_BACKOFF_MS: intish(250, 10, 60_000),
    OUTBOX_MAX_ATTEMPTS: intish(5, 1, 25),
    QUEUE_MAX_ATTEMPTS: intish(5, 1, 25),

    DEFAULT_TIMEZONE: z.string().min(1).default('Asia/Kolkata'),
  })
  .superRefine((value, ctx) => {
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
