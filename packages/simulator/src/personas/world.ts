import { SandboxLlmAdapter, type MockLlmAdapter } from '@serviceloop/adapters';
import { defaultShopConfig, type ShopConfig } from '@serviceloop/config';
import {
  createAgentRuntime,
  DeterministicExplanationWriter,
  type AgentRuntime,
} from '@serviceloop/agent-core';
import {
  APPROVAL_SUBJECT_TYPE,
  JobCardTransitionService,
  OutboundGate,
  WorkItemTransitionService,
  type EvidenceBundle,
  type JobCardContext,
} from '@serviceloop/domain';
import {
  createAgentTestHarness,
  createDomainTestHarness,
  InMemoryConsentStore,
  InMemoryConversationStore,
  InMemoryEtaStore,
  InMemoryMessageStore,
  InMemoryStatusWorld,
  RecordingChannelSender,
  type AgentTestHarness,
  type DomainTestHarness,
  type FakeRungScheduler,
  type MemoryTx,
} from '@serviceloop/domain/testing';
import { uuidv7, type Language } from '@serviceloop/shared';

/**
 * The world a persona runs in.
 *
 * Entirely in memory and on a fake clock, which is what makes the persona suite
 * a CI fixture rather than an integration test: the full approval saga — bundle,
 * request, ladder, decision, ledger — runs in milliseconds, deterministically,
 * with no database, no queue and no model. The stores are the same
 * implementations the domain's own tests are written against, so a rule proved
 * here is proved against the semantics `packages/db` implements.
 */

export const SIM_SHOP = '01920000-0000-7000-8000-0000000000aa';
export const SIM_CUSTOMER = '01920000-0000-7000-8000-0000000000bb';
export const SIM_JOB_CARD = '01920000-0000-7000-8000-0000000000dd';
export const SIM_ITEM_BRAKES = '01920000-0000-7000-8000-0000000000e1';
export const SIM_ITEM_OIL = '01920000-0000-7000-8000-0000000000e2';
export const SIM_CONVERSATION = '01920000-0000-7000-8000-0000000000ff';
export const SIM_ADVISOR = '01920000-0000-7000-8000-000000000a01';

/** 2026-08-14, 14:00 IST — inside business hours, outside quiet hours. */
export const SIM_T0 = new Date('2026-08-14T08:30:00.000Z');

export const BRAKE_LINE_PAISE = 320_000;
export const OIL_LINE_PAISE = 160_000;
export const TOTAL_PAISE = BRAKE_LINE_PAISE + OIL_LINE_PAISE;

/**
 * The card every persona is about.
 *
 * One card, two decidable items, one photo. Two items is the smallest number
 * that makes partial approval a real thing to test rather than a special case of
 * "yes".
 */
export function simJobCard(language: Language, customerName: string): JobCardContext {
  return {
    jobCardId: SIM_JOB_CARD,
    code: 'JC-2026-0042',
    state: 'AWAITING_APPROVAL',
    customerId: SIM_CUSTOMER,
    customerName,
    customerLanguage: language,
    vehicleLabel: 'Maruti Swift',
    registration: 'TN09BX4432',
    odometerKm: 62_000,
    promisedAt: null,
    complaint: 'Grinding noise when braking',
    workItems: [
      {
        id: SIM_ITEM_BRAKES,
        title: 'Front brake pad replacement',
        state: 'PENDING_APPROVAL',
        requiresApproval: true,
        technicianNote: 'Front pads worn to 2.1mm, minimum is 3mm. Metal to metal soon.',
        estimatedMinutes: 60,
      },
      {
        id: SIM_ITEM_OIL,
        title: 'Engine oil and filter',
        state: 'PENDING_APPROVAL',
        requiresApproval: true,
        technicianNote: 'Oil is dark and the filter is due at this odometer.',
        estimatedMinutes: 30,
      },
    ],
    estimate: {
      id: 'est-1',
      version: 2,
      status: 'DRAFT',
      totalPaise: TOTAL_PAISE,
      lines: [
        {
          id: 'line-brakes',
          workItemId: SIM_ITEM_BRAKES,
          description: 'Front brake pads (set)',
          kind: 'PART',
          quantityMilli: 1000,
          unitPricePaise: BRAKE_LINE_PAISE,
          lineTotalPaise: BRAKE_LINE_PAISE,
          taxRateBp: 1800,
          listPricePaise: BRAKE_LINE_PAISE,
        },
        {
          id: 'line-oil',
          workItemId: SIM_ITEM_OIL,
          description: 'Engine oil and filter',
          kind: 'CONSUMABLE',
          quantityMilli: 1000,
          unitPricePaise: OIL_LINE_PAISE,
          lineTotalPaise: OIL_LINE_PAISE,
          taxRateBp: 1800,
          listPricePaise: OIL_LINE_PAISE,
        },
      ],
    },
    media: [
      { id: 'media-1', kind: 'PHOTO', caption: 'Worn front pad', workItemId: SIM_ITEM_BRAKES },
    ],
    advisorName: 'Meena',
  };
}

