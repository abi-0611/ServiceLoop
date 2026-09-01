import { z } from 'zod';

/**
 * Single source of truth for every enumerated value in the system.
 *
 * Each enum is declared once as a readonly tuple, then projected into:
 *   - a zod schema (validation at every boundary), and
 *   - a Postgres enum (`packages/db/src/schema/enums.ts` consumes the tuples).
 *
 * TS types and DB types therefore cannot drift.
 */

function enumOf<const T extends readonly [string, ...string[]]>(values: T) {
  return { values, schema: z.enum(values) } as const;
}

export const STAFF_ROLES = ['OWNER', 'ADVISOR', 'TECHNICIAN'] as const;
export const StaffRoleSchema = enumOf(STAFF_ROLES).schema;
export type StaffRole = z.infer<typeof StaffRoleSchema>;

export const LANGUAGES = ['en', 'ta', 'hi'] as const;
export const LanguageSchema = enumOf(LANGUAGES).schema;
export type Language = z.infer<typeof LanguageSchema>;

export const JOB_CARD_STATES = [
  'DRAFT',
  'OPEN',
  'IN_DIAGNOSIS',
  'AWAITING_APPROVAL',
  'IN_PROGRESS',
  'AWAITING_PARTS',
  'QUALITY_CHECK',
  'READY_FOR_DELIVERY',
  'AWAITING_PAYMENT',
  'DELIVERED',
  'CLOSED',
  'CANCELLED',
] as const;
export const JobCardStateSchema = enumOf(JOB_CARD_STATES).schema;
export type JobCardState = z.infer<typeof JobCardStateSchema>;

export const JOB_CARD_EVENTS = [
  'OPEN_CARD',
  'BEGIN_DIAGNOSIS',
  'REQUEST_APPROVAL',
  'APPROVAL_GRANTED',
  'PARTS_AWAITED',
  'PARTS_RECEIVED',
  'WORK_COMPLETED',
  'QUALITY_PASSED',
  'PAYMENT_REQUESTED',
  'PAYMENT_SETTLED',
  'VEHICLE_DELIVERED',
  'CLOSE',
  'CANCEL',
] as const;
export const JobCardEventSchema = enumOf(JOB_CARD_EVENTS).schema;
export type JobCardEvent = z.infer<typeof JobCardEventSchema>;

export const WORK_ITEM_STATES = [
  'PROPOSED',
  'PENDING_APPROVAL',
  'APPROVED',
  'DECLINED',
  'DEFERRED',
  'IN_PROGRESS',
  'DONE',
] as const;
export const WorkItemStateSchema = enumOf(WORK_ITEM_STATES).schema;
export type WorkItemState = z.infer<typeof WorkItemStateSchema>;

export const WORK_ITEM_EVENTS = [
  'SUBMIT_FOR_APPROVAL',
  'APPROVE',
  'DECLINE',
  'DEFER',
  'START',
  'COMPLETE',
] as const;
export const WorkItemEventSchema = enumOf(WORK_ITEM_EVENTS).schema;
export type WorkItemEvent = z.infer<typeof WorkItemEventSchema>;

export const ESTIMATE_STATUSES = ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'SUPERSEDED'] as const;
export const EstimateStatusSchema = enumOf(ESTIMATE_STATUSES).schema;
export type EstimateStatus = z.infer<typeof EstimateStatusSchema>;

export const ESTIMATE_LINE_KINDS = ['LABOUR', 'PART', 'CONSUMABLE', 'FEE'] as const;
export const EstimateLineKindSchema = enumOf(ESTIMATE_LINE_KINDS).schema;
export type EstimateLineKind = z.infer<typeof EstimateLineKindSchema>;

export const APPROVAL_STATUSES = [
  'PENDING',
  'APPROVED',
  'PARTIAL',
  'DECLINED',
  'EXPIRED',
  'CANCELLED',
] as const;
export const ApprovalStatusSchema = enumOf(APPROVAL_STATUSES).schema;
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const CHANNEL_TYPES = ['WHATSAPP', 'SMS', 'VOICE', 'CONSOLE'] as const;
export const ChannelTypeSchema = enumOf(CHANNEL_TYPES).schema;
export type ChannelType = z.infer<typeof ChannelTypeSchema>;

export const MESSAGE_DIRECTIONS = ['INBOUND', 'OUTBOUND'] as const;
export const MessageDirectionSchema = enumOf(MESSAGE_DIRECTIONS).schema;
export type MessageDirection = z.infer<typeof MessageDirectionSchema>;

export const MESSAGE_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'QUEUED',
  'SENT',
  'DELIVERED',
  'READ',
  'FAILED',
  'BLOCKED',
] as const;
export const MessageStatusSchema = enumOf(MESSAGE_STATUSES).schema;
export type MessageStatus = z.infer<typeof MessageStatusSchema>;

export const CONSENT_PURPOSES = ['SERVICE', 'MARKETING'] as const;
export const ConsentPurposeSchema = enumOf(CONSENT_PURPOSES).schema;
export type ConsentPurpose = z.infer<typeof ConsentPurposeSchema>;

export const CONSENT_STATUSES = ['PENDING', 'GRANTED', 'REVOKED'] as const;
export const ConsentStatusSchema = enumOf(CONSENT_STATUSES).schema;
export type ConsentStatus = z.infer<typeof ConsentStatusSchema>;

export const MEDIA_KINDS = ['PHOTO', 'VIDEO', 'AUDIO', 'DOCUMENT'] as const;
export const MediaKindSchema = enumOf(MEDIA_KINDS).schema;
export type MediaKind = z.infer<typeof MediaKindSchema>;

