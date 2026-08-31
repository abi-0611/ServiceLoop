import { defaultShopConfig, type ShopConfig } from '@serviceloop/config';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConsentService } from './consent';
import { OutboundGate, type GateOutcome, type OutboundRequest } from './outbound-gate';
import { InboundRouter } from './router';
import {
  ConversationSessionService,
  CUSTOMER_SERVICE_WINDOW_MS,
  isWindowOpen,
  personThreadKey,
  windowExpiryFrom,
} from './session';
import type { InboundMessage, OutboundContent } from './types';
import {
  createDomainTestHarness,
  type DomainTestHarness,
  type MemoryTx,
} from '../testing/in-memory';
import {
  InMemoryConsentStore,
  InMemoryConversationStore,
  InMemoryCustomerLookup,
  InMemoryMessageStore,
  RecordingChannelSender,
  testBlindIndex,
} from '../testing/in-memory-messaging';

/**
 * Channels, sessions, consent and the outbound gate.
 *
 * The clock is a mutable variable rather than wall time throughout, so the
 * 24-hour window, quiet hours and frequency caps are tested by *moving time*
 * rather than by waiting for it.
 */

const SHOP = '01920000-0000-7000-8000-0000000000aa';
const CUSTOMER_ID = '01920000-0000-7000-8000-0000000000bb';
const CUSTOMER_PHONE = '+919841100001';
const TECHNICIAN_ID = '01920000-0000-7000-8000-0000000000cc';
const TECHNICIAN_PHONE = '+919840012003';
const STAFF_GROUP_ID = '120363000000000000';
const TRACE = 'trace-messaging';

/** 2026-08-14, 14:00 IST — inside business hours, outside quiet hours. */
const T0 = new Date('2026-08-14T08:30:00.000Z');

interface World {
  readonly harness: DomainTestHarness;
  readonly sessions: ConversationSessionService<MemoryTx>;
  readonly router: InboundRouter<MemoryTx>;
  readonly gate: OutboundGate<MemoryTx>;
  readonly consents: ConsentService<MemoryTx>;
  readonly sender: RecordingChannelSender;
  readonly conversations: InMemoryConversationStore;
  readonly messages: InMemoryMessageStore;
  setNow(at: Date): void;
  now(): Date;
}

function build(configPatch: Partial<ShopConfig> = {}): World {
  let current = new Date(T0);
  const now = (): Date => new Date(current);
  const harness = createDomainTestHarness(now);
  const clock = { now };

  harness.world.addShop(SHOP, 'Asia/Kolkata');
  harness.world.configs.set(SHOP, { ...defaultShopConfig('Asia/Kolkata'), ...configPatch });
  harness.world.addCustomer(SHOP, CUSTOMER_PHONE, CUSTOMER_ID, 'ta');
  harness.world.addStaff(SHOP, TECHNICIAN_PHONE, TECHNICIAN_ID);

  const conversations = new InMemoryConversationStore(harness.world);
  const messages = new InMemoryMessageStore(harness.world);
  const consentStore = new InMemoryConsentStore(harness.world);
  const customers = new InMemoryCustomerLookup(harness.world);
  const sender = new RecordingChannelSender();

  const sessions = new ConversationSessionService<MemoryTx>({
    uow: harness.uow,
    conversations,
    customers,
    audit: harness.audit,
    outbox: harness.outbox,
    blindIndex: testBlindIndex,
    clock,
  });

  const consents = new ConsentService<MemoryTx>({
    uow: harness.uow,
    consents: consentStore,
    audit: harness.audit,
    outbox: harness.outbox,
    clock,
  });

  const router = new InboundRouter<MemoryTx>({
    uow: harness.uow,
    conversations,
    messages,
    customers,
    config: harness.config,
    sessions,
    consents,
    audit: harness.audit,
    outbox: harness.outbox,
    clock,
  });

  const gate = new OutboundGate<MemoryTx>({
    uow: harness.uow,
    conversations,
    messages,
    consents: consentStore,
    config: harness.config,
    audit: harness.audit,
    outbox: harness.outbox,
    sender,
    clock,
  });

  return {
    harness,
    sessions,
    router,
    gate,
    consents,
    sender,
    conversations,
    messages,
    setNow: (at) => {
      current = new Date(at);
    },
    now,
  };
}

