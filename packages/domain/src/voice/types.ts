import type {
  CallConsentFact,
  CallDirection,
  CallEndReason,
  CallInputMode,
  CallOutcome,
  CallStatus,
  CallTurnRole,
  CustomerDecision,
  DtmfDigit,
  Language,
  Paise,
  VoiceIntent,
  VoiceLatencyStage,
} from '@serviceloop/shared';

/**
 * The voice layer's domain types (phase 5).
 *
 * `packages/domain` owns the rules and knows nothing about telephony: there is
 * no `CallSession`, no PCM frame and no websocket in this file. What lives here
 * is what a *shop* would recognise — whether a call may be placed, what was
 * said, what it cost, and whether the customer was told the things they are
 * owed before anything was recorded.
 *
 * The runtime that actually holds a phone line open is `packages/agent-core`,
 * which is the package already allowed to import adapters. That split is the
 * same one phase 3 made between `ApprovalService` and `AgentRunner`, and for
 * the same reason: the rules must be testable without a provider.
 */

export interface CallRecord {
  readonly id: string;
  readonly shopId: string;
  readonly direction: CallDirection;
  readonly status: CallStatus;
  readonly driver: string;
  readonly providerCallSid: string | null;
  readonly toMasked: string;
  readonly fromNumber: string;
  readonly jobCardId: string | null;
  readonly customerId: string | null;
  readonly conversationId: string | null;
  readonly approvalRequestId: string | null;
  readonly escalationId: string | null;
  readonly agentRunId: string | null;
  readonly objective: string;
  readonly language: Language;
  readonly intent: VoiceIntent | null;
  readonly outcome: CallOutcome | null;
  readonly endReason: CallEndReason | null;
  readonly blockedReason: string | null;
  readonly blockedCode: string | null;
  readonly ringingAt: Date | null;
  readonly answeredAt: Date | null;
  readonly endedAt: Date | null;
  readonly durationSeconds: number;
  readonly turnCount: number;
  readonly handedOff: boolean;
  readonly bridgedToStaffId: string | null;
  readonly whisperText: string | null;
  readonly advisorTaskId: string | null;
  readonly degradedToIvr: boolean;
  readonly poorTurnCount: number;
  readonly bargeInCount: number;
  readonly maxTurnLatencyMs: number;
  readonly recordingMediaId: string | null;
  readonly retentionUntil: Date | null;
  readonly retryOfCallId: string | null;
  readonly traceId: string;
  readonly createdAt: Date;
}

export interface OpenCallInput {
  readonly id: string;
  readonly shopId: string;
  readonly direction: CallDirection;
  readonly driver: string;
  readonly providerCallSid: string | null;
  /** Encrypted at rest by the store; only the mask reaches a screen or a log. */
  readonly to: string;
  readonly toMasked: string;
  readonly fromNumber: string;
  readonly jobCardId: string | null;
  readonly customerId: string | null;
  readonly conversationId: string | null;
  readonly approvalRequestId: string | null;
  readonly escalationId: string | null;
  readonly objective: string;
  readonly language: Language;
  readonly retryOfCallId: string | null;
  readonly retentionUntil: Date;
  readonly traceId: string;
  readonly startedAt: Date;
}

/**
 * A call that was refused before a packet left.
 *
 * Written as a `BLOCKED` row rather than as nothing at all: a rung that decided
 * not to dial is a fact the ladder, the audit trail and phase 6's containment
 * metrics all need, and silence is indistinguishable from a crash.
 */
export interface BlockedCallInput extends Omit<OpenCallInput, 'providerCallSid'> {
  readonly code: string;
  readonly reason: string;
}

export interface CallTurnRecord {
  readonly callId: string;
  readonly shopId: string;
  readonly turnIndex: number;
  readonly role: CallTurnRole;
  readonly inputMode: CallInputMode;
  readonly text: string;
  readonly dtmfDigit: DtmfDigit | null;
  /** 0–1. Null on an agent turn, which nobody had to recognise. */
  readonly confidence: number | null;
  readonly languageTag: string | null;
  readonly mandatorySegment: boolean;
  readonly scriptKey: string | null;
  readonly bargedIn: boolean;
  readonly playedMs: number | null;
  readonly latencyMs: number | null;
  readonly latencyStages: Partial<Record<VoiceLatencyStage, number>>;
  readonly toolCalls: readonly { readonly name: string; readonly args: unknown }[];
  readonly checkerVerdicts: readonly {
    readonly checker: string;
    readonly ok: boolean;
    readonly code: string | null;
    readonly reason: string | null;
  }[];
  readonly agentRunId: string | null;
  readonly startedAt: Date;
}

export interface CallConsentEventRecord {
  readonly callId: string;
  readonly shopId: string;
  readonly fact: CallConsentFact;
  readonly turnIndex: number | null;
  readonly detail: string | null;
  readonly occurredAt: Date;
}

export interface CallUsageRecord {
  readonly callId: string;
  readonly shopId: string;
  readonly telcoSeconds: number;
  readonly sttSeconds: number;
  readonly ttsSeconds: number;
  readonly llmInputTokens: number;
  readonly llmOutputTokens: number;
  readonly estimatedCostPaise: Paise;
  readonly capBreached: 'SHOP_DAILY' | 'PLATFORM_DAILY' | null;
  readonly traceId: string;
}

export interface FinishCallInput {
  readonly callId: string;
  readonly shopId: string;
  readonly status: CallStatus;
  readonly outcome: CallOutcome;
  readonly endReason: CallEndReason;
  readonly endedAt: Date;
  readonly durationSeconds: number;
  readonly turnCount: number;
  readonly handedOff: boolean;
  readonly degradedToIvr: boolean;
  readonly poorTurnCount: number;
  readonly bargeInCount: number;
  readonly maxTurnLatencyMs: number;
  readonly intent: VoiceIntent | null;
  readonly decision: CustomerDecision | null;
  readonly agentRunId: string | null;
}

/** Why a call may not be placed. Every one of these is a `BLOCKED` row. */
export type CallRefusalCode =
  | 'VOICE_DISABLED'
  | 'KILL_SWITCH'
  | 'OUTBOUND_DISABLED'
  | 'CONSENT_REVOKED'
  | 'NO_CONSENT'
  | 'NO_PHONE_NUMBER'
  | 'QUIET_HOURS'
  | 'CUSTOMER_CALL_CAP'
  | 'SHOP_CALL_CAP'
  | 'SHOP_COST_CAP'
  | 'PLATFORM_COST_CAP';

export type CallGateVerdict =
  | { readonly allowed: true; readonly warnings: readonly string[] }
  | {
      readonly allowed: false;
      readonly code: CallRefusalCode;
      readonly reason: string;
      /** True when the ladder should raise an advisor task instead. */
      readonly fallBackToAdvisor: boolean;
    };

/** One decision point offered on the keypad (phase 5.5). */
export interface DtmfOption {
  readonly digit: DtmfDigit;
  readonly action: DtmfAction;
  readonly label: string;
}

export type DtmfAction =
  | 'APPROVE'
  | 'DECLINE'
  | 'DEFER'
  | 'REPEAT'
  | 'HANDOFF'
  | 'STATUS'
  | 'BOOKING';

/** A composed script segment, before synthesis. */
export interface ScriptSegment {
  readonly key: string;
  readonly text: string;
  /**
   * Non-removable (⚿). The AI disclosure and the recording notice.
   *
   * Marked on the segment rather than recognised by its words, because the copy
   * exists in three languages and a compliance check by string comparison
   * breaks the first time somebody improves a Tamil sentence.
   */
  readonly mandatory: boolean;
}
