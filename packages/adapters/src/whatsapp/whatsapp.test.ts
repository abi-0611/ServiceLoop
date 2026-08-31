import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  kindForHttpStatus,
  mapMetaError,
  META_ERROR_KIND_BY_CODE,
  WhatsAppError,
} from './errors';
import { MetaCloudWhatsAppAdapter, type FetchLike } from './meta-cloud-adapter';
import { WA_LIMITS, type WhatsAppPort } from './port';
import {
  InMemoryTokenBucketStore,
  WhatsAppRateLimiter,
  type RateLimitPolicy,
} from './rate-limiter';
import {
  SandboxWhatsAppAdapter,
  type InjectedInbound,
  SANDBOX_APP_SECRET,
  SANDBOX_VERIFY_TOKEN,
} from './sandbox-adapter';
import type { WebhookDelivery } from './types';
import { normaliseMetaWebhook, signPayload, verifySignature } from './webhook';

/**
 * One contract, two adapters.
 *
 * `runWhatsAppContract` is the behaviour every WhatsAppPort must exhibit. It
 * runs against the sandbox adapter always, and against `MetaCloudWhatsAppAdapter`
 * driven by a scripted `fetch` — so the real adapter's request building, error
 * mapping and webhook handling are held to the same bar in CI, with no
 * credentials. The `LIVE_WA_TEST=1` block at the bottom is the only part that
 * needs a Meta test number.
 */

const CUSTOMER = '+919841100001';
const SHOP = 'shop-1';

interface Harness {
  readonly port: WhatsAppPort;
  readonly appSecret: string;
  readonly verifyToken: string;
  inject(injected: InjectedInbound): WebhookDelivery;
  /** The body of the most recent outbound send, as the provider received it. */
  lastRequestBody(): Record<string, unknown> | null;
  /** Makes the next send fail with this Meta error code. */
  failNextWith(httpStatus: number, code: number, title: string): void;
}

/* -------------------------------------------------------------------------- *
 * Harnesses
 * -------------------------------------------------------------------------- */

