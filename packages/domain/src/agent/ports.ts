import type {
  AdvisorTaskStatus,
  AgentObjective,
  ApprovalStatus,
  CustomerDecision,
  EscalationRungType,
  Language,
  Paise,
  ReviewAction,
} from '@serviceloop/shared';
import type {
  AdvisorTaskInput,
  AdvisorTaskSnapshot,
  AgentRunFinish,
  AgentRunRecord,
  AgentStepRecord,
  ApprovalSnapshot,
  BundleLine,
  BundleMedia,
  Claim,
  EvidenceBundle,
  PendingCandidate,
  ScheduledRung,
  SourceNote,
} from './types';

/**
 * Persistence and scheduling ports for the agent (phase 3).
 *
 * Same doctrine as everywhere else: the domain owns the rules, `packages/db`
 * owns the SQL, and every port is generic over an opaque `Tx`. The one
 * non-persistence port here is `RungScheduler` — the escalation ladder needs a
 * delayed-job queue, and BullMQ is `apps/workers`' business, not the domain's.
 */

/* -------------------------------------------------------------------------- *
 * Agent runs
 * -------------------------------------------------------------------------- */

export interface AgentRunStore<Tx> {
  /**
   * Opens a run. Returns null when a run for this trigger message already
   * exists — a redelivered customer reply must not start a second agent
   * answering it.
   */
  start(tx: Tx, run: AgentRunRecord): Promise<string | null>;

  /** Persisted *before* the next step begins; that ordering is the replay guarantee. */
  appendStep(tx: Tx, step: AgentStepRecord): Promise<void>;

  finish(tx: Tx, finish: AgentRunFinish): Promise<void>;

  /** A human took the wheel mid-run (L6). Not a failure — a different ending. */
  abort(tx: Tx, runId: string, reason: string, at: Date): Promise<void>;

  loadSteps(tx: Tx, shopId: string, runId: string): Promise<readonly AgentStepRecord[]>;

  /**
   * Runs still marked RUNNING on this conversation. The runtime checks this
   * before starting, so two triggers arriving together cannot both speak.
   */
  activeRunIds(tx: Tx, shopId: string, conversationId: string): Promise<readonly string[]>;
}

/* -------------------------------------------------------------------------- *
 * Job-card context the agent reads
 * -------------------------------------------------------------------------- */

export interface JobCardContext {
  readonly jobCardId: string;
  readonly code: string;
  readonly state: string;
  readonly customerId: string;
  readonly customerName: string;
  readonly customerLanguage: Language;
  readonly vehicleLabel: string;
  readonly registration: string;
  readonly odometerKm: number | null;
  readonly promisedAt: Date | null;
  readonly complaint: string | null;
  readonly workItems: readonly {
    readonly id: string;
    readonly title: string;
    readonly state: string;
    readonly requiresApproval: boolean;
    readonly technicianNote: string | null;
    readonly estimatedMinutes: number | null;
  }[];
  readonly estimate: {
    readonly id: string;
    readonly version: number;
    readonly status: string;
    readonly totalPaise: Paise;
    readonly lines: readonly BundleLine[];
  } | null;
  readonly media: readonly BundleMedia[];
  readonly advisorName: string | null;
}

export interface JobCardContextReader<Tx> {
  load(tx: Tx, shopId: string, jobCardId: string): Promise<JobCardContext | null>;
  /** The card a thread is currently about, when there is exactly one open. */
  findActiveJobCardId(tx: Tx, shopId: string, customerId: string): Promise<string | null>;
  /** Resolves `#TN09BX4432` shorthand from the staff group to a card. */
  findByRegistration(
    tx: Tx,
    shopId: string,
    normalisedRegistration: string,
  ): Promise<string | null>;
}

/**
 * The shop's price-list knowledge document, as the tool layer needs it: a list
 * price per item, so `adjust_offer` can compute a floor. Without a list price
 * the tool refuses rather than inventing one.
 */
export interface PriceListReader<Tx> {
  listPriceFor(tx: Tx, shopId: string, estimateLineId: string): Promise<Paise | null>;
  /** Free-text summary injected into the prompt so the agent knows the menu. */
  summarise(tx: Tx, shopId: string, limit: number): Promise<string>;
}

/* -------------------------------------------------------------------------- *
 * Evidence bundles
 * -------------------------------------------------------------------------- */

