import { migrateShopConfig, type ShopConfig } from '@serviceloop/config';
import {
  systemClock,
  uuidv7,
  type CallConsentFact,
  type CallStatus,
  type Clock,
  type EventEnvelope,
  type Paise,
} from '@serviceloop/shared';
import type { Actor } from '../job-card/context';
import { SYSTEM_ACTOR } from '../job-card/context';
import type { AuditAppender, OutboxWriter, ShopConfigStore, UnitOfWork } from '../ports';
import type { ConsentStore } from '../messaging/ports';
import { callDayWindow, evaluateCallGate } from './call-gate';
import { estimateCallCostPaise, toBilledSeconds, type VoiceRates } from './cost-meter';
import type {
  CallConsentStore,
  CallRecordingWriter,
  CallStore,
  CallTurnStore,
  CallUsageStore,
} from './ports';
import type {
  BlockedCallInput,
  CallGateVerdict,
  CallRecord,
  CallTurnRecord,
  CallUsageRecord,
  FinishCallInput,
  OpenCallInput,
} from './types';

/**
 * `VoiceCallService` — the record of what the phone did (phase 5).
 *
 * The runtime that holds a line open lives in `packages/agent-core`, because
 * only that package may import a telephony adapter. What lives here is
 * everything a shop, an auditor or phase 6's metrics service would want to
 * know: whether the call was allowed, what was said, whether the notice
 * preceded the recorder, what it cost, and how it ended.
 *
 * Two invariants this class exists to hold:
 *
 *   - **Recording cannot start before the notice.** `startRecording` refuses
 *     unless a `RECORDING_NOTICE_PLAYED` fact is already on the call, and the
 *     database carries the same rule as a trigger. Two places agreeing is not
 *     duplication here: the service is what gives a caller a useful error, and
 *     the trigger is what makes the claim true of the data rather than of one
 *     code path.
 *   - **A refused call is still a call row.** `refuse` writes a `BLOCKED`
 *     record with a code and a reason, audits it and emits `call.originated`
 *     with `blocked` set. A rung that decided not to dial is a fact; silence
 *     would be indistinguishable from a crash.
 */

export interface VoiceCallDeps<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly calls: CallStore<Tx>;
  readonly turns: CallTurnStore<Tx>;
  readonly consentEvents: CallConsentStore<Tx>;
  readonly usage: CallUsageStore<Tx>;
  readonly consents: ConsentStore<Tx>;
  readonly config: ShopConfigStore<Tx>;
  readonly audit: AuditAppender<Tx>;
  readonly outbox: OutboxWriter<Tx>;
  readonly recordings?: CallRecordingWriter<Tx>;
  readonly rates: VoiceRates;
  readonly platformCapPaise: Paise;
  readonly alertRatio: number;
  readonly platformKillSwitch: () => boolean;
  readonly retentionDays: number;
  readonly clock?: Clock;
  /** Where a cap alert goes. Wired to the notifier at boot. */
  readonly onCapAlert?: (alert: {
    readonly shopId: string;
    readonly message: string;
    readonly traceId: string;
  }) => void;
}

export interface OriginationRequest {
  readonly shopId: string;
  readonly driver: string;
  readonly to: string;
  readonly toMasked: string;
  readonly fromNumber: string;
  readonly jobCardId: string | null;
  readonly customerId: string | null;
  readonly conversationId: string | null;
  readonly approvalRequestId: string | null;
  readonly escalationId: string | null;
  readonly objective: string;
  readonly language: 'en' | 'ta' | 'hi';
  readonly retryOfCallId?: string | null;
  readonly actor?: Actor;
  readonly traceId: string;
}

export type OriginationDecision =
  | { readonly allowed: true; readonly callId: string; readonly warnings: readonly string[] }
  | {
      readonly allowed: false;
      readonly callId: string;
      readonly code: string;
      readonly reason: string;
      readonly fallBackToAdvisor: boolean;
    };

export class VoiceCallService<Tx> {
  private readonly clock: Clock;

  constructor(private readonly deps: VoiceCallDeps<Tx>) {
    this.clock = deps.clock ?? systemClock;
  }

