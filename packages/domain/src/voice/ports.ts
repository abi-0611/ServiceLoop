import type { CallStatus, Paise } from '@serviceloop/shared';
import type {
  BlockedCallInput,
  CallConsentEventRecord,
  CallRecord,
  CallTurnRecord,
  CallUsageRecord,
  FinishCallInput,
  OpenCallInput,
} from './types';

/**
 * Persistence ports for the voice layer (phase 5).
 *
 * The same doctrine as every other port here: the domain owns the rules and
 * `packages/db` owns the SQL, with `Tx` opaque on both sides. Two behaviours
 * are specified rather than left to an implementation's taste, because the
 * runtime above depends on them:
 *
 *   - **Idempotent writes return null, they do not throw.** A redelivered
 *     provider callback that tries to open a call which already exists gets
 *     `null` and carries on. "Already happened" is a value the caller handles,
 *     not an exception it has to classify by message.
 *   - **A turn is append-only.** `(callId, turnIndex)` is unique, so a retried
 *     write cannot duplicate a sentence in a transcript that an auditor will
 *     later read as the record of what the customer was told.
 */

export interface CallStore<Tx> {
  /** Returns null when a call with this provider sid is already recorded. */
  open(tx: Tx, input: OpenCallInput): Promise<string | null>;
  /** A call that was refused before dialling. Always written, never skipped. */
  recordBlocked(tx: Tx, input: BlockedCallInput): Promise<string>;
  load(tx: Tx, shopId: string, callId: string): Promise<CallRecord | null>;
  findByProviderSid(tx: Tx, shopId: string, sid: string): Promise<CallRecord | null>;
  setStatus(
    tx: Tx,
    shopId: string,
    callId: string,
    status: CallStatus,
    at: Date,
    providerCallSid?: string | null,
  ): Promise<void>;
  markAnswered(tx: Tx, shopId: string, callId: string, at: Date): Promise<void>;
  finish(tx: Tx, input: FinishCallInput): Promise<void>;
  attachRecording(
    tx: Tx,
    shopId: string,
    callId: string,
    mediaId: string,
    retentionUntil: Date,
  ): Promise<void>;
  recordBridge(
    tx: Tx,
    input: {
      readonly shopId: string;
      readonly callId: string;
      readonly advisorStaffId: string | null;
      readonly whisperText: string;
      readonly at: Date;
    },
  ): Promise<void>;
  attachAdvisorTask(tx: Tx, shopId: string, callId: string, taskId: string): Promise<void>;
  attachAgentRun(tx: Tx, shopId: string, callId: string, agentRunId: string): Promise<void>;

  /** How many calls this customer has taken from this shop since `since`. */
  countForCustomerSince(
    tx: Tx,
    shopId: string,
    customerId: string,
    since: Date,
  ): Promise<number>;
  /** Originations by this shop since `since`, blocked ones excluded. */
  countForShopSince(tx: Tx, shopId: string, since: Date): Promise<number>;
  /**
   * Calls already placed for one ladder rung. The retry counter.
   *
   * Counted from the call rows rather than held on the escalation, because a
   * deferred rung keeps its id and its row: "we rang once and nobody answered"
   * is a fact about a telephone call, and the place it is written down is the
   * call. A counter on the rung would be a second copy of it, and the two would
   * disagree the first time a process died between them.
   */
  countForEscalation(tx: Tx, shopId: string, escalationId: string): Promise<number>;
  /** Calls whose retention window has closed. Phase 7 drains this. */
  findExpiredRetention(tx: Tx, before: Date, limit: number): Promise<readonly CallRecord[]>;
}

export interface CallTurnStore<Tx> {
  /** Null when `(callId, turnIndex)` already exists — a retried write. */
  append(tx: Tx, turn: CallTurnRecord): Promise<string | null>;
  load(tx: Tx, shopId: string, callId: string): Promise<readonly CallTurnRecord[]>;
}

export interface CallConsentStore<Tx> {
  /** Null when this fact is already recorded for the call. */
  record(tx: Tx, event: CallConsentEventRecord): Promise<string | null>;
  load(tx: Tx, shopId: string, callId: string): Promise<readonly CallConsentEventRecord[]>;
}