export interface EvidenceBundleStore<Tx> {
  insert(
    tx: Tx,
    bundle: Omit<EvidenceBundle, 'createdAt'> & { readonly createdAt: Date },
  ): Promise<void>;
  load(tx: Tx, shopId: string, bundleId: string): Promise<EvidenceBundle | null>;
  /**
   * The newest bundle for a card — the one the agent may cite.
   *
   * An older bundle is a different conversation about a different finding, and
   * citing it would let the agent answer today's question with last week's
   * evidence.
   */
  findLatestForJobCard(
    tx: Tx,
    shopId: string,
    jobCardId: string,
  ): Promise<EvidenceBundle | null>;
  /** Technician notes and media captured against a card, newest last. */
  loadSourceNotes(tx: Tx, shopId: string, jobCardId: string): Promise<readonly SourceNote[]>;
}

/**
 * Writes the plain-language explanation.
 *
 * A port, not a direct LLM call, for the reason every other model-touching
 * capability is one: the domain states the rule — restate the notes and the
 * lines, nothing else, at the customer's reading level — and
 * `packages/agent-core` implements it over whichever adapter is live.
 */
export interface ExplanationWriter {
  write(input: {
    readonly shopId: string;
    readonly language: Language;
    readonly customerName: string;
    readonly vehicleLabel: string;
    readonly notes: readonly SourceNote[];
    readonly lines: readonly BundleLine[];
    readonly media: readonly BundleMedia[];
    readonly totalPaise: Paise;
    readonly traceId: string;
  }): Promise<{
    readonly summaryText: string;
    readonly claims: readonly Claim[];
    readonly model: string;
    readonly promptHash: string;
  }>;
}

/* -------------------------------------------------------------------------- *
 * Approvals
 * -------------------------------------------------------------------------- */

export interface ApprovalStore<Tx> {
  insert(
    tx: Tx,
    input: {
      readonly id: string;
      readonly shopId: string;
      readonly jobCardId: string;
      readonly customerId: string;
      readonly conversationId: string;
      readonly evidenceBundleId: string | null;
      readonly estimateId: string | null;
      readonly ladderRef: string;
      readonly workItemIds: readonly string[];
      readonly amountPaise: Paise;
      readonly agentRunId: string | null;
      readonly deadlineAt: Date | null;
      readonly requestedAt: Date;
    },
  ): Promise<void>;

  /** Locks the row: two button taps on one request must not both decide it. */
  lockById(tx: Tx, shopId: string, approvalId: string): Promise<ApprovalSnapshot | null>;

  /** The open request a thread's button reply belongs to. */
  findOpenByConversation(
    tx: Tx,
    shopId: string,
    conversationId: string,
  ): Promise<ApprovalSnapshot | null>;

  attachRequestMessage(tx: Tx, approvalId: string, messageId: string): Promise<void>;

  recordDecision(
    tx: Tx,
    input: {
      readonly approvalId: string;
      readonly status: ApprovalStatus;
      readonly decision: CustomerDecision;
      readonly approvedWorkItemIds: readonly string[];
      readonly approvedAmountPaise: Paise;
      readonly decisionChannel: string;
      readonly decisionNote: string;
      readonly decidedAt: Date;
    },
  ): Promise<void>;
}

/* -------------------------------------------------------------------------- *
 * Escalations
 * -------------------------------------------------------------------------- */

export interface EscalationStore<Tx> {
  /**
   * Inserts a rung, or returns null when `(subjectType, subjectId, rung)`
   * already exists. Idempotency lives in the unique index, so a redelivered
   * `approval.requested` cannot schedule a second ladder.
   */
  schedule(
    tx: Tx,
    input: {
      readonly id: string;
      readonly shopId: string;
      readonly objective: string;
      readonly subjectType: string;
      readonly subjectId: string;
      readonly ladderKey: string;
      readonly rung: number;
      readonly rungType: EscalationRungType;
      readonly channel: 'WHATSAPP' | 'SMS' | 'VOICE' | 'HUMAN';
      readonly label: string;
      readonly scheduledAt: Date;
      readonly queueJobId: string | null;
    },
  ): Promise<string | null>;

  /**
   * Records the delayed-job id for a rung that has just been enqueued.
   *
   * Separate from `schedule` because the row must exist *before* the job does:
   * if the enqueue succeeds and the insert then fails, a job fires with no rung
   * to guard it. This way the worst case is a row whose job id is null, which
   * cancellation handles — the row is the authority, and a job whose rung is
   * CANCELLED does nothing.
   */
  attachQueueJob(tx: Tx, escalationId: string, queueJobId: string): Promise<void>;

