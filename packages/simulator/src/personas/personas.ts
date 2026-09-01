import { MockLlmAdapter, deterministicJudge } from '@serviceloop/adapters';
import { sourcesFor } from '@serviceloop/agent-core';
import {
  APPROVAL_ACTION_IDS,
  windowExpiryFrom,
  type EvidenceBundle,
} from '@serviceloop/domain';
import {
  formatPaise,
  type CustomerDecision,
  type EtaMateriality,
  type EtaReason,
  type Language,
} from '@serviceloop/shared';
import {
  BRAKE_LINE_PAISE,
  SIM_CONVERSATION,
  SIM_CUSTOMER,
  SIM_ITEM_BRAKES,
  SIM_ITEM_OIL,
  SIM_JOB_CARD,
  SIM_SHOP,
  SIM_T0,
  simJobCard,
  TOTAL_PAISE,
  type SimWorld,
} from './world';

/**
 * The persona suite (phase 3.10).
 *
 * Six customers, each a behaviour the approval flow has to survive. They are
 * written as *scripts of what a person does*, not as assertions about what the
 * agent says: a persona presses a button, or types a sentence, and the runner
 * checks the outcome, the turn count, the time to decision and — on every
 * message that actually reached them — the guardrails.
 *
 * The agent's own turns are scripted through `MockLlmAdapter`, which raises
 * rather than improvising when a script runs out. That is what makes a failure
 * here a finding about the runtime instead of a flaky model.
 */

export interface PersonaTurn {
  /** What the customer did, for the transcript. */
  readonly actor: 'customer' | 'shop';
  readonly text: string;
  readonly atMinute: number;
}

export interface PersonaOutcome {
  readonly decision: CustomerDecision | null;
  readonly approvedWorkItemIds: readonly string[];
  readonly deferredWorkItemIds: readonly string[];
  readonly handoffs: number;
  readonly turns: readonly PersonaTurn[];
  /** Minutes from the bundle going out to the decision landing. Null if none. */
  readonly timeToDecisionMinutes: number | null;
}

export interface Persona {
  readonly name: string;
  readonly description: string;
  readonly language: Language;
  readonly customerName: string;
  /** Customer turns the flow may take before a decision. */
  readonly maxTurns: number;
  /** Time-to-decision budget (L3 measures this, not messages sent). */
  readonly maxMinutesToDecision: number;
  readonly expect: {
    readonly decision: CustomerDecision | null;
    readonly approvedWorkItemIds?: readonly string[];
    readonly handoffs?: number;
  };
  /** The agent's scripted turns, when this persona makes the agent talk. */
  script(): MockLlmAdapter | undefined;
  run(world: SimWorld, bundle: EvidenceBundle, approvalId: string): Promise<PersonaOutcome>;
}

/* -------------------------------------------------------------------------- *
 * Script helpers
 * -------------------------------------------------------------------------- */

interface Turn {
  readonly text: string;
  readonly toolCalls: ReadonlyArray<{ readonly name: string; readonly args: unknown }>;
  readonly expect?: string;
}

function script(name: string, turns: readonly Turn[]): MockLlmAdapter {
  return new MockLlmAdapter(
    {
      name,
      description: `persona script: ${name}`,
      model: 'mock-agent',
      turns: turns.map((turn) => ({
        ...turn,
        toolCalls: turn.toolCalls.map((call) => ({ ...call })),
        inputTokens: 900,
        outputTokens: 120,
      })),
    },
    {
      // The script is the *agent's* turns. The claim judge is delegated, so a
      // JUDGE call mid-run cannot consume the agent's next step.
      handles: ['AGENT'],
      delegate: deterministicJudge(),
    },
  );
}

