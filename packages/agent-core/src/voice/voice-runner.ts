import type { LlmPort, StreamingSpeechPort, CallSession, TelephonyPort } from '@serviceloop/adapters';
import { maskNumber } from '@serviceloop/adapters';
import { migrateShopConfig, type ShopConfig } from '@serviceloop/config';
import {
  APPROVAL_DTMF,
  INBOUND_DTMF,
  MANDATORY_SCRIPT_KEYS,
  type ApprovalService,
  type VoiceCallService,
  approvalCallScript,
  assertMandatorySegments,
  closingSegments,
  gracefulExitSegment,
  inboundGreetingScript,
  isPoorTurn,
  ivrModeSegment,
  noInputSegment,
  notUnderstoodSegment,
  pipelineFailureSegment,
  decisionReadbackSegment,
  readbackSegment,
  resolveDtmf,
  shouldDegradeToIvr,
  whisperText,
  type AdvisorTaskService,
  type ApprovalCallRequest,
  type CallDestinationReader,
  type DtmfAction,
  type DtmfMap,
  type JobCardContext,
  type JobCardContextReader,
  type MessageSnapshot,
  type OutboundGate,
  type ScriptSegment,
  type ShopConfigStore,
  type PlacedCallOutcome,
  type ShopDirectory,
  type UnitOfWork,
  type VoiceCallPlacer,
} from '@serviceloop/domain';
import {
  formatPaise,
  systemClock,
  t,
  uuidv7,
  type AgentObjective,
  type CallEndReason,
  type CallOutcome,
  type Clock,
  type CustomerDecision,
  type DtmfDigit,
  type Language,
  type Paise,
  type VoiceIntent,
  type VoiceLatencyStage,
} from '@serviceloop/shared';
import { AgentRunner, type AgentRunnerDeps, type RunRequest } from '../runner';
import type { ShopProfile } from '../prompt';
import type { ToolRegistry } from '../tool-registry';
import { VoiceTurnManager, type HeardTurn, type SpokenTurn } from './turn-manager';
import { VoiceCallState, voiceObjectiveSpec } from './voice-tools';

/**
 * `VoiceAgentRunner` — the phase-3 agent, on a telephone (phase 5.3 / 5.4).
 *
 * One class runs a whole call: the non-removable opening, the recorder's
 * lifecycle, the turn loop, the keypad, the caps, the graceful exit, the warm
 * handoff and the terminal report. What it deliberately does *not* do is decide
 * what to say — that is `AgentRunner`'s job, unchanged, with the same tools,
 * the same guardrails and the same post-checker.
 *
 * The shape worth understanding before reading the code: **one agent run per
 * customer turn**. A call is therefore several runs against one conversation,
 * exactly as a WhatsApp thread is. That falls out of phase 3's own design —
 * `resolve_partial_approval` is already "one message per run, their next
 * message starts the next run" — and it is what makes a phone transcript
 * replayable through the same `agent_steps` machinery a chat transcript is.
 *
 * The consequence, and the reason `VoiceCallState` exists: a guardrail that has
 * to span turns cannot live in `RunState`. The readback confirmation is exactly
 * such a guardrail, so the tool registry is built per *call* and closes over
 * call-scoped state.
 */

export interface VoiceRuntimeSettings {
  readonly endpointSilenceMs: number;
  readonly maxDeadAirMs: number;
  readonly latencyBudgetMs: number;
  readonly frameMs: number;
  /** Longest to wait for a caller who says nothing at all. */
  readonly noInputWaitMs: number;
  /** Longest to wait for the far end to pick up. */
  readonly ringTimeoutMs: number;
  readonly retentionDays: number;
  readonly rates: {
    readonly telcoPaisePerMinute: number;
    readonly sttPaisePerMinute: number;
    readonly ttsPaisePerMinute: number;
  };
}

export interface VoiceRunnerDeps<Tx> {
  readonly telephony: TelephonyPort;
  readonly speech: StreamingSpeechPort;
  readonly calls: VoiceCallService<Tx>;
  readonly destinations: CallDestinationReader<Tx>;
  readonly uow: UnitOfWork<Tx>;
  readonly cards: JobCardContextReader<Tx>;
  readonly directory: ShopDirectory<Tx>;
  readonly config: ShopConfigStore<Tx>;
  readonly tasks: AdvisorTaskService<Tx>;
  /**
   * The same service the chat path decides through (phase 5.5).
   *
   * A keypad approval does not go through `record_customer_decision` — no agent
   * run is involved when somebody presses 1 — so without this the customer's
   * decision would live only in the call row, and the job card, the work items,
   * the deferred-work ledger and the ladder cancellation would all miss it. A
   * decision reached on the phone has to move exactly as much as one reached in
   * a thread.
   */
  readonly approvals: ApprovalService<Tx>;
  /** Where the post-call WhatsApp summary goes. Every guardrail still applies. */
  readonly gate: OutboundGate<Tx>;
  readonly llm: LlmPort;
  /** Everything `AgentRunner` needs except the registry, which is per call. */
  readonly agent: Omit<AgentRunnerDeps<Tx>, 'registry'>;
  /** Builds the per-call tool registry around the call's own state. */
  readonly registryFor: (state: VoiceCallState) => ToolRegistry;
  readonly settings: VoiceRuntimeSettings;
  readonly clock?: Clock;
  readonly onTrace?: (line: VoiceTraceLine) => void;
}

export interface VoiceTraceLine {
  readonly callId: string;
  readonly stage: string;
  readonly detail: string;
  readonly at: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface OutboundApprovalCallInput {
  readonly shopId: string;
  readonly jobCardId: string;
  readonly customerId: string;
  readonly conversationId: string | null;
  readonly approvalRequestId: string;
  readonly escalationId: string | null;
  readonly amountPaise: Paise;
  readonly workSummary: string;
  readonly traceId: string;
  readonly retryOfCallId?: string | null;
}

export interface InboundCallInput {
  readonly shopId: string;
  readonly fromNumber: string;
  readonly traceId: string;
  readonly intentHint?: VoiceIntent;
}

export interface CallReport {
  readonly callId: string;
  readonly placed: boolean;
  /** True when somebody picked up. A call that rang out is placed, not answered. */
  readonly answered: boolean;
  readonly outcome: CallOutcome;
  readonly endReason: CallEndReason | null;
  readonly refusalCode: string | null;
  readonly refusalReason: string | null;
  readonly fallBackToAdvisor: boolean;
  readonly turns: number;
  readonly decision: CustomerDecision | null;
  readonly handedOff: boolean;
  readonly degradedToIvr: boolean;
  readonly maxTurnLatencyMs: number;
  readonly bargeIns: number;
  readonly durationSeconds: number;
  readonly disclosurePlayed: boolean;
  readonly recordingStartedAfterNotice: boolean;
  readonly advisorTaskId: string | null;
  readonly summarySent: boolean;
  readonly retryAfterMinutes: number | null;
}

/** Internal accounting for one call, folded into the terminal report. */
interface CallAccumulator {
  turnIndex: number;
  bargeIns: number;
  poorTurns: number;
  consecutivePoorTurns: number;
  maxLatencyMs: number;
  degraded: boolean;
  disclosurePlayed: boolean;
  noticePlayed: boolean;
  recordingStartedAt: Date | null;
  handedOff: boolean;
  advisorTaskId: string | null;
  summarySent: boolean;
  llmInputTokens: number;
  llmOutputTokens: number;
}

export class VoiceAgentRunner<Tx> implements VoiceCallPlacer {
  private readonly clock: Clock;

