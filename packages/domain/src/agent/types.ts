import type {
  AdvisorTaskKind,
  AdvisorTaskStatus,
  AgentObjective,
  AgentRunOutcome,
  ApprovalStatus,
  CustomerDecision,
  EscalationRungType,
  EstimateLineKind,
  Language,
  Paise,
  ReviewAction,
  TaskUrgency,
} from '@serviceloop/shared';
import type { EvidenceRef } from '../guardrails/policies';

/**
 * The agent's vocabulary, in the domain's own terms.
 *
 * Nothing here knows about a model, a provider or a prompt. The runtime that
 * does live in `packages/agent-core`; these are the shapes it manipulates, so
 * the approval flow, the escalation ladder and the review queue can be reasoned
 * about — and tested — without a language model anywhere in the picture.
 */

/* -------------------------------------------------------------------------- *
 * Evidence and claims (L7 — evidence or silence)
 * -------------------------------------------------------------------------- */

/**
 * Canonical string form of an evidence reference: `media:…`, `line:…`,
 * `note:…`.
 *
 * The agent sees claims as strings because that is what it can emit reliably;
 * the checker resolves them back to typed refs. One function owns the mapping in
 * both directions, so a prompt example and a checker lookup cannot disagree
 * about what a source id looks like.
 */
export function sourceId(ref: EvidenceRef): string {
  switch (ref.kind) {
    case 'MEDIA':
      return `media:${ref.id}`;
    case 'ESTIMATE_LINE':
      return `line:${ref.id}`;
    case 'TECHNICIAN_NOTE':
      return `note:${ref.id}`;
    case 'JOB_CARD_STATE':
      return `state:${ref.id}`;
    case 'ETA':
      return `eta:${ref.id}`;
  }
}

export function parseSourceId(value: string): EvidenceRef | null {
  const separator = value.indexOf(':');
  if (separator <= 0) return null;
  const prefix = value.slice(0, separator);
  const id = value.slice(separator + 1).trim();
  if (id.length === 0) return null;

  switch (prefix) {
    case 'media':
      return { kind: 'MEDIA', id };
    case 'line':
      return { kind: 'ESTIMATE_LINE', id };
    case 'note':
      return { kind: 'TECHNICIAN_NOTE', id };
    case 'state':
      return { kind: 'JOB_CARD_STATE', id };
    case 'eta':
      return { kind: 'ETA', id };
    default:
      return null;
  }
}

/** One sentence of customer-facing copy, with the sources that support it. */
export interface Claim {
  readonly text: string;
  readonly sources: readonly string[];
}

/** A technician's own words, addressable as a claim source. */
export interface SourceNote {
  readonly id: string;
  readonly workItemId: string | null;
  readonly authorStaffId: string | null;
  readonly text: string;
  readonly language: Language;
  readonly capturedAt: Date;
}

export interface BundleMedia {
  readonly id: string;
  readonly kind: 'PHOTO' | 'VIDEO' | 'AUDIO' | 'DOCUMENT';
  readonly caption: string | null;
  readonly workItemId: string | null;
}

export interface BundleLine {
  readonly id: string;
  readonly workItemId: string | null;
  readonly description: string;
  /**
   * What sort of line this is.
   *
   * Phase 4 made this load-bearing twice over: the ETA engine falls back to a
   * per-kind default when a work item carries no estimate of its own, and the
   * invoice needs it to decide HSN versus SAC. Before that it was information
   * the estimate had and the bundle threw away.
   */
  readonly kind: EstimateLineKind;
  readonly quantityMilli: number;
  readonly unitPricePaise: Paise;
  readonly lineTotalPaise: Paise;
  readonly taxRateBp: number;
  /** List price from the shop's price-list KB. Null when the item is not on it. */
  readonly listPricePaise: Paise | null;
}

/**
 * The composed artifact a customer sees: media, itemised lines, and a
 * plain-language explanation whose every sentence maps to a source.
 */
export interface EvidenceBundle {
  readonly id: string;
  readonly shopId: string;
  readonly jobCardId: string;
  readonly title: string;
  readonly summaryText: string;
  readonly language: Language;
  readonly media: readonly BundleMedia[];
  readonly lines: readonly BundleLine[];
  readonly workItemIds: readonly string[];
  readonly estimateId: string | null;
  readonly claims: readonly Claim[];
  readonly sourceNotes: readonly SourceNote[];
  readonly totalPaise: Paise;
  readonly createdByRunId: string | null;
  readonly explanationModel: string | null;
  readonly explanationPromptHash: string | null;
  readonly createdAt: Date;
}

/* -------------------------------------------------------------------------- *
 * Approvals
 * -------------------------------------------------------------------------- */

export interface ApprovalSnapshot {
  readonly id: string;
  readonly shopId: string;
  readonly jobCardId: string;
  readonly customerId: string | null;
  readonly conversationId: string | null;
  readonly evidenceBundleId: string | null;
  readonly estimateId: string | null;
  readonly status: ApprovalStatus;
  readonly decision: CustomerDecision | null;
  readonly ladderRef: string;
  readonly workItemIds: readonly string[];
  readonly approvedWorkItemIds: readonly string[];
  readonly amountPaise: Paise;
  readonly approvedAmountPaise: Paise;
  readonly requestMessageId: string | null;
  readonly agentRunId: string | null;
  readonly requestedAt: Date;
  readonly deadlineAt: Date | null;
  readonly decidedAt: Date | null;
}