let sequence = 0;

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  sequence += 1;
  return {
    channel: 'WHATSAPP',
    kind: 'TEXT',
    providerMessageId: `wamid.IN${sequence}`,
    from: CUSTOMER_PHONE,
    fromDisplayName: 'Anand',
    groupId: null,
    timestamp: new Date(T0),
    text: 'Vandi ready ah?',
    caption: null,
    media: null,
    replyId: null,
    replyTitle: null,
    contextProviderMessageId: null,
    location: null,
    reaction: null,
    ...overrides,
  };
}

const TEXT = (body: string): OutboundContent => ({ kind: 'text', body });

/**
 * An approved template for an AI-operated shop carries the disclosure in its
 * registered body, so the rendered preview does too — the gate checks the copy
 * that will actually reach the customer, template or not.
 */
const TEMPLATE: OutboundContent = {
  kind: 'template',
  templateName: 'job_card_opened',
  templateLanguage: 'ta',
  category: 'UTILITY',
  variables: ['JC-2026-0001'],
  preview:
    'This is the ServiceLoop assistant, an AI assistant for Sri Murugan Auto Works. Job card JC-2026-0001 opened for your Swift.',
};

const DISCLOSED = (body: string): OutboundContent =>
  TEXT(`I am an AI assistant from Sri Murugan Auto Works. ${body}`);

function request(world: World, conversationId: string, overrides: Partial<OutboundRequest> = {}): OutboundRequest {
  return {
    shopId: SHOP,
    conversationId,
    customerId: CUSTOMER_ID,
    purpose: 'SERVICE',
    content: DISCLOSED('Your vehicle is ready.'),
    actor: { type: 'AGENT', id: null },
    traceId: TRACE,
    flow: 'status',
    ...overrides,
  };
}

async function grantService(world: World): Promise<void> {
  await world.consents.record({
    shopId: SHOP,
    customerId: CUSTOMER_ID,
    purpose: 'SERVICE',
    status: 'GRANTED',
    channel: 'WHATSAPP',
    source: 'COUNTER_HANDOVER',
    evidence: 'Signed job card at the counter',
    actor: { type: 'STAFF', id: null },
    traceId: TRACE,
  });
}

/* -------------------------------------------------------------------------- *
 * Window arithmetic
 * -------------------------------------------------------------------------- */

describe('24-hour customer-service window', () => {
  it('expires exactly 24 hours after the inbound message', () => {
    const expiry = windowExpiryFrom(T0);
    expect(expiry.getTime() - T0.getTime()).toBe(CUSTOMER_SERVICE_WINDOW_MS);
  });

  it('is open a millisecond before the boundary and closed on it', () => {
    const expiry = windowExpiryFrom(T0);
    expect(isWindowOpen(expiry, new Date(expiry.getTime() - 1))).toBe(true);
    // Closed *on* the boundary: Meta rounds against us, and a 131047 costs more
    // than spending a template would have.
    expect(isWindowOpen(expiry, expiry)).toBe(false);
    expect(isWindowOpen(expiry, new Date(expiry.getTime() + 1))).toBe(false);
  });

  it('treats a thread that has never received an inbound message as closed', () => {
    expect(isWindowOpen(null, T0)).toBe(false);
  });
});

describe('thread keys', () => {
  it('never stores a raw phone number as the thread key', () => {
    const key = personThreadKey(testBlindIndex(SHOP, CUSTOMER_PHONE));
    expect(key.startsWith('wa:')).toBe(true);
    expect(key).not.toContain('9841100001');
  });

  it('gives the same number a different key in a different shop', () => {
    expect(testBlindIndex(SHOP, CUSTOMER_PHONE)).not.toBe(
      testBlindIndex('other-shop', CUSTOMER_PHONE),
    );
  });
});

/* -------------------------------------------------------------------------- *
 * Router
 * -------------------------------------------------------------------------- */