/** Where a media asset entered the system — matters for DPDP provenance. */
export const MEDIA_ORIGINS = [
  'INBOUND_WHATSAPP',
  'CONSOLE_UPLOAD',
  'GENERATED',
  'SEED',
] as const;
export const MediaOriginSchema = enumOf(MEDIA_ORIGINS).schema;
export type MediaOrigin = z.infer<typeof MediaOriginSchema>;

export const CONVERSATION_STATES = ['OPEN', 'SNOOZED', 'CLOSED'] as const;
export const ConversationStateSchema = enumOf(CONVERSATION_STATES).schema;
export type ConversationState = z.infer<typeof ConversationStateSchema>;

/**
 * What kind of line a thread is (phase 2.3). The router classifies every
 * inbound message into exactly one of these before anything else happens:
 * a customer thread, the shop's staff group (the technician evidence channel),
 * or a number nobody recognises yet.
 */
export const CONVERSATION_KINDS = ['CUSTOMER', 'STAFF_GROUP', 'UNKNOWN'] as const;
export const ConversationKindSchema = enumOf(CONVERSATION_KINDS).schema;
export type ConversationKind = z.infer<typeof ConversationKindSchema>;

/** Normalised inbound/outbound message shapes shared by every channel. */
export const MESSAGE_KINDS = [
  'TEXT',
  'IMAGE',
  'AUDIO',
  'VIDEO',
  'DOCUMENT',
  'STICKER',
  'LOCATION',
  'CONTACTS',
  'BUTTON_REPLY',
  'LIST_REPLY',
  'REACTION',
  'TEMPLATE',
  'INTERACTIVE',
  'SYSTEM',
  'UNSUPPORTED',
] as const;
export const MessageKindSchema = enumOf(MESSAGE_KINDS).schema;
export type MessageKind = z.infer<typeof MessageKindSchema>;

/**
 * WhatsApp conversation pricing categories. Recorded on every send so phase 7
 * can do the billing math; ServiceLoop itself never chooses MARKETING without
 * a MARKETING consent grant.
 */
export const CONVERSATION_CATEGORIES = [
  'SERVICE',
  'UTILITY',
  'MARKETING',
  'AUTHENTICATION',
] as const;
export const ConversationCategorySchema = enumOf(CONVERSATION_CATEGORIES).schema;
export type ConversationCategory = z.infer<typeof ConversationCategorySchema>;

/** Meta template categories (the AUTHENTICATION/UTILITY/MARKETING triad). */
export const WA_TEMPLATE_CATEGORIES = ['UTILITY', 'MARKETING', 'AUTHENTICATION'] as const;
export const WaTemplateCategorySchema = enumOf(WA_TEMPLATE_CATEGORIES).schema;
export type WaTemplateCategory = z.infer<typeof WaTemplateCategorySchema>;

export const WA_TEMPLATE_STATUSES = [
  /**
   * In the manifest, never sent to Meta by this shop (phase 7.3).
   *
   * The only state a template-ops screen is really for. Without it the screen
   * can show what has been submitted and cannot show what has not — and during
   * onboarding, "what still needs submitting" is the entire question.
   */
  'NOT_SUBMITTED',
  'PENDING',
  'APPROVED',
  'REJECTED',
  'PAUSED',
  'DISABLED',
] as const;
export const WaTemplateStatusSchema = enumOf(WA_TEMPLATE_STATUSES).schema;
export type WaTemplateStatus = z.infer<typeof WaTemplateStatusSchema>;

/** L2 — the three on-ramps a job card may enter through, plus the console form. */
export const INTAKE_SOURCES = ['PHOTO', 'FORWARDED_TEXT', 'VOICE_NOTE', 'CONSOLE_FORM'] as const;
export const IntakeSourceSchema = enumOf(INTAKE_SOURCES).schema;
export type IntakeSource = z.infer<typeof IntakeSourceSchema>;

export const INTAKE_DRAFT_STATUSES = [
  'AWAITING_CONFIRMATION',
  'CONFIRMED',
  'DISCARDED',
  'SUPERSEDED',
  'FAILED',
] as const;
export const IntakeDraftStatusSchema = enumOf(INTAKE_DRAFT_STATUSES).schema;
export type IntakeDraftStatus = z.infer<typeof IntakeDraftStatusSchema>;

/** Ambiguous entity matches queue a suggestion; ServiceLoop never merges blind. */
export const MERGE_SUGGESTION_KINDS = ['CUSTOMER', 'VEHICLE'] as const;
export const MergeSuggestionKindSchema = enumOf(MERGE_SUGGESTION_KINDS).schema;
export type MergeSuggestionKind = z.infer<typeof MergeSuggestionKindSchema>;

export const MERGE_SUGGESTION_STATUSES = ['OPEN', 'MERGED', 'REJECTED'] as const;
export const MergeSuggestionStatusSchema = enumOf(MERGE_SUGGESTION_STATUSES).schema;
export type MergeSuggestionStatus = z.infer<typeof MergeSuggestionStatusSchema>;

/** How a consent decision reached us — a regulator asks exactly this. */
export const CONSENT_SOURCES = [
  'INTERACTIVE_REPLY',
  'KEYWORD',
  'COUNTER_HANDOVER',
  'CONSOLE',
  'SEED',
] as const;
export const ConsentSourceSchema = enumOf(CONSENT_SOURCES).schema;
export type ConsentSource = z.infer<typeof ConsentSourceSchema>;

export const DECLINE_KINDS = ['DECLINED', 'DEFERRED'] as const;
export const DeclineKindSchema = enumOf(DECLINE_KINDS).schema;
export type DeclineKind = z.infer<typeof DeclineKindSchema>;