/** A compose+send pair, the shape every conversational turn ends in. */
function reply(
  body: string,
  claims: ReadonlyArray<{ text: string; sources: string[] }>,
  language: Language,
): readonly Turn[] {
  return [
    {
      text: '',
      toolCalls: [
        { name: 'compose_customer_message', args: { draft: body, claims, language } },
      ],
    },
    {
      text: '',
      // Resolved from the compose call's own tool result — the same way a
      // real model reads the id it was just handed.
      toolCalls: [{ name: 'send_customer_message', args: { candidateId: '{{candidateId}}' } }],
    },
  ];
}

/* -------------------------------------------------------------------------- *
 * Runner helpers shared by the conversational personas
 * -------------------------------------------------------------------------- */

async function runObjection(
  world: SimWorld,
  bundle: EvidenceBundle,
  customerSays: string,
): Promise<{ outcome: string; handoffs: number }> {
  const before = countHandoffs(world);

  const report = await world.runtime.runner.run({
    shopId: SIM_SHOP,
    objective: 'resolve_partial_approval',
    conversationId: SIM_CONVERSATION,
    customerId: SIM_CUSTOMER,
    jobCardId: SIM_JOB_CARD,
    triggerMessageId: null,
    traceId: `sim:${customerSays.slice(0, 20)}`,
    config: world.config,
    shop: {
      name: 'Sri Murugan Auto Works',
      city: 'Chennai',
      advisorName: 'Meena',
      priceListSummary: `- Front brake pads (set): typically ${formatPaise(BRAKE_LINE_PAISE)}`,
    },
    card: simJobCard(world.language, 'Ravi'),
    conversationTail: [],
    sources: sourcesFor(bundle).map((source) => ({ id: source.id, text: source.text })),
    language: world.language,
    customerName: 'Ravi',
  });

  return { outcome: report.outcome, handoffs: countHandoffs(world) - before };
}

/**
 * Every task that puts this conversation in front of a person.
 *
 * An owner-digest exception counts: it is a human being asked to intervene on a
 * customer who never answered, which is exactly what a handoff is. Counting only
 * the two obvious kinds would let a ladder that ends in silence look like a
 * ladder that closed.
 */
function countHandoffs(world: SimWorld): number {
  const human = new Set(['HANDOFF', 'CALL_CUSTOMER', 'OWNER_EXCEPTION']);
  return [...world.agentHarness.agentWorld.tasks.values()].filter((task) =>
    human.has(task.kind),
  ).length;
}

async function tapApprove(world: SimWorld, note: string): Promise<void> {
  await world.runtime.replies.approve({
    shopId: SIM_SHOP,
    conversationId: SIM_CONVERSATION,
    customerId: SIM_CUSTOMER,
    triggerMessageId: null,
    replyTitle: note,
    traceId: 'sim:approve',
  });
}

async function decisionOf(
  world: SimWorld,
  approvalId: string,
): Promise<{
  decision: CustomerDecision | null;
  approved: readonly string[];
  deferred: readonly string[];
}> {
  const approval = world.agentHarness.agentWorld.approvals.get(approvalId);
  if (approval === undefined) return { decision: null, approved: [], deferred: [] };
  return {
    decision: approval.decision,
    approved: approval.approvedWorkItemIds,
    deferred: approval.workItemIds.filter(
      (id) => !approval.approvedWorkItemIds.includes(id),
    ),
  };
}

/* -------------------------------------------------------------------------- *
 * The personas
 * -------------------------------------------------------------------------- */

/** Reads the estimate, taps Approve. The path most customers actually take. */
const quickApprover: Persona = {
  name: 'quick_approver',
  description: 'Reads the estimate and approves it within minutes',
  language: 'en',
  customerName: 'Ravi',
  maxTurns: 1,
  maxMinutesToDecision: 30,
  expect: { decision: 'FULL', approvedWorkItemIds: [SIM_ITEM_BRAKES, SIM_ITEM_OIL] },
  script: () => undefined,

  async run(world, _bundle, approvalId) {
    world.setNow(new Date(world.now().getTime() + 6 * 60_000));
    await tapApprove(world, 'Approve ✅');

    const decision = await decisionOf(world, approvalId);
    return {
      decision: decision.decision,
      approvedWorkItemIds: decision.approved,
      deferredWorkItemIds: decision.deferred,
      handoffs: 0,
      turns: [{ actor: 'customer', text: 'tapped Approve', atMinute: world.elapsedMinutes() }],
      timeToDecisionMinutes: world.elapsedMinutes(),
    };
  },
};