  /**
   * The gate, and the row it writes either way.
   *
   * A caller *must* go through this before touching the telephony port. There
   * is no second path: `TelephonyPort` is not exported from this package, and
   * the runtime that holds one takes the call id this returns.
   */
  async authorise(request: OriginationRequest): Promise<OriginationDecision> {
    const now = this.clock.now();
    const config = await this.loadConfig(request.shopId);
    const dayStart = callDayWindow(config, now);

    const verdict = await this.deps.uow.transaction(async (tx) => {
      const consents =
        request.customerId === null
          ? []
          : await this.deps.consents.current(tx, request.shopId, request.customerId);

      const callsToCustomerToday =
        request.customerId === null
          ? 0
          : await this.deps.calls.countForCustomerSince(
              tx,
              request.shopId,
              request.customerId,
              dayStart,
            );

      return evaluateCallGate({
        config,
        now,
        platformKillSwitch: this.deps.platformKillSwitch(),
        direction: 'OUTBOUND',
        consents: consents.map((row) => ({ purpose: row.purpose, status: row.status })),
        customerId: request.customerId,
        hasPhoneNumber: request.to.length > 0,
        callsToCustomerToday,
        callsFromShopToday: await this.deps.calls.countForShopSince(tx, request.shopId, dayStart),
        shopSpentTodayPaise: await this.deps.usage.spendSince(tx, request.shopId, dayStart),
        platformSpentTodayPaise: await this.deps.usage.platformSpendSince(tx, dayStart),
        platformCapPaise: this.deps.platformCapPaise,
        alertRatio: this.deps.alertRatio,
      });
    });

    if (!verdict.allowed) return this.refuse(request, verdict, config, now);

    for (const warning of verdict.warnings) {
      this.deps.onCapAlert?.({ shopId: request.shopId, message: warning, traceId: request.traceId });
    }

    const callId = uuidv7();
    await this.open(request, callId, now, config);

    return { allowed: true, callId, warnings: verdict.warnings };
  }

  /**
   * An arriving call. The gate still runs — the inbound branch of it — because
   * a shop that has switched its line off must not answer, and the kill switch
   * has to reach a call nobody at the shop initiated.
   */
  async acceptInbound(
    request: OriginationRequest & { readonly providerCallSid: string | null },
  ): Promise<OriginationDecision> {
    const now = this.clock.now();
    const config = await this.loadConfig(request.shopId);

    const verdict = evaluateCallGate({
      config,
      now,
      platformKillSwitch: this.deps.platformKillSwitch(),
      direction: 'INBOUND',
      consents: [],
      customerId: request.customerId,
      hasPhoneNumber: true,
      callsToCustomerToday: 0,
      callsFromShopToday: 0,
      shopSpentTodayPaise: 0,
      platformSpentTodayPaise: 0,
      platformCapPaise: this.deps.platformCapPaise,
      alertRatio: this.deps.alertRatio,
    });

    if (!verdict.allowed) return this.refuse(request, verdict, config, now);

    const callId = uuidv7();
    await this.open(request, callId, now, config, 'INBOUND', request.providerCallSid);
    return { allowed: true, callId, warnings: verdict.warnings };
  }

  /**
   * The line is ringing, and this is what the provider calls it.
   *
   * The sid is recorded here rather than at origination because it does not
   * exist until the provider has accepted the leg — and it is recorded *at all*
   * because the call row's id and the provider's are two different identifiers
   * for one telephone call. Everything that arrives later (a status webhook, a
   * recording callback, the console's own softphone) speaks the provider's, and
   * without this there is no way back to the row.
   */
  async markRinging(
    shopId: string,
    callId: string,
    providerCallSid: string | null = null,
  ): Promise<void> {
    await this.deps.uow.transaction((tx) =>
      this.deps.calls.setStatus(tx, shopId, callId, 'RINGING', this.clock.now(), providerCallSid),
    );
  }