/**
 * The declined-work ledger lifecycle (phase 6.1).
 *
 * `open → repitched(n) → converted | expired | opted_out`, plus `CLOSED` for the
 * item that ended for a reason none of those describe — the vehicle was sold,
 * the card was cancelled, an advisor struck it off.
 *
 * `OPTED_OUT` and `EXPIRED` are separate terminal states rather than one
 * `CLOSED`, because they mean opposite things to the shop: an expired item is
 * revenue that went cold and may be pitched again on a future visit, and an
 * opted-out one is a customer who said "not interested" and must never hear
 * about that item again. Collapsing them is how a permanent refusal becomes a
 * temporary one.
 */
export const LEDGER_STATUSES = [
  'OPEN',
  'RE_PITCHED',
  'CONVERTED',
  'EXPIRED',
  'OPTED_OUT',
  'CLOSED',
] as const;
export const LedgerStatusSchema = enumOf(LEDGER_STATUSES).schema;
export type LedgerStatus = z.infer<typeof LedgerStatusSchema>;

/**
 * *Why* the customer said no (phase 6.1).
 *
 * Distinct from `DECLINE_KINDS`, which records what the work item's state
 * became. This records the sentence behind it, because the four reasons need
 * four different follow-ups: a deferral is a timing problem the horizon solves,
 * a price objection needs the owner, and distrust needs evidence rather than
 * another quote. `other` exists so a technician is never forced to mislabel one.
 */
export const DECLINE_REASONS = [
  'customer_deferred',
  'customer_partial',
  'price',
  'distrust',
  'other',
] as const;
export const DeclineReasonSchema = enumOf(DECLINE_REASONS).schema;
export type DeclineReason = z.infer<typeof DeclineReasonSchema>;

/** The customer-facing objectives that own an escalation ladder (L3). */
export const OBJECTIVES = [
  'APPROVAL',
  'STATUS',
  'DELIVERY',
  'PAYMENT',
  'RETENTION',
  'FEEDBACK',
] as const;
export const ObjectiveSchema = enumOf(OBJECTIVES).schema;
export type Objective = z.infer<typeof ObjectiveSchema>;

export const ESCALATION_CHANNELS = ['WHATSAPP', 'SMS', 'VOICE', 'HUMAN'] as const;
export const EscalationChannelSchema = enumOf(ESCALATION_CHANNELS).schema;
export type EscalationChannel = z.infer<typeof EscalationChannelSchema>;

export const ESCALATION_STATUSES = ['SCHEDULED', 'EXECUTED', 'CANCELLED', 'SKIPPED'] as const;
export const EscalationStatusSchema = enumOf(ESCALATION_STATUSES).schema;
export type EscalationStatus = z.infer<typeof EscalationStatusSchema>;

export const AUDIT_ACTOR_TYPES = ['STAFF', 'CUSTOMER', 'AGENT', 'SYSTEM'] as const;
export const AuditActorTypeSchema = enumOf(AUDIT_ACTOR_TYPES).schema;
export type AuditActorType = z.infer<typeof AuditActorTypeSchema>;

export const OUTBOX_STATUSES = ['PENDING', 'DISPATCHED', 'FAILED'] as const;
export const OutboxStatusSchema = enumOf(OUTBOX_STATUSES).schema;
export type OutboxStatus = z.infer<typeof OutboxStatusSchema>;

/** L2: a photographed paper job card is a first-class intake source, forever. */
export const JOB_CARD_SOURCES = ['PAPER_CARD', 'WHATSAPP', 'WALK_IN', 'PHONE', 'CONSOLE'] as const;
export const JobCardSourceSchema = enumOf(JOB_CARD_SOURCES).schema;
export type JobCardSource = z.infer<typeof JobCardSourceSchema>;

/** Autonomy ladder (master §6). Every flow starts at L0 for a new shop. */
export const AUTONOMY_LEVELS = [
  'L0_SHADOW',
  'L1_TEMPLATED',
  'L2_CONVERSATIONAL',
  'L3_VOICE',
] as const;
export const AutonomyLevelSchema = enumOf(AUTONOMY_LEVELS).schema;
export type AutonomyLevel = z.infer<typeof AutonomyLevelSchema>;

export const AUTONOMY_FLOWS = ['approval', 'status', 'delivery', 'retention', 'voice'] as const;
export const AutonomyFlowSchema = enumOf(AUTONOMY_FLOWS).schema;
export type AutonomyFlow = z.infer<typeof AutonomyFlowSchema>;

/* -------------------------------------------------------------------------- *
 * Phase 3 — agent runtime, approval autopilot, escalation ladders
 * -------------------------------------------------------------------------- */

/**
 * What *kind* of work an LLM call is doing (phase 3.1).
 *
 * A task class, not a model: `LLM_<CLASS>_MODEL` in env maps each one to an id,
 * so a shop can run a cheap classifier and an expensive agent without a single
 * model string appearing in code (master §10).
 */
export const LLM_TASK_CLASSES = ['AGENT', 'CLASSIFY', 'EXTRACT', 'JUDGE'] as const;
export const LlmTaskClassSchema = enumOf(LLM_TASK_CLASSES).schema;
export type LlmTaskClass = z.infer<typeof LlmTaskClassSchema>;

/**
 * The objectives an agent run may pursue. An objective is a *goal with a
 * termination condition*, not a prompt: the runtime decides it is met by
 * observing tool results, never by the model saying so.
 */