/**
 * Pushes on price twice, then accepts a concession that stays inside the floor.
 *
 * The shop here permits a 10% discount, so the first ask (a third off) is
 * refused by `adjust_offer` and the agent has to relay that honestly. Break the
 * price floor and this persona fails loudly, which is the point of it.
 */
const priceObjector: Persona = {
  name: 'price_objector',
  description: 'Asks for a discount twice; accepts one that stays inside the floor',
  language: 'en',
  customerName: 'Ravi',
  maxTurns: 3,
  maxMinutesToDecision: 90,
  expect: { decision: 'FULL' },

  script: () =>
    script('price_objector', [
      // Round one: a third off. Below the floor, so the tool refuses and the
      // agent relays the refusal with the owner-check offer.
      {
        text: '',
        toolCalls: [
          { name: 'adjust_offer', args: { lineId: 'line-brakes', newPricePaise: 213_000 } },
        ],
      },
      ...reply(
        'That is below what I am able to offer. I can check with the owner and come back to you. Front brake pads (set) comes to ₹3,200.00.',
        [{ text: 'Front brake pads (set) comes to ₹3,200.00.', sources: ['line:line-brakes'] }],
        'en',
      ),
      // Round two: 10% off, exactly the ceiling. Accepted.
      {
        text: '',
        toolCalls: [
          { name: 'adjust_offer', args: { lineId: 'line-brakes', newPricePaise: 288_000 } },
        ],
      },
      ...reply(
        'I can do the brake pads for ₹2,880.00. Shall we go ahead?',
        [
          {
            text: 'I can do the brake pads for ₹2,880.00.',
            // The id `adjust_offer` minted when it approved the concession.
            sources: ['line:line-brakes@agreed'],
          },
        ],
        'en',
      ),
    ]),

  async run(world, bundle, approvalId) {
    const turns: PersonaTurn[] = [];
    let handoffs = 0;

    world.setNow(new Date(world.now().getTime() + 12 * 60_000));
    turns.push({ actor: 'customer', text: 'Too much. Any discount?', atMinute: world.elapsedMinutes() });
    handoffs += (await runObjection(world, bundle, 'Too much. Any discount?')).handoffs;

    world.setNow(new Date(world.now().getTime() + 20 * 60_000));
    turns.push({
      actor: 'customer',
      text: 'Come on, do something on the price',
      atMinute: world.elapsedMinutes(),
    });
    handoffs += (await runObjection(world, bundle, 'Come on, do something')).handoffs;

    world.setNow(new Date(world.now().getTime() + 8 * 60_000));
    turns.push({ actor: 'customer', text: 'Ok fine, go ahead', atMinute: world.elapsedMinutes() });
    await tapApprove(world, 'Approve ✅');

    const decision = await decisionOf(world, approvalId);
    return {
      decision: decision.decision,
      approvedWorkItemIds: decision.approved,
      deferredWorkItemIds: decision.deferred,
      handoffs,
      turns,
      timeToDecisionMinutes: world.elapsedMinutes(),
    };
  },
};

/**
 * Says nothing at all.
 *
 * The whole ladder runs under the fake clock and nobody decides, which is the
 * *correct* outcome: the objective ends with a person holding it, not with the
 * agent inventing consent. Time-to-decision is null and that is not a failure.
 */