function sandboxHarness(): Harness {
  const adapter = new SandboxWhatsAppAdapter({ deliveryMode: 'manual' });
  let forcedFailure: { httpStatus: number; code: number; title: string } | null = null;

  // The sandbox has no HTTP layer, so failure injection wraps the port. The
  // contract only cares that a provider refusal surfaces as the right kind.
  const port: WhatsAppPort = new Proxy(adapter, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function' || !String(property).startsWith('send')) return value;
      return (...args: unknown[]) => {
        if (forcedFailure !== null) {
          const failure = forcedFailure;
          forcedFailure = null;
          return Promise.reject(mapMetaError(failure.httpStatus, failure, 'forced failure'));
        }
        return (value as (...inner: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as WhatsAppPort;

  return {
    port,
    appSecret: SANDBOX_APP_SECRET,
    verifyToken: SANDBOX_VERIFY_TOKEN,
    inject: (injected) => adapter.injectInbound(injected),
    lastRequestBody: () => {
      const last = adapter.transcript().at(-1);
      return last === undefined ? null : (last as unknown as Record<string, unknown>);
    },
    failNextWith: (httpStatus, code, title) => {
      forcedFailure = { httpStatus, code, title };
    },
  };
}

const META_SECRET = 'meta-app-secret';
const META_VERIFY = 'meta-verify-token';

function metaHarness(): Harness {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  let forcedFailure: { httpStatus: number; code: number; title: string } | null = null;
  let sequence = 0;

  const fetchImpl: FetchLike = (url, init) => {
    const rawBody = typeof init.body === 'string' ? init.body : '{}';
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    requests.push({ url, body: parsed });

    if (forcedFailure !== null) {
      const failure = forcedFailure;
      forcedFailure = null;
      return Promise.resolve(
        jsonResponse(failure.httpStatus, {
          error: { code: failure.code, title: failure.title, message: failure.title },
        }),
      );
    }

    if (url.includes('/messages') && init.method === 'POST' && parsed['status'] === 'read') {
      return Promise.resolve(jsonResponse(200, { success: true }));
    }

    if (url.includes('/messages')) {
      sequence += 1;
      return Promise.resolve(
        jsonResponse(200, {
          messaging_product: 'whatsapp',
          contacts: [{ wa_id: '919841100001' }],
          messages: [{ id: `wamid.TEST${sequence}` }],
        }),
      );
    }

    // Media handle resolution, then the binary fetch from the returned URL.
    if (url.includes('/media-download')) {
      return Promise.resolve(
        new Response(Buffer.from('fixture-bytes'), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        }),
      );
    }
    return Promise.resolve(
      jsonResponse(200, {
        url: 'https://lookaside.example/media-download',
        mime_type: 'image/jpeg',
        sha256: createHash('sha256').update(Buffer.from('fixture-bytes')).digest('base64'),
        file_size: 13,
        id: 'media-1',
      }),
    );
  };

  const adapter = new MetaCloudWhatsAppAdapter(
    {
      accessToken: 'token',
      phoneNumberId: '1234567890',
      businessAccountId: 'waba-1',
      appSecret: META_SECRET,
      verifyToken: META_VERIFY,
      graphVersion: 'v23.0',
      baseUrl: 'https://graph.example',
    },
    { fetch: fetchImpl },
  );

  // Inbound for the live adapter is a genuine Meta envelope; the sandbox
  // builds exactly the same shape, which is why one contract covers both.
  const shaper = new SandboxWhatsAppAdapter({ appSecret: META_SECRET, deliveryMode: 'manual' });

  return {
    port: adapter,
    appSecret: META_SECRET,
    verifyToken: META_VERIFY,
    inject: (injected) => shaper.injectInbound(injected),
    lastRequestBody: () => requests.at(-1)?.body ?? null,
    failNextWith: (httpStatus, code, title) => {
      forcedFailure = { httpStatus, code, title };
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/* -------------------------------------------------------------------------- *
 * The contract
 * -------------------------------------------------------------------------- */

function runWhatsAppContract(name: string, makeHarness: () => Harness): void {
  describe(`WhatsAppPort contract — ${name}`, () => {
    let harness: Harness;

    beforeEach(() => {
      harness = makeHarness();
    });

    it('sends a session message and returns a provider message id', async () => {
      const result = await harness.port.sendSessionMessage({
        shopId: SHOP,
        to: CUSTOMER,
        body: 'Your Swift is ready for pickup.',
      });

      expect(result.providerMessageId.length).toBeGreaterThan(0);
      expect(result.acceptedAt).toBeInstanceOf(Date);
    });

    it('sends a template with its language and body variables', async () => {
      const result = await harness.port.sendTemplate({
        shopId: SHOP,
        to: CUSTOMER,
        template: { name: 'job_card_opened', language: 'ta', category: 'UTILITY' },
        variables: { body: ['JC-2026-0001', 'Swift VDi'] },
      });

      expect(result.providerMessageId.length).toBeGreaterThan(0);
      expect(JSON.stringify(harness.lastRequestBody())).toContain('job_card_opened');
    });

    it('sends interactive reply buttons', async () => {
      const result = await harness.port.sendInteractive({
        shopId: SHOP,
        to: CUSTOMER,
        body: 'Approve the brake pad replacement?',
        payload: {
          kind: 'buttons',
          buttons: [
            { id: 'approve', title: 'Approve' },
            { id: 'decline', title: 'Not now' },
          ],
        },
      });

      expect(result.providerMessageId.length).toBeGreaterThan(0);
      expect(JSON.stringify(harness.lastRequestBody())).toContain('approve');
    });

    it('sends media by bytes', async () => {
      const result = await harness.port.sendMedia({
        shopId: SHOP,
        to: CUSTOMER,
        media: { bytes: Buffer.from('jpeg'), contentType: 'image/jpeg', kind: 'PHOTO' },
        caption: 'Worn brake pad',
      });
      expect(result.providerMessageId.length).toBeGreaterThan(0);
    });

    it('marks an inbound message as read without throwing', async () => {
      await expect(
        harness.port.markRead({ shopId: SHOP, waMessageId: 'wamid.INBOUND1' }),
      ).resolves.toBeUndefined();
    });

    it('rejects a recipient that is not E.164 or a group address', async () => {
      await expect(
        harness.port.sendSessionMessage({ shopId: SHOP, to: '98765 43210', body: 'hi' }),
      ).rejects.toMatchObject({ kind: 'INVALID_REQUEST' });
    });

    it('refuses more reply buttons than WhatsApp accepts', async () => {
      await expect(
        harness.port.sendInteractive({
          shopId: SHOP,
          to: CUSTOMER,
          body: 'Pick one',
          payload: {
            kind: 'buttons',
            buttons: Array.from({ length: WA_LIMITS.maxButtons + 1 }, (_unused, index) => ({
              id: `b${index}`,
              title: `Option ${index}`,
            })),
          },
        }),
      ).rejects.toMatchObject({ kind: 'INVALID_REQUEST' });
    });

    it('refuses a button title WhatsApp would silently truncate', async () => {
      await expect(
        harness.port.sendInteractive({
          shopId: SHOP,
          to: CUSTOMER,
          body: 'Pick one',
          payload: {
            kind: 'buttons',
            buttons: [{ id: 'b', title: 'x'.repeat(WA_LIMITS.buttonTitle + 1) }],
          },
        }),
      ).rejects.toMatchObject({ kind: 'INVALID_REQUEST' });
    });

    it('maps a closed 24-hour window to WINDOW_CLOSED, not a generic failure', async () => {
      harness.failNextWith(400, 131047, 'Re-engagement message');
      await expect(
        harness.port.sendSessionMessage({ shopId: SHOP, to: CUSTOMER, body: 'still there?' }),
      ).rejects.toMatchObject({ kind: 'WINDOW_CLOSED', retryable: false });
    });

    it('maps a throughput error to a retryable RATE_LIMITED with a backoff', async () => {
      harness.failNextWith(400, 130429, 'Rate limit hit');
      await harness.port
        .sendSessionMessage({ shopId: SHOP, to: CUSTOMER, body: 'hello' })
        .then(
          () => expect.unreachable('the send should have been rejected'),
          (error: unknown) => {
            expect(error).toBeInstanceOf(WhatsAppError);
            const typed = error as WhatsAppError;
            expect(typed.kind).toBe('RATE_LIMITED');
            expect(typed.retryable).toBe(true);
            expect(typed.retryAfterMs).toBeGreaterThan(0);
          },
        );
    });

    it('maps an undeliverable recipient to a non-retryable INVALID_RECIPIENT', async () => {
      harness.failNextWith(400, 131026, 'Message undeliverable');
      await expect(
        harness.port.sendSessionMessage({ shopId: SHOP, to: CUSTOMER, body: 'hello' }),
      ).rejects.toMatchObject({ kind: 'INVALID_RECIPIENT', retryable: false });
    });

    it('normalises an inbound text message', async () => {
      const batch = await harness.port.receive(
        harness.inject({ kind: 'text', from: CUSTOMER, displayName: 'Anand', text: 'Ready ah?' }),
      );

      expect(batch.events).toHaveLength(1);
      const event = batch.events[0];
      expect(event?.kind).toBe('text');
      expect(event?.from).toBe(CUSTOMER);
      expect(event?.fromDisplayName).toBe('Anand');
      expect(event?.waMessageId.length).toBeGreaterThan(0);
      if (event?.kind === 'text') expect(event.text).toBe('Ready ah?');
    });

    it('normalises an inbound button tap into a button_reply event', async () => {
      const batch = await harness.port.receive(
        harness.inject({
          kind: 'button_reply',
          from: CUSTOMER,
          replyId: 'approve:jc-1',
          title: 'Approve',
        }),
      );

      const event = batch.events[0];
      expect(event?.kind).toBe('button_reply');
      if (event?.kind === 'button_reply') {
        expect(event.replyId).toBe('approve:jc-1');
        expect(event.title).toBe('Approve');
      }
    });

    it('normalises an inbound image with its caption and media handle', async () => {
      const batch = await harness.port.receive(
        harness.inject({
          kind: 'media',
          from: CUSTOMER,
          mediaKind: 'PHOTO',
          bytes: Buffer.from('fixture-bytes'),
          contentType: 'image/jpeg',
          caption: '#jobcard',
        }),
      );

      const event = batch.events[0];
      expect(event?.kind).toBe('media');
      if (event?.kind === 'media') {
        expect(event.mediaKind).toBe('PHOTO');
        expect(event.caption).toBe('#jobcard');
        expect(event.media.providerMediaId.length).toBeGreaterThan(0);
      }
    });

    it('flags a voice note distinctly from an attached audio file', async () => {
      const batch = await harness.port.receive(
        harness.inject({
          kind: 'media',
          from: CUSTOMER,
          mediaKind: 'AUDIO',
          bytes: Buffer.from('ogg'),
          contentType: 'audio/ogg; codecs=opus',
          isVoiceNote: true,
        }),
      );

      const event = batch.events[0];
      if (event?.kind === 'media') expect(event.media.isVoiceNote).toBe(true);
      else expect.unreachable('expected a media event');
    });

    it('normalises location and reaction events', async () => {
      const location = await harness.port.receive(
        harness.inject({ kind: 'location', from: CUSTOMER, latitude: 13.07, longitude: 80.22 }),
      );
      expect(location.events[0]?.kind).toBe('location');

      const reaction = await harness.port.receive(
        harness.inject({
          kind: 'reaction',
          from: CUSTOMER,
          emoji: '👍',
          targetMessageId: 'wamid.X',
        }),
      );
      expect(reaction.events[0]?.kind).toBe('reaction');
    });

    it('rejects a tampered payload before parsing it', async () => {
      const delivery = harness.inject({ kind: 'text', from: CUSTOMER, text: 'original' });
      const tampered: WebhookDelivery = {
        ...delivery,
        rawBody: delivery.rawBody.replace('original', 'tampered'),
      };

      await expect(harness.port.receive(tampered)).rejects.toMatchObject({
        kind: 'SIGNATURE_INVALID',
      });
    });

    it('rejects a payload with no signature at all', async () => {
      const delivery = harness.inject({ kind: 'text', from: CUSTOMER, text: 'hello' });
      await expect(
        harness.port.receive({ ...delivery, signatureHeader: null }),
      ).rejects.toMatchObject({ kind: 'SIGNATURE_INVALID' });
    });

    it('echoes the challenge on a valid subscription handshake', () => {
      expect(
        harness.port.verifySubscription({
          mode: 'subscribe',
          verifyToken: harness.verifyToken,
          challenge: '1158201444',
        }),
      ).toBe('1158201444');
    });

    it('refuses a subscription handshake with the wrong verify token', () => {
      expect(() =>
        harness.port.verifySubscription({
          mode: 'subscribe',
          verifyToken: 'not-the-token',
          challenge: '1158201444',
        }),
      ).toThrow(WhatsAppError);
    });

    it('downloads the bytes behind an inbound media reference', async () => {
      const batch = await harness.port.receive(
        harness.inject({
          kind: 'media',
          from: CUSTOMER,
          mediaKind: 'PHOTO',
          bytes: Buffer.from('fixture-bytes'),
          contentType: 'image/jpeg',
        }),
      );

      const event = batch.events[0];
      if (event?.kind !== 'media') return expect.unreachable('expected a media event');

      const downloaded = await harness.port.downloadMedia(SHOP, event.media);
      expect(downloaded.bytes.toString()).toBe('fixture-bytes');
      expect(downloaded.sizeBytes).toBe(13);
    });
  });
}

runWhatsAppContract('SandboxWhatsAppAdapter', sandboxHarness);
runWhatsAppContract('MetaCloudWhatsAppAdapter', metaHarness);

/* -------------------------------------------------------------------------- *
 * Adapter-specific behaviour
 * -------------------------------------------------------------------------- */

describe('webhook signature verification', () => {
  const body = '{"object":"whatsapp_business_account","entry":[]}';

  it('accepts a correctly signed body', () => {
    expect(verifySignature(body, signPayload(body, 'secret'), 'secret')).toBe(true);
  });

  it('rejects a body signed with a different secret', () => {
    expect(verifySignature(body, signPayload(body, 'other'), 'secret')).toBe(false);
  });

  it('rejects a signature with the wrong prefix, length or alphabet', () => {
    expect(verifySignature(body, 'sha1=abcdef', 'secret')).toBe(false);
    expect(verifySignature(body, 'sha256=zz', 'secret')).toBe(false);
    expect(verifySignature(body, `sha256=${'z'.repeat(64)}`, 'secret')).toBe(false);
    expect(verifySignature(body, null, 'secret')).toBe(false);
  });

  it('is sensitive to a single flipped byte anywhere in the body', () => {
    const signature = signPayload(body, 'secret');
    expect(verifySignature(`${body} `, signature, 'secret')).toBe(false);
  });
});

describe('Meta payload normalisation', () => {
  const receivedAt = new Date('2026-08-14T10:00:00.000Z');

  it('reads the phone number id from the change metadata', () => {
    const batch = normaliseMetaWebhook(
      JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'waba',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { phone_number_id: '15550001111' },
                  messages: [
                    { id: 'wamid.A', from: '919841100001', timestamp: '1786636800', type: 'text', text: { body: 'hi' } },
                  ],
                },
              },
            ],
          },
        ],
      }),
      receivedAt,
    );

    expect(batch.phoneNumberId).toBe('15550001111');
    expect(batch.events[0]?.to).toBe('15550001111');
    // Unix seconds, as WhatsApp sends them — not milliseconds.
    expect(batch.events[0]?.timestamp.toISOString()).toBe('2026-08-13T16:00:00.000Z');
  });

  it('treats a template quick-reply (`button`) as a button_reply', () => {
    const batch = normaliseMetaWebhook(
      JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    {
                      id: 'wamid.B',
                      from: '919841100001',
                      timestamp: '1786636800',
                      type: 'button',
                      button: { payload: 'APPROVE', text: 'Approve' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
      receivedAt,
    );

    const event = batch.events[0];
    expect(event?.kind).toBe('button_reply');
    if (event?.kind === 'button_reply') expect(event.replyId).toBe('APPROVE');
  });

  it('records an unknown message type instead of dropping or throwing', () => {
    const batch = normaliseMetaWebhook(
      JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    { id: 'wamid.C', from: '919841100001', timestamp: '1', type: 'poll_vote' },
                  ],
                },
              },
            ],
          },
        ],
      }),
      receivedAt,
    );

    const event = batch.events[0];
    expect(event?.kind).toBe('unsupported');
    if (event?.kind === 'unsupported') expect(event.providerType).toBe('poll_vote');
  });

  it('normalises delivery receipts with their pricing category', () => {
    const batch = normaliseMetaWebhook(
      JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                value: {
                  statuses: [
                    {
                      id: 'wamid.OUT',
                      status: 'delivered',
                      timestamp: '1786636800',
                      recipient_id: '919841100001',
                      conversation: { id: 'conv-1', origin: { type: 'service' } },
                      pricing: { billable: true, pricing_model: 'CBP', category: 'utility' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
      receivedAt,
    );

    expect(batch.statuses).toHaveLength(1);
    expect(batch.statuses[0]).toMatchObject({
      state: 'delivered',
      category: 'UTILITY',
      billable: true,
      providerConversationId: 'conv-1',
      recipient: '+919841100001',
    });
  });

  it('carries the provider error code on a failed receipt', () => {
    const sandbox = new SandboxWhatsAppAdapter({ deliveryMode: 'manual' });
    const delivery = sandbox.queueFailure('wamid.OUT', '+919841100001', 131047, 'Re-engagement');
    const batch = normaliseMetaWebhook(delivery.rawBody, receivedAt);

    expect(batch.statuses[0]).toMatchObject({ state: 'failed', errorCode: 131047 });
  });

  it('rejects a body that is not JSON, and one that is not a webhook', () => {
    expect(() => normaliseMetaWebhook('not json', receivedAt)).toThrow(WhatsAppError);
    expect(() => normaliseMetaWebhook('{"hello":"world"}', receivedAt)).toThrow(WhatsAppError);
  });
});

describe('error taxonomy', () => {
  it('maps every documented Meta code to a kind, and unknown codes to UNKNOWN', () => {
    for (const [code, expected] of Object.entries(META_ERROR_KIND_BY_CODE)) {
      const error = mapMetaError(400, { code: Number(code), message: 'x' }, 'fallback');
      expect(error.kind, `code ${code}`).toBe(expected);
    }

    const unknown = mapMetaError(400, { code: 999999, message: 'brand new' }, 'fallback');
    expect(unknown.kind).toBe('UNKNOWN');
  });

  it('never retries an error it does not understand', () => {
    expect(mapMetaError(400, { code: 999999 }, 'fallback').retryable).toBe(false);
  });

  it('falls back to the HTTP status when the body carries no Meta code', () => {
    expect(mapMetaError(503, undefined, 'gateway down').kind).toBe('PROVIDER_UNAVAILABLE');
    expect(mapMetaError(401, undefined, 'no token').kind).toBe('AUTH_FAILED');
    expect(kindForHttpStatus(429)).toBe('RATE_LIMITED');
    expect(kindForHttpStatus(418)).toBe('UNKNOWN');
  });
});

describe('per-shop rate limiter', () => {
  const policy: RateLimitPolicy = { capacity: 3, refillPerSecond: 1 };

  it('allows a burst up to capacity, then refuses until tokens refill', async () => {
    let clock = 1_000_000;
    const limiter = new WhatsAppRateLimiter(new InMemoryTokenBucketStore(), {
      policy,
      now: () => clock,
      maxWaitMs: 0,
      sleep: () => Promise.resolve(),
    });

    for (let index = 0; index < 3; index += 1) {
      expect((await limiter.acquire(SHOP)).allowed, `send ${index}`).toBe(true);
    }

    const denied = await limiter.acquire(SHOP);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);

    clock += 1_000;
    expect((await limiter.acquire(SHOP)).allowed).toBe(true);
  });

  it('budgets each shop separately', async () => {
    const clock = 1_000_000;
    const limiter = new WhatsAppRateLimiter(new InMemoryTokenBucketStore(), {
      policy,
      now: () => clock,
      maxWaitMs: 0,
      sleep: () => Promise.resolve(),
    });

    for (let index = 0; index < 3; index += 1) await limiter.acquire('shop-a');
    expect((await limiter.acquire('shop-a')).allowed).toBe(false);
    expect((await limiter.acquire('shop-b')).allowed).toBe(true);
  });

  it('waits for a token rather than failing when the wait is short', async () => {
    let clock = 1_000_000;
    const slept: number[] = [];
    const limiter = new WhatsAppRateLimiter(new InMemoryTokenBucketStore(), {
      policy: { capacity: 1, refillPerSecond: 10 },
      now: () => clock,
      maxWaitMs: 5_000,
      sleep: (ms) => {
        slept.push(ms);
        clock += ms;
        return Promise.resolve();
      },
    });

    expect((await limiter.acquire(SHOP)).allowed).toBe(true);
    expect((await limiter.acquire(SHOP)).allowed).toBe(true);
    expect(slept.length).toBe(1);
  });

  it('stops a burst before it ever reaches the provider', async () => {
    let clock = 1_000_000;
    const adapter = new SandboxWhatsAppAdapter({
      deliveryMode: 'manual',
      rateLimiter: new WhatsAppRateLimiter(new InMemoryTokenBucketStore(), {
        policy: { capacity: 2, refillPerSecond: 0.001 },
        now: () => clock,
        maxWaitMs: 0,
        sleep: () => Promise.resolve(),
      }),
    });

    await adapter.sendSessionMessage({ shopId: SHOP, to: CUSTOMER, body: 'one' });
    await adapter.sendSessionMessage({ shopId: SHOP, to: CUSTOMER, body: 'two' });
    await expect(
      adapter.sendSessionMessage({ shopId: SHOP, to: CUSTOMER, body: 'three' }),
    ).rejects.toMatchObject({ kind: 'RATE_LIMITED', retryable: true });

    expect(adapter.transcript()).toHaveLength(2);
    clock += 1;
  });
});

describe('SandboxWhatsAppAdapter simulator surface', () => {
  it('publishes every outbound to its subscribers for the console to render', async () => {
    const adapter = new SandboxWhatsAppAdapter({ deliveryMode: 'manual' });
    const seen: string[] = [];
    const unsubscribe = adapter.onOutbound((outbound) => seen.push(outbound.body));

    await adapter.sendSessionMessage({ shopId: SHOP, to: CUSTOMER, body: 'first' });
    unsubscribe();
    await adapter.sendSessionMessage({ shopId: SHOP, to: CUSTOMER, body: 'second' });

    expect(seen).toEqual(['first']);
    expect(adapter.transcript()).toHaveLength(2);
  });

  it('emits sent → delivered → read receipts through the real webhook path', async () => {
    const adapter = new SandboxWhatsAppAdapter({ deliveryMode: 'instant' });
    await adapter.sendSessionMessage({ shopId: SHOP, to: CUSTOMER, body: 'ready for pickup' });

    const delivery = adapter.drainStatusDelivery();
    expect(delivery).not.toBeNull();

    const batch = await adapter.receive(delivery as WebhookDelivery);
    expect(batch.statuses.map((status) => status.state)).toEqual(['sent', 'delivered', 'read']);
    expect(adapter.drainStatusDelivery()).toBeNull();
  });

  it('does not fabricate read receipts for the staff group', async () => {
    const adapter = new SandboxWhatsAppAdapter({ deliveryMode: 'instant' });
    await adapter.sendSessionMessage({
      shopId: SHOP,
      to: 'group:120363000000000000',
      body: 'New card on the board',
    });
    expect(adapter.drainStatusDelivery()).toBeNull();
  });

  it('records read receipts requested through markRead', async () => {
    const adapter = new SandboxWhatsAppAdapter({ deliveryMode: 'manual' });
    await adapter.markRead({ shopId: SHOP, waMessageId: 'wamid.IN' });
    expect(adapter.hasReadReceipt('wamid.IN')).toBe(true);
  });
});

/**
 * Live smoke test against a real Meta test number. Skipped unless
 * `LIVE_WA_TEST=1` and credentials are present, so CI never depends on it.
 */
const liveEnabled =
  process.env['LIVE_WA_TEST'] === '1' &&
  typeof process.env['WHATSAPP_ACCESS_TOKEN'] === 'string' &&
  typeof process.env['WHATSAPP_PHONE_NUMBER_ID'] === 'string' &&
  typeof process.env['LIVE_WA_TEST_RECIPIENT'] === 'string';

describe.skipIf(!liveEnabled)('MetaCloudWhatsAppAdapter — live', () => {
  it('sends a template to the configured test number', async () => {
    const adapter = new MetaCloudWhatsAppAdapter({
      accessToken: process.env['WHATSAPP_ACCESS_TOKEN'] as string,
      phoneNumberId: process.env['WHATSAPP_PHONE_NUMBER_ID'] as string,
      businessAccountId: process.env['WHATSAPP_BUSINESS_ACCOUNT_ID'] ?? '',
      appSecret: process.env['WHATSAPP_APP_SECRET'] ?? '',
      verifyToken: process.env['WHATSAPP_VERIFY_TOKEN'] ?? '',
      graphVersion: process.env['WHATSAPP_GRAPH_VERSION'] ?? 'v23.0',
    });

    const result = await adapter.sendTemplate({
      shopId: SHOP,
      to: process.env['LIVE_WA_TEST_RECIPIENT'] as string,
      template: { name: 'hello_world', language: 'en_US', category: 'UTILITY' },
      variables: {},
    });

    expect(result.providerMessageId).toMatch(/^wamid\./);
  });
});