  constructor(private readonly deps: VoiceRunnerDeps<Tx>) {
    this.clock = deps.clock ?? systemClock;
  }

  /**
   * The `VOICE_OR_ADVISOR` rung, when it actually calls (phase 5.4a).
   *
   * Returns a report rather than throwing on a refusal: "we could not call, so
   * a person will" is a normal outcome of a ladder rung and the caller needs to
   * act on it, not catch it.
   */
  async runOutboundApproval(input: OutboundApprovalCallInput): Promise<CallReport> {
    const config = await this.loadConfig(input.shopId);
    const card = await this.uow((tx) => this.deps.cards.load(tx, input.shopId, input.jobCardId));
    const shop = await this.loadShop(input.shopId);

    const phone = await this.uow((tx) =>
      this.deps.destinations.loadCustomerPhone(tx, input.shopId, input.customerId),
    );

    const language = card?.customerLanguage ?? config.languages.default;
    const customerName = card?.customerName ?? 'there';
    const advisorName = shop.advisorName ?? shop.name;

    const decision = await this.deps.calls.authorise({
      shopId: input.shopId,
      driver: this.deps.telephony.driver,
      to: phone ?? '',
      toMasked: phone === null ? '••••' : maskNumber(phone),
      fromNumber: this.deps.telephony.callerId,
      jobCardId: input.jobCardId,
      customerId: input.customerId,
      conversationId: input.conversationId,
      approvalRequestId: input.approvalRequestId,
      escalationId: input.escalationId,
      objective: 'request_approval',
      language,
      retryOfCallId: input.retryOfCallId ?? null,
      traceId: input.traceId,
    });

    if (!decision.allowed) {
      this.trace(decision.callId, 'gate', `refused: ${decision.code}`, { reason: decision.reason });
      return refusedReport(decision.callId, decision.code, decision.reason, decision.fallBackToAdvisor);
    }

    const script = approvalCallScript({
      language,
      shopName: shop.name,
      customerName,
      advisorName,
      vehicleLabel: card?.vehicleLabel ?? 'your vehicle',
      jobCardCode: card?.code ?? '',
      workSummary: input.workSummary,
      amountPaise: input.amountPaise,
    });

    // Belt and braces, and worth both: the script builder always includes the
    // two ⚿ segments, and this refuses to dial if a future edit ever stops it.
    assertMandatorySegments(script, 'OUTBOUND');

    return this.placeAndRun({
      callId: decision.callId,
      shopId: input.shopId,
      to: phone as string,
      direction: 'OUTBOUND',
      objective: 'request_approval',
      agentObjective: 'resolve_partial_approval',
      language,
      config,
      shop,
      card,
      advisorName,
      customerName,
      opening: script,
      dtmf: APPROVAL_DTMF,
      conversationId: input.conversationId,
      customerId: input.customerId,
      jobCardId: input.jobCardId,
      approvalRequestId: input.approvalRequestId,
      escalationId: input.escalationId,
      amountPaise: input.amountPaise,
      workSummary: input.workSummary,
      traceId: input.traceId,
    });
  }

  /**
   * `VoiceCallPlacer`, for the escalation ladder (phase 5.4a).
   *
   * A two-line adapter rather than a second implementation: the rung's port is
   * a strict subset of `CallReport`, so this exists to name the subset and to
   * let `packages/domain` depend on an interface it owns instead of on this
   * class, which imports a telephony adapter and therefore may not be reached
   * from there.
   */
  async placeApprovalCall(input: ApprovalCallRequest): Promise<PlacedCallOutcome> {
    return this.runOutboundApproval({
      ...input,
      retryOfCallId: input.retryOfCallId ?? null,
    });
  }

  async attemptsForEscalation(shopId: string, escalationId: string): Promise<number> {
    return this.deps.calls.attemptsForEscalation(shopId, escalationId);
  }

  /**
   * The published line (phase 5.4b).
   *
   * The caller is identified from their number where possible — a stranger is
   * still answered, because a shop's phone that only talks to people already in
   * its database is a shop that loses new customers.
   */
  async runInboundCall(input: InboundCallInput): Promise<CallReport> {
    const config = await this.loadConfig(input.shopId);
    const shop = await this.loadShop(input.shopId);

    const customerId = await this.uow((tx) =>
      this.deps.destinations.findCustomerByPhone(tx, input.shopId, input.fromNumber),
    );
    const jobCardId =
      customerId === null
        ? null
        : await this.uow((tx) =>
            this.deps.cards.findActiveJobCardId(tx, input.shopId, customerId),
          );
    const card =
      jobCardId === null
        ? null
        : await this.uow((tx) => this.deps.cards.load(tx, input.shopId, jobCardId));

    const language = card?.customerLanguage ?? config.languages.default;
    const advisorName = shop.advisorName ?? shop.name;

    const decision = await this.deps.calls.acceptInbound({
      shopId: input.shopId,
      driver: this.deps.telephony.driver,
      to: this.deps.telephony.callerId,
      toMasked: maskNumber(input.fromNumber),
      fromNumber: input.fromNumber,
      jobCardId,
      customerId,
      conversationId: null,
      approvalRequestId: null,
      escalationId: null,
      objective: 'answer_status',
      language,
      providerCallSid: null,
      traceId: input.traceId,
    });

    if (!decision.allowed) {
      return refusedReport(decision.callId, decision.code, decision.reason, decision.fallBackToAdvisor);
    }

    const opening = inboundGreetingScript({ language, shopName: shop.name, advisorName });
    assertMandatorySegments(opening, 'INBOUND');

    return this.placeAndRun({
      callId: decision.callId,
      shopId: input.shopId,
      to: input.fromNumber,
      direction: 'INBOUND',
      objective: 'answer_status',
      agentObjective: 'answer_status',
      language,
      config,
      shop,
      card,
      advisorName,
      customerName: card?.customerName ?? 'there',
      opening,
      dtmf: INBOUND_DTMF,
      conversationId: null,
      customerId,
      jobCardId,
      approvalRequestId: null,
      escalationId: null,
      amountPaise: 0,
      workSummary: '',
      traceId: input.traceId,
      intentHint: input.intentHint ?? null,
    });
  }

  /* --------------------------------------------------------------- the call */

