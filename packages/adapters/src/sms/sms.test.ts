import type { ChannelSender, ChannelSendRequest, ChannelSendResult } from '@serviceloop/domain';
import type { ChannelType } from '@serviceloop/shared';
import { describe, expect, it, vi } from 'vitest';
import { WhatsAppError } from '../whatsapp/errors';
import { SmsChannelSender, type SmsShopSettings } from './channel-sender';
import { DltSmsAdapter } from './dlt-adapter';
import { ChannelFailoverSender } from './failover-sender';
import { smsSegments, SmsSendError } from './port';
import { SandboxSmsAdapter } from './sandbox-adapter';

/**
 * The SMS fallback rung (phase 7.3), including the acceptance-gate drill:
 * "simulated WhatsApp outage falls back to SMS for a ladder rung and recovers".
 */

const SETTINGS: SmsShopSettings = {
  enabled: true,
  senderId: 'SLOOPS',
  dltTemplateIds: { ready_for_delivery: 'DLT-1007', approval_request: 'DLT-1003' },
};

const textRequest: ChannelSendRequest = {
  shopId: 'shop-1',
  to: '+919876543210',
  content: { kind: 'text', body: 'Your Swift is ready for pickup at Sri Balaji Motors.' },
  fallback: {
    templateKey: 'ready_for_delivery',
    body: 'Your Swift is ready for pickup at Sri Balaji Motors.',
    language: 'en',
  },
};

class StubSender implements ChannelSender {
  readonly sent: ChannelSendRequest[] = [];
  private queue: (Error | null)[] = [];

  constructor(readonly channel: ChannelType) {}

  failNext(...errors: Error[]): void {
    this.queue.push(...errors);
  }

  async send(request: ChannelSendRequest): Promise<ChannelSendResult> {
    const failure = this.queue.shift();
    if (failure != null) throw failure;
    this.sent.push(request);
    return {
      providerMessageId: `${this.channel.toLowerCase()}-${this.sent.length}`,
      providerConversationId: null,
      category: 'UTILITY',
    };
  }
}

const outage = (): WhatsAppError =>
  new WhatsAppError('PROVIDER_UNAVAILABLE', 'graph.facebook.com timed out');

describe('smsSegments', () => {
  it('counts a short English message as one segment', () => {
    expect(smsSegments('Your Swift is ready.')).toBe(1);
  });

  it('charges Tamil at the UCS-2 rate', () => {
    // The figure that surprises a shop owner: the same sentence costs four
    // times as much in Tamil, because it forces UCS-2 at 70 characters.
    const tamil = 'உங்கள் வாகனம் தயாராக உள்ளது. தயவுசெய்து வந்து எடுத்துச் செல்லவும். நன்றி.';
    expect(tamil.length).toBeGreaterThan(70);
    expect(smsSegments(tamil)).toBeGreaterThan(1);
  });

  it('never reports zero segments for an empty body', () => {
    expect(smsSegments('')).toBe(1);
  });
});

describe('SmsChannelSender', () => {
  it('sends under the shop-registered DLT template id', async () => {
    const sms = new SandboxSmsAdapter();
    const sender = new SmsChannelSender(sms, async () => SETTINGS);

    const result = await sender.send(textRequest);

    expect(result.channel).toBe('SMS');
    // Null, not a fabricated UTILITY: SMS has no WhatsApp conversation, and a
    // guess here would double-count the message in the cost rollup.
    expect(result.category).toBeNull();
    expect(sms.sentTo('+919876543210')[0]?.dltTemplateId).toBe('DLT-1007');
    expect(sms.sentTo('+919876543210')[0]?.senderId).toBe('SLOOPS');
  });

  it('refuses a message whose composer supplied no fallback', async () => {
    const sender = new SmsChannelSender(new SandboxSmsAdapter(), async () => SETTINGS);
    const { fallback: _drop, ...noFallback } = textRequest;

    await expect(sender.send(noFallback)).rejects.toMatchObject({
      code: 'SMS_NO_FALLBACK_CONTENT',
    });
  });

  it('refuses a template the shop has not registered with the DLT registry', async () => {
    const sender = new SmsChannelSender(new SandboxSmsAdapter(), async () => ({
      ...SETTINGS,
      dltTemplateIds: {},
    }));

    // The important half: it refuses rather than sending something the operator
    // would accept and silently drop.
    await expect(sender.send(textRequest)).rejects.toMatchObject({
      code: 'SMS_TEMPLATE_NOT_REGISTERED',
    });
  });

  it('refuses when the shop has not switched the rung on', async () => {
    const sender = new SmsChannelSender(new SandboxSmsAdapter(), async () => ({
      ...SETTINGS,
      enabled: false,
    }));
    await expect(sender.send(textRequest)).rejects.toMatchObject({
      code: 'SMS_FALLBACK_DISABLED',
    });
  });

  it('refuses to text the staff evidence group', async () => {
    const sender = new SmsChannelSender(new SandboxSmsAdapter(), async () => SETTINGS);
    await expect(sender.send({ ...textRequest, to: 'group:120363@g.us' })).rejects.toMatchObject({
      code: 'SMS_NO_GROUP_CHANNEL',
    });
  });
});

