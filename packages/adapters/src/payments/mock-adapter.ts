import { createHmac, timingSafeEqual } from 'node:crypto';
import { uuidv7, type Paise, type PaymentMethod } from '@serviceloop/shared';
import {
  toPaymentMethod,
  type CreatePaymentLinkInput,
  type PaymentLink,
  type PaymentsPort,
  type WebhookVerdict,
} from './port';

/**
 * `MockPaymentsAdapter` — the sandbox payment provider (phase 4.9).
 *
 * Production-quality, not a throwaway (master §5). It mints links, keeps an
 * in-process ledger of what each one has been paid, and — this is the part that
 * matters — **emits webhook payloads in Razorpay's own envelope shape, signed
 * with a sandbox secret**. The simulator's "simulate UPI success" button
 * produces bytes that travel the identical verify → parse → reconcile path a
 * real delivery takes.
 *
 * That is what makes the phase-4 demo worth running. A mock that called the
 * reconcile service directly would prove the reconcile service works and
 * nothing about the webhook boundary, which is exactly where signature
 * verification, idempotency and raw-body handling all live.
 */

export interface MockPaymentsOptions {
  /** Signs simulated webhooks. Any string; it never leaves the process. */
  readonly webhookSecret?: string;
  readonly baseUrl?: string;
  readonly now?: () => Date;
}

interface MockLink {
  readonly id: string;
  readonly shopId: string;
  readonly jobCardId: string;
  readonly referenceId: string;
  readonly amountPaise: Paise;
  readonly acceptPartial: boolean;
  readonly expiresAt: Date | null;
  amountPaidPaise: Paise;
  status: 'created' | 'partially_paid' | 'paid' | 'cancelled' | 'expired';
}

export class MockPaymentsAdapter implements PaymentsPort {
  readonly provider = 'mock' as const;
  readonly driver = 'mock' as const;

  private readonly links = new Map<string, MockLink>();
  private readonly secret: string;
  private readonly baseUrl: string;
  private readonly now: () => Date;

  constructor(options: MockPaymentsOptions = {}) {
    this.secret = options.webhookSecret ?? 'sandbox-payments-secret';
    this.baseUrl = options.baseUrl ?? 'https://pay.sandbox.serviceloop.test';
    this.now = options.now ?? (() => new Date());
  }

  async createPaymentLink(input: CreatePaymentLinkInput): Promise<PaymentLink> {
    const id = `plink_mock_${uuidv7().replace(/-/g, '').slice(0, 14)}`;
    this.links.set(id, {
      id,
      shopId: input.shopId,
      jobCardId: input.jobCardId,
      referenceId: input.referenceId,
      amountPaise: input.amountPaise,
      acceptPartial: input.acceptPartial,
      expiresAt: input.expiresAt,
      amountPaidPaise: 0,
      status: 'created',
    });

    return {
      providerPaymentLinkId: id,
      shortUrl: `${this.baseUrl}/l/${id}`,
      expiresAt: input.expiresAt,
    };
  }