  private async placeAndRun(input: {
    readonly callId: string;
    readonly shopId: string;
    readonly to: string;
    readonly direction: 'OUTBOUND' | 'INBOUND';
    /** What the *call* is for. Goes on the row and into the audit trail. */
    readonly objective: AgentObjective;
    /**
     * What each agent run on the call is doing, which is not the same thing.
     *
     * An outbound approval call is `request_approval` — that is what it is for —
     * but the asking is done by the script, in the shop's own recorded words,
     * before the model is ever consulted. Every turn after that is the customer
     * *replying* to an approval request, which is `resolve_partial_approval`:
     * the objective that may answer an objection, adjust an offer within the
     * shop's limits, and record what they decided. Running the call's own
     * objective for its turns would hand the agent a toolset with no
     * `record_customer_decision` in it, and a customer who said yes on the
     * phone would be told an advisor will call them back.
     */
    readonly agentObjective: AgentObjective;
    readonly language: Language;
    readonly config: ShopConfig;
    readonly shop: ShopProfile;
    readonly card: JobCardContext | null;
    readonly advisorName: string;
    readonly customerName: string;
    readonly opening: readonly ScriptSegment[];
    readonly dtmf: DtmfMap;
    readonly conversationId: string | null;
    readonly customerId: string | null;
    readonly jobCardId: string | null;
    readonly approvalRequestId: string | null;
    readonly escalationId: string | null;
    readonly amountPaise: Paise;
    readonly workSummary: string;
    readonly traceId: string;
    readonly intentHint?: VoiceIntent | null;
  }): Promise<CallReport> {
    const startedAt = this.clock.now();
    const accumulator: CallAccumulator = {
      turnIndex: 0,
      bargeIns: 0,
      poorTurns: 0,
      consecutivePoorTurns: 0,
      maxLatencyMs: 0,
      degraded: false,
      disclosurePlayed: false,
      noticePlayed: false,
      recordingStartedAt: null,
      handedOff: false,
      advisorTaskId: null,
      summarySent: false,
      llmInputTokens: 0,
      llmOutputTokens: 0,
    };

    let session: CallSession;
    try {
      session =
        input.direction === 'OUTBOUND'
          ? await this.deps.telephony.originate({
              to: input.to,
              context: this.callContext(input),
              ringTimeoutSeconds: Math.ceil(this.deps.settings.ringTimeoutMs / 1000),
            })
          : await this.awaitInboundSession(input.callId);
    } catch (error) {
      await this.finish(input, accumulator, startedAt, {
        status: 'FAILED',
        outcome: 'PIPELINE_FAILURE',
        endReason: 'PROVIDER_ERROR',
        decision: null,
        agentRunId: null,
        turnManager: null,
      });
      this.trace(input.callId, 'originate', 'the provider refused the call', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        ...refusedReport(input.callId, 'PROVIDER_ERROR', 'The provider refused the call', true),
        outcome: 'PIPELINE_FAILURE',
      };
    }

    await this.deps.calls.markRinging(input.shopId, input.callId, session.callId);

    const answered = await this.waitForAnswer(session);
    if (!answered) {
      await this.finish(input, accumulator, startedAt, {
        status: 'COMPLETED',
        outcome: 'NO_ANSWER',
        endReason: 'PROVIDER_ERROR',
        decision: null,
        agentRunId: null,
        turnManager: null,
      });

      return {
        ...refusedReport(input.callId, 'NO_ANSWER', 'The customer did not answer', true),
        outcome: 'NO_ANSWER',
        placed: true,
        // The single retry the phase asks for. The *scheduling* is the ladder's
        // job — this reports how long to wait, so the rung stays the one place
        // that owns a cadence (L3).
        retryAfterMinutes: input.config.voice.retryOnNoAnswer
          ? input.config.voice.retryAfterMinutes
          : null,
      };
    }

    await this.deps.calls.markAnswered({
      shopId: input.shopId,
      callId: input.callId,
      traceId: input.traceId,
    });

    const turns = new VoiceTurnManager({
      session,
      speech: this.deps.speech,
      shopId: input.shopId,
      language: input.language,
      endpointSilenceMs: this.deps.settings.endpointSilenceMs,
      maxWaitMs: this.deps.settings.noInputWaitMs,
      latencyBudgetMs: this.deps.settings.latencyBudgetMs,
      maxDeadAirMs: this.deps.settings.maxDeadAirMs,
      frameMs: this.deps.settings.frameMs,
      traceId: input.traceId,
      now: () => this.clock.now(),
      ...(input.card === null
        ? {}
        : { hints: [input.card.registration, ...input.card.workItems.map((item) => item.title)] }),
    });

    const callState = new VoiceCallState(input.config.voice);
    let endReason: CallEndReason = 'GRACEFUL_EXIT';
    let outcome: CallOutcome = 'BUDGET_EXHAUSTED';
    let lastRunId: string | null = null;

    try {
      /* -------------------------------------------- the non-removable opening */

      await this.playOpening(input, turns, accumulator, session);

      /* ------------------------------------------------------- the objective */

      const result = await this.runTurnLoop({
        input,
        turns,
        session,
        callState,
        accumulator,
        startedAt,
      });

      endReason = result.endReason;
      outcome = result.outcome;
      lastRunId = result.agentRunId;
    } catch (error) {
      /**
       * Any mid-call pipeline failure (phase 5.7).
       *
       * The apology clip and the WhatsApp follow-up are not politeness: a
       * customer who was mid-sentence when the recogniser died must not simply
       * hear nothing, and the thing they were told about must still reach them.
       */
      this.trace(input.callId, 'failure', 'the pipeline failed mid-call', {
        error: error instanceof Error ? error.message : String(error),
      });

      await this.sayScript(
        pipelineFailureSegment(input.language, input.advisorName),
        input,
        turns,
        accumulator,
      ).catch(() => undefined);

      accumulator.summarySent = await this.sendWhatsAppSummary(input, 'PIPELINE_FAILURE');
      accumulator.advisorTaskId = await this.raiseAdvisorTask(
        input,
        'The voice pipeline failed mid-call; the customer was told an advisor would follow up',
      );
      accumulator.handedOff = true;
      endReason = 'PIPELINE_FAILURE';
      outcome = 'PIPELINE_FAILURE';
    }

    /* ------------------------------------------------------------- the close */

    await this.stopRecordingIfStarted(input, session, accumulator);
    await session.hangup(`call ended: ${endReason}`).catch(() => undefined);

    const report = await this.finish(input, accumulator, startedAt, {
      status: 'COMPLETED',
      outcome,
      endReason,
      decision: callState.decision,
      agentRunId: lastRunId,
      turnManager: turns,
    });

    return {
      ...report,
      decision: callState.decision,
    };
  }

  /**
   * ⚿ disclosure → ⚿ recording notice → recorder on.
   *
   * The ordering the whole of 5.6 rests on, and it is expressed as three
   * statements in one method rather than as a policy some other object might
   * consult: the notice is spoken, the fact is recorded, and only then is the
   * recorder allowed to start. `VoiceCallService.mayStartRecording` re-checks,
   * and a database trigger checks again — three places, because it is a legal
   * obligation and not a preference.
   */
  private async playOpening(
    input: { readonly shopId: string; readonly callId: string; readonly traceId: string; readonly opening: readonly ScriptSegment[]; readonly language: Language; readonly direction: 'OUTBOUND' | 'INBOUND' },
    turns: VoiceTurnManager,
    accumulator: CallAccumulator,
    session: CallSession,
  ): Promise<void> {
    for (const segment of input.opening) {
      await this.sayScript(segment, input as never, turns, accumulator);

      if (segment.key === 'voice.disclosure' || segment.key === 'voice.inbound.greeting') {
        accumulator.disclosurePlayed = true;
        await this.deps.calls.recordConsentFact({
          shopId: input.shopId,
          callId: input.callId,
          fact: 'AI_DISCLOSURE_PLAYED',
          turnIndex: accumulator.turnIndex - 1,
          detail: segment.key,
          traceId: input.traceId,
        });
      }

      if (segment.key === 'voice.recording_notice') {
        accumulator.noticePlayed = true;
        await this.deps.calls.recordConsentFact({
          shopId: input.shopId,
          callId: input.callId,
          fact: 'RECORDING_NOTICE_PLAYED',
          turnIndex: accumulator.turnIndex - 1,
          detail: segment.key,
          traceId: input.traceId,
        });

        if (await this.deps.calls.mayStartRecording(input.shopId, input.callId)) {
          await session.startRecording();
          accumulator.recordingStartedAt = this.clock.now();
          await this.deps.calls.recordConsentFact({
            shopId: input.shopId,
            callId: input.callId,
            fact: 'RECORDING_STARTED',
            turnIndex: accumulator.turnIndex - 1,
            traceId: input.traceId,
          });
        }
      }
    }
  }

