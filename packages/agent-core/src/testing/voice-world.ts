import {
  BrowserLoopbackTelephonyAdapter,
  MockStreamingSpeechAdapter,
  ScriptedCaller,
  deterministicJudge,
  type CallerAction,
  type CallerTranscript,
  type LoopbackHandset,
  type LlmPort,
} from '@serviceloop/adapters';
import { defaultShopConfig, type ShopConfig } from '@serviceloop/config';
import {
  JobCardTransitionService,
  OutboundGate,
  VoiceCallService,
  WorkItemTransitionService,
  type EvidenceBundle,
  type JobCardContext,
} from '@serviceloop/domain';
import {
  createAgentTestHarness,
  createDomainTestHarness,
  createVoiceTestHarness,
  InMemoryConsentStore,
  InMemoryConversationStore,
  InMemoryEtaStore,
  InMemoryMessageStore,
  InMemoryStatusWorld,
  RecordingChannelSender,
  VoiceWorld,
  type AgentTestHarness,
  type DomainTestHarness,
  type MemoryTx,
  type VoiceTestHarness,
} from '@serviceloop/domain/testing';
import { uuidv7, type Language, type Paise } from '@serviceloop/shared';
import { createAgentRuntime, type AgentRuntime } from '../composition';
import { DeterministicExplanationWriter } from '../explanation-writer';
import { createVoiceRuntime, voiceSettingsFrom } from '../voice/composition';
import type {
  CallReport,
  OutboundApprovalCallInput,
  InboundCallInput,
  VoiceAgentRunner,
  VoiceRuntimeSettings,
  VoiceTraceLine,
} from '../voice/voice-runner';
import { APPROVAL_SUBJECT_TYPE, type FireRungResult } from '@serviceloop/domain';

/**
 * A whole telephone call, in memory (phase 5).
 *
 * The voice runtime is the hardest thing in this codebase to test, for a reason
 * that has nothing to do with speech: **a call has two parties and both of them
 * block**. The runner speaks and then waits; the customer listens and then
 * answers; neither can be driven by calling methods in sequence. So a voice
 * test is two concurrent actors, and this is the harness that runs them —
 * `VoiceAgentRunner` on one side, `ScriptedCaller` on a `LoopbackHandset` on
 * the other, with a fake clock, no database, no telco and no model.
 *
 * Exported from `@serviceloop/agent-core/testing` rather than kept beside the
 * tests because three things need exactly this world: the phase-5 unit tests,
 * the voice persona suite (`sim:voice`) and `demo:phase5`. A persona proven in
 * CI has to be the same persona the demo plays back, or the demo is theatre.
 *
 * Two knobs make it fast without making it fake. `playbackSpeed` runs the
 * modelled line faster than real time — the same seam as the fake clock, and it
 * changes no behaviour under test, only how long the test waits for audio the
 * runtime has already queued. `endpointSilenceMs` is shortened for the same
 * reason. Everything the phase actually asserts — the ordering of the
 * disclosure and the recorder, the readback before a decision, the barge-in
 * cut, the keypad, the caps — runs at full fidelity.
 */

export const VOICE_SHOP = '01920000-0000-7000-8000-0000000000aa';
export const VOICE_CUSTOMER = '01920000-0000-7000-8000-0000000000bb';
export const VOICE_JOB_CARD = '01920000-0000-7000-8000-0000000000dd';
export const VOICE_ITEM_BRAKES = '01920000-0000-7000-8000-0000000000e1';
export const VOICE_ITEM_OIL = '01920000-0000-7000-8000-0000000000e2';
export const VOICE_CONVERSATION = '01920000-0000-7000-8000-0000000000ff';
export const VOICE_ADVISOR = '01920000-0000-7000-8000-000000000a01';
export const VOICE_APPROVAL = '01920000-0000-7000-8000-000000000b01';

export const CUSTOMER_PHONE = '+919841100001';
export const ADVISOR_PHONE = '+919841100099';

/** 2026-08-14, 14:00 IST — inside business hours, outside quiet hours. */
export const VOICE_T0 = new Date('2026-08-14T08:30:00.000Z');

export const BRAKE_PAISE: Paise = 240_000;
export const OIL_PAISE: Paise = 60_000;
export const VOICE_TOTAL_PAISE: Paise = BRAKE_PAISE + OIL_PAISE;

