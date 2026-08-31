import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  PaymentsError,
  toPaymentMethod,
  type CreatePaymentLinkInput,
  type PaymentEvent,
  type PaymentLink,
  type PaymentsPort,
  type WebhookVerdict,
} from './port';

/**
 * `RazorpayPaymentsAdapter` — Payment Links plus signed webhooks (phase 4.9).
 *
 * API surface confirmed against the current Razorpay docs:
 *   POST https://api.razorpay.com/v1/payment_links   (HTTP Basic: key:secret)
 *     amount (smallest unit), currency, description, reference_id,
 *     accept_partial, first_min_partial_amount, expire_by (unix seconds),
 *     customer{name,contact}, notify{sms,email}, notes, upi_link
 *   → { id: "plink_…", short_url, status, amount_paid, … }
 *
 *   Webhooks carry `X-Razorpay-Signature`: HMAC-SHA256 of the **raw** request
 *   body keyed with the webhook secret. Events: payment_link.paid,
 *   payment_link.partially_paid, payment_link.expired, payment_link.cancelled.
 *
 * The one thing worth stating loudly: the signature is computed over the raw
 * bytes, before any parse. Razorpay's own docs say not to re-serialise the
 * body, and they are right — `JSON.parse` followed by `JSON.stringify` reorders
 * keys and drops whitespace, and the resulting HMAC will not match. That is the
 * failure mode where signature verification appears to work in testing and
 * silently rejects every real delivery.
 */

export interface RazorpayConfig {
  readonly keyId: string;
  readonly keySecret: string;
  readonly webhookSecret: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
}

export interface RazorpayAdapterOptions {
  readonly fetch?: typeof globalThis.fetch;
}

/** Event names this adapter consumes. Anything else is deliberately ignored. */
const EVENT_KINDS = {
  'payment_link.paid': 'PAID',
  'payment_link.partially_paid': 'PARTIALLY_PAID',
  'payment_link.expired': 'EXPIRED',
  'payment_link.cancelled': 'CANCELLED',
} as const;

export class RazorpayPaymentsAdapter implements PaymentsPort {
  readonly provider = 'razorpay' as const;
  readonly driver = 'razorpay' as const;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(
    private readonly config: RazorpayConfig,
    options: RazorpayAdapterOptions = {},
  ) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  async createPaymentLink(input: CreatePaymentLinkInput): Promise<PaymentLink> {
    const body: Record<string, unknown> = {
      // Razorpay's `amount` is in the smallest currency unit, which for INR is
      // paise — the same unit this system stores, so there is no conversion and
      // therefore no place for a factor-of-100 bug to hide.
      amount: input.amountPaise,
      currency: 'INR',
      description: input.description.slice(0, 2048),
      reference_id: input.referenceId.slice(0, 40),
      accept_partial: input.acceptPartial,
      // Razorpay wants the link opened as a UPI intent where it can, which is
      // what an Indian customer expects to see.
      upi_link: false,
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: { shopId: input.shopId, jobCardId: input.jobCardId, traceId: input.traceId },
    };

    if (input.acceptPartial && input.minimumFirstAmountPaise !== null) {
      body['first_min_partial_amount'] = input.minimumFirstAmountPaise;
    }
    if (input.expiresAt !== null) {
      body['expire_by'] = Math.floor(input.expiresAt.getTime() / 1000);
    }
    if (input.customerName !== null || input.customerPhone !== null) {
      body['customer'] = {
        ...(input.customerName === null ? {} : { name: input.customerName }),
        ...(input.customerPhone === null ? {} : { contact: input.customerPhone }),
      };
    }

    // Notifications are ours, not Razorpay's. The shop's message about money
    // has to pass the consent gate, quiet hours and the frequency caps like
    // every other outbound — a provider SMS would bypass all four.
    const payload = await this.post('/v1/payment_links', body, input.traceId);

    const id = typeof payload['id'] === 'string' ? payload['id'] : null;
    const shortUrl = typeof payload['short_url'] === 'string' ? payload['short_url'] : null;
    if (id === null || shortUrl === null) {
      throw new PaymentsError('UNKNOWN', 'Razorpay returned a payment link with no id or short_url', {
        payload,
      });
    }

    const expireBy = payload['expire_by'];
    return {
      providerPaymentLinkId: id,
      shortUrl,
      expiresAt: typeof expireBy === 'number' ? new Date(expireBy * 1000) : (input.expiresAt ?? null),
    };
  }