  /* ---------------------------------------------------------- the turn loop */

  private async runTurnLoop(context: {
    readonly input: Parameters<VoiceAgentRunner<Tx>['placeAndRun']>[0];
    readonly turns: VoiceTurnManager;
    readonly session: CallSession;
    readonly callState: VoiceCallState;
    readonly accumulator: CallAccumulator;
    readonly startedAt: Date;
  }): Promise<{
    readonly outcome: CallOutcome;
    readonly endReason: CallEndReason;
    readonly agentRunId: string | null;
  }> {
    const { input, turns, session, callState, accumulator } = context;
    const voice = input.config.voice;
    let agentRunId: string | null = null;
    let heardSoFar: MessageSnapshot[] = [];
    /**
     * The caller already spoke and the runtime already handled it.
     *
     * Set when a readback is confirmed: the customer has just said yes, and
     * going back to `listen()` would leave the line silent while waiting for
     * them to say it again. Somebody who has been asked "shall I confirm?" and
     * answered expects the next thing they hear to be what their answer did.
     */
    let planWithoutListening = false;
    let lastSpeechEndedAt: Date | null = null;
    /**
     * The decision the caller has been read back and not yet confirmed.
     *
     * Held on the loop rather than on `VoiceCallState` because it is about the
     * *keypad's* pending question, not about what the agent may record: a
     * caller who presses 1 and then 3 has changed their mind, and the second
     * press has to re-read the new decision rather than confirm the old one.
     */
    let pendingDecision: CustomerDecision | null = null;

    for (let turn = 0; turn < voice.maxTurnsPerCall; turn += 1) {
      const elapsedSeconds = Math.round(
        (this.clock.now().getTime() - context.startedAt.getTime()) / 1000,
      );
      if (elapsedSeconds >= voice.maxCallSeconds) {
        await this.gracefulExit(input, turns, accumulator, 'the call reached its time cap');
        return { outcome: 'ADVISOR_TASK_RAISED', endReason: 'TIME_CAP', agentRunId };
      }

      if (planWithoutListening) {
        planWithoutListening = false;
      } else {
        const heard = await turns.listen();
        await this.persistCallerTurn(input, accumulator, heard);

        if (heard.hangup) {
          return { outcome: 'CUSTOMER_HUNG_UP', endReason: 'CALLER_HUNG_UP', agentRunId };
        }

        /* ----------------------------------------------------------- keypad */

        if (heard.inputMode === 'DTMF' && heard.dtmf !== null) {
          const action = resolveDtmf(heard.dtmf, input.dtmf);
          const handled = await this.handleDtmf({
            action,
            digit: heard.dtmf,
            input,
            turns,
            session,
            callState,
            accumulator,
            pendingDecision,
          });
          if (handled.outcome !== undefined && handled.endReason !== undefined) {
            return { outcome: handled.outcome, endReason: handled.endReason, agentRunId };
          }
          pendingDecision = handled.pendingDecision ?? null;
          continue;
        }

        /* ------------------------------------------- speech, and its quality */

        const poor = isPoorTurn({
          confidence: heard.confidence,
          text: heard.text,
          minConfidence: voice.minTranscriptConfidence,
          inputMode: heard.inputMode,
        });

        if (poor) {
          accumulator.poorTurns += 1;
          accumulator.consecutivePoorTurns += 1;

          if (
            shouldDegradeToIvr({
              consecutivePoorTurns: accumulator.consecutivePoorTurns,
              threshold: voice.poorTurnsBeforeIvr,
              alreadyDegraded: accumulator.degraded,
            })
          ) {
            if (!accumulator.degraded) {
              accumulator.degraded = true;
              this.trace(input.callId, 'ivr', 'two poor turns; the call moved to the keypad');
              await this.sayScript(
                ivrModeSegment(input.language, input.advisorName),
                input,
                turns,
                accumulator,
              );
            }
            continue;
          }

          await this.sayScript(
            heard.inputMode === 'NONE'
              ? noInputSegment(input.language)
              : notUnderstoodSegment(input.language, input.advisorName),
            input,
            turns,
            accumulator,
          );
          continue;
        }

        accumulator.consecutivePoorTurns = 0;
        heardSoFar = [...heardSoFar, callerMessage(heard.text, input.conversationId)];
        lastSpeechEndedAt = heard.speechEndedAt;
      }

      /* ---------------------------------------------------------- the agent */

      const planStartedAt = this.clock.now();
      const registry = this.deps.registryFor(callState);
      const runner = new AgentRunner<Tx>({ ...this.deps.agent, registry });

      const planned = await turns.planWithFiller(
        () =>
          runner.run(this.runRequest(input, heardSoFar)),
        t(input.language, 'voice.filler'),
      );

      agentRunId = planned.value.runId;
      accumulator.llmInputTokens += planned.value.inputTokens;
      accumulator.llmOutputTokens += planned.value.outputTokens;
      const planReadyAt = this.clock.now();

      if (planned.value.outcome === 'blocked') {
        // The checker refused the turn. There is no "held for review" on a
        // phone — the customer is listening — so the call exits to a person
        // rather than saying something the checker would not stand behind.
        await this.gracefulExit(input, turns, accumulator, planned.value.reason ?? 'blocked');
        return { outcome: 'ADVISOR_TASK_RAISED', endReason: 'GRACEFUL_EXIT', agentRunId };
      }

      const queued = callState.takeQueued();
      if (
        queued.length === 0 &&
        callState.decision === null &&
        !callState.handoffRequested &&
        planned.value.outcome !== 'handoff'
      ) {
        // A run that said nothing *and* did nothing is a run that achieved
        // nothing. Rather than leaving the line silent, offer the keypad and
        // try once more. A run that recorded a decision or asked for a person
        // is a different case, handled below: answering that with "sorry, I did
        // not catch that" would be the agent apologising for a yes it heard.
        await this.sayScript(
          notUnderstoodSegment(input.language, input.advisorName),
          input,
          turns,
          accumulator,
        );
        continue;
      }

      for (const [index, text] of queued.entries()) {
        await this.say(text, input, turns, accumulator, {
          scriptKey: null,
          agentRunId,
          isReadback: callState.readbackText === text,
          ...(index === 0
            ? {
                latency: {
                  speechEndedAt: lastSpeechEndedAt,
                  finalAt: planStartedAt,
                  planReadyAt,
                },
              }
            : {}),
        });
      }

      /* ------------------------------------------------- the readback, heard */

      if (callState.readbackText !== null) {
        const confirmation = await turns.listen();
        await this.persistCallerTurn(input, accumulator, confirmation);

        if (confirmation.hangup) {
          return { outcome: 'CUSTOMER_HUNG_UP', endReason: 'CALLER_HUNG_UP', agentRunId };
        }

        const affirmative =
          (confirmation.inputMode === 'DTMF' &&
            confirmation.dtmf !== null &&
            resolveDtmf(confirmation.dtmf, input.dtmf) === 'APPROVE') ||
          (confirmation.inputMode === 'SPEECH' && isAffirmative(confirmation.text));

        if (affirmative) {
          callState.readbackConfirmed = true;
          heardSoFar = [
            ...heardSoFar,
            callerMessage(
              confirmation.inputMode === 'DTMF' ? 'yes (pressed 1)' : confirmation.text,
              input.conversationId,
            ),
          ];
          lastSpeechEndedAt = confirmation.speechEndedAt;
          // Straight back to the agent, not back to the microphone. They said
          // yes; the next thing they hear has to be what that yes did.
          planWithoutListening = true;
          continue;
        }

        // Not a yes. The readback is spent and nothing is recorded — which is
        // the whole point of asking.
        callState.readbackText = null;
        heardSoFar = [...heardSoFar, callerMessage(confirmation.text, input.conversationId)];
        continue;
      }

      if (callState.decision !== null) {
        await this.closeAfterDecision(input, turns, accumulator, callState.decision);
        return { outcome: 'DECISION_RECORDED', endReason: 'OBJECTIVE_MET', agentRunId };
      }

      if (callState.handoffRequested || planned.value.outcome === 'handoff') {
        const bridged = await this.bridgeToAdvisor(input, turns, session, accumulator);
        return {
          outcome: bridged ? 'BRIDGED' : 'ADVISOR_TASK_RAISED',
          endReason: 'HANDOFF_BRIDGED',
          agentRunId,
        };
      }

      if (input.direction === 'INBOUND' && planned.value.outcome === 'objective_met') {
        await this.sayScript(
          closingSegments({ language: input.language, summarySent: false })[0] as ScriptSegment,
          input,
          turns,
          accumulator,
        );
        return { outcome: 'ANSWERED_FROM_STATE', endReason: 'OBJECTIVE_MET', agentRunId };
      }
    }

    await this.gracefulExit(input, turns, accumulator, 'the call reached its turn cap');
    return { outcome: 'ADVISOR_TASK_RAISED', endReason: 'STEP_CAP', agentRunId };
  }

