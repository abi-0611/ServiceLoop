/**
 * Log redaction policy (master §2 — pino PII-redacting serializers;
 * phase 7.4 — "default logs PII-free", with a sampled full-body window).
 *
 * Defined here, in a dependency-free module, so the API, the workers and any
 * later service redact identically. Customer names, phone numbers, message
 * bodies and credentials never reach a log sink in the clear.
 *
 * The debugging problem this creates is real and is solved deliberately rather
 * than by exception: when a conversation goes wrong, the thing an engineer
 * needs is the message body, and a policy with no escape hatch gets worked
 * around with a `console.log` that nobody redacts. So there is a hatch — and it
 * closes by itself. See `fullBodyWindowOpen`.
 */

export const REDACTED = '[redacted]';

/** pino `redact.paths`. Wildcards match one level; `*.x` matches any parent. */
export const PII_REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-hub-signature-256"]',
  'req.headers["x-razorpay-signature"]',
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
  /* Phase 7: everything added since the policy was written. A redaction list
   * that stops being updated is worse than none, because it is believed. */
  '*.to',
  '*.toMasked',
  '*.transcript',
  '*.utterance',
  '*.registration',
  '*.email',
  '*.address',
  '*.comment',
  '*.senderId',
  '*.dltTemplateId',
  'PII_ENCRYPTION_KEY',
  'PII_KEY_RING',
  'BLIND_INDEX_KEY',
  'JWT_SECRET',
  'GATE_PASS_SECRET',
  'DATABASE_URL',
  'REDIS_URL',
  'ANTHROPIC_API_KEY',
  'SARVAM_API_KEY',
  'SMS_PROVIDER_API_KEY',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_VERIFY_TOKEN',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
  'TELEPHONY_WEBHOOK_SECRET',
  'EXOTEL_API_TOKEN',
  'TWILIO_AUTH_TOKEN',
  'S3_SECRET_ACCESS_KEY',
  'GOOGLE_SPEECH_ACCESS_TOKEN',
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

/**
 * Keys whose *values* are never safe to log.
 *
 * Anchored where the word is generic. `^to$` earns its place: in this codebase
 * a bare `to` is always a destination address — an E.164 number on an SMS or a
 * WhatsApp send — and it is the key that leaked a phone number past the first
 * version of this list. Leaving it out because "to could mean anything" is how
 * a redaction policy becomes decorative.
 */
const SENSITIVE_KEY_RE =
  /(password|secret|token|otp|^code$|phone|full_?name|customer_?name|authorization|cookie|api_?key|transcript|utterance|registration|^body$|^email$|^comment$|^to$|^to_?masked$|^recipient$|^msisdn$|^address$)/i;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key);
}

/* -------------------------------------------------------------------------- *
 * The full-body debug window (phase 7.4)
 * -------------------------------------------------------------------------- */

export interface FullBodyWindow {
  /** `LOG_FULL_BODIES_UNTIL`. Absent means the window is shut. */
  readonly until?: Date | undefined;
  /** `LOG_FULL_BODY_SAMPLE_RATIO`, 0–1. */
  readonly sampleRatio: number;
}

/**
 * Is the sampled full-body window open right now?
 *
 * A *timestamp*, not a boolean, and that is the whole design. A debug flag
 * somebody flips at 02:00 to chase a customer's missing message is a flag that
 * is still on three months later, quietly writing every customer's messages to
 * a log sink that a shop's staff, a cloud provider and anyone with read access
 * to the project can see. This one expires whether or not anybody remembers it.
 *
 * Evaluated per call rather than captured at boot, so shutting the window early
 * is a config change and not a redeploy.
 */
export function fullBodyWindowOpen(window: FullBodyWindow, now: Date = new Date()): boolean {
  return window.until !== undefined && window.until.getTime() > now.getTime();
}

/**
 * Should *this* record carry its body in full?
 *
 * Sampled rather than all-or-nothing, because the reason to open the window is
 * "show me what these messages look like", and a one-in-twenty sample answers
 * that while keeping nineteen customers out of the log. The sampling decision
 * is deterministic in `key` — a conversation id — so a sampled conversation is
 * sampled for its whole length: half a conversation is not a debugging aid.
 */
export function shouldLogFullBody(
  window: FullBodyWindow,
  key: string,
  now: Date = new Date(),
): boolean {
  if (!fullBodyWindowOpen(window, now)) return false;
  if (window.sampleRatio >= 1) return true;
  if (window.sampleRatio <= 0) return false;
  return hashUnitInterval(key) < window.sampleRatio;
}

/** FNV-1a folded to [0, 1). Not cryptographic; it only has to spread evenly. */
function hashUnitInterval(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash / 0x1_0000_0000;
}

/**
 * A message body as it may appear in a log.
 *
 * Not `[redacted]` in the default case, deliberately: a length and a first word
 * are enough to tell "the template rendered empty" from "the template rendered
 * something", which is most of what an engineer needs, and neither identifies
 * anybody. `previewChars` is 0 by default because even a first word can carry a
 * name in a language whose greeting puts it first.
 */
export function describeBody(
  body: string,
  options: { readonly full?: boolean; readonly previewChars?: number } = {},
): string {
  if (options.full === true) return body;
  const preview = options.previewChars ?? 0;
  const head = preview > 0 ? `${body.slice(0, preview)}…` : '';
  return `${REDACTED}(${body.length} chars)${head === '' ? '' : ` ${head}`}`;
}
