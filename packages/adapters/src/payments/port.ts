import type { Paise, PaymentEventKind, PaymentMethod } from '@serviceloop/shared';

/**
 * `PaymentsPort` — UPI links out, verified events in (phase 4.9).
 *
 * Two operations and a hard boundary between them. `createPaymentLink` is a
 * call the shop makes; `parseWebhook` is a call the *provider* makes, over the
 * public internet, with a body that is attacker-controlled until its signature
 * has been checked. The port's shape reflects that: `parseWebhook` takes the
 * **raw bytes** and the headers, and no adapter is permitted to look at a
 * parsed body before verifying it.
 */

export interface CreatePaymentLinkInput {
  readonly shopId: string;
  readonly jobCardId: string;
  /** Our own id for the link, echoed back on every event. */
  readonly referenceId: string;
  readonly amountPaise: Paise;
  readonly description: string;
  readonly customerName: string | null;
  readonly customerPhone: string | null;
  readonly acceptPartial: boolean;
  readonly minimumFirstAmountPaise: Paise | null;
  readonly expiresAt: Date | null;
  readonly traceId: string;
}

export interface PaymentLink {
  readonly providerPaymentLinkId: string;
  readonly shortUrl: string;
  readonly expiresAt: Date | null;
}

/** One verified fact from the provider, in the domain's own vocabulary. */
export interface PaymentEvent {
  readonly providerEventId: string;
  readonly providerPaymentLinkId: string;
  readonly providerPaymentId: string | null;
  readonly kind: PaymentEventKind;
  readonly amountPaise: Paise;
  readonly method: PaymentMethod | null;
  readonly instrument: string | null;
  readonly failureReason: string | null;
  readonly occurredAt: Date;
  readonly raw: Readonly<Record<string, unknown>>;
}

export type WebhookVerdict =
  | { readonly ok: true; readonly event: PaymentEvent }
  | {
      readonly ok: false;
      readonly code: 'BAD_SIGNATURE' | 'MALFORMED' | 'IGNORED';
      readonly reason: string;
    };

export interface PaymentsPort {
  readonly provider: string;
  readonly driver: 'mock' | 'razorpay';

  createPaymentLink(input: CreatePaymentLinkInput): Promise<PaymentLink>;

  /**
   * Verifies and parses a provider webhook.
   *
   * `IGNORED` is a success, not a failure: providers send event types we do not
   * consume, and answering them with an error would make the provider retry a
   * delivery there was never anything to do about. The caller still answers
   * 2xx — the *signature* is what decides whether the request is answered at
   * all.
   */
  parseWebhook(input: {
    readonly rawBody: Buffer;
    readonly headers: Readonly<Record<string, string | undefined>>;
  }): WebhookVerdict;
}

export type PaymentsErrorKind =
  | 'AUTH_FAILED'
  | 'INVALID_REQUEST'
  | 'RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'UNKNOWN';

export class PaymentsError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly kind: PaymentsErrorKind,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'PaymentsError';
    this.retryable = kind === 'PROVIDER_UNAVAILABLE' || kind === 'RATE_LIMITED';
  }
}

/**
 * Provider method string → our enum.
 *
 * Unrecognised methods become `OTHER` rather than throwing: a payment that
 * genuinely arrived must be credited even when the provider has invented a new
 * instrument name since this was written, and losing the money to protect a
 * label would be the wrong trade by a wide margin.
 */
export function toPaymentMethod(value: string | null | undefined): PaymentMethod | null {
  if (value === null || value === undefined) return null;
  switch (value.toLowerCase()) {
    case 'upi':
      return 'UPI';
    case 'card':
      return 'CARD';
    case 'netbanking':
      return 'NETBANKING';
    case 'wallet':
      return 'WALLET';
    case 'bank_transfer':
    case 'nach':
    case 'emandate':
      return 'BANK_TRANSFER';
    default:
      return 'OTHER';
  }
}