export const AGENT_OBJECTIVES = [
  'request_approval',
  'resolve_partial_approval',
  'explain_evidence',
  /**
   * Phase 4.5 — inbound "where's my car?" deflection. Strictly grounded in live
   * card state, ETA history and the estimate; anything outside that routes
   * elsewhere rather than being improvised.
   */
  'answer_status',
  /**
   * Phase 6.3 — re-pitching work the customer already declined once.
   *
   * Its own objective rather than a flavour of `request_approval`, because the
   * two are constrained differently: a re-pitch may only restate evidence that
   * already exists from the original visit and may only quote the price that
   * was already quoted. It is the one objective whose whole job is *not* to
   * find something new to say.
   */
  'repitch_declined_item',
] as const;
export const AgentObjectiveSchema = enumOf(AGENT_OBJECTIVES).schema;
export type AgentObjective = z.infer<typeof AgentObjectiveSchema>;

/** The terminal report of a run (phase 3.2). Every run ends in exactly one. */
export const AGENT_RUN_OUTCOMES = [
  'objective_met',
  'handoff',
  'blocked',
  'budget_exhausted',
] as const;
export const AgentRunOutcomeSchema = enumOf(AGENT_RUN_OUTCOMES).schema;
export type AgentRunOutcome = z.infer<typeof AgentRunOutcomeSchema>;

/**
 * `ABORTED` is its own status rather than an outcome: a run that a human
 * interrupted mid-step did not *decide* anything, and recording it as `blocked`
 * would poison the graduation report with a failure the agent never caused.
 */
export const AGENT_RUN_STATUSES = ['RUNNING', 'FINISHED', 'ABORTED', 'FAILED'] as const;
export const AgentRunStatusSchema = enumOf(AGENT_RUN_STATUSES).schema;
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;

/**
 * What the customer decided about an approval request.
 *
 * `PARTIAL` is first-class, not a degraded `FULL`: approving two of five lines
 * is the single most common real outcome, and the three that were not approved
 * are revenue the ledger re-pitches later.
 */
export const CUSTOMER_DECISIONS = ['FULL', 'PARTIAL', 'DEFERRED', 'DECLINED'] as const;
export const CustomerDecisionSchema = enumOf(CUSTOMER_DECISIONS).schema;
export type CustomerDecision = z.infer<typeof CustomerDecisionSchema>;

/**
 * What a ladder rung *is*, as opposed to which channel it happened to use.
 *
 * `VOICE_OR_ADVISOR` is the load-bearing one: until phase 5 it creates a
 * prioritised advisor task with the agent's brief, and after phase 5 it places
 * the call. Shops configure the rung type, so the swap changes an
 * implementation, never a shop's configuration.
 */
export const ESCALATION_RUNG_TYPES = [
  'WHATSAPP',
  'SMS',
  'VOICE_OR_ADVISOR',
  'OWNER_DIGEST',
  'HUMAN',
] as const;
export const EscalationRungTypeSchema = enumOf(ESCALATION_RUNG_TYPES).schema;
export type EscalationRungType = z.infer<typeof EscalationRungTypeSchema>;

/** Work queued for a person (L6 — human handoff is always one step away). */
export const ADVISOR_TASK_KINDS = [
  'CALL_CUSTOMER',
  'REVIEW_MESSAGE',
  'HANDOFF',
  'OWNER_EXCEPTION',
  'FOLLOW_UP',
] as const;
export const AdvisorTaskKindSchema = enumOf(ADVISOR_TASK_KINDS).schema;
export type AdvisorTaskKind = z.infer<typeof AdvisorTaskKindSchema>;

export const ADVISOR_TASK_STATUSES = ['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED'] as const;
export const AdvisorTaskStatusSchema = enumOf(ADVISOR_TASK_STATUSES).schema;
export type AdvisorTaskStatus = z.infer<typeof AdvisorTaskStatusSchema>;

export const TASK_URGENCIES = ['LOW', 'NORMAL', 'HIGH'] as const;
export const TaskUrgencySchema = enumOf(TASK_URGENCIES).schema;
export type TaskUrgency = z.infer<typeof TaskUrgencySchema>;

/** What an advisor did with a candidate message in the review queue (3.9). */
export const REVIEW_ACTIONS = ['APPROVE_SEND', 'EDIT_AND_SEND', 'REJECT'] as const;
export const ReviewActionSchema = enumOf(REVIEW_ACTIONS).schema;
export type ReviewAction = z.infer<typeof ReviewActionSchema>;

/* -------------------------------------------------------------------------- *
 * Phase 4 — status sentinel, delivery & payments
 * -------------------------------------------------------------------------- */

/**
 * What a technician's five-second voice note actually said (phase 4.2).
 *
 * Four kinds, because those are the four things that change what anyone else
 * needs to do: work moved on, work is stuck, work is finished, or something new
 * was found. The fourth is deliberately *not* a status — `issue_found` routes
 * into the phase-3 evidence-bundle flow, because new work needs a customer's
 * money and therefore their consent, not a state transition.
 */
export const STATUS_SIGNAL_TYPES = ['progress', 'blocked_parts', 'done', 'issue_found'] as const;
export const StatusSignalTypeSchema = enumOf(STATUS_SIGNAL_TYPES).schema;
export type StatusSignalType = z.infer<typeof StatusSignalTypeSchema>;

/** How the signal reached us. The bar for a technician is a voice note (L2). */
export const STATUS_SIGNAL_SOURCES = ['VOICE_NOTE', 'PHOTO', 'TEXT', 'CONSOLE'] as const;
export const StatusSignalSourceSchema = enumOf(STATUS_SIGNAL_SOURCES).schema;
export type StatusSignalSource = z.infer<typeof StatusSignalSourceSchema>;

/**
 * What the router did with a parsed signal.
 *
 * `AMBIGUOUS` is its own outcome rather than a flavour of `PENDING_CONFIRMATION`
 * because the two ask a human different questions: one asks "did Suresh mean
 * this?", the other asks "which of these two cards?". Recording which was asked
 * is what lets the parser's accuracy be measured later.
 */