  async markAnswered(input: {
    readonly shopId: string;
    readonly callId: string;
    readonly traceId: string;
  }): Promise<void> {
    const now = this.clock.now();

    await this.deps.uow.transaction(async (tx) => {
      await this.deps.calls.markAnswered(tx, input.shopId, input.callId, now);
      const call = await this.deps.calls.load(tx, input.shopId, input.callId);

      const envelope: EventEnvelope = {
        id: uuidv7(),
        type: 'call.answered',
        occurredAt: now.toISOString(),
        shopId: input.shopId,
        traceId: input.traceId,
        payload: {
          callId: input.callId,
          direction: call?.direction ?? 'OUTBOUND',
          answeredAt: now.toISOString(),
          jobCardId: call?.jobCardId ?? null,
          customerId: call?.customerId ?? null,
          actor: { type: 'AGENT', id: null },
        },
      };
      await this.deps.outbox.enqueue(tx, envelope);
    });
  }

  /** Appends one turn. Idempotent on `(callId, turnIndex)`. */
  async appendTurn(turn: CallTurnRecord): Promise<void> {
    await this.deps.uow.transaction(async (tx) => {
      await this.deps.turns.append(tx, turn);
    });
  }

  async loadTurns(shopId: string, callId: string): Promise<readonly CallTurnRecord[]> {
    return this.deps.uow.transaction((tx) => this.deps.turns.load(tx, shopId, callId));
  }

  async loadCall(shopId: string, callId: string): Promise<CallRecord | null> {
    return this.deps.uow.transaction((tx) => this.deps.calls.load(tx, shopId, callId));
  }

  /**
   * Records a consent or disclosure fact.
   *
   * Audited as it is written. The audit row is what an auditor reads; the table
   * row is what the recording trigger checks. Both, because they answer to
   * different people.
   */
  async recordConsentFact(input: {
    readonly shopId: string;
    readonly callId: string;
    readonly fact: CallConsentFact;
    readonly turnIndex: number | null;
    readonly detail?: string;
    readonly traceId: string;
  }): Promise<void> {
    const now = this.clock.now();

    await this.deps.uow.transaction(async (tx) => {
      const created = await this.deps.consentEvents.record(tx, {
        callId: input.callId,
        shopId: input.shopId,
        fact: input.fact,
        turnIndex: input.turnIndex,
        detail: input.detail ?? null,
        occurredAt: now,
      });

      if (created === null) return;

      await this.deps.audit.append(tx, {
        shopId: input.shopId,
        actorType: 'AGENT',
        actorId: null,
        action: 'call.consent_fact',
        entityType: 'Call',
        entityId: input.callId,
        payload: { fact: input.fact, turnIndex: input.turnIndex, detail: input.detail ?? null },
        traceId: input.traceId,
      });
    });
  }

  /**
   * May the recorder start?
   *
   * The phase's ordering requirement, enforced where it can be *acted on*: a
   * caller that gets `false` plays the notice and asks again, instead of
   * discovering the problem from a database exception three writes later.
   */
  async mayStartRecording(shopId: string, callId: string): Promise<boolean> {
    const facts = await this.deps.uow.transaction((tx) =>
      this.deps.consentEvents.load(tx, shopId, callId),
    );
    return facts.some((fact) => fact.fact === 'RECORDING_NOTICE_PLAYED');
  }

  async attachRecording(input: {
    readonly shopId: string;
    readonly callId: string;
    readonly wav: Buffer;
    readonly durationMs: number;
    readonly traceId: string;
  }): Promise<string | null> {
    const writer = this.deps.recordings;
    if (writer === undefined) return null;

    // Re-checked here, not only where the recorder started. Between those two
    // moments a call can have been transferred, retried or replayed, and the
    // question this asks is about the bytes actually being persisted.
    if (!(await this.mayStartRecording(input.shopId, input.callId))) return null;

    const now = this.clock.now();
    const retentionUntil = new Date(now.getTime() + this.deps.retentionDays * 86_400_000);

    return this.deps.uow.transaction(async (tx) => {
      const mediaId = await writer.store(tx, {
        shopId: input.shopId,
        callId: input.callId,
        wav: input.wav,
        durationMs: input.durationMs,
        at: now,
      });

      await this.deps.calls.attachRecording(
        tx,
        input.shopId,
        input.callId,
        mediaId,
        retentionUntil,
      );

      await this.deps.audit.append(tx, {
        shopId: input.shopId,
        actorType: 'AGENT',
        actorId: null,
        action: 'call.recording_stored',
        entityType: 'Call',
        entityId: input.callId,
        payload: { mediaId, durationMs: input.durationMs, retentionUntil: retentionUntil.toISOString() },
        traceId: input.traceId,
      });

      return mediaId;
    });
  }

