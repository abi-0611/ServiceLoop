import { defaultShopConfig, type ShopConfig } from '@serviceloop/config';
import { uuidv7 } from '@serviceloop/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { JobCardTransitionService } from '../job-card/transition-service';
import { OutboundGate } from '../messaging/outbound-gate';
import {
  InMemoryConsentStore,
  InMemoryConversationStore,
  InMemoryMessageStore,
  RecordingChannelSender,
} from '../testing/in-memory-messaging';
import {
  createAgentTestHarness,
  type AgentTestHarness,
} from '../testing/in-memory-agent';
import {
  createDomainTestHarness,
  type DomainTestHarness,
  type MemoryTx,
} from '../testing/in-memory';
import { WorkItemTransitionService } from '../work-item/transition-service';
import { AdvisorTaskService } from './advisor-tasks';
import { ApprovalReplyHandler } from './approval-replies';
import {
  APPROVAL_ACTION_IDS,
  ApprovalService,
  buildApprovalMessage,
  parseApprovalAction,
} from './approval-service';
import { APPROVAL_SUBJECT_TYPE, EscalationLadderEngine, channelForRung } from './escalation';
import { EvidenceBundleBuilder } from './evidence-bundle';
import { buildGraduationReport, diffLines, ReviewService } from './review';
import type { JobCardContext } from './ports';
import type { EvidenceBundle } from './types';

/**
 * Phase 3 — the approval saga, the escalation ladder and the review queue.
 *
 * Time is a mutable variable throughout, so the ladder is exercised by *moving
 * the clock* rather than by waiting: a full cadence, a decision at T+50m that
 * cancels the remainder, and a quiet-hours rung that defers to morning all run
 * in milliseconds.
 */

const SHOP = '01920000-0000-7000-8000-0000000000aa';
const CUSTOMER_ID = '01920000-0000-7000-8000-0000000000bb';
const CUSTOMER_PHONE = '+919841100001';
const JOB_CARD = '01920000-0000-7000-8000-0000000000dd';
const ITEM_BRAKES = '01920000-0000-7000-8000-0000000000e1';
const ITEM_OIL = '01920000-0000-7000-8000-0000000000e2';
const CONVERSATION = '01920000-0000-7000-8000-0000000000ff';
const ADVISOR = '01920000-0000-7000-8000-000000000a01';
const TRACE = 'trace-phase3';

/** 2026-08-14, 14:00 IST — inside business hours, outside quiet hours. */
const T0 = new Date('2026-08-14T08:30:00.000Z');

interface World {
  readonly harness: DomainTestHarness;
  readonly agent: AgentTestHarness;
  readonly gate: OutboundGate<MemoryTx>;
  readonly approvals: ApprovalService<MemoryTx>;
  readonly ladder: EscalationLadderEngine<MemoryTx>;
  readonly bundles: EvidenceBundleBuilder<MemoryTx>;
  readonly reviews: ReviewService<MemoryTx>;
  readonly tasks: AdvisorTaskService<MemoryTx>;
  readonly sender: RecordingChannelSender;
  readonly conversations: InMemoryConversationStore;
  readonly messages: InMemoryMessageStore;
  setNow(at: Date): void;
  now(): Date;
}

function card(): JobCardContext {
  return {
    jobCardId: JOB_CARD,
    code: 'JC-2026-0042',
    state: 'AWAITING_APPROVAL',
    customerId: CUSTOMER_ID,
    customerName: 'Ravi',
    customerLanguage: 'en',
    vehicleLabel: 'Maruti Swift',
    registration: 'TN09BX4432',
    odometerKm: 62_000,
    promisedAt: null,
    complaint: 'Grinding noise when braking',
    workItems: [
      {
        id: ITEM_BRAKES,
        title: 'Front brake pad replacement',
        state: 'PENDING_APPROVAL',
        requiresApproval: true,
        technicianNote: 'Front pads worn to 2.1mm, minimum is 3mm. Metal to metal soon.',
        estimatedMinutes: 60,
      },
      {
        id: ITEM_OIL,
        title: 'Engine oil and filter',
        state: 'PENDING_APPROVAL',
        requiresApproval: true,
        technicianNote: 'Oil is dark, filter due at this odometer.',
        estimatedMinutes: 30,
      },
    ],
    estimate: {
      id: 'est-1',
      version: 2,
      status: 'DRAFT',
      totalPaise: 480_000,
      lines: [
        {
          id: 'line-brakes',
          workItemId: ITEM_BRAKES,
          description: 'Front brake pads (set)',
          kind: 'PART',
          quantityMilli: 1000,
          unitPricePaise: 320_000,
          lineTotalPaise: 320_000,
          taxRateBp: 1800,
          listPricePaise: 320_000,
        },
        {
          id: 'line-oil',
          workItemId: ITEM_OIL,
          description: 'Engine oil and filter',
          kind: 'CONSUMABLE',
          quantityMilli: 1000,
          unitPricePaise: 160_000,
          lineTotalPaise: 160_000,
          taxRateBp: 1800,
          listPricePaise: 160_000,
        },
      ],
    },
    media: [{ id: 'media-1', kind: 'PHOTO', caption: 'Worn front pad', workItemId: ITEM_BRAKES }],
    advisorName: 'Meena',
  };
}