export const STATUS_SIGNAL_ROUTES = [
  'AUTO_APPLIED',
  'PENDING_CONFIRMATION',
  'AMBIGUOUS',
  'ROUTED_TO_EVIDENCE',
  'NO_CARD_MATCH',
  'CONFIRMED',
  'CORRECTED',
  'DISCARDED',
] as const;
export const StatusSignalRouteSchema = enumOf(STATUS_SIGNAL_ROUTES).schema;
export type StatusSignalRoute = z.infer<typeof StatusSignalRouteSchema>;

/**
 * Why an ETA moved (phase 4.3).
 *
 * Every ETA message states its reason ("the brake caliper part arrives by 4pm"),
 * so the reason is a stored enum rather than prose: the copy is generated from
 * it in the customer's language, and the same reason produces the same sentence
 * in every language the shop runs.
 */
export const ETA_REASONS = [
  'INTAKE_PROMISE',
  'WORK_APPROVED',
  'WORK_DECLINED',
  'BLOCKED_PARTS',
  'PARTS_RECEIVED',
  'TECHNICIAN_HINT',
  'WORK_DONE',
  'QUALITY_PASSED',
  'ADVISOR_OVERRIDE',
] as const;
export const EtaReasonSchema = enumOf(ETA_REASONS).schema;
export type EtaReason = z.infer<typeof EtaReasonSchema>;

/**
 * Whether an ETA change is worth interrupting a customer for.
 *
 * A slip past the threshold is bad news and goes out immediately (the
 * bad-news-early rule). A gain is good news and rides the next touchpoint —
 * telling someone their car is ready *earlier* is pleasant, but it is not worth
 * a notification at 20:55. Everything else batches.
 */
export const ETA_MATERIALITIES = ['MATERIAL_SLIP', 'MATERIAL_GAIN', 'IMMATERIAL'] as const;
export const EtaMaterialitySchema = enumOf(ETA_MATERIALITIES).schema;
export type EtaMateriality = z.infer<typeof EtaMaterialitySchema>;

/** Lifecycle of a payment link (phase 4.9). Mirrors what a provider reports. */
export const PAYMENT_STATUSES = [
  'PENDING',
  'PARTIALLY_PAID',
  'PAID',
  'FAILED',
  'EXPIRED',
  'CANCELLED',
] as const;
export const PaymentStatusSchema = enumOf(PAYMENT_STATUSES).schema;
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;

/** A single fact a provider told us about a payment. Append-only. */
export const PAYMENT_EVENT_KINDS = [
  'LINK_CREATED',
  'PAID',
  'PARTIALLY_PAID',
  'FAILED',
  'EXPIRED',
  'CANCELLED',
  'MANUAL_RECORD',
] as const;
export const PaymentEventKindSchema = enumOf(PAYMENT_EVENT_KINDS).schema;
export type PaymentEventKind = z.infer<typeof PaymentEventKindSchema>;

/** How the money arrived. `CASH` exists because most of these shops take it. */
export const PAYMENT_METHODS = [
  'UPI',
  'CARD',
  'NETBANKING',
  'WALLET',
  'CASH',
  'BANK_TRANSFER',
  'OTHER',
] as const;
export const PaymentMethodSchema = enumOf(PAYMENT_METHODS).schema;
export type PaymentMethod = z.infer<typeof PaymentMethodSchema>;

export const INVOICE_STATUSES = ['DRAFT', 'ISSUED', 'PAID', 'CANCELLED'] as const;
export const InvoiceStatusSchema = enumOf(INVOICE_STATUSES).schema;
export type InvoiceStatus = z.infer<typeof InvoiceStatusSchema>;

/** A pickup slot the customer was offered, and what became of it (phase 4.7). */
export const DELIVERY_BOOKING_STATUSES = [
  'OFFERED',
  'CHOSEN',
  'REMINDED',
  'COMPLETED',
  'MISSED',
  'CANCELLED',
] as const;
export const DeliveryBookingStatusSchema = enumOf(DELIVERY_BOOKING_STATUSES).schema;
export type DeliveryBookingStatus = z.infer<typeof DeliveryBookingStatusSchema>;

export const GATE_PASS_STATUSES = ['ISSUED', 'USED', 'EXPIRED', 'REVOKED'] as const;
export const GatePassStatusSchema = enumOf(GATE_PASS_STATUSES).schema;
export type GatePassStatus = z.infer<typeof GatePassStatusSchema>;

/**
 * What the gate person's screen shows (phase 4.10).
 *
 * Only `VALID` is green. Everything else is red and says which red it is — a
 * gate person who is told "invalid" learns nothing, and one who is told "this
 * pass expired at 18:00 yesterday" knows to call the advisor.
 */
export const GATE_PASS_VERIFY_RESULTS = [
  'VALID',
  'EXPIRED',
  'ALREADY_USED',
  'REVOKED',
  'FORGED',
  'UNKNOWN',
] as const;
export const GatePassVerifyResultSchema = enumOf(GATE_PASS_VERIFY_RESULTS).schema;
export type GatePassVerifyResult = z.infer<typeof GatePassVerifyResultSchema>;

/* -------------------------------------------------------------------------- *
 * Phase 5 — voice layer
 * -------------------------------------------------------------------------- */

/**
 * Who placed the call.
 *
 * `OUTBOUND` is the approval rung dialling a customer; `INBOUND` is the shop's
 * published line ringing. The distinction is not cosmetic: an outbound call is
 * a business initiation and passes the consent gate before a single packet
 * leaves, while an inbound call is a customer who chose to ring and needs no
 * permission to be answered.
 */