describe('inbound router', () => {
  let world: World;

  beforeEach(() => {
    world = build();
  });

  it('opens a customer thread and starts the window', async () => {
    const routed = await world.router.route({
      shopId: SHOP,
      channel: 'WHATSAPP',
      message: inbound(),
      traceId: TRACE,
    });

    expect(routed.conversationKind).toBe('CUSTOMER');
    expect(routed.customerId).toBe(CUSTOMER_ID);
    expect(routed.followUps).toEqual([{ kind: 'CONVERSATION' }]);
    expect(routed.windowExpiresAt?.getTime()).toBe(T0.getTime() + CUSTOMER_SERVICE_WINDOW_MS);
    // The customer's stored language wins over the shop default.
    expect(routed.language).toBe('ta');
  });

  it('classifies an unrecognised number as UNKNOWN and asks who it is', async () => {
    const routed = await world.router.route({
      shopId: SHOP,
      channel: 'WHATSAPP',
      message: inbound({ from: '+919999888877', fromDisplayName: null }),
      traceId: TRACE,
    });

    expect(routed.conversationKind).toBe('UNKNOWN');
    expect(routed.customerId).toBeNull();
    expect(routed.followUps).toContainEqual({ kind: 'IDENTIFY_UNKNOWN_NUMBER' });
  });

  it('routes the configured staff group as the evidence channel and attributes the sender', async () => {
    const staffWorld = build({
      messaging: {
        staffGroupId: STAFF_GROUP_ID,
        whatsappPhoneNumberId: null,
        templates: { reengagement: null, jobCardOpened: null, readyForDelivery: null },
        defaultOutboundLanguage: 'en',
      },
    });

    const routed = await staffWorld.router.route({
      shopId: SHOP,
      channel: 'WHATSAPP',
      message: inbound({ from: TECHNICIAN_PHONE, groupId: STAFF_GROUP_ID, text: 'Pads at 2mm' }),
      traceId: TRACE,
    });

    expect(routed.conversationKind).toBe('STAFF_GROUP');
    expect(routed.senderStaffId).toBe(TECHNICIAN_ID);
  });

  it('refuses evidence-channel privileges to a group that is not the configured one', async () => {
    const routed = await world.router.route({
      shopId: SHOP,
      channel: 'WHATSAPP',
      message: inbound({ groupId: 'some-other-group', text: 'hello' }),
      traceId: TRACE,
    });

    expect(routed.conversationKind).toBe('UNKNOWN');
    // No automated reply is proposed for a group we do not recognise.
    expect(routed.followUps).toEqual([{ kind: 'CONVERSATION' }]);
  });

  it('processes a redelivered webhook exactly once', async () => {
    const message = inbound();
    const first = await world.router.route({
      shopId: SHOP,
      channel: 'WHATSAPP',
      message,
      traceId: TRACE,
    });
    const second = await world.router.route({
      shopId: SHOP,
      channel: 'WHATSAPP',
      message,
      traceId: TRACE,
    });

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.messageId).toBe(first.messageId);
    expect(world.harness.world.messagesFor(first.conversationId)).toHaveLength(1);
    expect(world.harness.world.eventsOfType('message.received')).toHaveLength(1);
  });

  it('flags a captioned photo from a customer as an intake trigger', async () => {
    const routed = await world.router.route({
      shopId: SHOP,
      channel: 'WHATSAPP',
      message: inbound({
        kind: 'IMAGE',
        text: '',
        caption: '#jobcard',
        media: {
          providerMediaId: 'media-1',
          mimeType: 'image/jpeg',
          kind: 'PHOTO',
          sha256: null,
          fileSizeBytes: 1024,
          filename: null,
          isVoiceNote: false,
        },
      }),
      traceId: TRACE,
    });

    expect(routed.followUps).toContainEqual({ kind: 'RUN_INTAKE', source: 'PHOTO' });
  });

  it('does not treat an uncaptioned customer photo as a job card', async () => {
    const routed = await world.router.route({
      shopId: SHOP,
      channel: 'WHATSAPP',
      message: inbound({
        kind: 'IMAGE',
        text: '',
        caption: 'look at this scratch',
        media: {
          providerMediaId: 'media-2',
          mimeType: 'image/jpeg',
          kind: 'PHOTO',
          sha256: null,
          fileSizeBytes: 1024,
          filename: null,
          isVoiceNote: false,
        },
      }),
      traceId: TRACE,
    });

    expect(routed.followUps).toEqual([{ kind: 'CONVERSATION' }]);
  });

  it('treats any photo in the staff group as an intake, caption or not', async () => {
    const staffWorld = build({
      messaging: {
        staffGroupId: STAFF_GROUP_ID,
        whatsappPhoneNumberId: null,
        templates: { reengagement: null, jobCardOpened: null, readyForDelivery: null },
        defaultOutboundLanguage: 'en',
      },
    });

    const routed = await staffWorld.router.route({
      shopId: SHOP,
      channel: 'WHATSAPP',
      message: inbound({
        kind: 'IMAGE',
        from: TECHNICIAN_PHONE,
        groupId: STAFF_GROUP_ID,
        text: '',
        caption: null,
        media: {
          providerMediaId: 'media-3',
          mimeType: 'image/jpeg',
          kind: 'PHOTO',
          sha256: null,
          fileSizeBytes: 2048,
          filename: null,
          isVoiceNote: false,
        },
      }),
      traceId: TRACE,
    });

    expect(routed.followUps).toContainEqual({ kind: 'RUN_INTAKE', source: 'PHOTO' });
  });

  it('surfaces a button tap as an interactive reply', async () => {
    const routed = await world.router.route({
      shopId: SHOP,
      channel: 'WHATSAPP',
      message: inbound({
        kind: 'BUTTON_REPLY',
        text: '',
        replyId: 'confirm:draft-1',
        replyTitle: 'Confirm',
      }),
      traceId: TRACE,
    });

    expect(routed.followUps).toContainEqual({
      kind: 'INTERACTIVE_REPLY',
      replyId: 'confirm:draft-1',
      title: 'Confirm',
    });
  });

  it('routes a request for a person to a human handoff (L6)', async () => {
    const routed = await world.router.route({
      shopId: SHOP,
      channel: 'WHATSAPP',
      message: inbound({ text: 'HUMAN' }),
      traceId: TRACE,
    });
    expect(routed.followUps).toContainEqual({ kind: 'HUMAN_HANDOFF_REQUESTED' });
  });
});

