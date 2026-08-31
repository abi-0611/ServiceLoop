import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MockPaymentsAdapter } from './mock-adapter';
import { PaymentsError, toPaymentMethod, type CreatePaymentLinkInput, type PaymentsPort } from './port';
import { RazorpayPaymentsAdapter } from './razorpay-adapter';

/**
 * Phase 4.9 — the payments adapters.
 *
 * The contract suite runs against both, and the property it exists to pin down
 * is the one that protects a customer's money: **a tampered signature is
 * rejected, over the raw bytes, before anything is parsed.** Everything else
 * here is bookkeeping by comparison.
 */

const SECRET = 'sandbox-payments-secret';

function linkInput(overrides: Partial<CreatePaymentLinkInput> = {}): CreatePaymentLinkInput {
  return {
    shopId: 'shop-1',
    jobCardId: 'card-1',
    referenceId: 'JC-2026-0001-abc12345',
    amountPaise: 566_400,
    description: 'JC-2026-0001 — Maruti Swift',
    customerName: 'Ravi',
    customerPhone: '+919000000001',
    acceptPartial: false,
    minimumFirstAmountPaise: null,
    expiresAt: new Date('2026-08-20T12:00:00.000Z'),
    traceId: 'trace-1',
    ...overrides,
  };
}

function razorpay(fetchFn: typeof globalThis.fetch): RazorpayPaymentsAdapter {
  return new RazorpayPaymentsAdapter(
    {
      keyId: 'rzp_test_key',
      keySecret: 'rzp_test_secret',
      webhookSecret: SECRET,
      baseUrl: 'https://api.razorpay.com',
      timeoutMs: 5_000,
    },
    { fetch: fetchFn },
  );
}

const RAZORPAY_LINK = {
  id: 'plink_ExjpAUN3gVHrPJ',
  short_url: 'https://rzp.io/i/nxrHnLJ',
  status: 'created',
  amount: 566_400,
  amount_paid: 0,
  expire_by: Math.floor(new Date('2026-08-20T12:00:00.000Z').getTime() / 1000),
};

/** A Razorpay-shaped webhook envelope, signed with `secret`. */
function signedDelivery(
  envelope: unknown,
  secret = SECRET,
): { rawBody: Buffer; headers: Record<string, string> } {
  const rawBody = Buffer.from(JSON.stringify(envelope), 'utf8');
  return {
    rawBody,
    headers: {
      'content-type': 'application/json',
      'X-Razorpay-Signature': createHmac('sha256', secret).update(rawBody).digest('hex'),
    },
  };
}

function paidEnvelope(amountPaise = 566_400) {
  return {
    entity: 'event',
    account_id: 'acc_test',
    event: 'payment_link.paid',
    contains: ['payment_link', 'payment'],
    created_at: 1_786_900_000,
    payload: {
      payment_link: {
        entity: { id: 'plink_ExjpAUN3gVHrPJ', amount: amountPaise, amount_paid: amountPaise, status: 'paid' },
      },
      payment: {
        entity: {
          id: 'pay_29QQoUBi66xm2f',
          amount: amountPaise,
          method: 'upi',
          vpa: 'ravi@okhdfcbank',
          status: 'captured',
        },
      },
    },
  };
}

/* -------------------------------------------------------------------------- *
 * The contract, asked of both
 * -------------------------------------------------------------------------- */