  async recordBridge(input: {
    readonly shopId: string;
    readonly callId: string;
    readonly advisorStaffId: string | null;
    readonly whisperText: string;
    readonly traceId: string;
  }): Promise<void> {
    const now = this.clock.now();

    await this.deps.uow.transaction(async (tx) => {
      await this.deps.calls.recordBridge(tx, {
        shopId: input.shopId,
        callId: input.callId,
        advisorStaffId: input.advisorStaffId,
        whisperText: input.whisperText,
        at: now,
      });

      await this.deps.audit.append(tx, {
        shopId: input.shopId,
        actorType: 'AGENT',
        actorId: null,
        action: 'call.bridged',
        entityType: 'Call',
        entityId: input.callId,
        payload: { advisorStaffId: input.advisorStaffId, whisper: input.whisperText },
        traceId: input.traceId,
      });

      const envelope: EventEnvelope = {
        id: uuidv7(),
        type: 'call.handoff_bridged',
        occurredAt: now.toISOString(),
        shopId: input.shopId,
        traceId: input.traceId,
        payload: {
          callId: input.callId,
          advisorStaffId: input.advisorStaffId,
          whisperText: input.whisperText,
          bridgedAt: now.toISOString(),
          actor: { type: 'AGENT', id: null },
        },
      };
      await this.deps.outbox.enqueue(tx, envelope);
    });
  }

  async attachAdvisorTask(shopId: string, callId: string, taskId: string): Promise<void> {
    await this.deps.uow.transaction((tx) =>
      this.deps.calls.attachAdvisorTask(tx, shopId, callId, taskId),
    );
  }

  async attachAgentRun(shopId: string, callId: string, agentRunId: string): Promise<void> {
    await this.deps.uow.transaction((tx) =>
      this.deps.calls.attachAgentRun(tx, shopId, callId, agentRunId),
    );
  }