describe('ChannelFailoverSender — the WhatsApp outage drill', () => {
  it('falls back to SMS on a transport failure and reports the channel that carried it', async () => {
    const whatsapp = new StubSender('WHATSAPP');
    const sms = new StubSender('SMS');
    const sender = new ChannelFailoverSender(whatsapp, sms, {
      threshold: 3,
      probeAfterMs: 60_000,
    });

    whatsapp.failNext(outage());
    const result = await sender.send(textRequest);

    expect(result.channel).toBe('SMS');
    expect(sms.sent).toHaveLength(1);
    // The row is still *written* as WHATSAPP — what the system meant to do —
    // and the result says what actually happened.
    expect(sender.channel).toBe('WHATSAPP');
  });

  it('does NOT fall back when WhatsApp rejects the message on its merits', async () => {
    const whatsapp = new StubSender('WHATSAPP');
    const sms = new StubSender('SMS');
    const sender = new ChannelFailoverSender(whatsapp, sms, { threshold: 3, probeAfterMs: 60_000 });

    // A template Meta has not approved will not be approved on the retry
    // either, and sending it over SMS would route around a refusal.
    whatsapp.failNext(new WhatsAppError('TEMPLATE_INVALID', 'template not approved'));

    await expect(sender.send(textRequest)).rejects.toMatchObject({ kind: 'TEMPLATE_INVALID' });
    expect(sms.sent).toEqual([]);
  });

  it('opens the circuit after the threshold and stops waiting on WhatsApp', async () => {
    const whatsapp = new StubSender('WHATSAPP');
    const sms = new StubSender('SMS');
    const events: string[] = [];
    const sender = new ChannelFailoverSender(whatsapp, sms, {
      threshold: 2,
      probeAfterMs: 60_000,
      onStateChange: (event) => events.push(event.state),
    });

    whatsapp.failNext(outage(), outage());
    await sender.send(textRequest);
    expect(sender.primaryDown).toBe(false); // one failure is not an outage
    await sender.send(textRequest);
    expect(sender.primaryDown).toBe(true);

    // The third send must not touch WhatsApp at all. Without the circuit,
    // every message in an outage waits out a full HTTP timeout first.
    await sender.send(textRequest);
    expect(whatsapp.sent).toEqual([]);
    expect(sms.sent).toHaveLength(3);
    expect(events).toContain('DOWN');
  });

  it('recovers once WhatsApp answers again', async () => {
    const clock = { now: new Date('2026-09-01T10:00:00Z') };
    const whatsapp = new StubSender('WHATSAPP');
    const sms = new StubSender('SMS');
    const events: string[] = [];
    const sender = new ChannelFailoverSender(whatsapp, sms, {
      threshold: 1,
      probeAfterMs: 60_000,
      now: () => clock.now,
      onStateChange: (event) => events.push(event.state),
    });

    whatsapp.failNext(outage());
    await sender.send(textRequest);
    expect(sender.primaryDown).toBe(true);

    // The probe window elapses; the next send tries WhatsApp again.
    clock.now = new Date('2026-09-01T10:01:01Z');
    const result = await sender.send(textRequest);

    expect(result.channel).toBeUndefined(); // straight WhatsApp, no override
    expect(whatsapp.sent).toHaveLength(1);
    expect(sender.primaryDown).toBe(false);
    expect(events).toContain('RECOVERED');
  });

  it('re-raises the primary failure when the fallback also fails', async () => {
    const whatsapp = new StubSender('WHATSAPP');
    const sms = new StubSender('SMS');
    const sender = new ChannelFailoverSender(whatsapp, sms, { threshold: 3, probeAfterMs: 1_000 });

    whatsapp.failNext(outage());
    sms.failNext(new SmsSendError('no DLT id', 'SMS_TEMPLATE_NOT_REGISTERED', false));

    // Both reasons, primary first. During an incident the operator's question
    // is "why is WhatsApp broken", and an SMS error alone sends them elsewhere.
    await expect(sender.send(textRequest)).rejects.toThrow(
      /WHATSAPP failed \(graph\.facebook\.com timed out\).*SMS fallback also failed/s,
    );
  });
});

