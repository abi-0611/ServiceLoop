import { MockLlmAdapter, SandboxLlmAdapter } from '@serviceloop/adapters';
import { defaultShopConfig, type ShopConfig } from '@serviceloop/config';
import {
  AdvisorTaskService,
  ApprovalService,
  EvidenceBundleBuilder,
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
  InMemoryMessageStore,
  RecordingChannelSender,
  type AgentTestHarness,
  type DomainTestHarness,
  type MemoryTx,
} from '@serviceloop/domain/testing';
import { uuidv7 } from '@serviceloop/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { DeterministicExplanationWriter } from './explanation-writer';
import { PostChecker } from './post-checker';
import { AgentRunner } from './runner';
import { buildToolRegistry } from './tools';

/**
 * Phase 3.2 / 3.3 — the deterministic outer loop and the tool guardrails.
 *
 * Every run here is scripted through `MockLlmAdapter`, so what is being tested
 * is the *runtime*: the caps, the abort, the persistence, the replay, and the
 * refusals a tool returns regardless of what the prompt said.
 */

const SHOP = '01920000-0000-7000-8000-0000000000aa';
const CUSTOMER_ID = '01920000-0000-7000-8000-0000000000bb';
const JOB_CARD = '01920000-0000-7000-8000-0000000000dd';
const ITEM_BRAKES = '01920000-0000-7000-8000-0000000000e1';
const ITEM_OIL = '01920000-0000-7000-8000-0000000000e2';
const CONVERSATION = '01920000-0000-7000-8000-0000000000ff';
const TRACE = 'trace-runner';
const T0 = new Date('2026-08-14T08:30:00.000Z');

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
        technicianNote: 'Front pads worn to 2.1mm, minimum is 3mm.',
        estimatedMinutes: 60,
      },
      {
        id: ITEM_OIL,
        title: 'Engine oil and filter',
        state: 'PENDING_APPROVAL',
        requiresApproval: true,
        technicianNote: 'Oil dark, filter due.',
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

interface World {
  readonly harness: DomainTestHarness;
  readonly agent: AgentTestHarness;
  readonly conversations: InMemoryConversationStore;
  readonly sender: RecordingChannelSender;
  readonly config: ShopConfig;
  runner(llm: MockLlmAdapter | SandboxLlmAdapter): AgentRunner<MemoryTx>;
  bundle(): Promise<EvidenceBundle>;
}

function build(configPatch: Partial<ShopConfig> = {}): World {
  const now = (): Date => new Date(T0);
  const clock = { now };
  const harness = createDomainTestHarness(now);
  const agent = createAgentTestHarness(harness.world);
  const config = { ...defaultShopConfig('Asia/Kolkata'), ...configPatch };

  harness.world.addShop(SHOP, 'Asia/Kolkata');
  harness.world.configs.set(SHOP, config);
  harness.world.addCustomer(SHOP, '+919841100001', CUSTOMER_ID, 'en', 'Maruti Swift');
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
  harness.world.conversations.set(CONVERSATION, {
    id: CONVERSATION,
    shopId: SHOP,
    kind: 'CUSTOMER',
    channel: 'WHATSAPP',
    customerId: CUSTOMER_ID,
    externalThreadId: 'wa:test',
    externalAddress: '+919841100001',
    displayName: 'Ravi',
    state: 'OPEN',
    language: 'en',
    lastInboundAt: new Date(T0.getTime() - 60_000),
    lastOutboundAt: null,
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

  agent.agentWorld.putCard(card());
  agent.agentWorld.listPrices.set('line-brakes', 320_000);
  agent.agentWorld.listPrices.set('line-oil', 160_000);

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

  const tasks = new AdvisorTaskService<MemoryTx>({
    uow: harness.uow,
    tasks: agent.tasks,
    audit: harness.audit,
    outbox: harness.outbox,
    clock,
  });

  const bundleBuilder = new EvidenceBundleBuilder<MemoryTx>({
    uow: harness.uow,
    bundles: agent.bundles,
    cards: agent.cards,
    explanations: new DeterministicExplanationWriter(),
    audit: harness.audit,
    outbox: harness.outbox,
    resolvePinnedCard: async () => null,
    clock,
  });

  const approvals = new ApprovalService<MemoryTx>({
    uow: harness.uow,
    approvals: agent.approvals,
    bundles: agent.bundles,
    cards: agent.cards,
    messages,
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
    directory: harness.directory,
    audit: harness.audit,
    outbox: harness.outbox,
    cancelLadder: async () => undefined,
    clock,
  });

  let cachedBundleId: string | null = null;

  return {
    harness,
    agent,
    conversations,
    sender,
    config,
    runner(llm) {
      const registry = buildToolRegistry<MemoryTx>({
        uow: harness.uow,
        cards: agent.cards,
        bundles: agent.bundles,
        bundleBuilder,
        approvals,
        tasks,
        gate,
        prices: agent.prices,
        // A judge that clears everything: these tests are about the runtime,
        // and the checker has its own suite.
        checker: new PostChecker(new SandboxLlmAdapter(), { skipJudge: true }),
        loadConfig: async () => config,
        activeBundle: async (tx, shopId) =>
          cachedBundleId === null
            ? null
            : agent.bundles.load(tx, shopId, cachedBundleId),
        conversationTail: async (tx, shopId, conversationId, limit) =>
          messages.recentForConversation(tx, shopId, conversationId, limit),
        scheduleFollowup: async () => 'followup-1',
      });

      return new AgentRunner<MemoryTx>({
        uow: harness.uow,
        llm,
        runs: agent.runs,
        conversations,
        registry,
        audit: harness.audit,
        outbox: harness.outbox,
        clock,
      });
    },
    async bundle() {
      const result = await bundleBuilder.build({
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
      if (!result.ok) throw new Error(result.failure.reason);
      cachedBundleId = result.bundle.id;
      return result.bundle;
    },
  };
}

function request(world: World, overrides: Record<string, unknown> = {}) {
  return {
    shopId: SHOP,
    objective: 'request_approval' as const,
    conversationId: CONVERSATION,
    customerId: CUSTOMER_ID,
    jobCardId: JOB_CARD,
    triggerMessageId: null,
    traceId: TRACE,
    config: world.config,
    shop: {
      name: 'Sri Murugan Auto Works',
      city: 'Chennai',
      advisorName: 'Meena',
      priceListSummary: 'Brake pads ₹3,200. Oil change ₹1,600.',
    },
    card: card(),
    conversationTail: [],
    sources: [{ id: 'note:n1', text: 'Front pads worn to 2.1mm.' }],
    language: 'en' as const,
    customerName: 'Ravi',
    ...overrides,
  };
}

/** A scripted turn as a test writes one — token counts are the schema's job. */
interface Turn {
  readonly text: string;
  readonly toolCalls: ReadonlyArray<{ readonly name: string; readonly args: unknown }>;
  readonly expect?: string;
}

function script(turns: readonly Turn[]): MockLlmAdapter {
  return new MockLlmAdapter({
    name: 'test',
    description: '',
    model: 'mock-agent',
    turns: turns.map((turn) => ({
      ...turn,
      toolCalls: turn.toolCalls.map((call) => ({ ...call })),
      inputTokens: 100,
      outputTokens: 20,
    })),
  });
}

/* -------------------------------------------------------------------------- */

describe('AgentRunner', () => {
  let world: World;

  beforeEach(async () => {
    world = build({ autonomy: { ...defaultShopConfig().autonomy, approval: 'L2_CONVERSATIONAL' } });
    await world.bundle();
  });

  it('runs a multi-step objective and stops the moment it is met', async () => {
    const llm = script([
      { text: '', toolCalls: [{ name: 'get_job_card', args: {} }] },
      {
        text: '',
        toolCalls: [
          {
            name: 'create_approval_request',
            args: { workItemIds: [ITEM_BRAKES, ITEM_OIL], ladderRef: 'APPROVAL' },
          },
        ],
      },
      // A third turn exists and must never be reached: the objective is met on
      // the second, and a runtime that keeps going would spend a shop's money
      // to say something nobody asked for.
      { text: 'anything else?', toolCalls: [] },
    ]);

    const report = await world.runner(llm).run(request(world));

    expect(report.outcome).toBe('objective_met');
    expect(report.steps).toBe(2);
    expect(llm.remaining()).toBe(1);
    expect(world.sender.sent).toHaveLength(1);
  });

  it('persists every step before the next, and replays to identical tool calls', async () => {
    const llm = script([
      { text: 'reading', toolCalls: [{ name: 'get_job_card', args: {} }] },
      { text: 'noting', toolCalls: [{ name: 'log_note', args: { note: 'customer is in a hurry' } }] },
      {
        text: '',
        toolCalls: [
          {
            name: 'create_approval_request',
            args: { workItemIds: [ITEM_BRAKES], ladderRef: 'APPROVAL' },
          },
        ],
      },
    ]);

    const runner = world.runner(llm);
    const report = await runner.run(request(world));

    expect(report.outcome).toBe('objective_met');

    const steps = world.agent.agentWorld.steps;
    expect(steps.map((step) => step.stepIndex)).toEqual([0, 1, 2]);
    expect(steps[0]?.promptHash).toHaveLength(64);
    expect(steps.every((step) => step.promptHash === steps[0]?.promptHash)).toBe(true);

    const replayed = await runner.replay(SHOP, report.runId);
    expect(replayed.map((call) => call.name)).toEqual([
      'get_job_card',
      'log_note',
      'create_approval_request',
    ]);
    expect(replayed[2]?.args).toEqual({ workItemIds: [ITEM_BRAKES], ladderRef: 'APPROVAL' });
  });

  it('stops at the step cap and reports budget_exhausted', async () => {
    const capped = build({
      autonomy: { ...defaultShopConfig().autonomy, approval: 'L2_CONVERSATIONAL' },
      agent: { ...defaultShopConfig().agent, maxSteps: 2 },
    });
    await capped.bundle();

    const llm = script([
      { text: '', toolCalls: [{ name: 'get_job_card', args: {} }] },
      { text: '', toolCalls: [{ name: 'get_job_card', args: {} }] },
      { text: '', toolCalls: [{ name: 'get_job_card', args: {} }] },
    ]);

    const report = await capped.runner(llm).run(request(capped));

    expect(report.outcome).toBe('budget_exhausted');
    expect(report.steps).toBe(2);
    expect(report.reason).toContain('Step cap of 2');
    expect(capped.sender.sent).toHaveLength(0);
  });

  it('aborts when a human replies mid-run', async () => {
    // The human takes over between the first and second steps.
    let stepped = 0;
    const llm = script([
      { text: '', toolCalls: [{ name: 'get_job_card', args: {} }] },
      {
        text: '',
        toolCalls: [
          {
            name: 'create_approval_request',
            args: { workItemIds: [ITEM_BRAKES], ladderRef: 'APPROVAL' },
          },
        ],
      },
    ]);

    const original = llm.complete.bind(llm);
    llm.complete = async (llmRequest) => {
      stepped += 1;
      const result = await original(llmRequest);
      if (stepped === 1) {
        await world.harness.uow.transaction(async (tx) =>
          world.conversations.markHumanOverride(tx, {
            conversationId: CONVERSATION,
            at: new Date(T0.getTime() + 1000),
          }),
        );
      }
      return result;
    };

    const report = await world.runner(llm).run(request(world));

    expect(report.outcome).toBe('handoff');
    expect(report.skipped).toBe('HUMAN_OVERRIDE');
    expect(report.steps).toBe(1);
    expect(world.sender.sent).toHaveLength(0);

    const run = [...world.agent.agentWorld.runs.values()][0];
    // ABORTED, not FAILED: a person taking the wheel is the system working.
    expect(run?.status).toBe('ABORTED');
  });

  it('refuses to start when a human already has the thread', async () => {
    await world.harness.uow.transaction(async (tx) =>
      world.conversations.markHumanOverride(tx, {
        conversationId: CONVERSATION,
        at: new Date(T0),
      }),
    );

    const llm = script([{ text: '', toolCalls: [{ name: 'get_job_card', args: {} }] }]);
    const report = await world.runner(llm).run(request(world));

    expect(report.outcome).toBe('blocked');
    expect(report.skipped).toBe('HUMAN_OVERRIDE');
    // Not a single model call was spent learning what was already known.
    expect(llm.remaining()).toBe(1);
  });

  it('will not start a second run for a redelivered trigger message', async () => {
    const triggerMessageId = uuidv7();
    const first = script([
      {
        text: '',
        toolCalls: [
          {
            name: 'create_approval_request',
            args: { workItemIds: [ITEM_BRAKES], ladderRef: 'APPROVAL' },
          },
        ],
      },
    ]);
    await world.runner(first).run(request(world, { triggerMessageId }));

    const second = script([{ text: '', toolCalls: [{ name: 'get_job_card', args: {} }] }]);
    const report = await world.runner(second).run(request(world, { triggerMessageId }));

    expect(report.skipped).toBe('DUPLICATE_TRIGGER');
    expect(world.sender.sent).toHaveLength(1);
  });

  it('refuses a tool the objective may not use, and names what it may', async () => {
    const llm = script([
      // `adjust_offer` belongs to resolve_partial_approval, not to this one.
      { text: '', toolCalls: [{ name: 'adjust_offer', args: { lineId: 'line-brakes', newPricePaise: 1 } }] },
      {
        text: '',
        toolCalls: [
          {
            name: 'create_approval_request',
            args: { workItemIds: [ITEM_BRAKES], ladderRef: 'APPROVAL' },
          },
        ],
      },
    ]);

    const report = await world.runner(llm).run(request(world));

    expect(report.outcome).toBe('objective_met');
    const verdicts = world.agent.agentWorld.steps[0]?.checkerVerdicts ?? [];
    expect(verdicts[0]?.code).toBe('TOOL_NOT_PERMITTED');
    expect(verdicts[0]?.reason).toContain('create_approval_request');
  });

  it('records a handoff as handoff, not as a failure', async () => {
    const llm = script([
      {
        text: '',
        toolCalls: [
          {
            name: 'handoff_to_human',
            args: { summary: 'Customer disputes the previous invoice; needs a person.', urgency: 'HIGH' },
          },
        ],
      },
    ]);

    const report = await world.runner(llm).run(request(world));

    expect(report.outcome).toBe('handoff');
    const tasks = [...world.agent.agentWorld.tasks.values()];
    expect(tasks[0]?.kind).toBe('HANDOFF');
    expect(tasks[0]?.urgency).toBe('HIGH');
  });

  it('treats prose with no tool call as a wasted step, not as success', async () => {
    const llm = script([
      { text: 'I think the customer will approve.', toolCalls: [] },
      { text: 'Yes, definitely.', toolCalls: [] },
      { text: 'Objective met!', toolCalls: [] },
      { text: 'Done.', toolCalls: [] },
      { text: 'Done.', toolCalls: [] },
      { text: 'Done.', toolCalls: [] },
    ]);

    const report = await world.runner(llm).run(request(world));

    // The model announced success having sent nothing. The runtime observes
    // tool results, not claims, so this is the truth of what happened.
    expect(report.outcome).toBe('budget_exhausted');
    expect(world.sender.sent).toHaveLength(0);
  });
});

describe('tool guardrails', () => {
  let world: World;

  beforeEach(async () => {
    world = build({
      autonomy: { ...defaultShopConfig().autonomy, approval: 'L2_CONVERSATIONAL' },
      // A shop that permits a 10% discount, so the floor is a real boundary
      // rather than "any change at all".
      pricing: { priceFloorPercent: 90, discountCeilingPercent: 10 },
    });
    await world.bundle();
  });

  it('rejects a floor-violating offer regardless of what the prompt said', async () => {
    const llm = script([
      {
        text: '',
        toolCalls: [
          // The prompt in this script is irrelevant: the tool holds the line.
          { name: 'adjust_offer', args: { lineId: 'line-brakes', newPricePaise: 100_000 } },
        ],
      },
      {
        text: '',
        toolCalls: [
          {
            name: 'handoff_to_human',
            args: { summary: 'Customer asked for a discount below the floor; owner to decide.' },
          },
        ],
      },
    ]);

    const report = await world
      .runner(llm)
      .run(request(world, { objective: 'resolve_partial_approval' }));

    const refusal = world.agent.agentWorld.steps[0]?.toolResults[0];
    expect(refusal?.ok).toBe(false);
    expect((refusal?.result as { code: string }).code).toBe('PRICE_BELOW_FLOOR');
    // The refusal is phrased to be relayed, not hidden.
    expect((refusal?.result as { reason: string }).reason).toContain('below this shop');
    expect(report.steps).toBeGreaterThan(0);
  });

  it('accepts an offer inside the floor and the ceiling', async () => {
    const llm = script([
      {
        text: '',
        toolCalls: [
          // 10% off ₹3,200 is exactly the ceiling, and exactly the floor.
          { name: 'adjust_offer', args: { lineId: 'line-brakes', newPricePaise: 288_000 } },
        ],
      },
      { text: '', toolCalls: [{ name: 'handoff_to_human', args: { summary: 'Owner to confirm the concession offered.' } }] },
    ]);

    await world.runner(llm).run(request(world, { objective: 'resolve_partial_approval' }));

    const result = world.agent.agentWorld.steps[0]?.toolResults[0];
    expect(result?.ok).toBe(true);
    expect((result?.result as { accepted: boolean }).accepted).toBe(true);
  });

  it('refuses to reprice an item with no list price rather than inventing one', async () => {
    world.agent.agentWorld.listPrices.delete('line-brakes');
    // The bundle line carries the list price too, so clear both.
    const bundle = [...world.agent.agentWorld.bundles.values()][0];
    if (bundle !== undefined) {
      world.agent.agentWorld.bundles.set(bundle.id, {
        ...bundle,
        lines: bundle.lines.map((line) => ({ ...line, listPricePaise: null })),
      });
    }

    const llm = script([
      {
        text: '',
        toolCalls: [
          { name: 'adjust_offer', args: { lineId: 'line-brakes', newPricePaise: 300_000 } },
        ],
      },
      { text: '', toolCalls: [{ name: 'handoff_to_human', args: { summary: 'No list price on file for the brake pads.' } }] },
    ]);

    await world.runner(llm).run(request(world, { objective: 'resolve_partial_approval' }));

    const result = world.agent.agentWorld.steps[0]?.toolResults[0];
    expect((result?.result as { code: string }).code).toBe('NO_LIST_PRICE');
  });

  it('compose returns a candidate and sends nothing', async () => {
    const llm = script([
      {
        text: '',
        toolCalls: [
          {
            name: 'compose_customer_message',
            args: {
              draft: 'Front brake pads (set) comes to ₹3,200.00.',
              claims: [
                { text: 'Front brake pads (set) comes to ₹3,200.00.', sources: ['line:line-brakes'] },
              ],
              language: 'en',
            },
          },
        ],
      },
      { text: 'waiting', toolCalls: [] },
      { text: 'waiting', toolCalls: [] },
      { text: 'waiting', toolCalls: [] },
      { text: 'waiting', toolCalls: [] },
      { text: 'waiting', toolCalls: [] },
    ]);

    await world.runner(llm).run(request(world, { objective: 'explain_evidence' }));

    const composed = world.agent.agentWorld.steps[0]?.toolResults[0];
    expect(composed?.ok).toBe(true);
    expect((composed?.result as { candidateId: string }).candidateId).toMatch(/^cand_/);
    expect(world.sender.sent).toHaveLength(0);
  });

  it('will not send a candidate that was never composed', async () => {
    const llm = script([
      { text: '', toolCalls: [{ name: 'send_customer_message', args: { candidateId: 'cand_made_up' } }] },
      { text: '', toolCalls: [{ name: 'handoff_to_human', args: { summary: 'Could not compose a reply.' } }] },
    ]);

    await world.runner(llm).run(request(world, { objective: 'explain_evidence' }));

    const result = world.agent.agentWorld.steps[0]?.toolResults[0];
    expect((result?.result as { code: string }).code).toBe('UNKNOWN_CANDIDATE');
    expect(world.sender.sent).toHaveLength(0);
  });

  it('rejects an approval request naming a work item outside the bundle', async () => {
    const llm = script([
      {
        text: '',
        toolCalls: [
          {
            name: 'create_approval_request',
            args: { workItemIds: [uuidv7()], ladderRef: 'APPROVAL' },
          },
        ],
      },
      { text: '', toolCalls: [{ name: 'handoff_to_human', args: { summary: 'Bundle does not cover the requested work.' } }] },
    ]);

    await world.runner(llm).run(request(world));

    const result = world.agent.agentWorld.steps[0]?.toolResults[0];
    expect((result?.result as { code: string }).code).toBe('WORK_ITEM_NOT_IN_BUNDLE');
    expect(world.sender.sent).toHaveLength(0);
  });

  it('rejects invalid arguments before the handler runs', async () => {
    const llm = script([
      { text: '', toolCalls: [{ name: 'adjust_offer', args: { lineId: 'line-brakes', newPricePaise: -5 } }] },
      { text: '', toolCalls: [{ name: 'handoff_to_human', args: { summary: 'Could not adjust the offer.' } }] },
    ]);

    await world.runner(llm).run(request(world, { objective: 'resolve_partial_approval' }));

    const verdicts = world.agent.agentWorld.steps[0]?.checkerVerdicts ?? [];
    expect(verdicts[0]?.code).toBe('INVALID_ARGS');
  });
});

describe('L0 shadow mode, end to end', () => {
  it('routes the agent draft to HITL and never reaches the wire', async () => {
    // The default: every flow at L0.
    const world = build();
    await world.bundle();

    const llm = script([
      {
        text: '',
        toolCalls: [
          {
            name: 'create_approval_request',
            args: { workItemIds: [ITEM_BRAKES, ITEM_OIL], ladderRef: 'APPROVAL' },
          },
        ],
      },
    ]);

    const report = await world.runner(llm).run(request(world));

    expect(report.outcome).toBe('objective_met');
    expect(world.sender.sent).toHaveLength(0);

    const held = world.harness.world.messages.filter(
      (message) => message.status === 'PENDING_APPROVAL',
    );
    expect(held).toHaveLength(1);
    expect(held[0]?.createdByAgent).toBe(true);
    expect(held[0]?.agentRunId).toBe(report.runId);
  });
});