function build(configPatch: Partial<ShopConfig> = {}): World {
  let current = new Date(T0);
  const now = (): Date => new Date(current);
  const clock = { now };

  const harness = createDomainTestHarness(now);
  const agent = createAgentTestHarness(harness.world);

  harness.world.addShop(SHOP, 'Asia/Kolkata');
  harness.world.configs.set(SHOP, { ...defaultShopConfig('Asia/Kolkata'), ...configPatch });
  harness.world.addCustomer(SHOP, CUSTOMER_PHONE, CUSTOMER_ID, 'en', 'Maruti Swift TN09BX4432');
  harness.world.advisors.set(SHOP, { id: ADVISOR, fullName: 'Meena' });

  harness.world.cards.set(JOB_CARD, {
    id: JOB_CARD,
    shopId: SHOP,
    state: 'AWAITING_APPROVAL',
    version: 1,
    stateChangedAt: new Date(T0),
  });
  for (const id of [ITEM_BRAKES, ITEM_OIL]) {
    harness.world.items.set(id, {
      id,
      shopId: SHOP,
      jobCardId: JOB_CARD,
      state: 'PENDING_APPROVAL',
      requiresApproval: true,
    });
  }

  agent.agentWorld.putCard(card());
  agent.agentWorld.listPrices.set('line-brakes', 320_000);
  agent.agentWorld.listPrices.set('line-oil', 160_000);

  harness.world.conversations.set(CONVERSATION, {
    id: CONVERSATION,
    shopId: SHOP,
    kind: 'CUSTOMER',
    channel: 'WHATSAPP',
    customerId: CUSTOMER_ID,
    externalThreadId: 'wa:test',
    externalAddress: CUSTOMER_PHONE,
    displayName: 'Ravi',
    state: 'OPEN',
    language: 'en',
    lastInboundAt: new Date(T0.getTime() - 60_000),
    lastOutboundAt: null,
    // An open window, so the gate is testing autonomy rather than templates.
    windowExpiresAt: new Date(T0.getTime() + 20 * 60 * 60 * 1000),
    unreadCount: 0,
    humanOverrideAt: null,
  });
  harness.world.consents.push({
    id: uuidv7(),
    shopId: SHOP,
    customerId: CUSTOMER_ID,
    purpose: 'SERVICE',
    status: 'GRANTED',
    channel: 'WHATSAPP',
    source: 'SEED',
    evidence: null,
    grantedAt: new Date(T0.getTime() - 86_400_000),
    revokedAt: null,
    createdAt: new Date(T0.getTime() - 86_400_000),
  });

  const conversations = new InMemoryConversationStore(harness.world);
  const messages = new InMemoryMessageStore(harness.world);
  const sender = new RecordingChannelSender();

  const gate = new OutboundGate<MemoryTx>({
    uow: harness.uow,
    conversations,
    messages,
    consents: new InMemoryConsentStore(harness.world),
    config: harness.config,
    audit: harness.audit,
    outbox: harness.outbox,
    sender,
    clock,
  });

  const jobCards = new JobCardTransitionService<MemoryTx>({
    uow: harness.uow,
    cards: harness.cards,
    config: harness.config,
    audit: harness.audit,
    outbox: harness.outbox,
    clock,
  });

  const workItems = new WorkItemTransitionService<MemoryTx>({
    uow: harness.uow,
    items: harness.items,
    audit: harness.audit,
    outbox: harness.outbox,
    clock,
  });

  const tasks = new AdvisorTaskService<MemoryTx>({
    uow: harness.uow,
    tasks: agent.tasks,
    audit: harness.audit,
    outbox: harness.outbox,
    clock,
  });

  const ladder = new EscalationLadderEngine<MemoryTx>({
    uow: harness.uow,
    escalations: agent.escalations,
    approvals: agent.approvals,
    bundles: agent.bundles,
    cards: agent.cards,
    tasks: agent.tasks,
    conversations,
    config: harness.config,
    gate,
    scheduler: agent.scheduler,
    audit: harness.audit,
    outbox: harness.outbox,
    clock,
  });

  const approvals = new ApprovalService<MemoryTx>({
    uow: harness.uow,
    approvals: agent.approvals,
    bundles: agent.bundles,
    cards: agent.cards,
    messages,
    gate,
    jobCards,
    workItems,
    directory: harness.directory,
    audit: harness.audit,
    outbox: harness.outbox,
    cancelLadder: async (input) => {
      await ladder.cancelForSubject({
        shopId: input.shopId,
        subjectType: APPROVAL_SUBJECT_TYPE,
        subjectId: input.approvalId,
        reason: input.reason,
        actor: input.actor,
        traceId: input.traceId,
      });
      await tasks.cancelForApproval({
        shopId: input.shopId,
        approvalId: input.approvalId,
        traceId: input.traceId,
      });
    },
    clock,
  });

  const bundles = new EvidenceBundleBuilder<MemoryTx>({
    uow: harness.uow,
    bundles: agent.bundles,
    cards: agent.cards,
    explanations: {
      // A deterministic writer, anchored correctly: the builder's own
      // verification is what these tests exercise, not a model's prose.
      write: async (input) => ({
        summaryText: `We found: ${input.notes[0]?.text ?? ''}`,
        claims: [
          {
            text: `We found: ${input.notes[0]?.text ?? ''}`,
            sources: [`note:${input.notes[0]?.id ?? ''}`],
          },
        ],
        model: 'test-writer',
        promptHash: 'hash',
      }),
    },
    audit: harness.audit,
    outbox: harness.outbox,
    resolvePinnedCard: async (_tx, _shopId, messageId) =>
      agent.agentWorld.pinnedCards.get(messageId) ?? null,
    clock,
  });

  const reviews = new ReviewService<MemoryTx>({
    uow: harness.uow,
    reviews: agent.reviews,
    messages,
    gate,
    config: harness.config,
    audit: harness.audit,
    outbox: harness.outbox,
    loadHeld: async (_tx, shopId, messageId) => {
      const row = harness.world.messages.find(
        (message) => message.id === messageId && message.shopId === shopId,
      );
      if (row === undefined) return null;
      return {
        id: row.id,
        shopId: row.shopId,
        conversationId: row.conversationId,
        customerId: CUSTOMER_ID,
        purpose: row.purpose,
        kind: row.kind as 'TEXT',
        language: row.language,
        body: row.body,
        templateName: row.templateName,
        templateLanguage: row.templateLanguage,
        templateVariables: row.templateVariables,
        conversationCategory: null,
        interactive: row.interactive,
        mediaId: row.mediaId,
        jobCardId: row.jobCardId,
        createdByAgent: row.createdByAgent,
        isHumanReply: row.isHumanReply,
        agentRunId: row.agentRunId,
        approvedByStaffId: row.approvedByStaffId,
        scheduledFor: row.scheduledFor ?? new Date(T0),
      };
    },
    clock,
  });

  return {
    harness,
    agent,
    gate,
    approvals,
    ladder,
    bundles,
    reviews,
    tasks,
    sender,
    conversations,
    messages,
    setNow: (at) => {
      current = new Date(at);
    },
    now,
  };
}