/** The JSON a mocked `fetch` was called with. */
function requestBody(fetchImpl: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
  if (init === undefined) throw new Error('fetch was never called');
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

describe('DltSmsAdapter', () => {
  const config = {
    baseUrl: 'https://api.sms-provider.example',
    apiKey: 'key',
    entityId: 'ENTITY-1',
    senderId: 'SLOOPS',
    timeoutMs: 5_000,
  };

  it('puts the entity id, header and template id on the wire', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ message_id: 'p-1' }), { status: 200 }),
    );
    const adapter = new DltSmsAdapter(config, fetchImpl as unknown as typeof fetch);

    await adapter.send({
      shopId: 'shop-1',
      to: '+919876543210',
      dltTemplateId: 'DLT-1007',
      body: 'Your Swift is ready.',
      language: 'en',
    });

    const body = requestBody(fetchImpl);
    expect(body).toMatchObject({
      entity_id: 'ENTITY-1',
      template_id: 'DLT-1007',
      sender: 'SLOOPS',
      unicode: false,
    });
  });

  it('declares Unicode for a Tamil body', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ message_id: 'p-2' }), { status: 200 }),
    );
    const adapter = new DltSmsAdapter(config, fetchImpl as unknown as typeof fetch);

    await adapter.send({
      shopId: 'shop-1',
      to: '+919876543210',
      dltTemplateId: 'DLT-1007',
      body: 'உங்கள் வாகனம் தயார்.',
      language: 'ta',
    });

    const body = requestBody(fetchImpl);
    // Getting this wrong delivers a screen of question marks.
    expect(body.unicode).toBe(true);
  });

  it('refuses to send without a template id rather than being silently dropped', async () => {
    const fetchImpl = vi.fn();
    const adapter = new DltSmsAdapter(config, fetchImpl as unknown as typeof fetch);

    await expect(
      adapter.send({
        shopId: 'shop-1',
        to: '+919876543210',
        dltTemplateId: '',
        body: 'x',
        language: 'en',
      }),
    ).rejects.toMatchObject({ code: 'DLT_TEMPLATE_MISSING' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('marks a 5xx retryable and a 400 not', async () => {
    const adapter = (status: number) =>
      new DltSmsAdapter(
        config,
        (async () => new Response(JSON.stringify({ error: 'no' }), { status })) as typeof fetch,
      );
    const request = {
      shopId: 'shop-1',
      to: '+919876543210',
      dltTemplateId: 'DLT-1007',
      body: 'x',
      language: 'en' as const,
    };

    await expect(adapter(503).send(request)).rejects.toMatchObject({ retryable: true });
    await expect(adapter(400).send(request)).rejects.toMatchObject({ retryable: false });
  });

  it('fails a 200 that carries no message id', async () => {
    const adapter = new DltSmsAdapter(
      config,
      (async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 })) as typeof fetch,
    );
    // Reporting success for a message we cannot track would put a SENT row in
    // front of an advisor for something that may never have left the gateway.
    await expect(
      adapter.send({
        shopId: 'shop-1',
        to: '+919876543210',
        dltTemplateId: 'DLT-1007',
        body: 'x',
        language: 'en',
      }),
    ).rejects.toMatchObject({ code: 'SMS_NO_MESSAGE_ID' });
  });
});
