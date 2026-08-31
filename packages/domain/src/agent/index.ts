/**
 * The agent module's domain surface (phase 3).
 *
 * Everything here is model-free: the approval flow, the escalation ladder, the
 * evidence bundle and the review queue are ordinary services over ports, which
 * is why they can be tested exhaustively without a language model and why the
 * runtime in `packages/agent-core` can be swapped without touching a rule.
 */

export {
  AdvisorTaskService,
  type AdvisorTaskDeps,
} from './advisor-tasks';

export {
  ApprovalReplyHandler,
  type ApprovalReplyDeps,
} from './approval-replies';

export {
  APPROVAL_ACTION_IDS,
  ApprovalService,
  approvalSummaryLines,
  buildApprovalMessage,
  bundleEvidenceIds,
  parseApprovalAction,
  type ApprovalAction,
  type ApprovalMessageInput,
  type ApprovalServiceDeps,
  type CreateApprovalInput,
  type CreateApprovalResult,
  type DecisionResult,
} from './approval-service';

export {
  EscalationLadderEngine,
  APPROVAL_SUBJECT_TYPE,
  channelForRung,
  rungSchedule,
  type EscalationDeps,
  type FireRungInput,
  type FireRungResult,
  type ScheduleLadderInput,
} from './escalation';

export {
  EvidenceBundleBuilder,
  verifyClaimSources,
  type BundleFailure,
  type BundleResult,
  type EvidenceAnchor,
  type EvidenceBundleDeps,
  type EvidenceSubmission,
  type ProposedLine,
} from './evidence-bundle';

export {
  buildGraduationReport,
  diffLines,
  ReviewService,
  type DiffHunk,
  type GraduationCounts,
  type ReviewOutcome,
  type ReviewServiceDeps,
} from './review';

export { parseSourceId, sourceId } from './types';

export type {
  AdvisorTaskInput,
  AdvisorTaskSnapshot,
  AgentRunFinish,
  AgentRunRecord,
  AgentStepRecord,
  ApprovalSnapshot,
  BundleLine,
  BundleMedia,
  Claim,
  CustomerDecisionInput,
  EvidenceBundle,
  GraduationReport,
  PendingCandidate,
  ReviewDecisionInput,
  RungOutcome,
  ScheduledRung,
  SourceNote,
} from './types';

export type {
  AdvisorTaskStore,
  AgentRunStore,
  ApprovalStore,
  EscalationStore,
  EvidenceBundleStore,
  ExplanationWriter,
  JobCardContext,
  JobCardContextReader,
  PriceListReader,
  ReviewStore,
  RungScheduler,
} from './ports';