export const CALL_DIRECTIONS = ['OUTBOUND', 'INBOUND'] as const;
export const CallDirectionSchema = enumOf(CALL_DIRECTIONS).schema;
export type CallDirection = z.infer<typeof CallDirectionSchema>;

/**
 * The call's lifecycle, as the telephony port reports it.
 *
 * `BLOCKED` is a call that was never placed — revoked consent, a cost cap, or
 * the kill switch. It is a status rather than an absence because a rung that
 * decided not to dial is a fact the ladder and the audit trail both need.
 */
export const CALL_STATUSES = [
  'BLOCKED',
  'ORIGINATING',
  'RINGING',
  'IN_PROGRESS',
  'BRIDGING',
  'COMPLETED',
  'FAILED',
] as const;
export const CallStatusSchema = enumOf(CALL_STATUSES).schema;
export type CallStatus = z.infer<typeof CallStatusSchema>;

/**
 * How the call ended, in terms of what it achieved.
 *
 * Phase 6 aggregates these into containment and handoff rates, so they name
 * *outcomes* rather than hang-up causes: `DECISION_RECORDED` and
 * `ANSWERED_FROM_STATE` are the two ways a call closed a loop, `BRIDGED` is the
 * one that reached a person on purpose, and `NO_ANSWER` is the one the retry
 * schedule exists for.
 */
export const CALL_OUTCOMES = [
  'DECISION_RECORDED',
  'ANSWERED_FROM_STATE',
  'BOOKING_DRAFTED',
  'BRIDGED',
  'ADVISOR_TASK_RAISED',
  'NO_ANSWER',
  'BUSY',
  'CUSTOMER_HUNG_UP',
  'PIPELINE_FAILURE',
  'BUDGET_EXHAUSTED',
  'NOT_PLACED',
] as const;
export const CallOutcomeSchema = enumOf(CALL_OUTCOMES).schema;
export type CallOutcome = z.infer<typeof CallOutcomeSchema>;

/** Who spoke a turn. `SYSTEM` covers non-removable script segments and fillers. */
export const CALL_TURN_ROLES = ['AGENT', 'CALLER', 'SYSTEM', 'ADVISOR'] as const;
export const CallTurnRoleSchema = enumOf(CALL_TURN_ROLES).schema;
export type CallTurnRole = z.infer<typeof CallTurnRoleSchema>;

/**
 * What an inbound caller wanted (phase 5.4b).
 *
 * `OTHER` is deliberately a first-class answer rather than a wastebasket: it is
 * the classification that routes to a person, and a line that never says "I do
 * not know what you want" is a line that guesses.
 */
export const VOICE_INTENTS = ['STATUS', 'APPROVAL_RESPONSE', 'BOOKING', 'OTHER'] as const;
export const VoiceIntentSchema = enumOf(VOICE_INTENTS).schema;
export type VoiceIntent = z.infer<typeof VoiceIntentSchema>;

/**
 * Why the call script stopped talking.
 *
 * Every one of these has a defined closing behaviour — there is no ending in
 * which the line simply goes quiet.
 */
export const CALL_END_REASONS = [
  'OBJECTIVE_MET',
  'CALLER_HUNG_UP',
  'HANDOFF_BRIDGED',
  'GRACEFUL_EXIT',
  'STEP_CAP',
  'TIME_CAP',
  'PIPELINE_FAILURE',
  'KILL_SWITCH',
  'PROVIDER_ERROR',
] as const;
export const CallEndReasonSchema = enumOf(CALL_END_REASONS).schema;
export type CallEndReason = z.infer<typeof CallEndReasonSchema>;

/**
 * Consent and disclosure facts recorded per call (phase 5.6).
 *
 * Stored as an ordered list of events with timestamps rather than booleans,
 * because the compliance question is not "was the notice given" but "was it
 * given *before* the recorder started".
 */
export const CALL_CONSENT_FACTS = [
  'AI_DISCLOSURE_PLAYED',
  'RECORDING_NOTICE_PLAYED',
  'RECORDING_STARTED',
  'RECORDING_STOPPED',
  'CALLER_OBJECTED_TO_RECORDING',
] as const;
export const CallConsentFactSchema = enumOf(CALL_CONSENT_FACTS).schema;
export type CallConsentFact = z.infer<typeof CallConsentFactSchema>;

/**
 * The keypad. `*` and `#` are included because an elderly caller's phone has
 * them and a menu that ignores two of twelve keys feels broken.
 */
export const DTMF_DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '#'] as const;
export const DtmfDigitSchema = enumOf(DTMF_DIGITS).schema;
export type DtmfDigit = (typeof DTMF_DIGITS)[number];

/**
 * How a turn was heard: spoken words, or a keypad press.
 *
 * `DTMF` turns skip the recogniser entirely, which is the whole point of 5.5 —
 * a caller on a noisy line can complete an approval without the system ever
 * needing to understand a word they said.
 */
export const CALL_INPUT_MODES = ['SPEECH', 'DTMF', 'NONE'] as const;
export const CallInputModeSchema = enumOf(CALL_INPUT_MODES).schema;
export type CallInputMode = z.infer<typeof CallInputModeSchema>;

/**
 * The latency stages a turn is measured in (phase 5.3).
 *
 * Named stages rather than one number, because "the call felt slow" has four
 * possible causes and only the stage markers separate them.
 */
export const VOICE_LATENCY_STAGES = [
  'SPEECH_END_TO_FINAL',
  'FINAL_TO_PLAN',
  'PLAN_TO_FIRST_SYNTH_BYTE',
  'FIRST_SYNTH_BYTE_TO_SPEECH_START',
  'SPEECH_END_TO_SPEECH_START',
] as const;
export const VoiceLatencyStageSchema = enumOf(VOICE_LATENCY_STAGES).schema;
export type VoiceLatencyStage = z.infer<typeof VoiceLatencyStageSchema>;