/**
 * A decision, as the customer expressed it.
 *
 * `scope` is the set of work items they said yes to. For a full approval that
 * is every item; for a partial one it is the subset, and the remainder is
 * ledgered as DEFERRED with reason `customer_partial` — not discarded, because
 * deferred work is revenue phase 6 re-pitches.
 */
export interface CustomerDecisionInput {
  readonly approvalId: string;
  readonly decision: CustomerDecision;
  readonly approvedWorkItemIds: readonly string[];
  /** Why, in the customer's own words where we have them. */
  readonly note: string;
  readonly decidedVia: string;
  /** For DEFERRED: when phase 6 may raise it again. */
  readonly followUpAfter?: Date;
}

/* -------------------------------------------------------------------------- *
 * Escalations
 * -------------------------------------------------------------------------- */

export interface ScheduledRung {
  readonly id: string;
  readonly shopId: string;
  readonly objective: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly ladderKey: string;
  readonly rung: number;
  readonly rungType: EscalationRungType;
  readonly label: string;
  readonly scheduledAt: Date;
  readonly queueJobId: string | null;
}

export type RungOutcome = 'SENT' | 'DEFERRED' | 'BLOCKED' | 'TASK_CREATED' | 'SKIPPED';

/* -------------------------------------------------------------------------- *
 * Advisor tasks (L6)
 * -------------------------------------------------------------------------- */

export interface AdvisorTaskInput {
  readonly shopId: string;
  readonly kind: AdvisorTaskKind;
  readonly urgency: TaskUrgency;
  readonly brief: string;
  readonly context: Readonly<Record<string, unknown>>;
  readonly jobCardId?: string | null;
  readonly conversationId?: string | null;
  readonly customerId?: string | null;
  readonly approvalRequestId?: string | null;
  readonly agentRunId?: string | null;
  /**
   * Idempotency key. A ladder rung redelivered by the queue must re-use the
   * task it already raised rather than filling an advisor's list with copies of
   * the same phone call.
   */
  readonly dedupeKey?: string | null;
  readonly dueAt?: Date | null;
}

export interface AdvisorTaskSnapshot {
  readonly id: string;
  readonly shopId: string;
  readonly kind: AdvisorTaskKind;
  readonly status: AdvisorTaskStatus;
  readonly urgency: TaskUrgency;
  readonly brief: string;
  readonly context: Readonly<Record<string, unknown>>;
  readonly jobCardId: string | null;
  readonly conversationId: string | null;
  readonly customerId: string | null;
  readonly approvalRequestId: string | null;
  readonly agentRunId: string | null;
  readonly dueAt: Date | null;
  readonly createdAt: Date;
}

/* -------------------------------------------------------------------------- *
 * Agent runs
 * -------------------------------------------------------------------------- */

export interface AgentRunRecord {
  readonly id: string;
  readonly shopId: string;
  readonly objective: AgentObjective;
  readonly conversationId: string;
  readonly jobCardId: string | null;
  readonly customerId: string | null;
  readonly approvalRequestId: string | null;
  readonly triggerMessageId: string | null;
  readonly maxSteps: number;
  readonly model: string;
  readonly promptContext: Readonly<Record<string, unknown>>;
  readonly startedAt: Date;
}

export interface AgentStepRecord {
  readonly runId: string;
  readonly shopId: string;
  readonly stepIndex: number;
  readonly promptHash: string;
  readonly model: string;
  readonly responseText: string | null;
  readonly toolCalls: readonly { readonly name: string; readonly args: unknown }[];
  readonly toolResults: readonly {
    readonly name: string;
    readonly ok: boolean;
    readonly result: unknown;
  }[];
  readonly checkerVerdicts: readonly {
    readonly checker: string;
    readonly ok: boolean;
    readonly code: string | null;
    readonly reason: string | null;
  }[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
}

export interface AgentRunFinish {
  readonly runId: string;
  readonly outcome: AgentRunOutcome;
  readonly stepCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reason: string | null;
  readonly finishedAt: Date;
}

/* -------------------------------------------------------------------------- *
 * HITL review + graduation (3.9)
 * -------------------------------------------------------------------------- */

export interface ReviewDecisionInput {
  readonly shopId: string;
  readonly messageId: string;
  readonly action: ReviewAction;
  readonly reviewerStaffId: string | null;
  /** Required for EDIT_AND_SEND; the copy that actually goes out. */
  readonly editedBody?: string;
  /** Required for REJECT. */
  readonly rejectionReason?: string;
  readonly traceId: string;
}

export interface PendingCandidate {
  readonly messageId: string;
  readonly shopId: string;
  readonly conversationId: string;
  readonly customerLabel: string;
  readonly jobCardId: string | null;
  readonly agentRunId: string | null;
  readonly body: string;
  readonly language: Language;
  readonly checkerReasons: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly createdAt: Date;
}

/**
 * The numbers an owner is shown before being asked whether to raise autonomy.
 *
 * Deliberately blunt: three rates and a sample size. A recommendation the owner
 * cannot check is a recommendation they should not act on, so every figure here
 * is one they can verify by opening the review queue.
 */
export interface GraduationReport {
  readonly shopId: string;
  readonly flow: string;
  readonly runs: number;
  readonly approvedWithoutEdit: number;
  readonly approvedWithEdit: number;
  readonly rejected: number;
  readonly checkerBlocks: number;
  readonly approvedWithoutEditRate: number;
  readonly checkerBlockRate: number;
  readonly medianReviewWaitMs: number;
  readonly currentLevel: string;
  readonly recommendedLevel: string | null;
  readonly rationale: string;
}