  /* ------------------------------------------------------------------ keypad */

  private async handleDtmf(context: {
    readonly action: DtmfAction | null;
    readonly digit: DtmfDigit;
    readonly input: Parameters<VoiceAgentRunner<Tx>['placeAndRun']>[0];
    readonly turns: VoiceTurnManager;
    readonly session: CallSession;
    readonly callState: VoiceCallState;
    readonly accumulator: CallAccumulator;
    /** The decision the caller has been read back and not yet confirmed. */
    readonly pendingDecision: CustomerDecision | null;
  }): Promise<DtmfResult> {
    const { action, input, turns, session, callState, accumulator } = context;

    switch (action) {
      /**
       * Every keypad decision, read back before it is recorded (phase 5.5).
       *
       * A key is unambiguous about *which key*, not about what the customer
       * thought it meant — and the readback costs one sentence against a
       * misdial that spends somebody's money, or loses the shop the job and
       * sends a car out with the fault it came in with. Declining and deferring
       * are held to the same rule as approving for exactly that reason:
       * `requireReadbackBeforeDecision` is a literal in the schema so that no
       * reading of "which decisions matter" can switch it off for some of them.
       *
       * The first press composes the readback and waits; the second press —
       * against the *same* pending decision — is the confirmation. A caller who
       * presses 1 and then 3 has changed their mind, and gets the new decision
       * read back rather than the old one confirmed.
       */
      case 'APPROVE':
      case 'DECLINE':
      case 'DEFER': {
        const decision: CustomerDecision =
          action === 'APPROVE' ? 'FULL' : action === 'DECLINE' ? 'DECLINED' : 'DEFERRED';

        if (callState.readbackText === null || context.pendingDecision !== decision) {
          const scriptContext = {
            language: input.language,
            shopName: input.shop.name,
            customerName: input.customerName,
            advisorName: input.advisorName,
            vehicleLabel: input.card?.vehicleLabel ?? 'your vehicle',
            jobCardCode: input.card?.code ?? '',
            workSummary: input.workSummary,
            amountPaise: input.amountPaise,
          };
          const readback =
            decision === 'FULL'
              ? readbackSegment(scriptContext)
              : decisionReadbackSegment(decision, scriptContext);

          callState.readbackText = readback.text;
          await this.sayScript(readback, input, turns, accumulator);
          return { pendingDecision: decision };
        }

        callState.readbackConfirmed = true;
        callState.decision = decision;
        await this.recordKeypadDecision(input, accumulator, decision, context.digit);
        await this.closeAfterDecision(input, turns, accumulator, decision);
        return { outcome: 'DECISION_RECORDED', endReason: 'OBJECTIVE_MET' };
      }

      case 'HANDOFF': {
        const bridged = await this.bridgeToAdvisor(input, turns, session, accumulator);
        return {
          outcome: bridged ? 'BRIDGED' : 'ADVISOR_TASK_RAISED',
          endReason: 'HANDOFF_BRIDGED',
        };
      }


      case 'REPEAT': {
        for (const segment of input.opening.filter((entry) => !entry.mandatory)) {
          await this.sayScript(segment, input, turns, accumulator);
        }
        // The pending readback survives a repeat: somebody who did not catch
        // the amount and asked to hear it again has not changed their mind.
        return { pendingDecision: context.pendingDecision };
      }

      case 'STATUS':
      case 'BOOKING':
      case null:
      default:
        await this.sayScript(
          notUnderstoodSegment(input.language, input.advisorName),
          input,
          turns,
          accumulator,
        );
        return {};
    }
  }

  /**
   * A decision the keypad made (phase 5.5).
   *
   * The agent path records decisions with `record_customer_decision`, which is
   * a tool call inside an agent run — and a customer who pressed 1 during the
   * opening never triggered a run. So the keypad calls the *same* service
   * directly. Both paths move the work items, write the deferred-work ledger,
   * cancel the ladder and clear the advisor's task; only the `decidedVia` on
   * the row differs, which is exactly the fact that should differ.
   *
   * A failure here does not lose the answer. The customer said yes on a
   * recorded line, so the fallback is a person holding their decision in an
   * advisor task rather than an exception that ends the call.
   */
  private async recordKeypadDecision(
    input: Parameters<VoiceAgentRunner<Tx>['placeAndRun']>[0],
    accumulator: CallAccumulator,
    decision: CustomerDecision,
    digit: DtmfDigit,
  ): Promise<void> {
    if (input.approvalRequestId === null) return;

    try {
      const result = await this.deps.approvals.recordCustomerDecision({
        shopId: input.shopId,
        approvalId: input.approvalRequestId,
        decision,
        // A keypad cannot express a subset. `FULL` approves everything the
        // request asked about, and anything narrower needs words — which is
        // why `2` reaches a person rather than trying to enumerate items on a
        // telephone keypad.
        approvedWorkItemIds: [],
        note: `Pressed ${digit} on call ${input.callId}`,
        decidedVia: 'voice_keypad',
        actor: { type: 'AGENT', id: null },
        traceId: input.traceId,
      });

      this.trace(input.callId, 'decision', `keypad ${decision}`, {
        approvalId: result.approvalId,
        approvedWorkItemIds: result.approvedWorkItemIds,
        alreadyRecorded: !result.applied,
      });
    } catch (error) {
      this.trace(input.callId, 'decision', 'the keypad decision could not be recorded', {
        error: error instanceof Error ? error.message : String(error),
      });
      accumulator.advisorTaskId = await this.raiseAdvisorTask(
        input,
        `The customer pressed ${digit} on call ${input.callId} and agreed to ${decision}, but the decision could not be written. Apply it by hand.`,
      );
      accumulator.handedOff = true;
    }
  }

  /* --------------------------------------------------------------- handoff */