  /**
   * The terminal write: the call's outcome, its cost, and the two events phase
   * 6 aggregates.
   *
   * Cost is metered even when the call failed. A ringing leg that nobody
   * answered still consumed telco seconds, and a cap that only counted
   * successful calls would be a cap a shop could exhaust without it noticing.
   */
  async finish(
    input: FinishCallInput & {
      readonly traceId: string;
      readonly telcoMs: number;
      readonly sttMs: number;
      readonly ttsMs: number;
      readonly llmInputTokens: number;
      readonly llmOutputTokens: number;
      readonly llmCostUsdMicros: number;
    },
  ): Promise<CallUsageRecord> {
    const config = await this.loadConfig(input.shopId);
    const dayStart = callDayWindow(config, input.endedAt);

    const totals = {
      telcoSeconds: toBilledSeconds(input.telcoMs),
      sttSeconds: toBilledSeconds(input.sttMs),
      ttsSeconds: toBilledSeconds(input.ttsMs),
      llmInputTokens: input.llmInputTokens,
      llmOutputTokens: input.llmOutputTokens,
      llmCostUsdMicros: input.llmCostUsdMicros,
    };
    const estimatedCostPaise = estimateCallCostPaise(totals, this.deps.rates);

    return this.deps.uow.transaction(async (tx) => {
      await this.deps.calls.finish(tx, input);

      const spentBefore = await this.deps.usage.spendSince(tx, input.shopId, dayStart);
      const platformBefore = await this.deps.usage.platformSpendSince(tx, dayStart);

      const capBreached =
        config.voice.dailyCostCapPaise > 0 &&
        spentBefore + estimatedCostPaise >= config.voice.dailyCostCapPaise
          ? ('SHOP_DAILY' as const)
          : this.deps.platformCapPaise > 0 &&
              platformBefore + estimatedCostPaise >= this.deps.platformCapPaise
            ? ('PLATFORM_DAILY' as const)
            : null;

      const usage: CallUsageRecord = {
        callId: input.callId,
        shopId: input.shopId,
        ...totals,
        estimatedCostPaise,
        capBreached,
        traceId: input.traceId,
      };

      await this.deps.usage.record(tx, usage);

      await this.deps.audit.append(tx, {
        shopId: input.shopId,
        actorType: 'AGENT',
        actorId: null,
        action: 'call.ended',
        entityType: 'Call',
        entityId: input.callId,
        payload: {
          outcome: input.outcome,
          endReason: input.endReason,
          durationSeconds: input.durationSeconds,
          turns: input.turnCount,
          handedOff: input.handedOff,
          degradedToIvr: input.degradedToIvr,
          decision: input.decision,
          estimatedCostPaise,
          capBreached,
        },
        traceId: input.traceId,
      });

      const ended: EventEnvelope = {
        id: uuidv7(),
        type: 'call.ended',
        occurredAt: input.endedAt.toISOString(),
        shopId: input.shopId,
        traceId: input.traceId,
        payload: {
          callId: input.callId,
          direction:
            (await this.deps.calls.load(tx, input.shopId, input.callId))?.direction ?? 'OUTBOUND',
          outcome: input.outcome,
          endReason: input.endReason,
          durationSeconds: input.durationSeconds,
          turns: input.turnCount,
          handedOff: input.handedOff,
          decision: input.decision,
          jobCardId: null,
          customerId: null,
          approvalRequestId: null,
          actor: { type: 'AGENT', id: null },
        },
      };
      await this.deps.outbox.enqueue(tx, ended);

      const metered: EventEnvelope = {
        id: uuidv7(),
        type: 'call.usage_recorded',
        occurredAt: input.endedAt.toISOString(),
        shopId: input.shopId,
        traceId: input.traceId,
        payload: {
          callId: input.callId,
          telcoSeconds: totals.telcoSeconds,
          sttSeconds: totals.sttSeconds,
          ttsSeconds: totals.ttsSeconds,
          llmInputTokens: totals.llmInputTokens,
          llmOutputTokens: totals.llmOutputTokens,
          estimatedCostPaise,
          capBreached,
          actor: { type: 'AGENT', id: null },
        },
      };
      await this.deps.outbox.enqueue(tx, metered);

      if (capBreached !== null) {
        this.deps.onCapAlert?.({
          shopId: input.shopId,
          message: `Voice spending cap reached (${capBreached}); new calls are halted until tomorrow`,
          traceId: input.traceId,
        });
      }

      return usage;
    });
  }

  /** Calls already placed for one ladder rung. The retry counter (5.4a). */
  async attemptsForEscalation(shopId: string, escalationId: string): Promise<number> {
    return this.deps.uow.transaction((tx) =>
      this.deps.calls.countForEscalation(tx, shopId, escalationId),
    );
  }

  async spendToday(shopId: string): Promise<Paise> {
    const config = await this.loadConfig(shopId);
    const dayStart = callDayWindow(config, this.clock.now());
    return this.deps.uow.transaction((tx) => this.deps.usage.spendSince(tx, shopId, dayStart));
  }

  /* ------------------------------------------------------------------ private */