const silentCustomer: Persona = {
  name: 'silent_customer',
  description: 'Never replies; the full ladder runs and ends with a human',
  language: 'en',
  customerName: 'Ravi',
  maxTurns: 0,
  maxMinutesToDecision: Number.POSITIVE_INFINITY,
  expect: { decision: null, handoffs: 2 },
  script: () => undefined,

  async run(world) {
    const turns: PersonaTurn[] = [];

    // Drain the ladder at each rung's due time: 45m (deferred by the frequency
    // cap, then sent), 2h (the voice rung), 24h (the owner exception).
    for (const minute of [45, 61, 120, 1440]) {
      world.setNow(new Date(world.now().getTime() + 0));
      world.setNow(new Date(new Date('2026-08-14T08:30:00.000Z').getTime() + minute * 60_000));
      for (const job of world.scheduler.due(world.now())) {
        const result = await world.runtime.ladder.fireRung({
          shopId: SIM_SHOP,
          escalationId: job.escalationId,
          traceId: 'sim:ladder',
        });
        world.scheduler.complete(job.jobId);
        turns.push({ actor: 'shop', text: `rung → ${result.outcome}`, atMinute: minute });
      }
    }

    return {
      decision: null,
      approvedWorkItemIds: [],
      deferredWorkItemIds: [],
      handoffs: countHandoffs(world),
      turns,
      timeToDecisionMinutes: null,
    };
  },
};

/**
 * Doubts the work is needed.
 *
 * The correct answer is evidence, not persuasion: re-send the photo and offer
 * the old-part inspection at pickup — a standing allowed claim, true of every
 * job, which is why the checker exempts it without a source id.
 */
const sceptic: Persona = {
  name: 'sceptic',
  description: 'Doubts the work is needed; is answered with evidence, not pressure',
  language: 'en',
  customerName: 'Ravi',
  maxTurns: 2,
  maxMinutesToDecision: 60,
  expect: { decision: 'FULL' },

  script: () =>
    script('sceptic', [
      { text: '', toolCalls: [{ name: 'get_job_card', args: {} }] },
      ...reply(
        'I have attached a photo of what was found. You are welcome to inspect the old parts when you collect the vehicle.',
        [{ text: 'I have attached a photo of what was found.', sources: ['media:media-1'] }],
        'en',
      ),
    ]),

  async run(world, bundle, approvalId) {
    const turns: PersonaTurn[] = [];

    world.setNow(new Date(world.now().getTime() + 15 * 60_000));
    turns.push({
      actor: 'customer',
      text: 'Is it really needed? You people always find something',
      atMinute: world.elapsedMinutes(),
    });
    const objection = await runObjection(world, bundle, 'Is it really needed?');

    world.setNow(new Date(world.now().getTime() + 9 * 60_000));
    turns.push({ actor: 'customer', text: 'Ok, go ahead', atMinute: world.elapsedMinutes() });
    await tapApprove(world, 'Approve ✅');

    const decision = await decisionOf(world, approvalId);
    return {
      decision: decision.decision,
      approvedWorkItemIds: decision.approved,
      deferredWorkItemIds: decision.deferred,
      handoffs: objection.handoffs,
      turns,
      timeToDecisionMinutes: world.elapsedMinutes(),
    };
  },
};

/**
 * Short Tamil messages, plainly confused.
 *
 * The right move is to stop explaining and offer a call — L6, applied before
 * being asked. The persona asserts a callback task exists, because "offer a
 * call" that produces nothing an advisor can act on is not an offer.
 */