  parseWebhook(input: {
    readonly rawBody: Buffer;
    readonly headers: Readonly<Record<string, string | undefined>>;
  }): WebhookVerdict {
    const presented = header(input.headers, 'x-razorpay-signature');
    if (presented === null) {
      return { ok: false, code: 'BAD_SIGNATURE', reason: 'X-Razorpay-Signature is missing' };
    }

    const expected = createHmac('sha256', this.config.webhookSecret)
      .update(input.rawBody)
      .digest('hex');

    if (!constantTimeEquals(presented, expected)) {
      return {
        ok: false,
        code: 'BAD_SIGNATURE',
        reason: 'The webhook signature does not match the configured secret',
      };
    }

    let envelope: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(input.rawBody.toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { ok: false, code: 'MALFORMED', reason: 'The webhook body is not a JSON object' };
      }
      envelope = parsed as Record<string, unknown>;
    } catch {
      return { ok: false, code: 'MALFORMED', reason: 'The webhook body is not JSON' };
    }

    const eventName = typeof envelope['event'] === 'string' ? envelope['event'] : '';
    const kind = EVENT_KINDS[eventName as keyof typeof EVENT_KINDS];
    if (kind === undefined) {
      return { ok: false, code: 'IGNORED', reason: `${eventName || 'an unnamed event'} is not consumed` };
    }

    const payload = asObject(envelope['payload']);
    const link = asObject(asObject(payload['payment_link'])['entity']);
    const payment = asObject(asObject(payload['payment'])['entity']);

    const linkId = typeof link['id'] === 'string' ? link['id'] : null;
    if (linkId === null) {
      return {
        ok: false,
        code: 'MALFORMED',
        reason: 'The webhook carries no payment_link entity to reconcile against',
      };
    }

    const createdAt = typeof envelope['created_at'] === 'number' ? envelope['created_at'] : null;

    /**
     * The credited amount.
     *
     * `payment.entity.amount` when a payment is attached — that is the money
     * that actually moved in *this* event. `payment_link.amount_paid` is a
     * running total, and using it would double-count on the second instalment
     * of a partial payment.
     */
    const amountPaise =
      typeof payment['amount'] === 'number'
        ? payment['amount']
        : kind === 'PAID' && typeof link['amount'] === 'number'
          ? link['amount']
          : 0;

    const event: PaymentEvent = {
      // Razorpay has no per-delivery event id, so one is derived from the
      // (event, link, payment) triple. That is exactly the identity a retry
      // repeats and a genuinely new instalment does not.
      providerEventId: `${eventName}:${linkId}:${
        typeof payment['id'] === 'string' ? payment['id'] : 'none'
      }`,
      providerPaymentLinkId: linkId,
      providerPaymentId: typeof payment['id'] === 'string' ? payment['id'] : null,
      kind,
      amountPaise,
      method: toPaymentMethod(typeof payment['method'] === 'string' ? payment['method'] : null),
      instrument:
        typeof payment['vpa'] === 'string'
          ? payment['vpa']
          : typeof payment['card_id'] === 'string'
            ? payment['card_id']
            : null,
      failureReason:
        typeof payment['error_description'] === 'string' ? payment['error_description'] : null,
      occurredAt: createdAt === null ? new Date() : new Date(createdAt * 1000),
      raw: envelope,
    };

    return { ok: true, event };
  }

  private async post(
    path: string,
    body: unknown,
    traceId: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const auth = Buffer.from(`${this.config.keyId}:${this.config.keySecret}`).toString('base64');

    try {
      const response = await this.fetchFn(`${this.config.baseUrl.replace(/\/+$/, '')}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${auth}`,
          'content-type': 'application/json',
          'x-trace-id': traceId,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();
      if (!response.ok) throw toPaymentsError(response.status, text);

      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new PaymentsError('UNKNOWN', 'Razorpay returned a body that is not an object');
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof PaymentsError) throw error;
      throw new PaymentsError(
        'PROVIDER_UNAVAILABLE',
        `Razorpay request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function toPaymentsError(status: number, body: string): PaymentsError {
  const detail = body.slice(0, 400);
  if (status === 401 || status === 403) {
    return new PaymentsError('AUTH_FAILED', 'Razorpay rejected the API credentials', { detail });
  }
  if (status === 429) {
    return new PaymentsError('RATE_LIMITED', 'Razorpay is rate limiting this account', { detail });
  }
  if (status >= 500) {
    return new PaymentsError('PROVIDER_UNAVAILABLE', `Razorpay returned ${status}`, { detail });
  }
  return new PaymentsError('INVALID_REQUEST', `Razorpay rejected the request (${status})`, {
    detail,
  });
}

function header(
  headers: Readonly<Record<string, string | undefined>>,
  name: string,
): string | null {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