  private async open(
    request: OriginationRequest,
    callId: string,
    now: Date,
    config: ShopConfig,
    direction: 'OUTBOUND' | 'INBOUND' = 'OUTBOUND',
    providerCallSid: string | null = null,
  ): Promise<void> {
    const input: OpenCallInput = {
      id: callId,
      shopId: request.shopId,
      direction,
      driver: request.driver,
      providerCallSid,
      to: request.to,
      toMasked: request.toMasked,
      fromNumber: request.fromNumber,
      jobCardId: request.jobCardId,
      customerId: request.customerId,
      conversationId: request.conversationId,
      approvalRequestId: request.approvalRequestId,
      escalationId: request.escalationId,
      objective: request.objective,
      language: request.language,
      retryOfCallId: request.retryOfCallId ?? null,
      retentionUntil: new Date(now.getTime() + config.voice.recordingRetentionDays * 86_400_000),
      traceId: request.traceId,
      startedAt: now,
    };

    await this.deps.uow.transaction(async (tx) => {
      await this.deps.calls.open(tx, input);
      await this.deps.audit.append(tx, {
        shopId: request.shopId,
        actorType: request.actor?.type ?? SYSTEM_ACTOR.type,
        actorId: request.actor?.id ?? null,
        action: 'call.originated',
        entityType: 'Call',
        entityId: callId,
        payload: {
          direction,
          driver: request.driver,
          // The mask, never the number. A call log is a list of who a shop rang.
          to: request.toMasked,
          objective: request.objective,
          jobCardId: request.jobCardId,
          approvalRequestId: request.approvalRequestId,
          escalationId: request.escalationId,
        },
        traceId: request.traceId,
      });

      await this.deps.outbox.enqueue(tx, this.originatedEvent(request, callId, direction, now, null));
    });
  }

  private async refuse(
    request: OriginationRequest,
    verdict: Extract<CallGateVerdict, { allowed: false }>,
    config: ShopConfig,
    now: Date,
  ): Promise<OriginationDecision> {
    const callId = uuidv7();
    const input: BlockedCallInput = {
      id: callId,
      shopId: request.shopId,
      direction: 'OUTBOUND',
      driver: request.driver,
      to: request.to,
      toMasked: request.toMasked,
      fromNumber: request.fromNumber,
      jobCardId: request.jobCardId,
      customerId: request.customerId,
      conversationId: request.conversationId,
      approvalRequestId: request.approvalRequestId,
      escalationId: request.escalationId,
      objective: request.objective,
      language: request.language,
      retryOfCallId: request.retryOfCallId ?? null,
      retentionUntil: new Date(now.getTime() + config.voice.recordingRetentionDays * 86_400_000),
      traceId: request.traceId,
      startedAt: now,
      code: verdict.code,
      reason: verdict.reason,
    };

    await this.deps.uow.transaction(async (tx) => {
      await this.deps.calls.recordBlocked(tx, input);

      await this.deps.audit.append(tx, {
        shopId: request.shopId,
        actorType: request.actor?.type ?? SYSTEM_ACTOR.type,
        actorId: request.actor?.id ?? null,
        action: 'call.blocked',
        entityType: 'Call',
        entityId: callId,
        payload: {
          code: verdict.code,
          reason: verdict.reason,
          fallBackToAdvisor: verdict.fallBackToAdvisor,
          to: request.toMasked,
          objective: request.objective,
        },
        traceId: request.traceId,
      });

      await this.deps.outbox.enqueue(
        tx,
        this.originatedEvent(request, callId, 'OUTBOUND', now, verdict.code),
      );
    });

    return {
      allowed: false,
      callId,
      code: verdict.code,
      reason: verdict.reason,
      fallBackToAdvisor: verdict.fallBackToAdvisor,
    };
  }

  private originatedEvent(
    request: OriginationRequest,
    callId: string,
    direction: 'OUTBOUND' | 'INBOUND',
    now: Date,
    blocked: string | null,
  ): EventEnvelope {
    return {
      id: uuidv7(),
      type: 'call.originated',
      occurredAt: now.toISOString(),
      shopId: request.shopId,
      traceId: request.traceId,
      payload: {
        callId,
        direction,
        driver: request.driver,
        objective: request.objective,
        jobCardId: request.jobCardId,
        customerId: request.customerId,
        conversationId: request.conversationId,
        approvalRequestId: request.approvalRequestId,
        escalationId: request.escalationId,
        blocked,
        actor: {
          type: request.actor?.type ?? 'SYSTEM',
          id: request.actor?.id ?? null,
        },
      },
    };
  }

  private async loadConfig(shopId: string): Promise<ShopConfig> {
    return this.deps.uow.transaction(async (tx) => {
      const stored = await this.deps.config.load(tx, shopId);
      const timezone = (await this.deps.config.loadShopTimezone(tx, shopId)) ?? 'Asia/Kolkata';
      return migrateShopConfig(stored?.raw ?? {}, timezone).config;
    });
  }
}

export type { CallStatus };