export const WORK_SUMMARY = 'front brake pads worn to 2.1mm and an engine oil change';

export function voiceJobCard(language: Language, customerName = 'Ravi'): JobCardContext {
  return {
    jobCardId: VOICE_JOB_CARD,
    code: 'JC-2026-0042',
    state: 'AWAITING_APPROVAL',
    customerId: VOICE_CUSTOMER,
    customerName,
    customerLanguage: language,
    vehicleLabel: 'Maruti Swift',
    registration: 'TN09BX4432',
    odometerKm: 62_000,
    promisedAt: null,
    complaint: 'Grinding noise when braking',
    workItems: [
      {
        id: VOICE_ITEM_BRAKES,
        title: 'Front brake pad replacement',
        state: 'PENDING_APPROVAL',
        requiresApproval: true,
        technicianNote: 'Front pads worn to 2.1mm, minimum is 3mm. Metal to metal soon.',
        estimatedMinutes: 60,
      },
      {
        id: VOICE_ITEM_OIL,
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
      totalPaise: VOICE_TOTAL_PAISE,
      lines: [
        {
          id: 'line-brakes',
          workItemId: VOICE_ITEM_BRAKES,
          description: 'Front brake pads (set)',
          kind: 'PART',
          quantityMilli: 1000,
          unitPricePaise: BRAKE_PAISE,
          lineTotalPaise: BRAKE_PAISE,
          taxRateBp: 1800,
          listPricePaise: BRAKE_PAISE,
        },
        {
          id: 'line-oil',
          workItemId: VOICE_ITEM_OIL,
          description: 'Engine oil and filter',
          kind: 'CONSUMABLE',
          quantityMilli: 1000,
          unitPricePaise: OIL_PAISE,
          lineTotalPaise: OIL_PAISE,
          taxRateBp: 1800,
          listPricePaise: OIL_PAISE,
        },
      ],
    },
    media: [
      { id: 'media-1', kind: 'PHOTO', caption: 'Worn front pad', workItemId: VOICE_ITEM_BRAKES },
    ],
    advisorName: 'Meena',
  };
}

export interface VoiceCallWorldOptions {
  readonly language?: Language;
  readonly customerName?: string;
  /** The agent's scripted turns. The deterministic judge when absent. */
  readonly llm?: LlmPort;
  readonly configPatch?: (config: ShopConfig) => ShopConfig;
  readonly settingsPatch?: Partial<VoiceRuntimeSettings>;
  /** True runs the modelled line at real time, for a demo somebody listens to. */
  readonly realTimeAudio?: boolean;
  readonly platformKillSwitch?: () => boolean;
  readonly onTrace?: (line: VoiceTraceLine) => void;
  /** Ring delay, so a demo call reads as a phone call rather than a function. */
  readonly ringDelayMs?: number;
}

export interface PlacedCall {
  readonly report: CallReport;
  /** Null when the gate refused before a line was ever opened. */
  readonly caller: CallerTranscript | null;
}

export interface VoiceCallWorld {
  readonly harness: DomainTestHarness;
  readonly agentHarness: AgentTestHarness;
  readonly voice: VoiceTestHarness;
  readonly voiceWorld: VoiceWorld;
  readonly runtime: AgentRuntime<MemoryTx>;
  readonly runner: VoiceAgentRunner<MemoryTx>;
  readonly telephony: BrowserLoopbackTelephonyAdapter;
  readonly speech: MockStreamingSpeechAdapter;
  readonly calls: VoiceCallService<MemoryTx>;
  readonly sender: RecordingChannelSender;
  readonly config: ShopConfig;
  readonly language: Language;
  readonly traces: readonly VoiceTraceLine[];
  now(): Date;
  setNow(at: Date): void;
  /** Everything the shop sent on WhatsApp — the post-call summary lands here. */
  sentBodies(): readonly string[];
  buildBundle(): Promise<EvidenceBundle>;
  /**
   * The far end of a call, by the *call row's* id.
   *
   * The two ids are not the same — `calls.id` is ours and the session id is the
   * provider's — so this goes through `providerCallSid`, which is exactly the
   * hop the console's softphone and every provider webhook has to make.
   */
  handsetFor(callId: string): Promise<LoopbackHandset | null>;
  /**
   * The approval the call is chasing, as a real row.
   *
   * A voice test that skipped this would be testing a phone call about nothing:
   * the point of the keypad path is that pressing 1 moves the *work items*, and
   * there is nothing to move without a request. Returns the approval id, which
   * `placeOutbound` should then be pointed at.
   */
  openApproval(): Promise<string>;
  /**
   * Places an outbound approval call and runs a customer against it.
   *
   * Both parties run concurrently, which is the whole point: the caller's turn
   * exists only in the gap the runner is waiting in.
   */
  placeOutbound(
    actions: readonly CallerAction[],
    overrides?: Partial<OutboundApprovalCallInput>,
    callerOptions?: { readonly quietMs?: number; readonly timeoutMs?: number },
  ): Promise<PlacedCall>;
  /** Answers an inbound call from `CUSTOMER_PHONE` and runs a caller against it. */
  answerInbound(
    actions: readonly CallerAction[],
    overrides?: Partial<InboundCallInput>,
    callerOptions?: { readonly quietMs?: number; readonly timeoutMs?: number },
  ): Promise<PlacedCall>;
  /**
   * Fires the approval ladder's `VOICE_OR_ADVISOR` rung (phase 5.4a).
   *
   * Schedules the ladder if it is not already scheduled, then fires the voice
   * rung with a scripted customer attached — the rung is what decides whether
   * to ring at all, so this is the only way to test that decision rather than
   * the runner underneath it. Pass no actions to model a customer who does not
   * pick up.
   */
  fireVoiceRung(
    approvalId: string,
    actions?: readonly CallerAction[],
    callerOptions?: { readonly quietMs?: number; readonly timeoutMs?: number },
  ): Promise<FireRungResult>;
}

export function createVoiceCallWorld(options: VoiceCallWorldOptions = {}): VoiceCallWorld {
  const language = options.language ?? 'en';
  const customerName = options.customerName ?? 'Ravi';

  /**
   * A clock fixed to a *date* and running at real speed.
   *
   * Every other harness in this codebase freezes time, and for a phone call
   * that would be wrong twice over: the latency markers the phase budgets —
   * speech-end to speech-start — would all read zero, and the per-call time cap
   * could never be reached. So the wall clock ticks, while the calendar position
   * stays at a Thursday afternoon inside business hours, which is what the quiet
   * hours and working-hours rules are evaluated against. Durations are real;
   * "what time of day is it" is not.
   */
  let origin = new Date(VOICE_T0);
  let originAt = Date.now();
  const now = (): Date => new Date(origin.getTime() + (Date.now() - originAt));
  const clock = { now };

  const harness = createDomainTestHarness(now);
  const agentHarness = createAgentTestHarness(harness.world);
  const voiceWorld = new VoiceWorld();
  const voice = createVoiceTestHarness(voiceWorld);
  const traces: VoiceTraceLine[] = [];

  const base = defaultShopConfig('Asia/Kolkata');
  const withVoice: ShopConfig = {
    ...base,
    // The approval flow at L2 because the agent is meant to talk, and the voice
    // flow at L2 because the post-call WhatsApp summary is sent *as* the voice
    // flow — a shop left at L0 there would place the call, take the decision
    // and then hold the confirmation for an advisor to approve, which is a
    // defensible production default and a useless one to test the loop with.
    autonomy: { ...base.autonomy, approval: 'L2_CONVERSATIONAL', voice: 'L2_CONVERSATIONAL' },
    languages: { enabled: ['en', 'ta', 'hi'], default: language },
    voice: {
      ...base.voice,
      // A shop that has switched voice on, which is the only state in which any
      // of this is testable. The default is off, deliberately (§6: L0 first).
      enabled: true,
      outboundEnabled: true,
      inboundEnabled: true,
    },
  };
  const config = options.configPatch?.(withVoice) ?? withVoice;

  harness.world.addShop(VOICE_SHOP, 'Asia/Kolkata');
  harness.world.configs.set(VOICE_SHOP, config);
  harness.world.addCustomer(VOICE_SHOP, CUSTOMER_PHONE, VOICE_CUSTOMER, language, 'Maruti Swift');
  harness.world.advisors.set(VOICE_SHOP, { id: VOICE_ADVISOR, fullName: 'Meena' });

  voiceWorld.addCustomerPhone(VOICE_SHOP, VOICE_CUSTOMER, CUSTOMER_PHONE);
  voiceWorld.addAdvisorPhone(VOICE_SHOP, VOICE_ADVISOR, 'Meena', ADVISOR_PHONE);

  harness.world.cards.set(VOICE_JOB_CARD, {
    id: VOICE_JOB_CARD,
    shopId: VOICE_SHOP,
    state: 'AWAITING_APPROVAL',
    version: 1,
    stateChangedAt: new Date(VOICE_T0),
  });
  for (const id of [VOICE_ITEM_BRAKES, VOICE_ITEM_OIL]) {
    harness.world.items.set(id, {
      id,
      shopId: VOICE_SHOP,
      jobCardId: VOICE_JOB_CARD,
      state: 'PENDING_APPROVAL',
      requiresApproval: true,
    });
  }

  agentHarness.agentWorld.putCard(voiceJobCard(language, customerName));
  agentHarness.agentWorld.listPrices.set('line-brakes', BRAKE_PAISE);
  agentHarness.agentWorld.listPrices.set('line-oil', OIL_PAISE);

  harness.world.conversations.set(VOICE_CONVERSATION, {
    id: VOICE_CONVERSATION,
    shopId: VOICE_SHOP,
    kind: 'CUSTOMER',
    channel: 'WHATSAPP',
    customerId: VOICE_CUSTOMER,
    externalThreadId: 'wa:voice',
    externalAddress: CUSTOMER_PHONE,
    displayName: customerName,
    state: 'OPEN',
    language,
    lastInboundAt: new Date(VOICE_T0.getTime() - 60_000),
    lastOutboundAt: null,
    windowExpiresAt: new Date(VOICE_T0.getTime() + 20 * 60 * 60 * 1000),
    unreadCount: 0,
    humanOverrideAt: null,
  });
  harness.world.consents.push({
    id: uuidv7(),
    shopId: VOICE_SHOP,
    customerId: VOICE_CUSTOMER,
    purpose: 'SERVICE',
    status: 'GRANTED',
    channel: 'WHATSAPP',
    source: 'SEED',
    evidence: null,
    grantedAt: new Date(VOICE_T0.getTime() - 86_400_000),
    revokedAt: null,
    createdAt: new Date(VOICE_T0.getTime() - 86_400_000),
  });

  const conversations = new InMemoryConversationStore(harness.world);
  const messages = new InMemoryMessageStore(harness.world);
  const sender = new RecordingChannelSender();
  const statusWorld = new InMemoryStatusWorld();
  statusWorld.seedCard({
    jobCardId: VOICE_JOB_CARD,
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

  // The claim judge is the checker's third layer, and without a model key it
  // fails closed — a world with no judge is a world where the agent may never
  // say anything. The deterministic one keeps the layer honest without a
  // credential; a scripted model is expected to delegate JUDGE calls to it.
  const llm = options.llm ?? deterministicJudge();

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
    llm,
    config,
    conversationTail: (tx, shopId, conversationId, limit) =>
      messages.recentForConversation(tx, shopId, conversationId, limit),
    loadHeld: async () => null,
    resolvePinnedCard: async () => null,
    scheduleFollowup: async () => 'voice-followup',
    openObjectionObjective: async () => undefined,
    explanations: new DeterministicExplanationWriter(),
    clock,
  });

  const settings = voiceSettingsFrom(config, {
    // Shortened so a nine-turn call runs in under a second. The *rule* under
    // test is "a final transcript followed by silence ends the turn", and that
    // rule is exercised identically at 200 ms and at 700 ms.
    endpointSilenceMs: 150,
    noInputWaitMs: 500,
    maxDeadAirMs: 3_000,
    ringTimeoutMs: 1_500,
    ...options.settingsPatch,
  });

  const calls = new VoiceCallService<MemoryTx>({
    uow: harness.uow,
    calls: voice.calls,
    turns: voice.turns,
    consentEvents: voice.consentEvents,
    usage: voice.usage,
    consents: new InMemoryConsentStore(harness.world),
    config: harness.config,
    audit: harness.audit,
    outbox: harness.outbox,
    recordings: voice.recordings,
    rates: { ...settings.rates, usdMicrosToPaise: 9 },
    platformCapPaise: 10_000_000,
    alertRatio: 0.8,
    platformKillSwitch: options.platformKillSwitch ?? ((): boolean => false),
    retentionDays: config.voice.recordingRetentionDays,
    clock,
  });

  const telephony = new BrowserLoopbackTelephonyAdapter({
    now,
    ringDelayMs: options.ringDelayMs ?? 0,
    playbackSpeed: options.realTimeAudio === true ? 1 : 25,
    frameMs: settings.frameMs,
  });
  const speech = new MockStreamingSpeechAdapter({ frameMs: settings.frameMs });

  const runner = createVoiceRuntime<MemoryTx>({
    runtime,
    telephony,
    speech,
    calls,
    destinations: voice.destinations,
    gate,
    llm,
    stores: {
      uow: harness.uow,
      runs: agentHarness.runs,
      cards: agentHarness.cards,
      conversations,
      directory: harness.directory,
      config: harness.config,
      audit: harness.audit,
      outbox: harness.outbox,
    },
    settings,
    clock,
    onTrace: (line) => {
      traces.push(line);
      options.onTrace?.(line);
    },
  });

  const drive = async (
    running: Promise<CallReport>,
    actions: readonly CallerAction[],
    callerOptions: { readonly quietMs?: number; readonly timeoutMs?: number } = {},
  ): Promise<PlacedCall> => {
    const handset = await awaitHandset(telephony, running);
    if (handset === null) return { report: await running, caller: null };

    const caller = new ScriptedCaller(handset, actions, {
      language,
      frameMs: settings.frameMs,
      pollMs: 3,
      quietMs: callerOptions.quietMs ?? 120,
      timeoutMs: callerOptions.timeoutMs ?? 20_000,
    });

    const [report, transcript] = await Promise.all([running, caller.run()]);
    return { report, caller: transcript };
  };

  return {
    harness,
    agentHarness,
    voice,
    voiceWorld,
    runtime,
    runner,
    telephony,
    speech,
    calls,
    sender,
    config,
    language,
    traces,
    now,
    setNow: (at) => {
      origin = new Date(at);
      originAt = Date.now();
    },
    sentBodies: () =>
      sender.sent.map((message) =>
        message.content.kind === 'text'
          ? message.content.body
          : message.content.kind === 'interactive'
            ? message.content.body
            : '',
      ),

    async fireVoiceRung(approvalId, actions = [], callerOptions = {}) {
      const existing = [...agentHarness.agentWorld.escalations.values()].filter(
        (row) => row.subjectId === approvalId,
      );
      if (existing.length === 0) {
        await runtime.ladder.scheduleLadder({
          shopId: VOICE_SHOP,
          objective: 'APPROVAL',
          subjectType: APPROVAL_SUBJECT_TYPE,
          subjectId: approvalId,
          openedAt: now(),
          actor: { type: 'STAFF', id: null },
          traceId: 'voice-rung',
          skipRungs: [0],
        });
      }

      const rung = [...agentHarness.agentWorld.escalations.values()].find(
        (row) =>
          row.subjectId === approvalId &&
          row.rungType === 'VOICE_OR_ADVISOR' &&
          row.status === 'SCHEDULED',
      );
      if (rung === undefined) throw new Error('No scheduled voice rung for this approval');

      // Quiet hours and the minimum-interval hold are evaluated against the
      // clock, and the rung is scheduled hours after T0. Move the clock to the
      // rung's own time so the test fires the rung it scheduled rather than one
      // the engine defers.
      if (rung.scheduledAt.getTime() > now().getTime()) {
        origin = new Date(rung.scheduledAt);
        originAt = Date.now();
      }

      const running = runtime.ladder.fireRung({
        shopId: VOICE_SHOP,
        escalationId: rung.id,
        traceId: 'voice-rung',
      });

      if (actions.length === 0) return running;

      const handset = await awaitHandset(telephony, running);
      if (handset === null) return running;

      const caller = new ScriptedCaller(handset, actions, {
        language,
        frameMs: settings.frameMs,
        pollMs: 3,
        quietMs: callerOptions.quietMs ?? 120,
        timeoutMs: callerOptions.timeoutMs ?? 20_000,
      });

      const [result] = await Promise.all([running, caller.run()]);
      return result;
    },

    async handsetFor(callId) {
      const call = await calls.loadCall(VOICE_SHOP, callId);
      const sid = call?.providerCallSid ?? null;
      if (sid === null) return null;
      return telephony.handset(sid);
    },

    async buildBundle() {
      const result = await runtime.bundles.build({
        shopId: VOICE_SHOP,
        anchor: { kind: 'explicit', jobCardId: VOICE_JOB_CARD },
        note: 'Front pads worn to 2.1mm, minimum is 3mm. Metal to metal soon.',
        noteLanguage: 'en',
        authorStaffId: null,
        mediaIds: ['media-1'],
        workItemIds: [VOICE_ITEM_BRAKES, VOICE_ITEM_OIL],
        traceId: 'voice-test',
        actor: { type: 'STAFF', id: null },
      });
      if (!result.ok) throw new Error(`bundle failed: ${result.failure.reason}`);
      return result.bundle;
    },

    async openApproval() {
      const bundle = await runtime.bundles.build({
        shopId: VOICE_SHOP,
        anchor: { kind: 'explicit', jobCardId: VOICE_JOB_CARD },
        note: 'Front pads worn to 2.1mm, minimum is 3mm. Metal to metal soon.',
        noteLanguage: 'en',
        authorStaffId: null,
        mediaIds: ['media-1'],
        workItemIds: [VOICE_ITEM_BRAKES, VOICE_ITEM_OIL],
        traceId: 'voice-test',
        actor: { type: 'STAFF', id: null },
      });
      if (!bundle.ok) throw new Error(`bundle failed: ${bundle.failure.reason}`);

      const created = await runtime.approvals.createApprovalRequest({
        shopId: VOICE_SHOP,
        jobCardId: VOICE_JOB_CARD,
        customerId: VOICE_CUSTOMER,
        conversationId: VOICE_CONVERSATION,
        bundle: bundle.bundle,
        ladderRef: 'APPROVAL',
        actor: { type: 'STAFF', id: null },
        traceId: 'voice-test',
      });
      if (!created.ok) throw new Error(`approval failed: ${created.reason}`);
      return created.approvalId;
    },

    placeOutbound: (actions, overrides = {}, callerOptions = {}) =>
      drive(
        runner.runOutboundApproval({
          shopId: VOICE_SHOP,
          jobCardId: VOICE_JOB_CARD,
          customerId: VOICE_CUSTOMER,
          conversationId: VOICE_CONVERSATION,
          approvalRequestId: VOICE_APPROVAL,
          escalationId: null,
          amountPaise: VOICE_TOTAL_PAISE,
          workSummary: WORK_SUMMARY,
          traceId: 'voice-test',
          ...overrides,
        }),
        actions,
        callerOptions,
      ),

    answerInbound: (actions, overrides = {}, callerOptions = {}) => {
      // The inbound leg exists before the runner does: a customer dialled, the
      // provider handed us a live session, and only then does anything of ours
      // start. Modelling it the other way round would let the runtime assume an
      // ordering a real telephone will not give it.
      const running = (async (): Promise<CallReport> => {
        const report = runner.runInboundCall({
          shopId: VOICE_SHOP,
          fromNumber: CUSTOMER_PHONE,
          traceId: 'voice-test-inbound',
          ...overrides,
        });
        await telephony.ringIn({
          from: overrides.fromNumber ?? CUSTOMER_PHONE,
          context: {
            shopId: VOICE_SHOP,
            jobCardId: VOICE_JOB_CARD,
            customerId: VOICE_CUSTOMER,
            conversationId: null,
            approvalRequestId: null,
            escalationId: null,
            objective: 'answer_status',
            language,
            customerName,
            traceId: 'voice-test-inbound',
          },
        });
        return report;
      })();

      return drive(running, actions, callerOptions);
    },
  };
}

/**
 * The handset for whichever call the runner just opened.
 *
 * Polls rather than takes a callback because the session is created *inside*
 * `runOutboundApproval`, several awaits deep, and nothing above it is handed a
 * reference. Races the run so a call the gate refused — which never opens a
 * line at all — returns null instead of hanging for the timeout.
 */
async function awaitHandset(
  telephony: BrowserLoopbackTelephonyAdapter,
  running: Promise<unknown>,
): Promise<LoopbackHandset | null> {
  let settled = false;
  void running.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    const session = telephony.activeSessions()[0];
    if (session !== undefined) return telephony.handset(session.callId);
    if (settled) return null;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  return null;
}