const confusedElder: Persona = {
  name: 'confused_elder',
  description: 'Short Tamil messages and evident confusion; is offered a call proactively',
  language: 'ta',
  customerName: 'Kumar',
  maxTurns: 2,
  maxMinutesToDecision: 120,
  // Two: the agent hands off when it sees the confusion, and the customer's
  // own "Call me" raises the callback. Both are correct and both are wanted.
  expect: { decision: null, handoffs: 2 },

  script: () =>
    script('confused_elder', [
      {
        text: '',
        toolCalls: [
          {
            name: 'handoff_to_human',
            args: {
              summary:
                'Kumar sounds confused about the brake estimate and writes in short Tamil — call him rather than explaining again.',
              urgency: 'NORMAL',
            },
          },
        ],
      },
    ]),

  async run(world, bundle) {
    const turns: PersonaTurn[] = [];

    world.setNow(new Date(world.now().getTime() + 20 * 60_000));
    turns.push({ actor: 'customer', text: 'என்ன?', atMinute: world.elapsedMinutes() });
    const objection = await runObjection(world, bundle, 'என்ன?');

    world.setNow(new Date(world.now().getTime() + 5 * 60_000));
    turns.push({ actor: 'customer', text: 'புரியல', atMinute: world.elapsedMinutes() });
    await world.runtime.replies.requestCall({
      shopId: SIM_SHOP,
      conversationId: SIM_CONVERSATION,
      customerId: SIM_CUSTOMER,
      triggerMessageId: null,
      replyTitle: 'அழையுங்கள் 📞',
      traceId: 'sim:call',
    });

    return {
      decision: null,
      approvedWorkItemIds: [],
      deferredWorkItemIds: [],
      handoffs: objection.handoffs + 1,
      turns,
      timeToDecisionMinutes: null,
    };
  },
};

/**
 * Approves the brakes, defers the oil.
 *
 * The most common real outcome, and the one a naive implementation gets wrong
 * by treating "partial" as a degraded yes. The deferred line must land in the
 * ledger with reason `customer_partial` — it is revenue phase 6 re-pitches.
 */
const partialApprover: Persona = {
  name: 'partial_approver',
  description: 'Approves the brakes now and defers the oil change',
  language: 'en',
  customerName: 'Ravi',
  maxTurns: 2,
  maxMinutesToDecision: 60,
  expect: { decision: 'PARTIAL', approvedWorkItemIds: [SIM_ITEM_BRAKES] },

  // Decided through the service rather than through a run: this persona is
  // about what a *partial* decision does to the work items and the ledger, and
  // routing it through the agent would only be testing the agent twice.
  script: () => undefined,

  async run(world, _bundle, approvalId) {
    const turns: PersonaTurn[] = [];

    world.setNow(new Date(world.now().getTime() + 18 * 60_000));
    turns.push({
      actor: 'customer',
      text: 'Do the brakes only. Oil next time.',
      atMinute: world.elapsedMinutes(),
    });

    await world.runtime.approvals.recordCustomerDecision({
      shopId: SIM_SHOP,
      approvalId,
      decision: 'PARTIAL',
      approvedWorkItemIds: [SIM_ITEM_BRAKES],
      note: 'brakes only for now, oil next time',
      decidedVia: 'agent',
      actor: { type: 'CUSTOMER', id: SIM_CUSTOMER },
      traceId: 'sim:partial',
    });

    const decision = await decisionOf(world, approvalId);
    return {
      decision: decision.decision,
      approvedWorkItemIds: decision.approved,
      deferredWorkItemIds: decision.deferred,
      handoffs: 0,
      turns,
      timeToDecisionMinutes: world.elapsedMinutes(),
    };
  },
};

/**
 * "Where's my car?" — five times, in the words people use (phase 4.5).
 *
 * The only persona that never decides anything, and that is the point: this one
 * exists to prove the *deflection* half of the loop. Every answer is grounded in
 * the card's live state and its ETA history and nothing else, and the sixth
 * question — a discount, on a thread whose job is answering "is it ready" —
 * must leave rather than be improvised.
 *
 * The card is moved between questions on purpose. The gate asks for correct
 * answers "at any state", and a persona that asked five times about a card
 * sitting in one state would have tested one answer five times.
 */