/* -------------------------------------------------------------------------- *
 * Phase 6 — retention, feedback, digest & analytics
 * -------------------------------------------------------------------------- */

/**
 * Why a retention touch is going out (phase 6.2).
 *
 * The trigger is stored on the touch rather than inferred from its timing,
 * because the four are worth telling apart in the analytics: a season trigger
 * that converts twice as often as a time-elapsed one is a fact about when to
 * pitch brakes, and a system that only records "a re-pitch was sent" can never
 * learn it.
 *
 * `odometer` is only ever raised from a reading the *customer* volunteered.
 * ServiceLoop does not read anybody's telematics.
 */
export const RETENTION_TRIGGERS = [
  'next_visit',
  'time_elapsed',
  'season',
  'odometer',
  'service_due',
  'document_expiry',
  'win_back',
  'manual',
] as const;
export const RetentionTriggerSchema = enumOf(RETENTION_TRIGGERS).schema;
export type RetentionTrigger = z.infer<typeof RetentionTriggerSchema>;

/**
 * What became of a scheduled retention touch.
 *
 * `SKIPPED` and `BLOCKED` are separate on purpose. Skipped is the retention
 * engine's own decision — the 21-day floor, the per-item cap, a frozen
 * customer — and blocked is the OutboundGate refusing, which is a consent or a
 * cap problem. Both are silence from the customer's side and completely
 * different problems from the shop's.
 */
export const RETENTION_TOUCH_STATUSES = [
  'SCHEDULED',
  'SENT',
  'HELD',
  'SKIPPED',
  'BLOCKED',
  'CANCELLED',
] as const;
export const RetentionTouchStatusSchema = enumOf(RETENTION_TOUCH_STATUSES).schema;
export type RetentionTouchStatus = z.infer<typeof RetentionTouchStatusSchema>;

/**
 * How the customer answered a re-pitch (phase 6.3).
 *
 * Three one-tap answers and nothing else. "Remind me later" counts as a
 * re-pitch against the item's cap, which is the whole reason it is a recorded
 * response rather than silence: a customer who defers twice has been asked
 * twice, and the cap has to see both.
 */
export const REPITCH_RESPONSES = ['BOOK', 'REMIND_LATER', 'NOT_INTERESTED'] as const;
export const RepitchResponseSchema = enumOf(REPITCH_RESPONSES).schema;
export type RepitchResponse = z.infer<typeof RepitchResponseSchema>;

/**
 * The one-tap feedback face (phase 6.4).
 *
 * Three, not five stars: a scale invites a considered answer and this is a
 * question asked by WhatsApp the day after a service. What the shop needs to
 * know is which of three things to do next — thank and ask for a review, thank
 * and log, or wake the owner up.
 */
export const FEEDBACK_SENTIMENTS = ['POSITIVE', 'NEUTRAL', 'NEGATIVE'] as const;
export const FeedbackSentimentSchema = enumOf(FEEDBACK_SENTIMENTS).schema;
export type FeedbackSentiment = z.infer<typeof FeedbackSentimentSchema>;

export const FEEDBACK_STATUSES = ['SCHEDULED', 'ASKED', 'ANSWERED', 'EXPIRED', 'SKIPPED'] as const;
export const FeedbackStatusSchema = enumOf(FEEDBACK_STATUSES).schema;
export type FeedbackStatus = z.infer<typeof FeedbackStatusSchema>;

/** Documents a customer may ask the shop to track for them (phase 6.5). */
export const DOCUMENT_KINDS = ['INSURANCE', 'PUC'] as const;
export const DocumentKindSchema = enumOf(DOCUMENT_KINDS).schema;
export type DocumentKind = z.infer<typeof DocumentKindSchema>;

/**
 * What a scheduled reminder is about (phase 6.5).
 *
 * `SERVICE_DUE` rides SERVICE consent — it is about a vehicle the shop worked
 * on. The two document reminders are strictly MARKETING, and only for a
 * customer who enrolled: a shop that has a customer's insurance date because it
 * saw the papers has not thereby been asked to remind them about it.
 */
export const REMINDER_KINDS = ['SERVICE_DUE', 'INSURANCE_EXPIRY', 'PUC_EXPIRY'] as const;
export const ReminderKindSchema = enumOf(REMINDER_KINDS).schema;
export type ReminderKind = z.infer<typeof ReminderKindSchema>;

export const DIGEST_KINDS = ['DAILY', 'WEEKLY'] as const;
export const DigestKindSchema = enumOf(DIGEST_KINDS).schema;
export type DigestKind = z.infer<typeof DigestKindSchema>;

/**
 * The exceptions that interrupt an owner in realtime rather than waiting for
 * the evening digest (phase 6.8).
 *
 * Five, and the list is deliberately short: an alert stream that fires for
 * everything is one an owner mutes, and a muted alert stream is worse than none
 * because the shop believes it has one.
 */
export const ALERT_KINDS = [
  'APPROVAL_STUCK',
  'NEGATIVE_FEEDBACK',
  'PAYMENT_FAILED_TWICE',
  'VOICE_KILL_SWITCH',
  'SILENT_BAY_REPEAT',
] as const;
export const AlertKindSchema = enumOf(ALERT_KINDS).schema;
export type AlertKind = z.infer<typeof AlertKindSchema>;

/**
 * How a metric rollup came to exist.
 *
 * `LIVE` is the nightly (or on-demand) fold over the day's events; `BACKFILL`
 * is `recompute --from` replaying the log. They must produce identical numbers
 * — that equality is the audit story behind the "₹ recovered" claim — so the
 * provenance is recorded rather than assumed, and a rollup that disagrees with
 * its own recomputation can be found.
 */