  /**
   * The warm handoff (phase 5.4c).
   *
   * Whispered summary to the advisor's leg, then the two legs joined. When
   * there is no advisor to bridge to — nobody on shift, no number on file — it
   * degrades to the phase-3 behaviour rather than to a dead line: an advisor
   * task carrying the same summary, and a sentence telling the customer so.
   */
  private async bridgeToAdvisor(
    input: Parameters<VoiceAgentRunner<Tx>['placeAndRun']>[0],
    turns: VoiceTurnManager,
    session: CallSession,
    accumulator: CallAccumulator,
  ): Promise<boolean> {
    const advisor = await this.uow((tx) => this.deps.destinations.loadAdvisorPhone(tx, input.shopId));

    const summary = whisperText({
      language: input.language,
      customerName: input.customerName,
      vehicleLabel: input.card?.vehicleLabel ?? 'a vehicle',
      jobCardCode: input.card?.code ?? '',
      reason: input.direction === 'INBOUND' ? 'inbound call' : 'approval chase',
      amountPaise: input.amountPaise,
    });

    if (advisor === null) {
      await this.sayScript(
        gracefulExitSegment(input.language, input.advisorName),
        input,
        turns,
        accumulator,
      );
      accumulator.advisorTaskId = await this.raiseAdvisorTask(input, summary);
      accumulator.handedOff = true;
      return false;
    }

    await this.sayScript(
      {
        key: 'voice.handoff_bridging',
        text: t(input.language, 'voice.handoff_bridging', { advisorName: advisor.fullName }),
        mandatory: false,
      },
      input,
      turns,
      accumulator,
    );

    const whisperFrames = await this.synthesise(input, summary);
    await session.bridgeTo(advisor.phone, whisperFrames);

    await this.deps.calls.recordBridge({
      shopId: input.shopId,
      callId: input.callId,
      advisorStaffId: advisor.staffId,
      whisperText: summary,
      traceId: input.traceId,
    });

    accumulator.handedOff = true;
    this.trace(input.callId, 'bridge', `bridged to ${advisor.fullName}`, { whisper: summary });
    return true;
  }

  private async raiseAdvisorTask(
    input: Parameters<VoiceAgentRunner<Tx>['placeAndRun']>[0],
    brief: string,
  ): Promise<string> {
    return this.deps.tasks.create({
      shopId: input.shopId,
      kind: 'CALL_CUSTOMER',
      urgency: 'HIGH',
      brief,
      context: {
        callId: input.callId,
        objective: input.objective,
        amountPaise: input.amountPaise,
        jobCardCode: input.card?.code ?? null,
      },
      jobCardId: input.jobCardId,
      conversationId: input.conversationId,
      customerId: input.customerId,
      approvalRequestId: input.approvalRequestId,
      dedupeKey: `call:${input.callId}`,
      actor: { type: 'AGENT', id: null },
      traceId: input.traceId,
    });
  }

  /* ---------------------------------------------------------------- closing */

  private async gracefulExit(
    input: Parameters<VoiceAgentRunner<Tx>['placeAndRun']>[0],
    turns: VoiceTurnManager,
    accumulator: CallAccumulator,
    reason: string,
  ): Promise<void> {
    await this.sayScript(
      gracefulExitSegment(input.language, input.advisorName),
      input,
      turns,
      accumulator,
    );
    accumulator.advisorTaskId = await this.raiseAdvisorTask(
      input,
      `Call ${input.callId} ended without a decision (${reason}). ${input.workSummary}`.slice(0, 400),
    );
    accumulator.handedOff = true;
  }

  private async closeAfterDecision(
    input: Parameters<VoiceAgentRunner<Tx>['placeAndRun']>[0],
    turns: VoiceTurnManager,
    accumulator: CallAccumulator,
    decision: CustomerDecision,
  ): Promise<void> {
    const key =
      decision === 'DECLINED'
        ? 'voice.declined'
        : decision === 'DEFERRED'
          ? 'voice.deferred'
          : 'voice.approved';

    await this.sayScript(
      {
        key,
        text:
          key === 'voice.deferred'
            ? t(input.language, key, { when: 'next month' })
            : t(input.language, key),
        mandatory: false,
      },
      input,
      turns,
      accumulator,
    );

    accumulator.summarySent = await this.sendWhatsAppSummary(input, decision);

    for (const segment of closingSegments({
      language: input.language,
      summarySent: accumulator.summarySent,
    })) {
      await this.sayScript(segment, input, turns, accumulator);
    }
  }

  /**
   * The WhatsApp summary that closes the loop after the call.
   *
   * Sent through the ordinary `OutboundGate`, so consent, quiet hours, the
   * frequency caps and the 24-hour window all still apply — a call does not buy
   * a shop a free message. `isAcknowledgement` because it confirms something
   * the customer just did on the phone, which is the same exemption a button
   * tap earns (phase 3, deviation 18).
   */
  private async sendWhatsAppSummary(
    input: Parameters<VoiceAgentRunner<Tx>['placeAndRun']>[0],
    outcome: CustomerDecision | 'PIPELINE_FAILURE',
  ): Promise<boolean> {
    if (input.conversationId === null || input.customerId === null) return false;

    const body =
      outcome === 'PIPELINE_FAILURE'
        ? t(input.language, 'voice.pipeline_failure', { advisorName: input.advisorName })
        : `${t(input.language, 'voice.readback', {
            summary: input.workSummary,
            amount: formatPaise(input.amountPaise),
          })} ${t(input.language, outcome === 'FULL' ? 'voice.approved' : 'voice.declined')}`;

    const sent = await this.deps.gate.send({
      shopId: input.shopId,
      conversationId: input.conversationId,
      customerId: input.customerId,
      purpose: 'SERVICE',
      content: { kind: 'text', body },
      actor: { type: 'AGENT', id: null },
      traceId: input.traceId,
      flow: 'voice',
      language: input.language,
      jobCardId: input.jobCardId,
      templated: true,
      isAcknowledgement: true,
    });

    this.trace(input.callId, 'summary', `WhatsApp summary ${sent.status}`);
    return sent.status === 'SENT';
  }

  private async stopRecordingIfStarted(
    input: Parameters<VoiceAgentRunner<Tx>['placeAndRun']>[0],
    session: CallSession,
    accumulator: CallAccumulator,
  ): Promise<void> {
    if (accumulator.recordingStartedAt === null) return;

    const recording = await session.stopRecording().catch(() => null);
    if (recording === null) return;

    await this.deps.calls.recordConsentFact({
      shopId: input.shopId,
      callId: input.callId,
      fact: 'RECORDING_STOPPED',
      turnIndex: accumulator.turnIndex,
      traceId: input.traceId,
    });

    await this.deps.calls.attachRecording({
      shopId: input.shopId,
      callId: input.callId,
      wav: recording.wav,
      durationMs: recording.durationMs,
      traceId: input.traceId,
    });

    this.trace(input.callId, 'recording', `stored ${recording.durationMs}ms`, {
      framesBeforeStart: recording.framesBeforeStart,
    });
  }

  /* ------------------------------------------------------- speaking, heard */

  private async sayScript(
    segment: ScriptSegment,
    input: Parameters<VoiceAgentRunner<Tx>['placeAndRun']>[0],
    turns: VoiceTurnManager,
    accumulator: CallAccumulator,
  ): Promise<SpokenTurn> {
    return this.say(segment.text, input, turns, accumulator, {
      scriptKey: segment.key,
      mandatory: segment.mandatory,
      agentRunId: null,
      isReadback: false,
    });
  }