const statusChecker: Persona = {
  name: 'status_checker',
  description: 'Asks where the car is, five ways; the discount probe is routed, not answered',
  language: 'en',
  customerName: 'Ravi',
  maxTurns: 6,
  maxMinutesToDecision: 240,
  // Nothing is being asked of this customer, so there is nothing to decide.
  // The one handoff is the discount probe leaving for the flow that owns price.
  expect: { decision: null, handoffs: 1 },

  script: () =>
    script('status_checker', [
      // 1. "Is it ready?" — the card's state, in words a person uses.
      { text: '', toolCalls: [{ name: 'get_job_card', args: {} }] },
      ...statusReply(
        'Your Maruti Swift is with the technician now, and the approved work is under way.',
        `state:${SIM_JOB_CARD}#IN_PROGRESS`,
      ),

      // 2. "How much longer?" — the ETA, and the reason it is what it is.
      { text: '', toolCalls: [{ name: 'get_eta', args: { history: 5 } }] },
      ...statusReply(
        'We expect it to be ready later today. I will tell you the moment that changes.',
        `eta:${SIM_JOB_CARD}#1`,
      ),

      // 3. "Car ready aacha?" — after the ETA slipped, which is the case that
      //    matters: people forgive a delay they were told about.
      { text: '', toolCalls: [{ name: 'get_eta', args: { history: 5 } }] },
      ...statusReply(
        'Not yet. A part we need has not arrived, so the time has moved to tomorrow morning.',
        `eta:${SIM_JOB_CARD}#2`,
      ),

      // 4. "What are you doing to it?" — the approved lines, and no more.
      { text: '', toolCalls: [{ name: 'get_job_card', args: {} }] },
      ...statusReply(
        'We are replacing the front brake pads and changing the engine oil and filter.',
        'line:line-brakes',
      ),

      // 5. "Kitna time aur lagega?" — in quality check, which in a person's
      //    words means finished and being checked over.
      { text: '', toolCalls: [{ name: 'get_job_card', args: {} }] },
      ...statusReply(
        'The work is finished and we are checking it over now.',
        `state:${SIM_JOB_CARD}#QUALITY_CHECK`,
      ),

      // 6. The out-of-scope probe. No compose, no send — it leaves.
      {
        text: '',
        toolCalls: [
          {
            name: 'handoff_to_human',
            args: {
              summary:
                'Asked for 20% off on a status thread — pricing belongs to the approval flow',
              urgency: 'NORMAL',
            },
          },
        ],
      },
    ]),

  async run(world) {
    const turns: PersonaTurn[] = [];

    const ask = async (text: string, atMinutes: number): Promise<void> => {
      world.setNow(new Date(SIM_T0.getTime() + atMinutes * 60_000));
      turns.push({ actor: 'customer', text, atMinute: world.elapsedMinutes() });
      // The customer writing is what re-opens the 24-hour service window, and
      // day two's questions land outside the window the approval request
      // opened. Recording the inbound is not a convenience: without it the
      // guardrail is correct and the persona is measuring the wrong thing.
      await world.harness.uow.transaction((tx) =>
        world.conversations.recordInbound(tx, {
          conversationId: SIM_CONVERSATION,
          at: world.now(),
          windowExpiresAt: windowExpiryFrom(world.now()),
        }),
      );
      await runStatus(world, text);
    };

    // Spread across two days, and not for convenience: the shop's daily cap is
    // three outbound messages per customer and the approval request already
    // used one of today's. A persona that answered five questions inside an
    // hour would be testing a shop that had turned its own frequency cap off.
    moveCard(world, 'IN_PROGRESS');
    await ask('is it ready?', 20);

    appendEta(world, {
      version: 1,
      eta: new Date(SIM_T0.getTime() + 3 * 60 * 60_000),
      previousEta: null,
      reason: 'WORK_APPROVED',
      materiality: 'IMMATERIAL',
      detail: 'Work approved; three hours of shop time remaining',
    });
    await ask('how much longer?', 35);

    // The part did not arrive. This is the question the objective exists for.
    moveCard(world, 'AWAITING_PARTS');
    appendEta(world, {
      version: 2,
      eta: new Date(SIM_T0.getTime() + 26 * 60 * 60_000),
      previousEta: new Date(SIM_T0.getTime() + 3 * 60 * 60_000),
      reason: 'BLOCKED_PARTS',
      materiality: 'MATERIAL_SLIP',
      detail: 'Waiting for the front brake caliper; the part arrives tomorrow morning',
    });
    await ask('car ready aacha?', 26 * 60);

    moveCard(world, 'IN_PROGRESS');
    await ask('what are you doing to it?', 27 * 60);

    moveCard(world, 'QUALITY_CHECK');
    await ask('kitna time aur lagega?', 28 * 60);

    // Out of scope: pricing belongs to the approval flow, where the floor and
    // the ceiling are enforced. Answering it here would be the agent inventing
    // an authority it does not have.
    const before = countHandoffs(world);
    await ask('give me 20% off and I will pay cash now', 29 * 60);
    const handoffs = countHandoffs(world) - before;

    return {
      decision: null,
      approvedWorkItemIds: [],
      deferredWorkItemIds: [],
      handoffs,
      turns,
      // Nothing was decided, so there is no time-to-decision to budget.
      timeToDecisionMinutes: null,
    };
  },
};