describe.each([
  ['MockPaymentsAdapter', (): PaymentsPort => new MockPaymentsAdapter({ webhookSecret: SECRET })],
  ['RazorpayPaymentsAdapter', (): PaymentsPort => razorpay(async () => jsonOk(RAZORPAY_LINK))],
])('PaymentsPort contract — %s', (_name, build) => {
  it('mints a link with a provider id and a short url', async () => {
    const link = await build().createPaymentLink(linkInput());
    expect(link.providerPaymentLinkId.length).toBeGreaterThan(0);
    expect(link.shortUrl).toMatch(/^https:\/\//);
  });

  it('rejects a delivery whose signature does not match', async () => {
    const adapter = build();
    const link = await adapter.createPaymentLink(linkInput());
    const envelope = { ...paidEnvelope(), payload: withLinkId(paidEnvelope().payload, link.providerPaymentLinkId) };

    const forged = signedDelivery(envelope, 'not-the-webhook-secret');
    const verdict = adapter.parseWebhook(forged);

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('BAD_SIGNATURE');
  });

  it('rejects a delivery with no signature header at all', () => {
    const verdict = build().parseWebhook({
      rawBody: Buffer.from(JSON.stringify(paidEnvelope()), 'utf8'),
      headers: { 'content-type': 'application/json' },
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('BAD_SIGNATURE');
  });

  it('rejects a body whose bytes were altered after signing', async () => {
    const adapter = build();
    const link = await adapter.createPaymentLink(linkInput());
    const envelope = { ...paidEnvelope(), payload: withLinkId(paidEnvelope().payload, link.providerPaymentLinkId) };
    const delivery = signedDelivery(envelope);

    // Somebody doubles the amount in flight. The signature is over the bytes.
    const tampered = Buffer.from(
      delivery.rawBody.toString('utf8').replace('566400', '1132800'),
      'utf8',
    );
    const verdict = adapter.parseWebhook({ rawBody: tampered, headers: delivery.headers });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('BAD_SIGNATURE');
  });

  it('accepts a correctly signed delivery and reads the money that moved', async () => {
    const adapter = build();
    const link = await adapter.createPaymentLink(linkInput());
    const envelope = { ...paidEnvelope(), payload: withLinkId(paidEnvelope().payload, link.providerPaymentLinkId) };

    const verdict = adapter.parseWebhook(signedDelivery(envelope));
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;

    expect(verdict.event.kind).toBe('PAID');
    expect(verdict.event.amountPaise).toBe(566_400);
    expect(verdict.event.method).toBe('UPI');
    expect(verdict.event.instrument).toBe('ravi@okhdfcbank');
    expect(verdict.event.providerPaymentLinkId).toBe(link.providerPaymentLinkId);
  });

  it('gives a retried delivery the same event id, so it can be de-duplicated', async () => {
    const adapter = build();
    const link = await adapter.createPaymentLink(linkInput());
    const envelope = { ...paidEnvelope(), payload: withLinkId(paidEnvelope().payload, link.providerPaymentLinkId) };

    const first = adapter.parseWebhook(signedDelivery(envelope));
    const second = adapter.parseWebhook(signedDelivery(envelope));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.event.providerEventId).toBe(second.event.providerEventId);
  });

  it('ignores an event type it does not consume, rather than erroring', () => {
    const verdict = build().parseWebhook(
      signedDelivery({ entity: 'event', event: 'refund.created', payload: {} }),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    // `IGNORED` is a success from the endpoint's side: answering with an error
    // would make the provider retry something there was nothing to do about.
    expect(verdict.code).toBe('IGNORED');
  });

  it('rejects a signed body that is not JSON', () => {
    const rawBody = Buffer.from('not json at all', 'utf8');
    const verdict = build().parseWebhook({
      rawBody,
      headers: {
        'x-razorpay-signature': createHmac('sha256', SECRET).update(rawBody).digest('hex'),
      },
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('MALFORMED');
  });
});

/* -------------------------------------------------------------------------- *
 * Razorpay specifics
 * -------------------------------------------------------------------------- */

describe('RazorpayPaymentsAdapter', () => {
  it('posts to the payment-links endpoint with basic auth and paise', async () => {
    const fetchFn = vi.fn(async () => jsonOk(RAZORPAY_LINK));
    await razorpay(fetchFn as unknown as typeof globalThis.fetch).createPaymentLink(linkInput());

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.razorpay.com/v1/payment_links');

    const auth = (init.headers as Record<string, string>)['authorization'] ?? '';
    expect(auth.startsWith('Basic ')).toBe(true);
    expect(Buffer.from(auth.slice(6), 'base64').toString('utf8')).toBe(
      'rzp_test_key:rzp_test_secret',
    );

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    // Razorpay's smallest currency unit for INR *is* paise, so there is no
    // conversion and nowhere for a factor-of-100 bug to hide.
    expect(body['amount']).toBe(566_400);
    expect(body['currency']).toBe('INR');
    expect(body['reference_id']).toBe('JC-2026-0001-abc12345');
  });

  it('turns the provider’s notifications off, because ours pass the gate', async () => {
    const fetchFn = vi.fn(async () => jsonOk(RAZORPAY_LINK));
    await razorpay(fetchFn as unknown as typeof globalThis.fetch).createPaymentLink(linkInput());

    const body = JSON.parse(
      (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>;
    // A provider SMS would bypass consent, quiet hours and the frequency caps.
    expect(body['notify']).toEqual({ sms: false, email: false });
    expect(body['reminder_enable']).toBe(false);
  });

  it('sends the minimum first instalment only when partial payment is on', async () => {
    const fetchFn = vi.fn(async () => jsonOk(RAZORPAY_LINK));
    const adapter = razorpay(fetchFn as unknown as typeof globalThis.fetch);

    await adapter.createPaymentLink(linkInput());
    let body = JSON.parse(
      (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>;
    expect(body['first_min_partial_amount']).toBeUndefined();

    await adapter.createPaymentLink(
      linkInput({ acceptPartial: true, minimumFirstAmountPaise: 283_200 }),
    );
    body = JSON.parse(
      (fetchFn.mock.calls[1] as unknown as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>;
    expect(body['accept_partial']).toBe(true);
    expect(body['first_min_partial_amount']).toBe(283_200);
  });

  it.each([
    [401, 'AUTH_FAILED'],
    [429, 'RATE_LIMITED'],
    [500, 'PROVIDER_UNAVAILABLE'],
    [400, 'INVALID_REQUEST'],
  ])('maps HTTP %d onto %s', async (status, kind) => {
    const adapter = razorpay(async () => new Response('{"error":{}}', { status }));
    await expect(adapter.createPaymentLink(linkInput())).rejects.toMatchObject({ kind });
  });

  it('refuses a response with no link id', async () => {
    const adapter = razorpay(async () => jsonOk({ status: 'created' }));
    await expect(adapter.createPaymentLink(linkInput())).rejects.toBeInstanceOf(PaymentsError);
  });

  it('credits what moved in this event, not the running total', () => {
    // The second instalment of a partial payment: `amount_paid` is 500000 but
    // only 250000 arrived now. Crediting the total would double-count.
    const envelope = {
      entity: 'event',
      event: 'payment_link.partially_paid',
      created_at: 1_786_900_000,
      payload: {
        payment_link: { entity: { id: 'plink_x', amount: 500_000, amount_paid: 500_000 } },
        payment: { entity: { id: 'pay_2', amount: 250_000, method: 'upi' } },
      },
    };

    const verdict = razorpay(async () => jsonOk(RAZORPAY_LINK)).parseWebhook(
      signedDelivery(envelope),
    );
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.event.amountPaise).toBe(250_000);
    expect(verdict.event.kind).toBe('PARTIALLY_PAID');
  });

  it('distinguishes two instalments on one link by their payment ids', () => {
    const build = (paymentId: string) => ({
      entity: 'event',
      event: 'payment_link.partially_paid',
      created_at: 1_786_900_000,
      payload: {
        payment_link: { entity: { id: 'plink_x', amount: 500_000 } },
        payment: { entity: { id: paymentId, amount: 250_000, method: 'upi' } },
      },
    });

    const adapter = razorpay(async () => jsonOk(RAZORPAY_LINK));
    const first = adapter.parseWebhook(signedDelivery(build('pay_1')));
    const second = adapter.parseWebhook(signedDelivery(build('pay_2')));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    // A genuinely new instalment must NOT be de-duplicated away.
    expect(first.event.providerEventId).not.toBe(second.event.providerEventId);
  });

  it('reads an expiry event with no payment attached', () => {
    const envelope = {
      entity: 'event',
      event: 'payment_link.expired',
      created_at: 1_786_900_000,
      payload: { payment_link: { entity: { id: 'plink_x', amount: 500_000, amount_paid: 0 } } },
    };
    const verdict = razorpay(async () => jsonOk(RAZORPAY_LINK)).parseWebhook(
      signedDelivery(envelope),
    );
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.event.kind).toBe('EXPIRED');
    expect(verdict.event.amountPaise).toBe(0);
  });
});

/* -------------------------------------------------------------------------- *
 * The sandbox
 * -------------------------------------------------------------------------- */

describe('MockPaymentsAdapter', () => {
  it('emits deliveries the real verifier would accept', async () => {
    const mock = new MockPaymentsAdapter({ webhookSecret: SECRET });
    const link = await mock.createPaymentLink(linkInput());

    const delivery = mock.simulate({
      providerPaymentLinkId: link.providerPaymentLinkId,
      outcome: 'success',
    });

    // The bytes travel the identical verify → parse path a Razorpay delivery
    // takes, including through the *real* adapter's verifier.
    const verdict = razorpay(async () => jsonOk(RAZORPAY_LINK)).parseWebhook(delivery);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.event.kind).toBe('PAID');
    expect(verdict.event.amountPaise).toBe(566_400);
  });

  it('tracks a partial payment and then settles it', async () => {
    const mock = new MockPaymentsAdapter({ webhookSecret: SECRET });
    const link = await mock.createPaymentLink(linkInput({ acceptPartial: true }));

    const first = mock.simulate({
      providerPaymentLinkId: link.providerPaymentLinkId,
      outcome: 'partial',
    });
    expect(mock.ledger(link.providerPaymentLinkId)).toEqual({
      amountPaidPaise: 283_200,
      status: 'partially_paid',
    });

    const firstVerdict = mock.parseWebhook(first);
    expect(firstVerdict.ok).toBe(true);
    if (!firstVerdict.ok) return;
    expect(firstVerdict.event.kind).toBe('PARTIALLY_PAID');

    mock.simulate({ providerPaymentLinkId: link.providerPaymentLinkId, outcome: 'success' });
    expect(mock.ledger(link.providerPaymentLinkId)?.status).toBe('paid');
  });

  it('simulates a failure with a reason', async () => {
    const mock = new MockPaymentsAdapter({ webhookSecret: SECRET });
    const link = await mock.createPaymentLink(linkInput());
    const delivery = mock.simulate({
      providerPaymentLinkId: link.providerPaymentLinkId,
      outcome: 'failure',
    });

    const verdict = mock.parseWebhook(delivery);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.event.failureReason).toContain('Simulated failure');
  });

  it('refuses to simulate against a link it never minted', () => {
    const mock = new MockPaymentsAdapter({ webhookSecret: SECRET });
    expect(() =>
      mock.simulate({ providerPaymentLinkId: 'plink_never', outcome: 'success' }),
    ).toThrow(/never/i);
  });
});

describe('toPaymentMethod', () => {
  it.each([
    ['upi', 'UPI'],
    ['card', 'CARD'],
    ['netbanking', 'NETBANKING'],
    ['wallet', 'WALLET'],
    ['nach', 'BANK_TRANSFER'],
    // An instrument invented since this was written must still be credited.
    ['something_new', 'OTHER'],
  ])('maps %s onto %s', (value, expected) => {
    expect(toPaymentMethod(value)).toBe(expected);
  });

  it('is null when the provider named no method', () => {
    expect(toPaymentMethod(null)).toBeNull();
    expect(toPaymentMethod(undefined)).toBeNull();
  });
});

/* ---------------------------------------------------------------- helpers -- */

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function withLinkId(payload: Record<string, unknown>, id: string): Record<string, unknown> {
  const link = payload['payment_link'] as { entity: Record<string, unknown> };
  return {
    ...payload,
    payment_link: { entity: { ...link.entity, id } },
  };
}