  parseWebhook(input: {
    readonly rawBody: Buffer;
    readonly headers: Readonly<Record<string, string | undefined>>;
  }): WebhookVerdict {
    // The same verification the real adapter does, against the same header, so
    // a tampered-signature test in the sandbox proves the property that matters
    // in production.
    const presented = Object.entries(input.headers).find(
      ([key]) => key.toLowerCase() === 'x-razorpay-signature',
    )?.[1];

    if (typeof presented !== 'string' || presented.length === 0) {
      return { ok: false, code: 'BAD_SIGNATURE', reason: 'X-Razorpay-Signature is missing' };
    }

    const expected = createHmac('sha256', this.secret).update(input.rawBody).digest('hex');
    const a = Buffer.from(presented, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { ok: false, code: 'BAD_SIGNATURE', reason: 'The simulated signature does not match' };
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
    const kind = MOCK_EVENT_KINDS[eventName as keyof typeof MOCK_EVENT_KINDS];
    if (kind === undefined) {
      return { ok: false, code: 'IGNORED', reason: `${eventName || 'unnamed'} is not consumed` };
    }

    const payload = asObject(envelope['payload']);
    const link = asObject(asObject(payload['payment_link'])['entity']);
    const payment = asObject(asObject(payload['payment'])['entity']);
    const linkId = typeof link['id'] === 'string' ? link['id'] : null;
    if (linkId === null) {
      return { ok: false, code: 'MALFORMED', reason: 'No payment_link entity in the payload' };
    }

    const createdAt = typeof envelope['created_at'] === 'number' ? envelope['created_at'] : null;

    return {
      ok: true,
      event: {
        providerEventId: `${eventName}:${linkId}:${
          typeof payment['id'] === 'string' ? payment['id'] : 'none'
        }`,
        providerPaymentLinkId: linkId,
        providerPaymentId: typeof payment['id'] === 'string' ? payment['id'] : null,
        kind,
        amountPaise: typeof payment['amount'] === 'number' ? payment['amount'] : 0,
        method: toPaymentMethod(typeof payment['method'] === 'string' ? payment['method'] : null),
        instrument: typeof payment['vpa'] === 'string' ? payment['vpa'] : null,
        failureReason:
          typeof payment['error_description'] === 'string' ? payment['error_description'] : null,
        occurredAt: createdAt === null ? this.now() : new Date(createdAt * 1000),
        raw: envelope,
      },
    };
  }

  /* ------------------------------------------------------- sandbox controls */

  /**
   * Builds a signed webhook delivery, exactly as the provider would send it.
   *
   * Returns bytes and headers rather than an event, so the caller pushes them
   * through the real webhook endpoint. There is no back door into the
   * reconcile service — which is the same property phase 2 gave the WhatsApp
   * sandbox, and for the same reason.
   */
  simulate(input: {
    readonly providerPaymentLinkId: string;
    readonly outcome: 'success' | 'partial' | 'failure' | 'expired';
    readonly amountPaise?: Paise;
    readonly method?: PaymentMethod;
    readonly vpa?: string;
  }): { readonly rawBody: Buffer; readonly headers: Readonly<Record<string, string>> } {
    const link = this.links.get(input.providerPaymentLinkId);
    if (link === undefined) {
      throw new Error(`No mock payment link ${input.providerPaymentLinkId} exists`);
    }

    const now = this.now();
    const amountPaise =
      input.amountPaise ??
      (input.outcome === 'partial'
        ? Math.round(link.amountPaise / 2)
        : link.amountPaise - link.amountPaidPaise);

    const eventName =
      input.outcome === 'success'
        ? 'payment_link.paid'
        : input.outcome === 'partial'
          ? 'payment_link.partially_paid'
          : input.outcome === 'expired'
            ? 'payment_link.expired'
            : 'payment_link.paid';

    if (input.outcome === 'success' || input.outcome === 'partial') {
      link.amountPaidPaise += amountPaise;
      link.status = link.amountPaidPaise >= link.amountPaise ? 'paid' : 'partially_paid';
    } else if (input.outcome === 'expired') {
      link.status = 'expired';
    }

    const paymentEntity =
      input.outcome === 'expired'
        ? undefined
        : {
            entity: {
              id: `pay_mock_${uuidv7().replace(/-/g, '').slice(0, 14)}`,
              entity: 'payment',
              amount: amountPaise,
              currency: 'INR',
              status: input.outcome === 'failure' ? 'failed' : 'captured',
              method: (input.method ?? 'UPI').toLowerCase(),
              vpa: input.vpa ?? 'customer@sandboxupi',
              ...(input.outcome === 'failure'
                ? { error_description: 'Simulated failure from the sandbox' }
                : {}),
            },
          };

    const envelope = {
      entity: 'event',
      account_id: 'acc_mock_serviceloop',
      event: eventName,
      contains: paymentEntity === undefined ? ['payment_link'] : ['payment_link', 'payment'],
      created_at: Math.floor(now.getTime() / 1000),
      payload: {
        payment_link: {
          entity: {
            id: link.id,
            entity: 'payment_link',
            reference_id: link.referenceId,
            amount: link.amountPaise,
            amount_paid: link.amountPaidPaise,
            status: link.status,
            currency: 'INR',
          },
        },
        ...(paymentEntity === undefined ? {} : { payment: paymentEntity }),
      },
    };

    const rawBody = Buffer.from(JSON.stringify(envelope), 'utf8');
    return {
      rawBody,
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': createHmac('sha256', this.secret).update(rawBody).digest('hex'),
        'x-razorpay-event-id': `evt_mock_${uuidv7().slice(0, 8)}`,
      },
    };
  }

  /** What the sandbox believes a link has been paid. For assertions only. */
  ledger(providerPaymentLinkId: string): { readonly amountPaidPaise: Paise; readonly status: string } | null {
    const link = this.links.get(providerPaymentLinkId);
    return link === undefined
      ? null
      : { amountPaidPaise: link.amountPaidPaise, status: link.status };
  }

  get size(): number {
    return this.links.size;
  }
}

const MOCK_EVENT_KINDS = {
  'payment_link.paid': 'PAID',
  'payment_link.partially_paid': 'PARTIALLY_PAID',
  'payment_link.expired': 'EXPIRED',
  'payment_link.cancelled': 'CANCELLED',
} as const;

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