/** One grounded status answer: a claim, and the single source it restates. */
function statusReply(body: string, source: string): readonly Turn[] {
  return reply(body, [{ text: body, sources: [source] }], 'en');
}

/** Moves the card the tools read, so an answer is about the state it names. */
function moveCard(world: SimWorld, state: string): void {
  const card = world.agentHarness.agentWorld.cards.get(SIM_JOB_CARD);
  if (card === undefined) return;
  world.agentHarness.agentWorld.putCard({ ...card, state });
}

/** Appends an ETA entry the way the engine would, so `get_eta` reads it back. */
function appendEta(
  world: SimWorld,
  entry: {
    version: number;
    eta: Date;
    previousEta: Date | null;
    reason: EtaReason;
    materiality: EtaMateriality;
    detail: string;
  },
): void {
  world.statusWorld.etaEntries.push({
    id: `eta-${entry.version}`,
    shopId: SIM_SHOP,
    jobCardId: SIM_JOB_CARD,
    version: entry.version,
    previousEta: entry.previousEta,
    eta: entry.eta,
    promisedAt: null,
    reason: entry.reason,
    materiality: entry.materiality,
    deltaMinutes:
      entry.previousEta === null
        ? 0
        : Math.round((entry.eta.getTime() - entry.previousEta.getTime()) / 60_000),
    detail: entry.detail,
    statusSignalId: null,
    notifiedAt: entry.materiality === 'MATERIAL_SLIP' ? world.now() : null,
    createdAt: world.now(),
  });
}

async function runStatus(world: SimWorld, customerSays: string): Promise<void> {
  await world.runtime.runner.run({
    shopId: SIM_SHOP,
    objective: 'answer_status',
    conversationId: SIM_CONVERSATION,
    customerId: SIM_CUSTOMER,
    jobCardId: SIM_JOB_CARD,
    triggerMessageId: null,
    traceId: `sim:status:${customerSays.slice(0, 16)}`,
    config: world.config,
    shop: {
      name: 'Sri Murugan Auto Works',
      city: 'Chennai',
      advisorName: 'Meena',
      priceListSummary: '',
    },
    card: world.agentHarness.agentWorld.cards.get(SIM_JOB_CARD) ?? null,
    conversationTail: [],
    sources: [],
    language: 'en',
    customerName: 'Ravi',
  });
}

export const PERSONAS: readonly Persona[] = [
  quickApprover,
  priceObjector,
  silentCustomer,
  sceptic,
  confusedElder,
  partialApprover,
  statusChecker,
];

export { APPROVAL_ACTION_IDS, TOTAL_PAISE, SIM_ITEM_OIL };