  private async say(
    text: string,
    input: Parameters<VoiceAgentRunner<Tx>['placeAndRun']>[0],
    turns: VoiceTurnManager,
    accumulator: CallAccumulator,
    options: {
      readonly scriptKey: string | null;
      readonly mandatory?: boolean;
      readonly agentRunId: string | null;
      readonly isReadback: boolean;
      readonly latency?: {
        readonly speechEndedAt: Date | null;
        readonly finalAt: Date;
        readonly planReadyAt: Date;
      };
    },
  ): Promise<SpokenTurn> {
    const mandatory = options.mandatory ?? false;
    const spoken = await turns.speak(text, { allowBargeIn: !mandatory });

    const stages: Partial<Record<VoiceLatencyStage, number>> =
      options.latency === undefined
        ? {}
        : VoiceTurnManager.latencyStages({
            speechEndedAt: options.latency.speechEndedAt,
            finalAt: options.latency.finalAt,
            planReadyAt: options.latency.planReadyAt,
            firstFrameAt: spoken.firstFrameAt,
            speechStartedAt: spoken.startedAt,
          });

    const latencyMs = stages.SPEECH_END_TO_SPEECH_START ?? null;
    if (latencyMs !== null) {
      accumulator.maxLatencyMs = Math.max(accumulator.maxLatencyMs, latencyMs);
    }

    // Counted here rather than at the agent-turn call site, because a caller
    // interrupts *sentences*, not turns — and the sentence they cut across is
    // as often a script segment (the evidence recap, the keypad hint) as
    // something the model wrote. Counting only the latter reported zero
    // barge-ins on calls where the customer had cut in three times.
    if (spoken.bargedIn) accumulator.bargeIns += 1;

    const turnIndex = accumulator.turnIndex;
    accumulator.turnIndex += 1;

    await this.deps.calls.appendTurn({
      callId: input.callId,
      shopId: input.shopId,
      turnIndex,
      role: mandatory ? 'SYSTEM' : 'AGENT',
      inputMode: 'NONE',
      text,
      dtmfDigit: null,
      confidence: null,
      languageTag: `${input.language}-IN`,
      mandatorySegment: mandatory,
      // A readback is marked in the transcript even when the words came from
      // the model rather than the catalogue. "Was this decision read back?" has
      // to be answerable by reading the call record — which is the phase's own
      // demand that the audit story be as strong as chat's — and a turn that
      // only knew it was a readback in memory answers it nowhere.
      scriptKey: options.isReadback ? READBACK_SCRIPT_KEY : options.scriptKey,
      bargedIn: spoken.bargedIn,
      playedMs: spoken.synthesisedMs - spoken.droppedMs,
      latencyMs,
      latencyStages: stages,
      toolCalls: [],
      checkerVerdicts: [],
      agentRunId: options.agentRunId,
      startedAt: spoken.startedAt,
    });

    this.trace(input.callId, mandatory ? 'script' : 'agent', text, {
      bargedIn: spoken.bargedIn,
      latencyMs,
    });

    return spoken;
  }

  private async persistCallerTurn(
    input: Parameters<VoiceAgentRunner<Tx>['placeAndRun']>[0],
    accumulator: CallAccumulator,
    heard: HeardTurn,
  ): Promise<void> {
    const turnIndex = accumulator.turnIndex;
    accumulator.turnIndex += 1;

    await this.deps.calls.appendTurn({
      callId: input.callId,
      shopId: input.shopId,
      turnIndex,
      role: 'CALLER',
      inputMode: heard.inputMode,
      text: heard.dtmf === null ? heard.text : `[keypad ${heard.dtmf}]`,
      dtmfDigit: heard.dtmf,
      confidence: heard.confidence,
      languageTag: heard.languageTag,
      mandatorySegment: false,
      scriptKey: null,
      bargedIn: false,
      playedMs: null,
      latencyMs: null,
      latencyStages: {},
      toolCalls: [],
      checkerVerdicts: [],
      agentRunId: null,
      startedAt: heard.startedAt,
    });

    this.trace(input.callId, 'caller', heard.dtmf === null ? heard.text : `keypad ${heard.dtmf}`, {
      confidence: heard.confidence,
      inputMode: heard.inputMode,
    });
  }

  private async synthesise(
    input: Parameters<VoiceAgentRunner<Tx>['placeAndRun']>[0],
    text: string,
  ): Promise<ReturnType<typeof collectFrames> extends Promise<infer T> ? T : never> {
    const stream = this.deps.speech.streamSynthesize({
      shopId: input.shopId,
      callId: input.callId,
      language: input.language,
      frameMs: this.deps.settings.frameMs,
      traceId: input.traceId,
    });
    await stream.write(text);
    await stream.end();
    return collectFrames(stream);
  }

  /* ------------------------------------------------------------- plumbing */

  private runRequest(
    input: Parameters<VoiceAgentRunner<Tx>['placeAndRun']>[0],
    tail: readonly MessageSnapshot[],
  ): RunRequest {
    return {
      shopId: input.shopId,
      objective: input.agentObjective,
      // A call without a customer thread still needs a conversation id for the
      // run record. The call's own id stands in: it is a real, unique thread of
      // conversation, and it is what the transcript hangs off.
      conversationId: input.conversationId ?? input.callId,
      customerId: input.customerId,
      jobCardId: input.jobCardId,
      triggerMessageId: tail.at(-1)?.id ?? null,
      traceId: input.traceId,
      config: input.config,
      shop: input.shop,
      card: input.card,
      conversationTail: tail,
      sources: [],
      language: input.language,
      customerName: input.customerName,
      spec: voiceObjectiveSpec(input.agentObjective),
    };
  }

  private callContext(input: Parameters<VoiceAgentRunner<Tx>['placeAndRun']>[0]): {
    readonly shopId: string;
    readonly jobCardId: string | null;
    readonly customerId: string | null;
    readonly conversationId: string | null;
    readonly approvalRequestId: string | null;
    readonly escalationId: string | null;
    readonly objective: string;
    readonly language: Language;
    readonly customerName: string | null;
    readonly traceId: string;
  } {
    return {
      shopId: input.shopId,
      jobCardId: input.jobCardId,
      customerId: input.customerId,
      conversationId: input.conversationId,
      approvalRequestId: input.approvalRequestId,
      escalationId: input.escalationId,
      objective: input.objective,
      language: input.language,
      customerName: input.customerName,
      traceId: input.traceId,
    };
  }

  private async waitForAnswer(session: CallSession): Promise<boolean> {
    const deadline = Date.now() + this.deps.settings.ringTimeoutMs;

    while (Date.now() < deadline) {
      const event = await session.events.next(Math.min(100, deadline - Date.now()));
      if (event === null) {
        if (session.isLive()) return true;
        continue;
      }
      if (event.kind === 'answered') return true;
      if (event.kind === 'failed' || event.kind === 'hangup') return false;
    }

    return session.isLive();
  }