/* -------------------------------------------------------------------------- *
 * Opt-out
 * -------------------------------------------------------------------------- */

describe('opt-out keywords', () => {
  it.each([
    ['STOP', 'en'],
    ['stop.', 'en punctuated'],
    ['UNSUBSCRIBE', 'en long form'],
    ['நிறுத்து', 'Tamil'],
    ['niruthu', 'Tamil transliterated'],
    ['बंद करो', 'Hindi'],
    ['band karo', 'Hindi transliterated'],
  ])('revokes consent instantly for %s (%s)', async (text) => {
    const world = build();
    await grantService(world);

    const routed = await world.router.route({
      shopId: SHOP,
      channel: 'WHATSAPP',
      message: inbound({ text }),
      traceId: TRACE,
    });

    expect(routed.followUps).toEqual([{ kind: 'ACKNOWLEDGE_OPT_OUT' }]);

    const state = await world.consents.current(SHOP, CUSTOMER_ID);
    expect(state.service?.status).toBe('REVOKED');
    // A blanket STOP is not "only the service ones".
    expect(state.marketing?.status).toBe('REVOKED');
  });

  it('audits the revocation with the customer’s own words', async () => {
    const world = build();
    await grantService(world);
    await world.router.route({
      shopId: SHOP,
      channel: 'WHATSAPP',
      message: inbound({ text: 'STOP' }),
      traceId: TRACE,
    });

    expect(world.harness.world.auditActions()).toContain('consent.updated');
    // The initial counter grant, then the SERVICE and MARKETING revocations.
    expect(world.harness.world.eventsOfType('consent.updated')).toHaveLength(3);
  });

  it('does not opt out a customer who used a stop-word inside a sentence', async () => {
    const world = build();
    await grantService(world);

    const routed = await world.router.route({
      shopId: SHOP,
      channel: 'WHATSAPP',
      message: inbound({ text: 'please stop the AC work, only do the brakes' }),
      traceId: TRACE,
    });

    expect(routed.followUps).toEqual([{ kind: 'CONVERSATION' }]);
    expect((await world.consents.current(SHOP, CUSTOMER_ID)).service?.status).toBe('GRANTED');
  });

  it('does not read a Tamil "no thanks" as an unsubscribe', async () => {
    const world = build();
    await grantService(world);

    // "வேண்டாம்" answers a question; it must not silence the thread.
    const routed = await world.router.route({
      shopId: SHOP,
      channel: 'WHATSAPP',
      message: inbound({ text: 'வேண்டாம்' }),
      traceId: TRACE,
    });

    expect(routed.followUps).toEqual([{ kind: 'CONVERSATION' }]);
    expect((await world.consents.current(SHOP, CUSTOMER_ID)).service?.status).toBe('GRANTED');
  });

  it('restores service consent on START', async () => {
    const world = build();
    await grantService(world);
    await world.router.route({
      shopId: SHOP,
      channel: 'WHATSAPP',
      message: inbound({ text: 'STOP' }),
      traceId: TRACE,
    });
    const routed = await world.router.route({
      shopId: SHOP,
      channel: 'WHATSAPP',
      message: inbound({ text: 'START' }),
      traceId: TRACE,
    });

    expect(routed.followUps).toEqual([{ kind: 'ACKNOWLEDGE_OPT_IN' }]);
    expect((await world.consents.current(SHOP, CUSTOMER_ID)).service?.status).toBe('GRANTED');
    // Marketing is *not* restored: purpose limitation cuts both ways.
    expect((await world.consents.current(SHOP, CUSTOMER_ID)).marketing?.status).toBe('REVOKED');
  });
});