export interface CallUsageStore<Tx> {
  /** One row per call. Null on a redelivered `call.ended`, never a second bill. */
  record(tx: Tx, usage: CallUsageRecord): Promise<string | null>;
  /** The shop's spend since `since`, in paise. Drives the daily cap. */
  spendSince(tx: Tx, shopId: string, since: Date): Promise<Paise>;
  /** Every shop's spend since `since`. Drives the platform cap. */
  platformSpendSince(tx: Tx, since: Date): Promise<Paise>;
  load(tx: Tx, shopId: string, callId: string): Promise<CallUsageRecord | null>;
}

/**
 * Where a call recording is stored.
 *
 * Narrower than `MediaService` on purpose: the voice layer needs to put one WAV
 * somewhere and get an id back, and handing it the whole media pipeline would
 * let a call start generating thumbnails.
 */
export interface CallRecordingWriter<Tx> {
  store(
    tx: Tx,
    input: {
      readonly shopId: string;
      readonly callId: string;
      readonly wav: Buffer;
      readonly durationMs: number;
      readonly at: Date;
    },
  ): Promise<string>;
}

/**
 * The phone number to dial, decrypted at the last possible moment.
 *
 * A separate port from `CustomerLookup` because it answers a different
 * question and carries a different risk: this one hands back a plaintext
 * number, and the set of callers allowed to ask for one should be exactly the
 * set that is about to dial it.
 */
export interface CallDestinationReader<Tx> {
  loadCustomerPhone(tx: Tx, shopId: string, customerId: string): Promise<string | null>;
  /** The advisor a warm handoff bridges to, and their number. */
  loadAdvisorPhone(
    tx: Tx,
    shopId: string,
  ): Promise<{ readonly staffId: string; readonly fullName: string; readonly phone: string } | null>;
  /** Which customer a caller id belongs to, for an inbound call. */
  findCustomerByPhone(tx: Tx, shopId: string, phone: string): Promise<string | null>;
}

/**
 * Placing a call, as the escalation ladder sees it (phase 5.4a).
 *
 * The `VOICE_OR_ADVISOR` rung has to be able to *ring somebody*, and the engine
 * that runs it lives in `packages/domain`, which may not import a telephony
 * adapter. So the rung takes a port, and `VoiceAgentRunner` in
 * `packages/agent-core` is what implements it — the same split phase 3 made
 * between `ApprovalService` and `AgentRunner`.
 *
 * A deployment that has not wired voice leaves it undefined, and the rung keeps
 * doing exactly what phase 3 made it do: raise an advisor task. That is not a
 * degraded mode to be apologised for; it is the mode every shop starts in.
 */
export interface VoiceCallPlacer {
  placeApprovalCall(input: ApprovalCallRequest): Promise<PlacedCallOutcome>;
  /** How many calls this rung has already made. Drives the single retry. */
  attemptsForEscalation(shopId: string, escalationId: string): Promise<number>;
}

export interface ApprovalCallRequest {
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

/**
 * What the ladder needs to know about a call that has ended.
 *
 * A strict subset of the runtime's own `CallReport`, so the runner satisfies
 * this without an adapter in between — and a deliberately small subset, because
 * a rung has exactly four decisions to make from it: the customer decided, ring
 * again later, a person is already holding it, or fall back to a task.
 */
export interface PlacedCallOutcome {
  readonly callId: string;
  /** False when the gate refused before a packet left. */
  readonly placed: boolean;
  /**
   * True when somebody picked up.
   *
   * Distinct from `placed`, and the distinction is the whole of the retry rule:
   * a call that rang out was placed and reached nobody, which is the one
   * outcome that earns a second attempt. Reading that off a refusal code would
   * mean the ladder parsing strings to decide whether to ring again.
   */
  readonly answered: boolean;
  readonly decision: string | null;
  readonly handedOff: boolean;
  readonly refusalCode: string | null;
  readonly refusalReason: string | null;
  /** True when a refusal should become an advisor task rather than silence. */
  readonly fallBackToAdvisor: boolean;
  /** Set when nobody answered and the shop allows one more attempt. */
  readonly retryAfterMinutes: number | null;
}