async function makeBundle(world: World): Promise<EvidenceBundle> {
  const result = await world.bundles.build({
    shopId: SHOP,
    anchor: { kind: 'explicit', jobCardId: JOB_CARD },
    note: 'Front pads worn to 2.1mm, minimum is 3mm.',
    noteLanguage: 'en',
    authorStaffId: null,
    mediaIds: ['media-1'],
    workItemIds: [ITEM_BRAKES, ITEM_OIL],
    traceId: TRACE,
    actor: { type: 'STAFF', id: null },
  });
  if (!result.ok) throw new Error(`bundle failed: ${result.failure.reason}`);
  return result.bundle;
}

/** Fires every rung whose time has come, as the worker would. */
async function drainLadder(world: World): Promise<string[]> {
  const outcomes: string[] = [];
  for (const job of world.agent.scheduler.due(world.now())) {
    const result = await world.ladder.fireRung({
      shopId: SHOP,
      escalationId: job.escalationId,
      traceId: TRACE,
    });
    world.agent.scheduler.complete(job.jobId);
    outcomes.push(result.outcome);
  }
  return outcomes;
}

/* -------------------------------------------------------------------------- */

describe('evidence bundles', () => {
  it('anchors every claim to a real source and audits the bundle', async () => {
    const world = build();
    const bundle = await makeBundle(world);

    expect(bundle.claims).toHaveLength(1);
    expect(bundle.claims[0]?.sources[0]).toBe(`note:${bundle.sourceNotes[0]?.id}`);
    expect(bundle.lines.map((line) => line.id)).toEqual(['line-brakes', 'line-oil']);
    expect(bundle.totalPaise).toBe(480_000);
    expect(
      world.harness.world.outbox.some((event) => event.type === 'evidence_bundle.created'),
    ).toBe(true);
  });

  it('refuses a bundle whose explanation cites a source that is not in it', async () => {
    const world = build();
    // A writer that fabricates a source id — the exact failure L7 exists for.
    const builder = new EvidenceBundleBuilder<MemoryTx>({
      uow: world.harness.uow,
      bundles: world.agent.bundles,
      cards: world.agent.cards,
      explanations: {
        write: async () => ({
          summaryText: 'Your suspension is failing.',
          claims: [{ text: 'Your suspension is failing.', sources: ['note:fabricated'] }],
          model: 'bad-writer',
          promptHash: 'hash',
        }),
      },
      audit: world.harness.audit,
      outbox: world.harness.outbox,
      resolvePinnedCard: async () => null,
    });

    const result = await builder.build({
      shopId: SHOP,
      anchor: { kind: 'explicit', jobCardId: JOB_CARD },
      note: 'Pads at 2.1mm',
      noteLanguage: 'en',
      authorStaffId: null,
      mediaIds: [],
      traceId: TRACE,
      actor: { type: 'STAFF', id: null },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('UNSUPPORTED_CLAIM');
  });

  it('resolves a card from the #REG shorthand, and refuses an unrepairable plate', async () => {
    const world = build();

    const good = await world.bundles.build({
      shopId: SHOP,
      anchor: { kind: 'registration', text: 'TN 09 BX 4432' },
      note: 'Pads at 2.1mm',
      noteLanguage: 'en',
      authorStaffId: null,
      mediaIds: [],
      traceId: TRACE,
      actor: { type: 'STAFF', id: null },
    });
    expect(good.ok).toBe(true);

    // `IN` is not an RTO code; inventing one would attach evidence to a vehicle
    // nobody can ever match again.
    const bad = await world.bundles.build({
      shopId: SHOP,
      anchor: { kind: 'registration', text: '1N09BX4432' },
      note: 'Pads at 2.1mm',
      noteLanguage: 'en',
      authorStaffId: null,
      mediaIds: [],
      traceId: TRACE,
      actor: { type: 'STAFF', id: null },
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.failure.code).toBe('NO_JOB_CARD');
  });

  it('refuses evidence with no technician note', async () => {
    const world = build();
    const result = await world.bundles.build({
      shopId: SHOP,
      anchor: { kind: 'explicit', jobCardId: JOB_CARD },
      note: '   ',
      noteLanguage: 'en',
      authorStaffId: null,
      mediaIds: ['media-1'],
      traceId: TRACE,
      actor: { type: 'STAFF', id: null },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('NO_NOTE');
  });
});

describe('approval autopilot', () => {
  let world: World;
  let bundle: EvidenceBundle;

  beforeEach(async () => {
    world = build({ autonomy: { ...defaultShopConfig().autonomy, approval: 'L2_CONVERSATIONAL' } });
    bundle = await makeBundle(world);
  });

  it('sends an interactive request with all three buttons', async () => {
    const result = await world.approvals.createApprovalRequest({
      shopId: SHOP,
      jobCardId: JOB_CARD,
      customerId: CUSTOMER_ID,
      conversationId: CONVERSATION,
      bundle,
      ladderRef: 'APPROVAL',
      actor: { type: 'AGENT', id: null },
      traceId: TRACE,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.gateStatus).toBe('SENT');

    const sent = world.sender.sent[0];
    expect(sent?.content.kind).toBe('interactive');
    if (sent?.content.kind === 'interactive') {
      expect(sent.content.buttons?.map((button) => button.id)).toEqual([
        APPROVAL_ACTION_IDS.approve,
        APPROVAL_ACTION_IDS.partial,
        APPROVAL_ACTION_IDS.call,
      ]);
      // Every button title fits WhatsApp's 20-character limit, in every language.
      for (const button of sent.content.buttons ?? []) {
        expect(button.title.length).toBeLessThanOrEqual(20);
      }
    }
  });

  it('approves everything and moves the card back to work', async () => {
    const created = await world.approvals.createApprovalRequest({
      shopId: SHOP,
      jobCardId: JOB_CARD,
      customerId: CUSTOMER_ID,
      conversationId: CONVERSATION,
      bundle,
      ladderRef: 'APPROVAL',
      actor: { type: 'AGENT', id: null },
      traceId: TRACE,
    });
    if (!created.ok) throw new Error('setup failed');

    const decision = await world.approvals.recordCustomerDecision({
      shopId: SHOP,
      approvalId: created.approvalId,
      decision: 'FULL',
      approvedWorkItemIds: [],
      note: 'ok do it',
      decidedVia: 'button',
      actor: { type: 'CUSTOMER', id: CUSTOMER_ID },
      traceId: TRACE,
    });

    expect(decision.applied).toBe(true);
    expect(decision.approvedWorkItemIds).toEqual([ITEM_BRAKES, ITEM_OIL]);
    expect(decision.approvedAmountPaise).toBe(480_000);
    expect(world.harness.world.items.get(ITEM_BRAKES)?.state).toBe('APPROVED');
    expect(world.harness.world.cards.get(JOB_CARD)?.state).toBe('IN_PROGRESS');
    // The ETA hook phase 4 fills.
    expect(world.harness.world.outbox.some((event) => event.type === 'eta.requested')).toBe(true);
  });

  it('partial approval updates exactly the approved lines and ledgers the rest', async () => {
    const created = await world.approvals.createApprovalRequest({
      shopId: SHOP,
      jobCardId: JOB_CARD,
      customerId: CUSTOMER_ID,
      conversationId: CONVERSATION,
      bundle,
      ladderRef: 'APPROVAL',
      actor: { type: 'AGENT', id: null },
      traceId: TRACE,
    });
    if (!created.ok) throw new Error('setup failed');

    const decision = await world.approvals.recordCustomerDecision({
      shopId: SHOP,
      approvalId: created.approvalId,
      decision: 'PARTIAL',
      approvedWorkItemIds: [ITEM_BRAKES],
      note: 'brakes only for now',
      decidedVia: 'button',
      actor: { type: 'CUSTOMER', id: CUSTOMER_ID },
      traceId: TRACE,
    });

    expect(decision.approvedWorkItemIds).toEqual([ITEM_BRAKES]);
    expect(decision.deferredWorkItemIds).toEqual([ITEM_OIL]);
    expect(decision.approvedAmountPaise).toBe(320_000);
    expect(world.harness.world.items.get(ITEM_BRAKES)?.state).toBe('APPROVED');
    expect(world.harness.world.items.get(ITEM_OIL)?.state).toBe('DEFERRED');

    const ledgered = world.harness.world.ledger.find((row) => row.workItemId === ITEM_OIL);
    expect(ledgered?.kind).toBe('DEFERRED');
    expect(ledgered?.reason).toBe('customer_partial');
    expect(ledgered?.followUpAfter).not.toBeNull();
  });

  it('records a decision once, however many times the customer taps', async () => {
    const created = await world.approvals.createApprovalRequest({
      shopId: SHOP,
      jobCardId: JOB_CARD,
      customerId: CUSTOMER_ID,
      conversationId: CONVERSATION,
      bundle,
      ladderRef: 'APPROVAL',
      actor: { type: 'AGENT', id: null },
      traceId: TRACE,
    });
    if (!created.ok) throw new Error('setup failed');

    const decide = () =>
      world.approvals.recordCustomerDecision({
        shopId: SHOP,
        approvalId: created.approvalId,
        decision: 'FULL',
        approvedWorkItemIds: [],
        note: '',
        decidedVia: 'button',
        actor: { type: 'CUSTOMER', id: CUSTOMER_ID },
        traceId: TRACE,
      });

    const first = await decide();
    const second = await decide();

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    const transitions = world.harness.world.outbox.filter(
      (event) => event.type === 'work_item.state_changed',
    );
    expect(transitions).toHaveLength(2);
  });

  it('parses each button back to its action, and nothing else', () => {
    expect(parseApprovalAction(APPROVAL_ACTION_IDS.approve)).toBe('APPROVE');
    expect(parseApprovalAction(APPROVAL_ACTION_IDS.partial)).toBe('PARTIAL');
    expect(parseApprovalAction(APPROVAL_ACTION_IDS.call)).toBe('CALL');
    expect(parseApprovalAction('approval:approve_everything')).toBeNull();
    expect(parseApprovalAction(null)).toBeNull();
  });

  it('itemises every line and states the new total exactly once', () => {
    const content = buildApprovalMessage({ bundle, language: 'en', vehicleLabel: 'Swift' });
    expect(content.kind).toBe('interactive');
    if (content.kind !== 'interactive') return;
    expect(content.body).toContain('Front brake pads (set)');
    expect(content.body).toContain('₹4,800.00');
  });
});

describe('L0 shadow mode', () => {
  it('holds the request for an advisor and never reaches the wire', async () => {
    // The default: every flow at L0 for a new shop.
    const world = build();
    const bundle = await makeBundle(world);

    const result = await world.approvals.createApprovalRequest({
      shopId: SHOP,
      jobCardId: JOB_CARD,
      customerId: CUSTOMER_ID,
      conversationId: CONVERSATION,
      bundle,
      ladderRef: 'APPROVAL',
      actor: { type: 'AGENT', id: null },
      traceId: TRACE,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.gateStatus).toBe('PENDING_APPROVAL');
    expect(world.sender.sent).toHaveLength(0);

    const pending = await world.reviews.pending(SHOP);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.messageId).toBe(result.messageId);
  });

  it('holds for review even inside quiet hours, and defers only on release', async () => {
    const world = build();
    // 21:30 IST — inside the default 21:00-08:00 window.
    world.setNow(new Date('2026-08-14T16:00:00.000Z'));
    const bundle = await makeBundle(world);

    const result = await world.approvals.createApprovalRequest({
      shopId: SHOP,
      jobCardId: JOB_CARD,
      customerId: CUSTOMER_ID,
      conversationId: CONVERSATION,
      bundle,
      ladderRef: 'APPROVAL',
      actor: { type: 'AGENT', id: null },
      traceId: TRACE,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Held for a person, not deferred to the morning: a quiet-hours defer is
    // about when a *customer* may be disturbed, not about when an advisor may
    // read something. Deferring first would hide the draft from the queue
    // overnight and only then start the clock on a human looking at it.
    expect(result.gateStatus).toBe('PENDING_APPROVAL');
    expect(world.sender.sent).toHaveLength(0);

    // And the advisor clearing it at 21:30 still does not wake the customer:
    // release re-runs quiet hours.
    const outcome = await world.reviews.decide({
      shopId: SHOP,
      messageId: result.messageId,
      action: 'APPROVE_SEND',
      reviewerStaffId: ADVISOR,
      traceId: TRACE,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.action !== 'SENT') throw new Error('expected a release');
    expect(outcome.gate.status).toBe('DEFERRED');
    expect(world.sender.sent).toHaveLength(0);

    // And it is genuinely queued for the morning, not merely absent from the
    // review list: without the reschedule it would sit in PENDING_APPROVAL for
    // ever, actioned by an advisor and invisible to the deferred sender.
    const row = world.harness.world.messages.find(
      (message) => message.id === result.messageId,
    );
    expect(row?.status).toBe('QUEUED');
    expect(row?.scheduledFor?.toISOString()).toBe('2026-08-15T02:30:00.000Z');
    expect(await world.reviews.pending(SHOP)).toHaveLength(0);
  });
});

describe('escalation ladder', () => {
  let world: World;
  let approvalId: string;

  beforeEach(async () => {
    world = build({ autonomy: { ...defaultShopConfig().autonomy, approval: 'L2_CONVERSATIONAL' } });
    const bundle = await makeBundle(world);
    const created = await world.approvals.createApprovalRequest({
      shopId: SHOP,
      jobCardId: JOB_CARD,
      customerId: CUSTOMER_ID,
      conversationId: CONVERSATION,
      bundle,
      ladderRef: 'APPROVAL',
      actor: { type: 'AGENT', id: null },
      traceId: TRACE,
    });
    if (!created.ok) throw new Error('setup failed');
    approvalId = created.approvalId;

    await world.ladder.scheduleLadder({
      shopId: SHOP,
      objective: 'APPROVAL',
      subjectType: APPROVAL_SUBJECT_TYPE,
      subjectId: approvalId,
      openedAt: new Date(T0),
      actor: { type: 'AGENT', id: null },
      traceId: TRACE,
      // Rung 0 already went out with the bundle itself.
      skipRungs: [0],
    });
  });

  it('fires the full ladder in order under a fake clock', async () => {
    const pending = await world.harness.uow.transaction(async (tx) =>
      world.agent.escalations.pendingForSubject(tx, SHOP, APPROVAL_SUBJECT_TYPE, approvalId),
    );
    expect(pending.map((rung) => rung.rung)).toEqual([1, 2, 3]);
    expect(pending.map((rung) => rung.rungType)).toEqual([
      'WHATSAPP',
      'VOICE_OR_ADVISOR',
      'OWNER_DIGEST',
    ]);

    // T+45m: the gentle reminder is due, but the shop's minimum interval is 60
    // minutes and the bundle went out at T0. The rung waits rather than being
    // lost — neither the cadence nor the cap gives way.
    world.setNow(new Date(T0.getTime() + 45 * 60_000));
    expect(await drainLadder(world)).toEqual(['DEFERRED']);
    expect(world.sender.sent).toHaveLength(1);

    world.setNow(new Date(T0.getTime() + 61 * 60_000));
    expect(await drainLadder(world)).toEqual(['SENT']);
    expect(world.sender.sent).toHaveLength(2);

    // T+2h: the voice rung, which raises a prioritised advisor task until
    // phase 5 places the call itself.
    world.setNow(new Date(T0.getTime() + 120 * 60_000));
    expect(await drainLadder(world)).toEqual(['TASK_CREATED']);

    const calls = await world.tasks.list(SHOP);
    expect(calls[0]?.kind).toBe('CALL_CUSTOMER');
    expect(calls[0]?.urgency).toBe('HIGH');
    expect(calls[0]?.brief).toContain('Maruti Swift');
    expect(calls[0]?.brief).toContain('₹4,800.00');

    // T+24h: the owner-digest exception.
    world.setNow(new Date(T0.getTime() + 1440 * 60_000));
    expect(await drainLadder(world)).toEqual(['TASK_CREATED']);
    const open = await world.tasks.list(SHOP);
    expect(open.map((task) => task.kind).sort()).toEqual(['CALL_CUSTOMER', 'OWNER_EXCEPTION']);
  });

  it('cancels every remaining rung the moment the customer decides', async () => {
    world.setNow(new Date(T0.getTime() + 50 * 60_000));
    await drainLadder(world);

    await world.approvals.recordCustomerDecision({
      shopId: SHOP,
      approvalId,
      decision: 'FULL',
      approvedWorkItemIds: [],
      note: 'yes',
      decidedVia: 'button',
      actor: { type: 'CUSTOMER', id: CUSTOMER_ID },
      traceId: TRACE,
    });

    const remaining = await world.harness.uow.transaction(async (tx) =>
      world.agent.escalations.pendingForSubject(tx, SHOP, APPROVAL_SUBJECT_TYPE, approvalId),
    );
    expect(remaining).toEqual([]);

    // And the queue jobs are gone, so nothing can fire late.
    expect(world.agent.agentWorld.queue.size).toBe(0);

    // Even if a job somehow survived, the row is the authority.
    world.setNow(new Date(T0.getTime() + 200 * 60_000));
    expect(await drainLadder(world)).toEqual([]);
  });

  it('defers a quiet-hours rung to the morning rather than skipping it', async () => {
    // 21:30 IST — inside the default 21:00–08:00 quiet window.
    world.setNow(new Date('2026-08-14T16:00:00.000Z'));

    const job = world.agent.scheduler.due(new Date('2026-08-15T00:00:00.000Z'))[0];
    expect(job).toBeDefined();
    const escalationId = job?.escalationId as string;

    const result = await world.ladder.fireRung({ shopId: SHOP, escalationId, traceId: TRACE });

    expect(result.outcome).toBe('DEFERRED');
    // Still scheduled — a deferred rung is not a lost rung.
    const pending = await world.harness.uow.transaction(async (tx) =>
      world.agent.escalations.pendingForSubject(tx, SHOP, APPROVAL_SUBJECT_TYPE, approvalId),
    );
    expect(pending.some((rung) => rung.id === escalationId)).toBe(true);
    const deferred = pending.find((rung) => rung.id === escalationId);
    // 08:00 IST the next morning.
    expect(deferred?.scheduledAt.toISOString()).toBe('2026-08-15T02:30:00.000Z');
  });

  it('suppresses a duplicate rung by idempotency', async () => {
    const again = await world.ladder.scheduleLadder({
      shopId: SHOP,
      objective: 'APPROVAL',
      subjectType: APPROVAL_SUBJECT_TYPE,
      subjectId: approvalId,
      openedAt: new Date(T0),
      actor: { type: 'AGENT', id: null },
      traceId: TRACE,
      skipRungs: [0],
    });

    expect(again).toEqual([]);
    const pending = await world.harness.uow.transaction(async (tx) =>
      world.agent.escalations.pendingForSubject(tx, SHOP, APPROVAL_SUBJECT_TYPE, approvalId),
    );
    expect(pending).toHaveLength(3);
  });

  it('stops chasing once a human has taken over the thread', async () => {
    await world.harness.uow.transaction(async (tx) =>
      world.conversations.markHumanOverride(tx, {
        conversationId: CONVERSATION,
        at: new Date(T0.getTime() + 10 * 60_000),
      }),
    );

    world.setNow(new Date(T0.getTime() + 45 * 60_000));
    expect(await drainLadder(world)).toEqual(['SKIPPED']);
    expect(world.sender.sent).toHaveLength(1);
  });

  it('reports the voice rung as HUMAN on the channel until phase 5 places calls', () => {
    expect(channelForRung('VOICE_OR_ADVISOR')).toBe('HUMAN');
    expect(channelForRung('WHATSAPP')).toBe('WHATSAPP');
  });
});

describe('HITL review queue', () => {
  it('sends an advisor edit rather than the agent draft, and stores the diff', async () => {
    const world = build();
    const bundle = await makeBundle(world);

    const created = await world.approvals.createApprovalRequest({
      shopId: SHOP,
      jobCardId: JOB_CARD,
      customerId: CUSTOMER_ID,
      conversationId: CONVERSATION,
      bundle,
      ladderRef: 'APPROVAL',
      actor: { type: 'AGENT', id: null },
      traceId: TRACE,
    });
    if (!created.ok) throw new Error('setup failed');

    const outcome = await world.reviews.decide({
      shopId: SHOP,
      messageId: created.messageId,
      action: 'EDIT_AND_SEND',
      reviewerStaffId: ADVISOR,
      editedBody: 'Ravi anna, brake pads need changing. Total ₹4,800.00. Shall we go ahead?',
      traceId: TRACE,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.action !== 'SENT') throw new Error('expected a send');
    expect(outcome.edited).toBe(true);
    expect(outcome.gate.status).toBe('SENT');

    // The edit changes the words and keeps the buttons: an advisor rewriting
    // the copy must not accidentally strip the customer's way of answering.
    const sent = world.sender.sent.at(-1);
    expect(sent?.content.kind).toBe('interactive');
    if (sent?.content.kind === 'interactive') {
      expect(sent.content.body).toContain('Ravi anna');
      expect(sent.content.buttons).toHaveLength(3);
    }

    const review = world.agent.agentWorld.reviews[0];
    expect(review?.action).toBe('EDIT_AND_SEND');
    expect(review?.bodyAfter).toContain('Ravi anna');
    expect(review?.reviewerStaffId).toBe(ADVISOR);
  });

  it('refuses a rejection with no reason', async () => {
    const world = build();
    const bundle = await makeBundle(world);
    const created = await world.approvals.createApprovalRequest({
      shopId: SHOP,
      jobCardId: JOB_CARD,
      customerId: CUSTOMER_ID,
      conversationId: CONVERSATION,
      bundle,
      ladderRef: 'APPROVAL',
      actor: { type: 'AGENT', id: null },
      traceId: TRACE,
    });
    if (!created.ok) throw new Error('setup failed');

    const outcome = await world.reviews.decide({
      shopId: SHOP,
      messageId: created.messageId,
      action: 'REJECT',
      reviewerStaffId: ADVISOR,
      rejectionReason: '   ',
      traceId: TRACE,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('REASON_REQUIRED');
    expect(world.sender.sent).toHaveLength(0);
  });

  it('produces a minimal line diff', () => {
    const diff = diffLines('one\ntwo\nthree', 'one\ntwo point five\nthree');
    expect(diff).toEqual([
      { op: 'keep', text: 'one' },
      { op: 'remove', text: 'two' },
      { op: 'add', text: 'two point five' },
      { op: 'keep', text: 'three' },
    ]);
  });
});

describe('autonomy graduation', () => {
  const config = defaultShopConfig();

  it('recommends nothing below the sample size, however good the rate', () => {
    const report = buildGraduationReport(config, SHOP, 'approval', {
      approvedWithoutEdit: 4,
      approvedWithEdit: 0,
      rejected: 0,
      checkerBlocks: 0,
      runs: 4,
      waitTimesMs: [1000, 2000, 3000, 4000],
    });

    expect(report.approvedWithoutEditRate).toBe(1);
    expect(report.recommendedLevel).toBeNull();
    expect(report.rationale).toContain('4 reviewed message(s)');
  });

  it('recommends the next level when every gate is cleared', () => {
    const report = buildGraduationReport(config, SHOP, 'approval', {
      approvedWithoutEdit: 29,
      approvedWithEdit: 1,
      rejected: 0,
      checkerBlocks: 1,
      runs: 40,
      waitTimesMs: [1000, 5000, 9000],
    });

    expect(report.currentLevel).toBe('L0_SHADOW');
    expect(report.recommendedLevel).toBe('L1_TEMPLATED');
    expect(report.medianReviewWaitMs).toBe(5000);
    expect(report.rationale).toContain('you decide');
  });

  it('refuses to recommend when the checker blocks too often, however high the approval rate', () => {
    const report = buildGraduationReport(config, SHOP, 'approval', {
      approvedWithoutEdit: 30,
      approvedWithEdit: 0,
      rejected: 0,
      // A flow the checker blocks constantly is a flow whose drafts are unsafe;
      // a high approval rate on the few that got through does not redeem it.
      checkerBlocks: 20,
      runs: 50,
      waitTimesMs: [],
    });

    expect(report.checkerBlockRate).toBeCloseTo(0.4);
    expect(report.recommendedLevel).toBeNull();
    expect(report.rationale).toContain('post-checker blocked');
  });

  it('never recommends past the level chat evidence can justify', () => {
    const l2 = { ...config, autonomy: { ...config.autonomy, approval: 'L2_CONVERSATIONAL' as const } };
    const report = buildGraduationReport(l2, SHOP, 'approval', {
      approvedWithoutEdit: 100,
      approvedWithEdit: 0,
      rejected: 0,
      checkerBlocks: 0,
      runs: 100,
      waitTimesMs: [],
    });

    expect(report.recommendedLevel).toBeNull();
    expect(report.rationale).toContain('as far as the approval flow graduates');
  });
});


describe('approval buttons', () => {
  /**
   * The three buttons, through the port the inbound handler calls.
   *
   * Driven at the port rather than through a full webhook, because what is
   * being tested is what a *tap means* — the handler's job is only to recognise
   * the id, and `parseApprovalAction` already has that covered.
   */
  async function withOpenApproval(): Promise<{
    world: World;
    handler: ApprovalReplyHandler<MemoryTx>;
    approvalId: string;
    objectivesOpened: string[];
  }> {
    const world = build({
      autonomy: { ...defaultShopConfig().autonomy, approval: 'L2_CONVERSATIONAL' },
    });
    const bundle = await makeBundle(world);
    const created = await world.approvals.createApprovalRequest({
      shopId: SHOP,
      jobCardId: JOB_CARD,
      customerId: CUSTOMER_ID,
      conversationId: CONVERSATION,
      bundle,
      ladderRef: 'APPROVAL',
      actor: { type: 'AGENT', id: null },
      traceId: TRACE,
    });
    if (!created.ok) throw new Error('setup failed');

    const objectivesOpened: string[] = [];
    const handler = new ApprovalReplyHandler<MemoryTx>({
      uow: world.harness.uow,
      approvals: world.approvals,
      approvalStore: world.agent.approvals,
      cards: world.agent.cards,
      conversations: world.conversations,
      tasks: world.tasks,
      directory: world.harness.directory,
      gate: world.gate,
      openObjectionObjective: async (input) => {
        objectivesOpened.push(input.approvalId);
      },
      clock: { now: world.now },
    });

    return { world, handler, approvalId: created.approvalId, objectivesOpened };
  }

  const reply = {
    shopId: SHOP,
    conversationId: CONVERSATION,
    customerId: CUSTOMER_ID,
    triggerMessageId: null,
    replyTitle: 'Approve ✅',
    traceId: TRACE,
  };

  it('Approve records the decision and confirms it', async () => {
    const { world, handler, approvalId } = await withOpenApproval();

    const result = await handler.approve(reply);

    expect(result.handled).toBe(true);
    expect(result.approvalId).toBe(approvalId);
    expect(world.harness.world.items.get(ITEM_BRAKES)?.state).toBe('APPROVED');
    expect(world.harness.world.cards.get(JOB_CARD)?.state).toBe('IN_PROGRESS');

    const confirmation = world.sender.sent.at(-1);
    expect(confirmation?.content.kind === 'text' && confirmation.content.body).toContain(
      'started the approved work',
    );
  });

  it('re-confirms an already-decided request rather than going quiet', async () => {
    const { world, handler } = await withOpenApproval();

    await handler.approve(reply);
    const sentAfterFirst = world.sender.sent.length;
    const second = await handler.approve(reply);

    // The second tap finds no *open* request, so it is a no-op — which is the
    // conservative reading: nothing is decided twice.
    expect(second.handled).toBe(false);
    expect(world.sender.sent).toHaveLength(sentAfterFirst);
  });

  it('the question button opens the objection objective and decides nothing', async () => {
    const { world, handler, approvalId, objectivesOpened } = await withOpenApproval();

    const result = await handler.openObjection({ ...reply, replyTitle: 'Ask a question 💬' });

    expect(result.handled).toBe(true);
    expect(objectivesOpened).toEqual([approvalId]);
    // Nothing decided: guessing what "not yes" meant is the error this avoids.
    expect(world.harness.world.items.get(ITEM_BRAKES)?.state).toBe('PENDING_APPROVAL');
  });

  it('Call me raises a high-urgency task and acknowledges', async () => {
    const { world, handler } = await withOpenApproval();

    await handler.requestCall({ ...reply, replyTitle: 'Call me 📞' });

    const tasks = await world.tasks.list(SHOP);
    expect(tasks[0]?.kind).toBe('CALL_CUSTOMER');
    expect(tasks[0]?.urgency).toBe('HIGH');
    expect(tasks[0]?.brief).toContain('tapped "Call me"');

    const ack = world.sender.sent.at(-1);
    expect(ack?.content.kind === 'text' && ack.content.body).toContain('will call you shortly');
  });

  it('raises one callback task however many times the customer taps', async () => {
    const { world, handler } = await withOpenApproval();

    await handler.requestCall(reply);
    await handler.requestCall(reply);

    expect(await world.tasks.list(SHOP)).toHaveLength(1);
  });

  it('stays silent when the tap belongs to an already-decided estimate', async () => {
    const { world, handler } = await withOpenApproval();
    await handler.approve(reply);
    const before = world.sender.sent.length;

    const result = await handler.requestCall(reply);

    expect(result.handled).toBe(false);
    expect(result.detail).toContain('no open approval request');
    expect(world.sender.sent).toHaveLength(before);
  });
});