/* -------------------------------------------------------------------------- *
 * OutboundGate
 * -------------------------------------------------------------------------- */

describe('OutboundGate', () => {
  let world: World;
  let conversationId: string;

  beforeEach(async () => {
    world = build({ autonomy: { approval: 'L2_CONVERSATIONAL', status: 'L2_CONVERSATIONAL', delivery: 'L2_CONVERSATIONAL', retention: 'L2_CONVERSATIONAL', voice: 'L0_SHADOW' } });
    const routed = await world.router.route({
      shopId: SHOP,
      channel: 'WHATSAPP',
      message: inbound(),
      traceId: TRACE,
    });
    conversationId = routed.conversationId;
  });

  it('sends inside an open window without stored consent, because the customer wrote first', async () => {
    const outcome = await world.gate.send(request(world, conversationId));
    expect(outcome.status).toBe('SENT');
    expect(world.sender.sent).toHaveLength(1);
  });

  it('blocks a business-initiated send with no consent once the window has closed', async () => {
    world.setNow(new Date(T0.getTime() + CUSTOMER_SERVICE_WINDOW_MS + 1000));

    const outcome = await world.gate.send(request(world, conversationId, { content: TEMPLATE }));
    expect(outcome.status).toBe('BLOCKED');
    if (outcome.status === 'BLOCKED') expect(outcome.code).toBe('CONSENT_MISSING');
    expect(world.sender.sent).toHaveLength(0);
  });

  it('records a blocked send as an auditable BLOCKED row, never a silent drop', async () => {
    world.setNow(new Date(T0.getTime() + CUSTOMER_SERVICE_WINDOW_MS + 1000));
    const outcome = await world.gate.send(request(world, conversationId, { content: TEMPLATE }));

    const rows = world.harness.world.messagesFor(conversationId);
    const blocked = rows.find((row) => row.id === outcome.messageId);
    expect(blocked?.status).toBe('BLOCKED');
    expect(blocked?.blockedCode).toBe('CONSENT_MISSING');
    expect(blocked?.blockedReason?.length ?? 0).toBeGreaterThan(0);
    expect(world.harness.world.eventsOfType('message.blocked')).toHaveLength(1);
    expect(world.harness.world.auditActions()).toContain('message.blocked');
  });

  it('requires a template once the window has closed, even with consent', async () => {
    await grantService(world);
    world.setNow(new Date(T0.getTime() + CUSTOMER_SERVICE_WINDOW_MS + 1000));

    const outcome = await world.gate.send(request(world, conversationId));
    expect(outcome.status).toBe('BLOCKED');
    if (outcome.status === 'BLOCKED') expect(outcome.code).toBe('WINDOW_CLOSED_NEEDS_TEMPLATE');
  });

  it('allows a template outside the window when consent is on record', async () => {
    await grantService(world);
    world.setNow(new Date(T0.getTime() + CUSTOMER_SERVICE_WINDOW_MS + 1000));

    const outcome = await world.gate.send(request(world, conversationId, { content: TEMPLATE }));
    expect(outcome.status).toBe('SENT');
  });

  it('blocks everything after a revocation except the opt-out acknowledgement', async () => {
    await grantService(world);
    await world.router.route({
      shopId: SHOP,
      channel: 'WHATSAPP',
      message: inbound({ text: 'STOP' }),
      traceId: TRACE,
    });

    const blocked = await world.gate.send(request(world, conversationId));
    expect(blocked.status).toBe('BLOCKED');
    if (blocked.status === 'BLOCKED') expect(blocked.code).toBe('CONSENT_REVOKED');

    const ack = await world.gate.send(
      request(world, conversationId, {
        consentFlow: 'OPT_OUT_ACK',
        content: TEXT('You will not receive further messages. Reply START to resume.'),
        isHumanReply: false,
      }),
    );
    expect(ack.status).toBe('SENT');
  });

  it('never lets a SERVICE grant imply MARKETING', async () => {
    await grantService(world);
    const outcome = await world.gate.send(
      request(world, conversationId, { purpose: 'MARKETING', flow: 'retention' }),
    );

    expect(outcome.status).toBe('BLOCKED');
    if (outcome.status === 'BLOCKED') expect(outcome.code).toBe('CONSENT_MISSING');
  });

  it('defers a quiet-hours message to a scheduled time instead of dropping it', async () => {
    // 22:30 IST — inside the default 21:00–08:00 quiet window.
    world.setNow(new Date('2026-08-14T17:00:00.000Z'));

    const outcome = await world.gate.send(request(world, conversationId));
    expect(outcome.status).toBe('DEFERRED');
    if (outcome.status !== 'DEFERRED') return;

    expect(outcome.deferUntil.getTime()).toBeGreaterThan(world.now().getTime());
    expect(world.sender.sent).toHaveLength(0);

    const row = world.harness.world
      .messagesFor(conversationId)
      .find((candidate) => candidate.id === outcome.messageId);
    expect(row?.status).toBe('QUEUED');
    expect(row?.scheduledFor?.getTime()).toBe(outcome.deferUntil.getTime());
    expect(world.harness.world.eventsOfType('message.deferred')).toHaveLength(1);
  });

  it('sends an opt-out acknowledgement during quiet hours anyway', async () => {
    await grantService(world);
    world.setNow(new Date('2026-08-14T17:00:00.000Z'));

    const outcome = await world.gate.send(
      request(world, conversationId, {
        consentFlow: 'OPT_OUT_ACK',
        content: TEXT('You will not receive further messages.'),
      }),
    );
    expect(outcome.status).toBe('SENT');
  });

  it('holds a message for a human when the flow is in shadow mode', async () => {
    const shadow = build();
    const routed = await shadow.router.route({
      shopId: SHOP,
      channel: 'WHATSAPP',
      message: inbound(),
      traceId: TRACE,
    });

    const outcome = await shadow.gate.send(request(shadow, routed.conversationId));
    expect(outcome.status).toBe('PENDING_APPROVAL');
    expect(shadow.sender.sent).toHaveLength(0);

    const row = shadow.harness.world
      .messagesFor(routed.conversationId)
      .find((candidate) => candidate.id === outcome.messageId);
    expect(row?.status).toBe('PENDING_APPROVAL');
  });

  it('re-checks consent when a held message is released, so approval is not a free pass', async () => {
    const shadow = build();
    const routed = await shadow.router.route({
      shopId: SHOP,
      channel: 'WHATSAPP',
      message: inbound(),
      traceId: TRACE,
    });

    const held = await shadow.gate.send(request(shadow, routed.conversationId));
    expect(held.status).toBe('PENDING_APPROVAL');

    // The customer opts out while the message waits in the HITL queue.
    await shadow.router.route({
      shopId: SHOP,
      channel: 'WHATSAPP',
      message: inbound({ text: 'STOP' }),
      traceId: TRACE,
    });

    const released = await shadow.gate.release(
      request(shadow, routed.conversationId),
      held.messageId,
      'staff-1',
    );
    expect(released.status).toBe('BLOCKED');
    if (released.status === 'BLOCKED') expect(released.code).toBe('CONSENT_REVOKED');
    expect(shadow.sender.sent).toHaveLength(0);
  });

  it('lets a human advisor reply without an AI disclosure, but not without consent', async () => {
    const outcome = await world.gate.send(
      request(world, conversationId, {
        content: TEXT('Sure, I will check and call you back. — Priya'),
        isHumanReply: true,
        actor: { type: 'STAFF', id: 'staff-1' },
      }),
    );
    expect(outcome.status).toBe('SENT');
  });

  it('blocks an agent message that omits the mandatory first-contact disclosure', async () => {
    const outcome = await world.gate.send(
      request(world, conversationId, { content: TEXT('Your vehicle is ready.') }),
    );
    expect(outcome.status).toBe('BLOCKED');
    if (outcome.status === 'BLOCKED') expect(outcome.code).toBe('DISCLOSURE_MISSING');
  });

  it('blocks a claim that cites no evidence (L7)', async () => {
    const outcome = await world.gate.send(
      request(world, conversationId, {
        claims: [{ text: 'Your brake pads are dangerously worn', evidence: [] }],
      }),
    );
    expect(outcome.status).toBe('BLOCKED');
    if (outcome.status === 'BLOCKED') expect(outcome.code).toBe('CLAIM_NOT_ANCHORED');
  });

  it('allows the same claim when it cites a technician note', async () => {
    const outcome = await world.gate.send(
      request(world, conversationId, {
        claims: [
          {
            text: 'Your brake pads are worn to 2.1mm',
            evidence: [{ kind: 'TECHNICIAN_NOTE', id: 'note-1' }],
          },
        ],
      }),
    );
    expect(outcome.status).toBe('SENT');
  });

  it('enforces the frequency cap across a burst', async () => {
    await grantService(world);
    const caps = defaultShopConfig().frequencyCaps;

    let sent = 0;
    let blocked: GateOutcome | null = null;
    for (let index = 0; index < caps.maxOutboundPerCustomerPerDay + 1; index += 1) {
      // Step past the minimum interval so the daily cap is what bites.
      world.setNow(new Date(T0.getTime() + index * (caps.minMinutesBetweenMessages + 1) * 60_000));
      const outcome = await world.gate.send(request(world, conversationId));
      if (outcome.status === 'SENT') sent += 1;
      else blocked = outcome;
    }

    expect(sent).toBe(caps.maxOutboundPerCustomerPerDay);
    expect(blocked?.status).toBe('BLOCKED');
    if (blocked?.status === 'BLOCKED') expect(blocked.code).toBe('DAILY_CAP_REACHED');
  });

  it('enforces the minimum interval between two messages', async () => {
    await grantService(world);
    await world.gate.send(request(world, conversationId));

    world.setNow(new Date(T0.getTime() + 60_000));
    const outcome = await world.gate.send(request(world, conversationId));
    expect(outcome.status).toBe('BLOCKED');
    if (outcome.status === 'BLOCKED') expect(outcome.code).toBe('MIN_INTERVAL_NOT_ELAPSED');
  });

  it('records a transport failure against the message rather than losing it', async () => {
    world.sender.failWith = Object.assign(new Error('provider unreachable'), {
      kind: 'PROVIDER_UNAVAILABLE',
    });

    const outcome = await world.gate.send(request(world, conversationId));
    expect(outcome.status).toBe('FAILED');
    if (outcome.status === 'FAILED') expect(outcome.code).toBe('PROVIDER_UNAVAILABLE');

    const row = world.harness.world
      .messagesFor(conversationId)
      .find((candidate) => candidate.id === outcome.messageId);
    expect(row?.status).toBe('FAILED');
    expect(row?.errorCode).toBe('PROVIDER_UNAVAILABLE');
  });

  it('sends to the staff group without consent, but still respects quiet hours', async () => {
    const staffWorld = build({
      messaging: {
        staffGroupId: STAFF_GROUP_ID,
        whatsappPhoneNumberId: null,
        templates: { reengagement: null, jobCardOpened: null, readyForDelivery: null },
        defaultOutboundLanguage: 'en',
      },
      autonomy: {
        approval: 'L2_CONVERSATIONAL',
        status: 'L2_CONVERSATIONAL',
        delivery: 'L2_CONVERSATIONAL',
        retention: 'L2_CONVERSATIONAL',
        voice: 'L0_SHADOW',
      },
    });

    const routed = await staffWorld.router.route({
      shopId: SHOP,
      channel: 'WHATSAPP',
      message: inbound({ from: TECHNICIAN_PHONE, groupId: STAFF_GROUP_ID, text: 'ok' }),
      traceId: TRACE,
    });

    const sent = await staffWorld.gate.send(
      request(staffWorld, routed.conversationId, { customerId: null, content: TEXT('New card JC-1') }),
    );
    expect(sent.status).toBe('SENT');

    staffWorld.setNow(new Date('2026-08-14T17:00:00.000Z'));
    const deferred = await staffWorld.gate.send(
      request(staffWorld, routed.conversationId, {
        customerId: null,
        content: TEXT('Another card'),
      }),
    );
    expect(deferred.status).toBe('DEFERRED');
  });

  it('refuses to message an unidentified thread once its own window has closed', async () => {
    const unknownWorld = build();
    const routed = await unknownWorld.router.route({
      shopId: SHOP,
      channel: 'WHATSAPP',
      message: inbound({ from: '+919999888877', fromDisplayName: null }),
      traceId: TRACE,
    });

    unknownWorld.setNow(new Date(T0.getTime() + CUSTOMER_SERVICE_WINDOW_MS + 1000));
    const outcome = await unknownWorld.gate.send(
      request(unknownWorld, routed.conversationId, { customerId: null, content: TEMPLATE }),
    );

    expect(outcome.status).toBe('BLOCKED');
    if (outcome.status === 'BLOCKED') expect(outcome.code).toBe('UNIDENTIFIED_RECIPIENT');
  });

  it('emits message.sent with the provider id so delivery receipts can be matched', async () => {
    const outcome = await world.gate.send(request(world, conversationId));
    expect(outcome.status).toBe('SENT');

    const events = world.harness.world.eventsOfType('message.sent');
    expect(events).toHaveLength(1);
    const payload = events[0]?.payload as { providerMessageId?: string };
    expect(payload.providerMessageId).toBe(world.sender.sent[0]?.providerMessageId);
  });
});