export const ROLLUP_SOURCES = ['LIVE', 'BACKFILL'] as const;
export const RollupSourceSchema = enumOf(ROLLUP_SOURCES).schema;
export type RollupSource = z.infer<typeof RollupSourceSchema>;

/* -------------------------------------------------------------------------- *
 * Phase 7 — DPDP data-principal workflows
 * -------------------------------------------------------------------------- */

/**
 * The two rights the DPDP Act 2023 gives a data principal that this system has
 * to actually implement: access (as a portable export) and erasure.
 *
 * Correction is deliberately absent from this enum, and its absence is a design
 * statement rather than an omission: a customer correcting their name or phone
 * is an ordinary edit an advisor makes at the counter, already audited, and
 * modelling it as an asynchronous "request" would make a five-second fix into a
 * workflow with a queue.
 */
export const DATA_REQUEST_KINDS = ['EXPORT', 'DELETION'] as const;
export const DataRequestKindSchema = enumOf(DATA_REQUEST_KINDS).schema;
export type DataRequestKind = z.infer<typeof DataRequestKindSchema>;

/**
 * The lifecycle of a data-principal request.
 *
 * Longer than a boolean because deletion is irreversible and the Act expects a
 * verified requester, so the states between "asked" and "done" are where the
 * safety lives:
 *
 * - `RECEIVED`   — somebody asked. Nothing has been verified.
 * - `VERIFIED`   — we are satisfied this is the data principal (an OTP to the
 *                  number on file, or an advisor attesting an in-person ID check).
 * - `APPROVED`   — a member of staff has authorised the cascade. Separate from
 *                  VERIFIED on purpose: verifying identity and deciding to
 *                  destroy records are different judgements by different people.
 * - `SCHEDULED`  — inside the shop's grace window, running at `scheduled_for`.
 *                  Cancellable. Exists because a deletion aimed at the wrong
 *                  customer has no undo.
 * - `RUNNING`    — the cascade is executing. A crash here is resumable, which
 *                  is why steps are recorded individually.
 * - `COMPLETED`  — every step ran; the completion report is attached.
 * - `REJECTED`   — refused, with a reason the requester is told.
 * - `CANCELLED`  — withdrawn during the grace window.
 * - `FAILED`     — a step errored and could not be retried. Never silent.
 */
export const DATA_REQUEST_STATUSES = [
  'RECEIVED',
  'VERIFIED',
  'APPROVED',
  'SCHEDULED',
  'RUNNING',
  'COMPLETED',
  'REJECTED',
  'CANCELLED',
  'FAILED',
] as const;
export const DataRequestStatusSchema = enumOf(DATA_REQUEST_STATUSES).schema;
export type DataRequestStatus = z.infer<typeof DataRequestStatusSchema>;

/** How we satisfied ourselves that the requester is the data principal. */
export const DATA_REQUEST_VERIFICATIONS = [
  /** One-time code to the phone number already on the customer record. */
  'OTP_TO_NUMBER_ON_FILE',
  /** An advisor checked a physical ID at the counter and attested to it. */
  'STAFF_ATTESTED_IN_PERSON',
  /** The request arrived on the customer's own authenticated WhatsApp thread. */
  'AUTHENTICATED_THREAD',
] as const;
export const DataRequestVerificationSchema = enumOf(DATA_REQUEST_VERIFICATIONS).schema;
export type DataRequestVerification = z.infer<typeof DataRequestVerificationSchema>;

/**
 * What a deletion did to one table.
 *
 * Three outcomes, and the distinction between them is the whole of DPDP
 * compliance in this system:
 *
 * - `PURGED`        — rows destroyed. Personal data with no other basis to exist.
 * - `PSEUDONYMISED` — the row survives with every identifier replaced by a
 *                     one-way pseudonym. Used where a *number* must survive:
 *                     the audit chain (removing a row breaks every hash after
 *                     it) and the metric rollups (a deletion that moved last
 *                     quarter's revenue would make the figures unauditable).
 * - `RETAINED`      — the row is kept intact under a statutory carve-out, with
 *                     its retention clock recorded. Invoices and GST records.
 */
export const CASCADE_ACTIONS = ['PURGED', 'PSEUDONYMISED', 'RETAINED'] as const;
export const CascadeActionSchema = enumOf(CASCADE_ACTIONS).schema;
export type CascadeAction = z.infer<typeof CascadeActionSchema>;

/**
 * Where a WhatsApp template stands with Meta, for one WABA (phase 7.3).
 *
 * Meta's own vocabulary, deliberately, plus one state of ours. Mirroring their
 * names means an operator comparing this screen with the Business Manager is
 * comparing like with like, and a status we invented — "pending", say, for
 * their `IN_APPEAL` — would be a translation somebody has to hold in their head
 * at the exact moment they are trying to work out why a message did not send.
 *
 * `NOT_SUBMITTED` is the one that is ours, and it is the important one: it is
 * the state of every template in the manifest that nobody has sent to Meta yet.
 * Without it, a template the code will happily try to use is simply absent from
 * the screen, and absence reads as "fine".
 */
export const TEMPLATE_APPROVAL_STATUSES = [
  'NOT_SUBMITTED',
  'PENDING',
  'APPROVED',
  'REJECTED',
  'PAUSED',
  'DISABLED',
] as const;
export const TemplateApprovalStatusSchema = enumOf(TEMPLATE_APPROVAL_STATUSES).schema;
export type TemplateApprovalStatus = z.infer<typeof TemplateApprovalStatusSchema>;