  /**
   * The inbound leg the provider is holding open for us.
   *
   * Waited for rather than looked up once, because the two halves of an inbound
   * call start independently: a customer dialled and the provider connected a
   * leg, while this process was still deciding whether the shop's line is even
   * switched on. Which of the two gets there first is not something either side
   * controls, and a lookup that ran a millisecond early would fail a call the
   * customer is listening to.
   */
  private async awaitInboundSession(callId: string): Promise<CallSession> {
    const deadline = Date.now() + this.deps.settings.ringTimeoutMs;

    for (;;) {
      const live = this.deps.telephony.activeSessions();
      const matched = live.find(
        (session) => session.callId === callId || session.context.traceId === callId,
      );
      if (matched !== undefined) return matched;

      const newest = live.at(-1);
      if (newest !== undefined) return newest;

      if (Date.now() >= deadline) {
        throw new Error(`No inbound session arrived for call ${callId}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }

  private async finish(
    input: Parameters<VoiceAgentRunner<Tx>['placeAndRun']>[0],
    accumulator: CallAccumulator,
    startedAt: Date,
    result: {
      readonly status: 'COMPLETED' | 'FAILED';
      readonly outcome: CallOutcome;
      readonly endReason: CallEndReason;
      readonly decision: CustomerDecision | null;
      readonly agentRunId: string | null;
      readonly turnManager: VoiceTurnManager | null;
    },
  ): Promise<CallReport> {
    const endedAt = this.clock.now();
    const durationSeconds = Math.max(
      0,
      Math.round((endedAt.getTime() - startedAt.getTime()) / 1000),
    );

    await this.deps.calls.finish({
      callId: input.callId,
      shopId: input.shopId,
      status: result.status,
      outcome: result.outcome,
      endReason: result.endReason,
      endedAt,
      durationSeconds,
      turnCount: accumulator.turnIndex,
      handedOff: accumulator.handedOff,
      degradedToIvr: accumulator.degraded,
      poorTurnCount: accumulator.poorTurns,
      bargeInCount: accumulator.bargeIns,
      maxTurnLatencyMs: accumulator.maxLatencyMs,
      intent: input.intentHint ?? null,
      decision: result.decision,
      agentRunId: result.agentRunId,
      traceId: input.traceId,
      telcoMs: durationSeconds * 1000,
      sttMs: result.turnManager?.sttMillis ?? 0,
      ttsMs: result.turnManager?.ttsMillis ?? 0,
      llmInputTokens: accumulator.llmInputTokens,
      llmOutputTokens: accumulator.llmOutputTokens,
      // The phase-3 meter already priced the model calls; passing zero here
      // avoids double-counting them against the voice cap.
      llmCostUsdMicros: 0,
    });

    return {
      callId: input.callId,
      placed: true,
      answered: true,
      outcome: result.outcome,
      endReason: result.endReason,
      refusalCode: null,
      refusalReason: null,
      fallBackToAdvisor: accumulator.handedOff,
      turns: accumulator.turnIndex,
      decision: result.decision,
      handedOff: accumulator.handedOff,
      degradedToIvr: accumulator.degraded,
      maxTurnLatencyMs: accumulator.maxLatencyMs,
      bargeIns: accumulator.bargeIns,
      durationSeconds,
      disclosurePlayed: accumulator.disclosurePlayed,
      recordingStartedAfterNotice:
        accumulator.recordingStartedAt !== null && accumulator.noticePlayed,
      advisorTaskId: accumulator.advisorTaskId,
      summarySent: accumulator.summarySent,
      retryAfterMinutes: null,
    };
  }

  private trace(
    callId: string,
    stage: string,
    detail: string,
    data?: Readonly<Record<string, unknown>>,
  ): void {
    this.deps.onTrace?.({
      callId,
      stage,
      detail,
      at: this.clock.now().toISOString(),
      ...(data === undefined ? {} : { data }),
    });
  }

  private async uow<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.deps.uow.transaction(work);
  }

  private async loadConfig(shopId: string): Promise<ShopConfig> {
    return this.uow(async (tx) => {
      const stored = await this.deps.config.load(tx, shopId);
      const timezone = (await this.deps.config.loadShopTimezone(tx, shopId)) ?? 'Asia/Kolkata';
      return migrateShopConfig(stored?.raw ?? {}, timezone).config;
    });
  }

  private async loadShop(shopId: string): Promise<ShopProfile> {
    return this.uow(async (tx) => {
      const name = (await this.deps.directory.loadShopName(tx, shopId)) ?? 'the workshop';
      const advisor = await this.deps.directory.loadHandoffAdvisor(tx, shopId);
      return {
        name,
        city: null,
        advisorName: advisor?.fullName ?? null,
        priceListSummary: '',
      };
    });
  }
}

/**
 * What handling a keypress produced.
 *
 * An outcome ends the call; a pending decision means the caller has been read
 * something back and the next press is the answer to it; neither means the call
 * carries on unchanged. Three states in one shape, because the alternative — a
 * nullable outcome plus an out-parameter — is how the "was it read back?"
 * question stops being answerable.
 */
interface DtmfResult {
  readonly outcome?: CallOutcome;
  readonly endReason?: CallEndReason;
  readonly pendingDecision?: CustomerDecision | null;
}

/* ---------------------------------------------------------------- helpers */

/**
 * The transcript's marker for a confirm-by-readback turn.
 *
 * The catalogue key, reused for a model-written readback, so one query answers
 * the question for both — `readbackSegment` produces this key already.
 */
export const READBACK_SCRIPT_KEY = 'voice.readback';

function refusedReport(
  callId: string,
  code: string,
  reason: string,
  fallBackToAdvisor: boolean,
): CallReport {
  return {
    callId,
    placed: false,
    answered: false,
    outcome: 'NOT_PLACED',
    endReason: null,
    refusalCode: code,
    refusalReason: reason,
    fallBackToAdvisor,
    turns: 0,
    decision: null,
    handedOff: false,
    degradedToIvr: false,
    maxTurnLatencyMs: 0,
    bargeIns: 0,
    durationSeconds: 0,
    disclosurePlayed: false,
    recordingStartedAfterNotice: false,
    advisorTaskId: null,
    summarySent: false,
    retryAfterMinutes: null,
  };
}

function callerMessage(text: string, conversationId: string | null): MessageSnapshot {
  const now = new Date();
  return {
    id: uuidv7(),
    conversationId: conversationId ?? '',
    direction: 'INBOUND',
    status: 'DELIVERED',
    kind: 'TEXT',
    purpose: 'SERVICE',
    body: text,
    sentAt: now,
    createdAt: now,
  };
}

/**
 * Whether a spoken reply means yes.
 *
 * Deliberately narrow, and deliberately multilingual. A phone line mis-hears,
 * and this is the last thing standing between a mis-hearing and a decision, so
 * "yeah okay fine" counts and anything the list does not recognise does not.
 * The keypad is always offered alongside precisely because this list can never
 * be complete.
 */
export function isAffirmative(text: string): boolean {
  const normalised = text.trim().toLowerCase();
  if (normalised.length === 0) return false;

  const words = normalised.split(/[\s,.!?]+/u).filter((word) => word.length > 0);
  const yes = new Set([
    'yes',
    'yeah',
    'yep',
    'ok',
    'okay',
    'sure',
    'confirm',
    'confirmed',
    'go',
    'proceed',
    'seri',
    'sari',
    'aama',
    'ama',
    'ha',
    'haan',
    'ji',
    'theek',
    'thik',
    'ஆம்',
    'சரி',
    'हाँ',
    'हां',
    'ठीक',
  ]);

  // Any explicit negative anywhere in the reply wins. "Yes but not today" is
  // not an approval, and treating it as one is the exact failure the readback
  // exists to prevent.
  const no = new Set(['no', 'not', 'dont', "don't", 'wait', 'illa', 'venda', 'nahi', 'mat', 'இல்லை', 'नहीं']);
  if (words.some((word) => no.has(word))) return false;

  return words.some((word) => yes.has(word));
}

async function collectFrames(stream: {
  frames: { next(timeoutMs?: number): Promise<unknown | null> };
}): Promise<never[]> {
  const frames: unknown[] = [];
  for (;;) {
    const frame = await stream.frames.next(0);
    if (frame === null) break;
    frames.push(frame);
  }
  return frames as never[];
}

export { MANDATORY_SCRIPT_KEYS };