/* -------------------------------------------------------------------------- *
 * Session service
 * -------------------------------------------------------------------------- */

describe('ConversationSessionService', () => {
  it('answers canSendSessionMessage across the 24-hour boundary', async () => {
    const world = build();
    const routed = await world.router.route({
      shopId: SHOP,
      channel: 'WHATSAPP',
      message: inbound(),
      traceId: TRACE,
    });

    expect(await world.sessions.canSendSessionMessage(SHOP, routed.conversationId)).toBe(true);

    world.setNow(new Date(T0.getTime() + CUSTOMER_SERVICE_WINDOW_MS - 1));
    expect(await world.sessions.canSendSessionMessage(SHOP, routed.conversationId)).toBe(true);

    world.setNow(new Date(T0.getTime() + CUSTOMER_SERVICE_WINDOW_MS));
    expect(await world.sessions.canSendSessionMessage(SHOP, routed.conversationId)).toBe(false);
  });

  it('restarts the window on every new inbound message', async () => {
    const world = build();
    const first = await world.router.route({
      shopId: SHOP,
      channel: 'WHATSAPP',
      message: inbound(),
      traceId: TRACE,
    });

    const later = new Date(T0.getTime() + 20 * 60 * 60 * 1000);
    world.setNow(later);
    const second = await world.router.route({
      shopId: SHOP,
      channel: 'WHATSAPP',
      message: inbound({ timestamp: later }),
      traceId: TRACE,
    });

    expect(second.conversationId).toBe(first.conversationId);
    expect(second.windowExpiresAt?.getTime()).toBe(later.getTime() + CUSTOMER_SERVICE_WINDOW_MS);

    // 30 hours after the first message the window is still open, because the
    // second message reset it.
    world.setNow(new Date(T0.getTime() + 30 * 60 * 60 * 1000));
    expect(await world.sessions.canSendSessionMessage(SHOP, first.conversationId)).toBe(true);
  });

  it('reuses one thread for repeated messages from the same number', async () => {
    const world = build();
    const first = await world.router.route({
      shopId: SHOP,
      channel: 'WHATSAPP',
      message: inbound(),
      traceId: TRACE,
    });
    const second = await world.router.route({
      shopId: SHOP,
      channel: 'WHATSAPP',
      message: inbound({ text: 'and one more thing' }),
      traceId: TRACE,
    });

    expect(second.conversationId).toBe(first.conversationId);
    expect(world.harness.world.conversations.size).toBe(1);
  });

  it('treats the staff group as always open — the window protects customers, not technicians', async () => {
    const staffWorld = build({
      messaging: {
        staffGroupId: STAFF_GROUP_ID,
        whatsappPhoneNumberId: null,
        templates: { reengagement: null, jobCardOpened: null, readyForDelivery: null },
        defaultOutboundLanguage: 'en',
      },
    });
    const routed = await staffWorld.router.route({
      shopId: SHOP,
      channel: 'WHATSAPP',
      message: inbound({ from: TECHNICIAN_PHONE, groupId: STAFF_GROUP_ID }),
      traceId: TRACE,
    });

    staffWorld.setNow(new Date(T0.getTime() + 10 * 24 * 60 * 60 * 1000));
    expect(await staffWorld.sessions.canSendSessionMessage(SHOP, routed.conversationId)).toBe(true);
  });
});