export interface SimWorld {
  readonly harness: DomainTestHarness;
  readonly agentHarness: AgentTestHarness;
  readonly runtime: AgentRuntime<MemoryTx>;
  readonly sender: RecordingChannelSender;
  readonly conversations: InMemoryConversationStore;
  readonly scheduler: FakeRungScheduler;
  /** ETA history, so `answer_status` has something true to answer from (4.5). */
  readonly statusWorld: InMemoryStatusWorld;
  readonly config: ShopConfig;
  readonly language: Language;
  now(): Date;
  setNow(at: Date): void;
  /** Minutes elapsed since T0 — how time-to-decision is measured. */
  elapsedMinutes(): number;
  buildBundle(): Promise<EvidenceBundle>;
  /** Everything that actually reached the customer, in order. */
  sentBodies(): readonly string[];
}

export interface SimWorldOptions {
  readonly language?: Language;
  readonly customerName?: string;
  readonly configPatch?: Partial<ShopConfig>;
  /** The agent's scripted turns. Absent for personas that never run the agent. */
  readonly llm?: MockLlmAdapter;
}

export function createSimWorld(options: SimWorldOptions = {}): SimWorld {
  const language = options.language ?? 'en';
  const customerName = options.customerName ?? 'Ravi';

  let current = new Date(SIM_T0);
  const now = (): Date => new Date(current);
  const clock = { now };

  const harness = createDomainTestHarness(now);
  const agentHarness = createAgentTestHarness(harness.world);

  const config: ShopConfig = {
    ...defaultShopConfig('Asia/Kolkata'),
    // The personas exercise the agent talking to a customer, so the approval
    // flow is at L2. `l0_shadow` has its own coverage in the domain suite; a
    // persona at L0 would only ever prove that nothing was sent.
    autonomy: { ...defaultShopConfig().autonomy, approval: 'L2_CONVERSATIONAL' },
    languages: { enabled: ['en', 'ta', 'hi'], default: language },
    ...options.configPatch,
  };

  harness.world.addShop(SIM_SHOP, 'Asia/Kolkata');
  harness.world.configs.set(SIM_SHOP, config);
  harness.world.addCustomer(SIM_SHOP, '+919841100001', SIM_CUSTOMER, language, 'Maruti Swift');
  harness.world.advisors.set(SIM_SHOP, { id: SIM_ADVISOR, fullName: 'Meena' });

  harness.world.cards.set(SIM_JOB_CARD, {
    id: SIM_JOB_CARD,
    shopId: SIM_SHOP,
    state: 'AWAITING_APPROVAL',
    version: 1,
    stateChangedAt: new Date(SIM_T0),
  });
  for (const id of [SIM_ITEM_BRAKES, SIM_ITEM_OIL]) {
    harness.world.items.set(id, {
      id,
      shopId: SIM_SHOP,
      jobCardId: SIM_JOB_CARD,
      state: 'PENDING_APPROVAL',
      requiresApproval: true,
    });
  }

  agentHarness.agentWorld.putCard(simJobCard(language, customerName));
  agentHarness.agentWorld.listPrices.set('line-brakes', BRAKE_LINE_PAISE);
  agentHarness.agentWorld.listPrices.set('line-oil', OIL_LINE_PAISE);

  harness.world.conversations.set(SIM_CONVERSATION, {
    id: SIM_CONVERSATION,
    shopId: SIM_SHOP,
    kind: 'CUSTOMER',
    channel: 'WHATSAPP',
    customerId: SIM_CUSTOMER,
    externalThreadId: 'wa:sim',
    externalAddress: '+919841100001',
    displayName: customerName,
    state: 'OPEN',
    language,
    lastInboundAt: new Date(SIM_T0.getTime() - 60_000),
    lastOutboundAt: null,
    // An open window: the personas test what the agent *says*, not whether a
    // template was required.
    windowExpiresAt: new Date(SIM_T0.getTime() + 20 * 60 * 60 * 1000),
    unreadCount: 0,
    humanOverrideAt: null,
  });
  harness.world.consents.push({
    id: uuidv7(),
    shopId: SIM_SHOP,
    customerId: SIM_CUSTOMER,
    purpose: 'SERVICE',
    status: 'GRANTED',
    channel: 'WHATSAPP',
    source: 'SEED',
    evidence: null,
    grantedAt: new Date(SIM_T0.getTime() - 86_400_000),
    revokedAt: null,
    createdAt: new Date(SIM_T0.getTime() - 86_400_000),
  });

  const conversations = new InMemoryConversationStore(harness.world);
  const messages = new InMemoryMessageStore(harness.world);
  const sender = new RecordingChannelSender();

  // Phase 4.5: the ETA history a status answer is grounded in. Seeded with the
  // card's head so a persona can append entries; empty until one does, which is
  // the honest starting state — nothing has been estimated yet.
  const statusWorld = new InMemoryStatusWorld();
  statusWorld.seedCard({
    jobCardId: SIM_JOB_CARD,
    version: 0,
    currentEta: null,
    promisedAt: null,
    state: 'AWAITING_APPROVAL',
  });

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

  const runtime = createAgentRuntime<MemoryTx>({
    stores: {
      uow: harness.uow,
      runs: agentHarness.runs,
      cards: agentHarness.cards,
      prices: agentHarness.prices,
      bundles: agentHarness.bundles,
      approvals: agentHarness.approvals,
      escalations: agentHarness.escalations,
      tasks: agentHarness.tasks,
      reviews: agentHarness.reviews,
      conversations,
      messages,
      config: harness.config,
      directory: harness.directory,
      audit: harness.audit,
      outbox: harness.outbox,
      eta: new InMemoryEtaStore(statusWorld),
    },
    gate,
    jobCards: new JobCardTransitionService<MemoryTx>({
      uow: harness.uow,
      cards: harness.cards,
      config: harness.config,
      audit: harness.audit,
      outbox: harness.outbox,
      clock,
    }),
    workItems: new WorkItemTransitionService<MemoryTx>({
      uow: harness.uow,
      items: harness.items,
      audit: harness.audit,
      outbox: harness.outbox,
      clock,
    }),
    scheduler: agentHarness.scheduler,
    // The scripted agent, with the claim judge delegated to a deterministic
    // responder. A judge call is infrastructure, not a turn: letting it consume
    // the next scripted step would desynchronise the whole script.
    llm: options.llm ?? new SandboxLlmAdapter(),
    config,
    conversationTail: (tx, shopId, conversationId, limit) =>
      messages.recentForConversation(tx, shopId, conversationId, limit),
    loadHeld: async () => null,
    resolvePinnedCard: async () => null,
    scheduleFollowup: async () => 'sim-followup',
    openObjectionObjective: async () => undefined,
    explanations: new DeterministicExplanationWriter(),
    clock,
  });

  return {
    harness,
    agentHarness,
    runtime,
    sender,
    conversations,
    scheduler: agentHarness.scheduler,
    statusWorld,
    config,
    language,
    now,
    setNow: (at) => {
      current = new Date(at);
    },
    elapsedMinutes: () => Math.round((current.getTime() - SIM_T0.getTime()) / 60_000),
    async buildBundle() {
      const result = await runtime.bundles.build({
        shopId: SIM_SHOP,
        anchor: { kind: 'explicit', jobCardId: SIM_JOB_CARD },
        note: 'Front pads worn to 2.1mm, minimum is 3mm. Metal to metal soon.',
        noteLanguage: 'en',
        authorStaffId: null,
        mediaIds: ['media-1'],
        workItemIds: [SIM_ITEM_BRAKES, SIM_ITEM_OIL],
        traceId: 'sim',
        actor: { type: 'STAFF', id: null },
      });
      if (!result.ok) throw new Error(`bundle failed: ${result.failure.reason}`);
      return result.bundle;
    },
    sentBodies() {
      return sender.sent.map((message) =>
        message.content.kind === 'text'
          ? message.content.body
          : message.content.kind === 'interactive'
            ? message.content.body
            : '',
      );
    },
  };
}

export { APPROVAL_SUBJECT_TYPE };
