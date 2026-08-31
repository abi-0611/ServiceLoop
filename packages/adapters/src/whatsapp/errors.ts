/**
 * WhatsApp error taxonomy.
 *
 * Callers act on the *kind*, never on a provider number: a closed window means
 * "send a template instead", a rate limit means "back off and retry", an
 * invalid recipient means "stop and tell a human". Mapping happens once, here,
 * and both adapters produce the same kinds.
 */

export type WhatsAppErrorKind =
  /** Throttled by the provider. Retry after `retryAfterMs`. */
  | 'RATE_LIMITED'
  /** The 24-hour customer-service window has closed; only templates may go. */
  | 'WINDOW_CLOSED'
  /** Not a WhatsApp user, blocked us, or an unreachable number. Do not retry. */
  | 'INVALID_RECIPIENT'
  /** Template missing, unapproved, paused, or parameter count mismatch. */
  | 'TEMPLATE_INVALID'
  /** Token expired or lacks permission. Operator action required. */
  | 'AUTH_FAILED'
  /** We built a bad request. A bug on our side; never retried blindly. */
  | 'INVALID_REQUEST'
  /** Media upload/download failed, or the asset is too large/unsupported. */
  | 'MEDIA_ERROR'
  /** Provider outage or a transport failure. Retryable. */
  | 'PROVIDER_UNAVAILABLE'
  /** `X-Hub-Signature-256` missing or wrong. The payload is discarded. */
  | 'SIGNATURE_INVALID'
  /** Signature was fine but the body is not a webhook we recognise. */
  | 'MALFORMED_PAYLOAD'
  /** Unmapped provider code. Treated as non-retryable and surfaced loudly. */
  | 'UNKNOWN';

export interface WhatsAppErrorDetails {
  readonly providerCode?: number;
  readonly providerSubcode?: number;
  readonly providerTitle?: string;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
  readonly context?: Readonly<Record<string, unknown>>;
}

export class WhatsAppError extends Error {
  readonly kind: WhatsAppErrorKind;
  readonly retryable: boolean;
  readonly details: WhatsAppErrorDetails;

  constructor(kind: WhatsAppErrorKind, message: string, details: WhatsAppErrorDetails = {}) {
    super(message);
    this.name = 'WhatsAppError';
    this.kind = kind;
    this.retryable = RETRYABLE_KINDS.has(kind);
    this.details = details;
  }

  /** Backoff hint for the send queue; falls back to the caller's own policy. */
  get retryAfterMs(): number | null {
    return this.details.retryAfterMs ?? null;
  }
}

const RETRYABLE_KINDS: ReadonlySet<WhatsAppErrorKind> = new Set<WhatsAppErrorKind>([
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
]);

/**
 * Meta Cloud API error codes we handle explicitly.
 *
 * This table is the tested contract (`whatsapp.test.ts` asserts every row).
 * Codes outside it map to `UNKNOWN`, which is deliberately *not* retryable:
 * silently retrying an error we do not understand is how a workshop ends up
 * messaging a customer eleven times.
 */
export const META_ERROR_KIND_BY_CODE: Readonly<Record<number, WhatsAppErrorKind>> = {
  0: 'AUTH_FAILED', // AuthException
  3: 'AUTH_FAILED', // API method — permission missing
  10: 'AUTH_FAILED', // permission denied
  100: 'INVALID_REQUEST', // invalid parameter
  190: 'AUTH_FAILED', // access token expired/invalid
  368: 'INVALID_RECIPIENT', // temporarily blocked for policy violations
  130429: 'RATE_LIMITED', // Cloud API message throughput reached
  130472: 'INVALID_RECIPIENT', // user's number is part of an experiment
  131000: 'PROVIDER_UNAVAILABLE', // something went wrong (generic)
  131005: 'AUTH_FAILED', // access denied
  131008: 'INVALID_REQUEST', // required parameter missing
  131009: 'INVALID_REQUEST', // parameter value invalid
  131016: 'PROVIDER_UNAVAILABLE', // service unavailable
  131021: 'INVALID_RECIPIENT', // recipient cannot be the sender
  131026: 'INVALID_RECIPIENT', // message undeliverable
  131031: 'AUTH_FAILED', // account locked
  131042: 'AUTH_FAILED', // business eligibility payment issue
  131045: 'AUTH_FAILED', // incorrect certificate
  131047: 'WINDOW_CLOSED', // re-engagement message — 24h window has closed
  131048: 'RATE_LIMITED', // spam rate limit hit
  131049: 'RATE_LIMITED', // healthy-ecosystem per-user marketing limit
  131051: 'INVALID_REQUEST', // unsupported message type
  131052: 'MEDIA_ERROR', // media download error
  131053: 'MEDIA_ERROR', // media upload error
  131056: 'RATE_LIMITED', // (business, recipient) pair rate limit
  131057: 'AUTH_FAILED', // account in maintenance mode
  132000: 'TEMPLATE_INVALID', // parameter count mismatch
  132001: 'TEMPLATE_INVALID', // template does not exist
  132005: 'TEMPLATE_INVALID', // hydrated text too long
  132007: 'TEMPLATE_INVALID', // template format character policy violated
  132012: 'TEMPLATE_INVALID', // template parameter format mismatch
  132015: 'TEMPLATE_INVALID', // template is paused
  132016: 'TEMPLATE_INVALID', // template is disabled
  132068: 'TEMPLATE_INVALID', // flow is blocked
  133010: 'AUTH_FAILED', // phone number not registered
  135000: 'INVALID_REQUEST', // generic user error
};

/** HTTP status → kind, used when the body carries no usable Meta code. */
export function kindForHttpStatus(status: number): WhatsAppErrorKind {
  if (status === 401 || status === 403) return 'AUTH_FAILED';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 400 || status === 404) return 'INVALID_REQUEST';
  if (status >= 500) return 'PROVIDER_UNAVAILABLE';
  return 'UNKNOWN';
}

export interface MetaErrorBody {
  readonly code?: number;
  readonly error_subcode?: number;
  readonly message?: string;
  readonly title?: string;
  readonly error_data?: { readonly details?: string };
}

/** Builds a typed error from a Meta error body plus the HTTP status. */
export function mapMetaError(
  httpStatus: number,
  body: MetaErrorBody | undefined,
  fallbackMessage: string,
): WhatsAppError {
  const code = body?.code;
  // A code we do not recognise stays UNKNOWN rather than being folded into the
  // HTTP status: "Meta said something new" and "we built a bad request" call
  // for different responses from an operator. The status is only a fallback
  // when there is no code at all (gateway errors, HTML error pages).
  const kind =
    code === undefined
      ? kindForHttpStatus(httpStatus)
      : (META_ERROR_KIND_BY_CODE[code] ?? 'UNKNOWN');

  const detail = body?.error_data?.details ?? body?.message ?? fallbackMessage;
  const message =
    code === undefined
      ? `WhatsApp request failed with HTTP ${httpStatus}: ${detail}`
      : `WhatsApp error ${code}${body?.title === undefined ? '' : ` (${body.title})`}: ${detail}`;

  return new WhatsAppError(kind, message, {
    ...(code === undefined ? {} : { providerCode: code }),
    ...(body?.error_subcode === undefined ? {} : { providerSubcode: body.error_subcode }),
    ...(body?.title === undefined ? {} : { providerTitle: body.title }),
    httpStatus,
    // Meta does not send Retry-After; 60s is its documented throughput window.
    ...(kind === 'RATE_LIMITED' ? { retryAfterMs: 60_000 } : {}),
  });
}
