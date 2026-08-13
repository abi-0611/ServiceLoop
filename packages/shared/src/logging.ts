/**
 * Log redaction policy (master §2 — pino PII-redacting serializers).
 *
 * Defined here, in a dependency-free module, so the API, the workers and any
 * later service redact identically. Customer names, phone numbers, message
 * bodies and credentials never reach a log sink in the clear.
 */

export const REDACTED = '[redacted]';

/** pino `redact.paths`. Wildcards match one level; `*.x` matches any parent. */
export const PII_REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'password',
  'code',
  'otp',
  'token',
  'accessToken',
  'refreshToken',
  '*.password',
  '*.otp',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.phone',
  '*.phoneEncrypted',
  '*.fullName',
  '*.fullNameEncrypted',
  '*.customerName',
  '*.body',
  'customer.phone',
  'customer.fullName',
  'payload.body',
  'payload.customerPhone',
  'PII_ENCRYPTION_KEY',
  'BLIND_INDEX_KEY',
  'JWT_SECRET',
  'DATABASE_URL',
  'ANTHROPIC_API_KEY',
  'SMS_PROVIDER_API_KEY',
  'S3_SECRET_ACCESS_KEY',
];

/**
 * Structural redaction for values that are logged as free-form objects (queue
 * payloads, tool arguments) where pino's static paths cannot reach.
 */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 8) return REDACTED;
  if (Array.isArray(value)) return value.map((entry) => redactDeep(entry, depth + 1));
  if (value === null || typeof value !== 'object') return value;

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isSensitiveKey(key) ? REDACTED : redactDeep(entry, depth + 1);
  }
  return output;
}

const SENSITIVE_KEY_RE =
  /(password|secret|token|otp|^code$|phone|full_?name|customer_?name|authorization|cookie|api_?key)/i;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key);
}