  /** Claims a rung for execution. Null when it is no longer SCHEDULED. */
  claim(tx: Tx, shopId: string, escalationId: string): Promise<ScheduledRung | null>;

  markExecuted(
    tx: Tx,
    input: {
      readonly escalationId: string;
      readonly outcome: string;
      readonly detail: string;
      readonly at: Date;
    },
  ): Promise<void>;

  markSkipped(tx: Tx, escalationId: string, reason: string, at: Date): Promise<void>;

  /** Cancels every still-scheduled rung for a subject; returns what it cancelled. */
  cancelForSubject(
    tx: Tx,
    input: {
      readonly shopId: string;
      readonly subjectType: string;
      readonly subjectId: string;
      readonly at: Date;
    },
  ): Promise<readonly ScheduledRung[]>;

  pendingForSubject(
    tx: Tx,
    shopId: string,
    subjectType: string,
    subjectId: string,
  ): Promise<readonly ScheduledRung[]>;
}

/**
 * The delayed-job side of the ladder.
 *
 * Cancellation is the load-bearing operation: the database row and the queue
 * job are cancelled in the same logical step, and the row is the authority — a
 * job that fires anyway finds its rung already CANCELLED and does nothing.
 */
export interface RungScheduler {
  enqueue(input: {
    readonly escalationId: string;
    readonly shopId: string;
    readonly subjectId: string;
    readonly runAt: Date;
  }): Promise<string | null>;

  cancel(jobId: string): Promise<void>;
}

/* -------------------------------------------------------------------------- *
 * Advisor tasks
 * -------------------------------------------------------------------------- */

export interface AdvisorTaskStore<Tx> {
  /** Returns the existing task's id when `dedupeKey` has already been used. */
  create(tx: Tx, id: string, input: AdvisorTaskInput, at: Date): Promise<string>;
  list(
    tx: Tx,
    shopId: string,
    status: AdvisorTaskStatus,
    limit: number,
  ): Promise<readonly AdvisorTaskSnapshot[]>;
  resolve(
    tx: Tx,
    input: {
      readonly shopId: string;
      readonly taskId: string;
      readonly status: AdvisorTaskStatus;
      readonly staffId: string | null;
      readonly note: string;
      readonly at: Date;
    },
  ): Promise<void>;
  /** Cancels open tasks tied to a subject once it no longer needs a human. */
  cancelForApproval(tx: Tx, shopId: string, approvalId: string, at: Date): Promise<number>;
}

/* -------------------------------------------------------------------------- *
 * HITL review + graduation
 * -------------------------------------------------------------------------- */

export interface ReviewStore<Tx> {
  pending(tx: Tx, shopId: string, limit: number): Promise<readonly PendingCandidate[]>;

  loadCandidate(tx: Tx, shopId: string, messageId: string): Promise<PendingCandidate | null>;

  /** The stored preference-training row. One per message, enforced by an index. */
  recordReview(
    tx: Tx,
    input: {
      readonly id: string;
      readonly shopId: string;
      readonly messageId: string;
      readonly conversationId: string;
      readonly agentRunId: string | null;
      readonly action: ReviewAction;
      readonly reviewerStaffId: string | null;
      readonly bodyBefore: string;
      readonly bodyAfter: string | null;
      readonly diff: readonly unknown[];
      readonly rejectionReason: string | null;
      readonly checkerReasons: readonly string[];
      readonly waitedMs: number;
      readonly at: Date;
    },
  ): Promise<void>;

  /** Applies an advisor's edit to the stored candidate before it is released. */
  updateBody(tx: Tx, shopId: string, messageId: string, body: string): Promise<void>;

  markRejected(
    tx: Tx,
    input: {
      readonly shopId: string;
      readonly messageId: string;
      readonly reason: string;
      readonly at: Date;
    },
  ): Promise<void>;

  /** Raw counts the graduation report is computed from. */
  graduationCounts(
    tx: Tx,
    input: { readonly shopId: string; readonly objective: AgentObjective; readonly limit: number },
  ): Promise<{
    readonly approvedWithoutEdit: number;
    readonly approvedWithEdit: number;
    readonly rejected: number;
    readonly checkerBlocks: number;
    readonly runs: number;
    readonly waitTimesMs: readonly number[];
  }>;
}
