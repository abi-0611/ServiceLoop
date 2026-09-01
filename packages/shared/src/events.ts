import { z } from 'zod';
import {
  DataRequestKindSchema,
  AdvisorTaskKindSchema,
  AgentObjectiveSchema,
  AgentRunOutcomeSchema,
  CallDirectionSchema,
  CallEndReasonSchema,
  CallOutcomeSchema,
  AlertKindSchema,
  ChannelTypeSchema,
  ConsentPurposeSchema,
  ConsentStatusSchema,
  ConversationKindSchema,
  CustomerDecisionSchema,
  DeclineKindSchema,
  DeclineReasonSchema,
  DigestKindSchema,
  EscalationRungTypeSchema,
  EtaMaterialitySchema,
  EtaReasonSchema,
  FeedbackSentimentSchema,
  GatePassVerifyResultSchema,
  IntakeSourceSchema,
  JobCardEventSchema,
  LedgerStatusSchema,
  JobCardStateSchema,
  LanguageSchema,
  MediaKindSchema,
  MergeSuggestionKindSchema,
  MessageKindSchema,
  ObjectiveSchema,
  PaymentEventKindSchema,
  PaymentMethodSchema,
  PaymentStatusSchema,
  RepitchResponseSchema,
  RetentionTriggerSchema,
  ReviewActionSchema,
  RollupSourceSchema,
  StatusSignalRouteSchema,
  StatusSignalSourceSchema,
  StatusSignalTypeSchema,
  TaskUrgencySchema,
  WorkItemEventSchema,
  WorkItemStateSchema,
} from './enums';

/**
 * The event envelope crossing the transactional outbox → BullMQ boundary.
 *
 * It is zod-validated on both ends (phase 1.5): the writer cannot enqueue a
 * malformed event, and a consumer cannot silently mis-read one. Phase 2+ adds
 * new members to the union; the envelope shape itself is frozen.
 */

export const EVENT_TYPES = [
  'job_card.created',
  'job_card.state_changed',
  'job_card.transition_rejected',
  'work_item.created',
  'work_item.state_changed',
  'shop_config.updated',
  // Phase 2 — channels & intake.
  'conversation.opened',
  'message.received',
  'message.sent',
  'message.blocked',
  'message.deferred',
  'consent.updated',
  'media.ingested',
  'intake.draft_created',
  'intake.draft_confirmed',
  'merge_suggestion.created',
  // Phase 3 — agent runtime & approval autopilot.
  'agent.run_started',
  'agent.run_finished',
  'evidence_bundle.created',
  'approval.requested',
  'approval.decided',
  'escalation.rung_fired',
  'escalation.cancelled',
  'advisor_task.created',
  'message.review_decided',
  'eta.requested',
  // Phase 4 — status sentinel, delivery & payments.
  'status_signal.captured',
  'eta.changed',
  'silent_bay.detected',
  'delivery.ready',
  'delivery.slot_chosen',
  'invoice.issued',
  'payment.link_created',
  'payment.recorded',
  'gate_pass.issued',
  'gate_pass.verified',
  // Phase 5 — voice.
  'call.originated',
  'call.answered',
  'call.ended',
  'call.handoff_bridged',
  'call.usage_recorded',
  // Phase 6 — retention, feedback, digest & analytics.
  'ledger.item_opened',
  'ledger.repitched',
  'ledger.item_closed',
  'retention.touch_sent',
  'retention.touch_skipped',
  'feedback.requested',
  'feedback.recorded',
  'owner_digest.sent',
  'alert.raised',
  'metrics.rollup_computed',
  /* Phase 7 — DPDP data-principal workflows. */
  'privacy.request_raised',
  'privacy.export_ready',
  'privacy.deletion_completed',
] as const;

export const EventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventTypeSchema>;

const ActorSchema = z.object({
  type: z.enum(['STAFF', 'CUSTOMER', 'AGENT', 'SYSTEM']),
  id: z.string().nullable(),
});
export type EventActor = z.infer<typeof ActorSchema>;

const envelopeBase = {
  id: z.string().uuid(),
  occurredAt: z.string().datetime({ offset: true }),
  shopId: z.string().uuid(),
  traceId: z.string().min(1).max(128),
};

export const JobCardCreatedPayloadSchema = z.object({
  jobCardId: z.string().uuid(),
  code: z.string(),
  state: JobCardStateSchema,
  actor: ActorSchema,
});

export const JobCardStateChangedPayloadSchema = z.object({
  jobCardId: z.string().uuid(),
  from: JobCardStateSchema,
  to: JobCardStateSchema,
  event: JobCardEventSchema,
  actor: ActorSchema,
  meta: z.record(z.unknown()).default({}),
});

export const JobCardTransitionRejectedPayloadSchema = z.object({
  jobCardId: z.string().uuid(),
  from: JobCardStateSchema,
  event: JobCardEventSchema,
  reason: z.string(),
  actor: ActorSchema,
});

export const WorkItemCreatedPayloadSchema = z.object({
  workItemId: z.string().uuid(),
  jobCardId: z.string().uuid(),
  state: WorkItemStateSchema,
  actor: ActorSchema,
});

export const WorkItemStateChangedPayloadSchema = z.object({
  workItemId: z.string().uuid(),
  jobCardId: z.string().uuid(),
  from: WorkItemStateSchema,
  to: WorkItemStateSchema,
  event: WorkItemEventSchema,
  actor: ActorSchema,
  meta: z.record(z.unknown()).default({}),
});

export const ShopConfigUpdatedPayloadSchema = z.object({
  configVersion: z.number().int(),
  changedPaths: z.array(z.string()),
  actor: ActorSchema,
});

/* ------------------------------------------------------------------------ *
 * Phase 2 payloads — channels & intake.
 *
 * Every one of these is a fact that already happened and was committed in the
 * same transaction as its outbox row. Nothing here is a command.
 * ------------------------------------------------------------------------ */

export const ConversationOpenedPayloadSchema = z.object({
  conversationId: z.string().uuid(),
  kind: ConversationKindSchema,
  channel: ChannelTypeSchema,
  customerId: z.string().uuid().nullable(),
  actor: ActorSchema,
});

export const MessageReceivedPayloadSchema = z.object({
  messageId: z.string().uuid(),
  conversationId: z.string().uuid(),
  conversationKind: ConversationKindSchema,
  channel: ChannelTypeSchema,
  messageKind: MessageKindSchema,
  customerId: z.string().uuid().nullable(),
  senderStaffId: z.string().uuid().nullable(),
  mediaId: z.string().uuid().nullable(),
  /** Set when the inbound message carried an intake trigger such as `#jobcard`. */
  intakeHint: IntakeSourceSchema.nullable().default(null),
  actor: ActorSchema,
});

export const MessageSentPayloadSchema = z.object({
  messageId: z.string().uuid(),
  conversationId: z.string().uuid(),
  channel: ChannelTypeSchema,
  purpose: ConsentPurposeSchema,
  templateName: z.string().nullable(),
  providerMessageId: z.string().nullable(),
  actor: ActorSchema,
});

/** A send the OutboundGate refused. Audited, surfaced in console, never silent. */
export const MessageBlockedPayloadSchema = z.object({
  messageId: z.string().uuid().nullable(),
  conversationId: z.string().uuid().nullable(),
  customerId: z.string().uuid().nullable(),
  purpose: ConsentPurposeSchema,
  code: z.string(),
  reason: z.string(),
  actor: ActorSchema,
});

/** Quiet hours defer rather than drop: the message is held with a due time. */
export const MessageDeferredPayloadSchema = z.object({
  messageId: z.string().uuid(),
  conversationId: z.string().uuid(),
  deferUntil: z.string().datetime({ offset: true }),
  reason: z.string(),
  actor: ActorSchema,
});

export const ConsentUpdatedPayloadSchema = z.object({
  consentId: z.string().uuid(),
  customerId: z.string().uuid(),
  purpose: ConsentPurposeSchema,
  from: ConsentStatusSchema.nullable(),
  to: ConsentStatusSchema,
  channel: ChannelTypeSchema,
  actor: ActorSchema,
});

export const MediaIngestedPayloadSchema = z.object({
  mediaId: z.string().uuid(),
  kind: MediaKindSchema,
  contentType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  messageId: z.string().uuid().nullable(),
  jobCardId: z.string().uuid().nullable(),
  actor: ActorSchema,
});

export const IntakeDraftCreatedPayloadSchema = z.object({
  draftId: z.string().uuid(),
  source: IntakeSourceSchema,
  conversationId: z.string().uuid().nullable(),
  mediaId: z.string().uuid().nullable(),
  /** Mean field confidence, 0–1. Low means more ⚠ prompts for the advisor. */
  overallConfidence: z.number().min(0).max(1),
  lowConfidenceFields: z.array(z.string()),
  actor: ActorSchema,
});

export const IntakeDraftConfirmedPayloadSchema = z.object({
  draftId: z.string().uuid(),
  jobCardId: z.string().uuid(),
  customerId: z.string().uuid(),
  vehicleId: z.string().uuid(),
  source: IntakeSourceSchema,
  /** Field paths a human corrected before confirming — the OCR feedback loop. */
  correctedFields: z.array(z.string()),
  actor: ActorSchema,
});

export const MergeSuggestionCreatedPayloadSchema = z.object({
  suggestionId: z.string().uuid(),
  kind: MergeSuggestionKindSchema,
  candidateIds: z.array(z.string().uuid()),
  reason: z.string(),
  actor: ActorSchema,
});

/* ------------------------------------------------------------------------ *
 * Phase 3 payloads — agent runtime & approval autopilot.
 *
 * Same rule as phase 2: every one of these is a fact that already happened and
 * was committed in the same transaction as its outbox row. The escalation
 * ladder is scheduled *from* `approval.requested` rather than being commanded
 * by it, so a redelivered event re-schedules idempotently instead of firing a
 * second ladder at a customer.
 * ------------------------------------------------------------------------ */

export const AgentRunStartedPayloadSchema = z.object({
  runId: z.string().uuid(),
  objective: AgentObjectiveSchema,
  conversationId: z.string().uuid(),
  jobCardId: z.string().uuid().nullable(),
  /** sha256 of the assembled prompt — which instructions produced this run. */
  promptHash: z.string(),
  actor: ActorSchema,
});

export const AgentRunFinishedPayloadSchema = z.object({
  runId: z.string().uuid(),
  objective: AgentObjectiveSchema,
  conversationId: z.string().uuid(),
  outcome: AgentRunOutcomeSchema,
  steps: z.number().int().nonnegative(),
  /** Populated on `blocked` — the checker or tool refusal that ended the run. */
  reason: z.string().nullable(),
  actor: ActorSchema,
});

export const EvidenceBundleCreatedPayloadSchema = z.object({
  bundleId: z.string().uuid(),
  jobCardId: z.string().uuid(),
  workItemIds: z.array(z.string().uuid()),
  mediaCount: z.number().int().nonnegative(),
  claimCount: z.number().int().nonnegative(),
  language: LanguageSchema,
  actor: ActorSchema,
});

export const ApprovalRequestedPayloadSchema = z.object({
  approvalId: z.string().uuid(),
  jobCardId: z.string().uuid(),
  conversationId: z.string().uuid(),
  customerId: z.string().uuid(),
  evidenceBundleId: z.string().uuid().nullable(),
  workItemIds: z.array(z.string().uuid()),
  amountPaise: z.number().int().nonnegative(),
  /** Which ladder in shop config governs the chase. */
  ladderRef: ObjectiveSchema,
  actor: ActorSchema,
});

export const ApprovalDecidedPayloadSchema = z.object({
  approvalId: z.string().uuid(),
  jobCardId: z.string().uuid(),
  decision: CustomerDecisionSchema,
  approvedWorkItemIds: z.array(z.string().uuid()),
  deferredWorkItemIds: z.array(z.string().uuid()),
  declinedWorkItemIds: z.array(z.string().uuid()),
  approvedAmountPaise: z.number().int().nonnegative(),
  decidedVia: z.string(),
  actor: ActorSchema,
});

export const EscalationRungFiredPayloadSchema = z.object({
  escalationId: z.string().uuid(),
  objective: ObjectiveSchema,
  subjectType: z.string(),
  subjectId: z.string().uuid(),
  rung: z.number().int().nonnegative(),
  rungType: EscalationRungTypeSchema,
  outcome: z.enum(['SENT', 'DEFERRED', 'BLOCKED', 'TASK_CREATED', 'SKIPPED']),
  detail: z.string(),
  actor: ActorSchema,
});

export const EscalationCancelledPayloadSchema = z.object({
  objective: ObjectiveSchema,
  subjectType: z.string(),
  subjectId: z.string().uuid(),
  cancelledRungs: z.array(z.number().int().nonnegative()),
  reason: z.string(),
  actor: ActorSchema,
});

export const AdvisorTaskCreatedPayloadSchema = z.object({
  taskId: z.string().uuid(),
  kind: AdvisorTaskKindSchema,
  urgency: TaskUrgencySchema,
  jobCardId: z.string().uuid().nullable(),
  conversationId: z.string().uuid().nullable(),
  brief: z.string(),
  actor: ActorSchema,
});

/** An advisor cleared a candidate out of the HITL queue (phase 3.9). */
export const MessageReviewDecidedPayloadSchema = z.object({
  messageId: z.string().uuid(),
  conversationId: z.string().uuid(),
  action: ReviewActionSchema,
  /** True when the advisor changed the copy before sending — training signal. */
  edited: z.boolean(),
  agentRunId: z.string().uuid().nullable(),
  reviewerStaffId: z.string().uuid().nullable(),
  actor: ActorSchema,
});

/**
 * The ETA hook (phase 3.6). A decision changes when the vehicle will be ready,
 * and phase 4 owns the engine that answers that. Emitting the question now
 * means the approval flow is complete on its own terms and phase 4 adds a
 * consumer rather than a call site.
 */
export const EtaRequestedPayloadSchema = z.object({
  jobCardId: z.string().uuid(),
  reason: z.enum(['APPROVAL_GRANTED', 'PARTS_AWAITED', 'WORK_ADDED']),
  approvalId: z.string().uuid().nullable(),
  conversationId: z.string().uuid().nullable(),
  actor: ActorSchema,
});

/* ------------------------------------------------------------------------ *
 * Phase 4 payloads — status sentinel, delivery & payments.
 *
 * The same rule holds: every one of these is a fact that already happened and
 * was committed in the same transaction as its outbox row. In particular
 * `eta.changed` reports a recalculation that has *already been written* to the
 * card's history — the proactive-comms worker consumes it and decides whether a
 * customer hears about it, which is why the materiality verdict travels on the
 * event rather than being re-derived by every consumer that might disagree.
 * ------------------------------------------------------------------------ */

export const StatusSignalCapturedPayloadSchema = z.object({
  signalId: z.string().uuid(),
  jobCardId: z.string().uuid().nullable(),
  workItemIds: z.array(z.string().uuid()),
  signalType: StatusSignalTypeSchema,
  source: StatusSignalSourceSchema,
  route: StatusSignalRouteSchema,
  confidence: z.number().min(0).max(1),
  senderStaffId: z.string().uuid().nullable(),
  /** Set when the parser heard a time ("part varum 4 maniku"). */
  etaHint: z.string().datetime({ offset: true }).nullable(),
  actor: ActorSchema,
});

export const EtaChangedPayloadSchema = z.object({
  jobCardId: z.string().uuid(),
  /** Null on the first ETA a card ever gets — there is nothing to compare to. */
  previousEta: z.string().datetime({ offset: true }).nullable(),
  newEta: z.string().datetime({ offset: true }),
  promisedAt: z.string().datetime({ offset: true }).nullable(),
  reason: EtaReasonSchema,
  materiality: EtaMaterialitySchema,
  /** Monotonic per card, so a consumer can order two events without clocks. */
  version: z.number().int().positive(),
  deltaMinutes: z.number().int(),
  detail: z.string(),
  actor: ActorSchema,
});

/**
 * A bay went quiet (phase 4.6).
 *
 * `consecutiveWindows` is what phase 6 reads: one silent window is a technician
 * on a tea break, four in a row is a vehicle nobody is working on.
 */
export const SilentBayDetectedPayloadSchema = z.object({
  jobCardId: z.string().uuid(),
  code: z.string(),
  state: JobCardStateSchema,
  quietForMinutes: z.number().int().nonnegative(),
  consecutiveWindows: z.number().int().positive(),
  assignedTechnicianId: z.string().uuid().nullable(),
  actor: ActorSchema,
});

export const DeliveryReadyPayloadSchema = z.object({
  jobCardId: z.string().uuid(),
  bookingId: z.string().uuid(),
  customerId: z.string().uuid(),
  conversationId: z.string().uuid().nullable(),
  amountDuePaise: z.number().int().nonnegative(),
  offeredSlots: z.array(z.string().datetime({ offset: true })),
  actor: ActorSchema,
});

export const DeliverySlotChosenPayloadSchema = z.object({
  bookingId: z.string().uuid(),
  jobCardId: z.string().uuid(),
  slotStart: z.string().datetime({ offset: true }),
  slotEnd: z.string().datetime({ offset: true }),
  chosenVia: z.string(),
  actor: ActorSchema,
});

export const InvoiceIssuedPayloadSchema = z.object({
  invoiceId: z.string().uuid(),
  jobCardId: z.string().uuid(),
  number: z.string(),
  subtotalPaise: z.number().int().nonnegative(),
  taxPaise: z.number().int().nonnegative(),
  totalPaise: z.number().int().nonnegative(),
  /** The stored PDF. Null only when rendering failed and a human must retry. */
  mediaId: z.string().uuid().nullable(),
  evidenceBlocks: z.number().int().nonnegative(),
  actor: ActorSchema,
});

export const PaymentLinkCreatedPayloadSchema = z.object({
  paymentId: z.string().uuid(),
  jobCardId: z.string().uuid(),
  invoiceId: z.string().uuid().nullable(),
  provider: z.string(),
  providerPaymentLinkId: z.string(),
  amountPaise: z.number().int().nonnegative(),
  shortUrl: z.string(),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
  actor: ActorSchema,
});

/**
 * Money moved (or failed to). Emitted once per *provider event*, after the
 * signature has been verified and the event id claimed, so a webhook Razorpay
 * retries six times produces one of these.
 */
export const PaymentRecordedPayloadSchema = z.object({
  paymentId: z.string().uuid(),
  paymentEventId: z.string().uuid(),
  jobCardId: z.string().uuid(),
  kind: PaymentEventKindSchema,
  status: PaymentStatusSchema,
  method: PaymentMethodSchema.nullable(),
  amountPaise: z.number().int().nonnegative(),
  amountPaidPaise: z.number().int().nonnegative(),
  balancePaise: z.number().int(),
  actor: ActorSchema,
});

export const GatePassIssuedPayloadSchema = z.object({
  gatePassId: z.string().uuid(),
  jobCardId: z.string().uuid(),
  code: z.string(),
  expiresAt: z.string().datetime({ offset: true }),
  /** Set when an owner released a vehicle with a balance outstanding. */
  overrideReason: z.string().nullable(),
  actor: ActorSchema,
});

export const GatePassVerifiedPayloadSchema = z.object({
  /** Null for a forged or unknown code — there is no row to point at. */
  gatePassId: z.string().uuid().nullable(),
  jobCardId: z.string().uuid().nullable(),
  code: z.string(),
  result: GatePassVerifyResultSchema,
  verifiedByStaffId: z.string().uuid().nullable(),
  actor: ActorSchema,
});

/* --- Phase 5 — voice ------------------------------------------------------ */

/**
 * A call the system decided to place — or decided not to.
 *
 * `blocked` carries the reason a call was refused at the port call-site
 * (revoked consent, a cost cap, the kill switch), because a rung that did not
 * dial is a fact the ladder, the audit trail and phase 6's containment metrics
 * all need. A silent non-event would look identical to a call that never got
 * scheduled.
 */
export const CallOriginatedPayloadSchema = z.object({
  callId: z.string().uuid(),
  direction: CallDirectionSchema,
  driver: z.string().min(1),
  objective: z.string().min(1),
  jobCardId: z.string().uuid().nullable(),
  customerId: z.string().uuid().nullable(),
  conversationId: z.string().uuid().nullable(),
  approvalRequestId: z.string().uuid().nullable(),
  escalationId: z.string().uuid().nullable(),
  blocked: z.string().nullable(),
  actor: ActorSchema,
});

export const CallAnsweredPayloadSchema = z.object({
  callId: z.string().uuid(),
  direction: CallDirectionSchema,
  answeredAt: z.string().datetime({ offset: true }),
  jobCardId: z.string().uuid().nullable(),
  customerId: z.string().uuid().nullable(),
  actor: ActorSchema,
});

/**
 * The terminal fact about a call.
 *
 * Deliberately carries the counts phase 6 aggregates — turns, whether a
 * decision was recorded, whether it reached a person — rather than leaving the
 * metrics service to re-derive them by joining four tables at report time.
 */
export const CallEndedPayloadSchema = z.object({
  callId: z.string().uuid(),
  direction: CallDirectionSchema,
  outcome: CallOutcomeSchema,
  endReason: CallEndReasonSchema,
  durationSeconds: z.number().int().min(0),
  turns: z.number().int().min(0),
  /** True when the call ended in a human: a bridge or an advisor task. */
  handedOff: z.boolean(),
  /** Set when a `record_customer_decision` fired from this call. */
  decision: CustomerDecisionSchema.nullable(),
  jobCardId: z.string().uuid().nullable(),
  customerId: z.string().uuid().nullable(),
  approvalRequestId: z.string().uuid().nullable(),
  actor: ActorSchema,
});

export const CallHandoffBridgedPayloadSchema = z.object({
  callId: z.string().uuid(),
  advisorStaffId: z.string().uuid().nullable(),
  whisperText: z.string(),
  bridgedAt: z.string().datetime({ offset: true }),
  actor: ActorSchema,
});

/**
 * What the call cost, in the three currencies that matter (phase 5.7).
 *
 * Telco seconds, speech seconds and model tokens are metered separately
 * because they fail separately: a shop can be inside its minute budget and
 * outside its model budget on the same afternoon, and a single blended number
 * would hide which one to fix.
 */
export const CallUsageRecordedPayloadSchema = z.object({
  callId: z.string().uuid(),
  telcoSeconds: z.number().int().min(0),
  sttSeconds: z.number().int().min(0),
  ttsSeconds: z.number().int().min(0),
  llmInputTokens: z.number().int().min(0),
  llmOutputTokens: z.number().int().min(0),
  estimatedCostPaise: z.number().int().min(0),
  /** Set when this call took the shop past a cap. */
  capBreached: z.enum(['SHOP_DAILY', 'PLATFORM_DAILY']).nullable(),
  actor: ActorSchema,
});

/* ------------------------------------------------------------------------ *
 * Phase 6 payloads — retention, feedback, digest & analytics.
 *
 * These carry more denormalised context than the phases before them, and that
 * is a deliberate consequence of 6.9 rather than carelessness. The metrics
 * service is an **event-sourced fold**: `recompute --from` must reproduce a
 * rollup exactly from the log alone, which means every number a KPI needs has
 * to be *on* an event rather than reachable by joining four tables whose
 * present-day contents have moved on since. So `ledger.item_closed` carries the
 * amount and the date the item was ledgered, and `feedback.recorded` carries
 * whether the review ask went out — facts a join could answer today and could
 * not answer identically after a backfill six months from now.
 * ------------------------------------------------------------------------ */

/**
 * A declined or deferred work item entered the ledger with a horizon.
 *
 * Written in the same transaction as the work-item transition that produced it:
 * phase 3.6 already made the transition, and phase 6.1 gives the row its
 * reason, its horizon and its trigger tags. `amountPaise` is the denominator of
 * the recovery rate the whole business case rests on, so it is stated once,
 * here, and never recomputed from an estimate that may since have been
 * superseded.
 */
export const LedgerItemOpenedPayloadSchema = z.object({
  ledgerItemId: z.string().uuid(),
  jobCardId: z.string().uuid(),
  workItemId: z.string().uuid(),
  customerId: z.string().uuid().nullable(),
  vehicleId: z.string().uuid().nullable(),
  kind: DeclineKindSchema,
  reason: DeclineReasonSchema,
  amountPaise: z.number().int().nonnegative(),
  /** Shop-KB category ("brakes", "tyres", "cosmetic") — drives the horizon. */
  category: z.string().nullable(),
  /** Null for a category the shop never re-pitches, such as cosmetic work. */
  followUpAfter: z.string().datetime({ offset: true }).nullable(),
  triggerTags: z.array(z.string()),
  actor: ActorSchema,
});

/** One re-pitch of one ledger item actually reached the customer. */
export const LedgerRepitchedPayloadSchema = z.object({
  ledgerItemId: z.string().uuid(),
  touchId: z.string().uuid(),
  jobCardId: z.string().uuid(),
  customerId: z.string().uuid(),
  trigger: RetentionTriggerSchema,
  /** 1 for the first re-pitch, 2 for the second. The cap is two. */
  repitchCount: z.number().int().positive(),
  amountPaise: z.number().int().nonnegative(),
  purpose: ConsentPurposeSchema,
  messageId: z.string().uuid().nullable(),
  actor: ActorSchema,
});

/**
 * A ledger item reached a terminal state.
 *
 * `openedAt` and `ledgeredAmountPaise` travel with it so the 90-day recovery
 * cohort is a single-pass fold: converted rupees have to be attributed to the
 * cohort the item was *ledgered* in rather than the one it converted in, and a
 * fold that had to look the opening up would not be a fold.
 */
export const LedgerItemClosedPayloadSchema = z.object({
  ledgerItemId: z.string().uuid(),
  jobCardId: z.string().uuid(),
  customerId: z.string().uuid().nullable(),
  status: LedgerStatusSchema,
  openedAt: z.string().datetime({ offset: true }),
  ledgeredAmountPaise: z.number().int().nonnegative(),
  /** What the customer actually spent. Zero for every non-conversion. */
  recoveredAmountPaise: z.number().int().nonnegative(),
  /** The visit the recovered work was done on, when there is one. */
  convertedJobCardId: z.string().uuid().nullable(),
  response: RepitchResponseSchema.nullable(),
  reason: z.string(),
  actor: ActorSchema,
});

/**
 * A retention touch left the building.
 *
 * One event for every retention-shaped message — re-pitches, service-due
 * reminders, document reminders, win-backs — because the 21-day floor is a
 * property of all of them together, and a per-flow event would let four flows
 * each stay inside their own cap and jointly write to somebody weekly.
 */
export const RetentionTouchSentPayloadSchema = z.object({
  touchId: z.string().uuid(),
  customerId: z.string().uuid(),
  trigger: RetentionTriggerSchema,
  purpose: ConsentPurposeSchema,
  ledgerItemIds: z.array(z.string().uuid()),
  jobCardId: z.string().uuid().nullable(),
  vehicleId: z.string().uuid().nullable(),
  messageId: z.string().uuid(),
  amountPaise: z.number().int().nonnegative(),
  actor: ActorSchema,
});

/**
 * A retention touch that was due and did not go.
 *
 * A first-class fact rather than an absence: "the engine decided not to write
 * to this customer" and "the engine never looked at this customer" are the same
 * silence from outside and completely different bugs from inside.
 */
export const RetentionTouchSkippedPayloadSchema = z.object({
  touchId: z.string().uuid(),
  customerId: z.string().uuid(),
  trigger: RetentionTriggerSchema,
  ledgerItemIds: z.array(z.string().uuid()),
  code: z.string(),
  reason: z.string(),
  actor: ActorSchema,
});

export const FeedbackRequestedPayloadSchema = z.object({
  feedbackId: z.string().uuid(),
  jobCardId: z.string().uuid(),
  customerId: z.string().uuid(),
  conversationId: z.string().uuid().nullable(),
  deliveredAt: z.string().datetime({ offset: true }),
  messageId: z.string().uuid().nullable(),
  actor: ActorSchema,
});

/**
 * What the customer said about the visit (phase 6.4).
 *
 * `reviewAsked` is on the event rather than derived from a later message,
 * because "review velocity" is a KPI and "ask once, never nag" is a rule — both
 * need the ask to be a recorded fact at the moment it was decided.
 */
export const FeedbackRecordedPayloadSchema = z.object({
  feedbackId: z.string().uuid(),
  jobCardId: z.string().uuid(),
  customerId: z.string().uuid(),
  sentiment: FeedbackSentimentSchema,
  hasComment: z.boolean(),
  /** True when the comment arrived as a voice note and was transcribed. */
  viaVoiceNote: z.boolean(),
  reviewAsked: z.boolean(),
  /** Set on the negative route — the advisor's service-recovery task. */
  recoveryTaskId: z.string().uuid().nullable(),
  /** True while a negative result freezes every retention touch for them. */
  retentionFrozen: z.boolean(),
  actor: ActorSchema,
});

/**
 * The evening brief went out (phase 6.7).
 *
 * It carries the headline figures it printed, so "what did the owner actually
 * see on the 14th" stays answerable after the rollup has been recomputed —
 * which is the point of an audit trail for a number a shop makes decisions on.
 */
export const OwnerDigestSentPayloadSchema = z.object({
  digestId: z.string().uuid(),
  kind: DigestKindSchema,
  /** Local calendar day the digest covers, `YYYY-MM-DD` in the shop's zone. */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  recipientStaffId: z.string().uuid().nullable(),
  messageId: z.string().uuid().nullable(),
  vehiclesIn: z.number().int().nonnegative(),
  vehiclesOut: z.number().int().nonnegative(),
  approvalsPending: z.number().int().nonnegative(),
  approvedPaise: z.number().int().nonnegative(),
  recoveredPaise: z.number().int().nonnegative(),
  feedbackFlags: z.number().int().nonnegative(),
  silentBays: z.number().int().nonnegative(),
  actor: ActorSchema,
});

/**
 * An exception an owner hears about now, not at 20:30 (phase 6.8).
 *
 * `incidentKey` is the dedupe identity — one alert per incident, however many
 * times the condition is re-observed by a scan that runs every two minutes.
 */
export const AlertRaisedPayloadSchema = z.object({
  alertId: z.string().uuid(),
  kind: AlertKindSchema,
  incidentKey: z.string().min(1),
  subjectType: z.string(),
  subjectId: z.string().uuid().nullable(),
  urgency: TaskUrgencySchema,
  detail: z.string(),
  messageId: z.string().uuid().nullable(),
  actor: ActorSchema,
});

/**
 * A daily rollup was computed or recomputed (phase 6.9).
 *
 * `payloadHash` is what makes `recompute --from` provable rather than merely
 * claimed: a backfill that produces a different hash for a day already folded
 * is a regression somebody can find, and the assertion is one comparison rather
 * than a diff of forty numbers.
 */
export const MetricsRollupComputedPayloadSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source: RollupSourceSchema,
  eventsRead: z.number().int().nonnegative(),
  payloadHash: z.string().min(1),
  changed: z.boolean(),
  actor: ActorSchema,
});

/**
 * A data principal exercised a right (phase 7.2).
 *
 * The payloads deliberately carry `subjectPseudonym` and *not* a customer name
 * or number. These envelopes outlive the customer they are about — a
 * `privacy.deletion_completed` event whose payload named the person would be an
 * identifier surviving its own erasure, which is the exact failure this whole
 * workflow exists to prevent.
 *
 * `customerId` is nullable and is null on the completion event, for the same
 * reason: by the time it is emitted, that id no longer resolves to a person.
 */
export const PrivacyRequestRaisedPayloadSchema = z.object({
  requestId: z.string().uuid(),
  subjectPseudonym: z.string().min(1),
  customerId: z.string().uuid().nullable(),
  kind: DataRequestKindSchema,
});

export const PrivacyExportReadyPayloadSchema = z.object({
  requestId: z.string().uuid(),
  subjectPseudonym: z.string().min(1),
  customerId: z.string().uuid().nullable(),
  /**
   * The one-shot download credential.
   *
   * On the envelope rather than on the row, because the row stores only its
   * hash — the same rule as a refresh token. It reaches the composer that puts
   * the link in a message and goes no further; `PII_REDACT_PATHS` covers it in
   * every log sink.
   */
  downloadToken: z.string().min(1),
  expiresAt: z.string().datetime({ offset: true }),
});

export const PrivacyDeletionCompletedPayloadSchema = z.object({
  requestId: z.string().uuid(),
  subjectPseudonym: z.string().min(1),
  customerId: z.string().uuid().nullable(),
  totals: z.object({
    purgedRows: z.number().int().min(0),
    pseudonymisedRows: z.number().int().min(0),
    retainedRows: z.number().int().min(0),
    tablesTouched: z.number().int().min(0),
  }),
});

export const EventEnvelopeSchema = z.discriminatedUnion('type', [
  z.object({
    ...envelopeBase,
    type: z.literal('job_card.created'),
    payload: JobCardCreatedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('job_card.state_changed'),
    payload: JobCardStateChangedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('job_card.transition_rejected'),
    payload: JobCardTransitionRejectedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('work_item.created'),
    payload: WorkItemCreatedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('work_item.state_changed'),
    payload: WorkItemStateChangedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('shop_config.updated'),
    payload: ShopConfigUpdatedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('conversation.opened'),
    payload: ConversationOpenedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('message.received'),
    payload: MessageReceivedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('message.sent'),
    payload: MessageSentPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('message.blocked'),
    payload: MessageBlockedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('message.deferred'),
    payload: MessageDeferredPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('consent.updated'),
    payload: ConsentUpdatedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('media.ingested'),
    payload: MediaIngestedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('intake.draft_created'),
    payload: IntakeDraftCreatedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('intake.draft_confirmed'),
    payload: IntakeDraftConfirmedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('merge_suggestion.created'),
    payload: MergeSuggestionCreatedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('agent.run_started'),
    payload: AgentRunStartedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('agent.run_finished'),
    payload: AgentRunFinishedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('evidence_bundle.created'),
    payload: EvidenceBundleCreatedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('approval.requested'),
    payload: ApprovalRequestedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('approval.decided'),
    payload: ApprovalDecidedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('escalation.rung_fired'),
    payload: EscalationRungFiredPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('escalation.cancelled'),
    payload: EscalationCancelledPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('advisor_task.created'),
    payload: AdvisorTaskCreatedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('message.review_decided'),
    payload: MessageReviewDecidedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('eta.requested'),
    payload: EtaRequestedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('status_signal.captured'),
    payload: StatusSignalCapturedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('eta.changed'),
    payload: EtaChangedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('silent_bay.detected'),
    payload: SilentBayDetectedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('delivery.ready'),
    payload: DeliveryReadyPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('delivery.slot_chosen'),
    payload: DeliverySlotChosenPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('invoice.issued'),
    payload: InvoiceIssuedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('payment.link_created'),
    payload: PaymentLinkCreatedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('payment.recorded'),
    payload: PaymentRecordedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('gate_pass.issued'),
    payload: GatePassIssuedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('gate_pass.verified'),
    payload: GatePassVerifiedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('call.originated'),
    payload: CallOriginatedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('call.answered'),
    payload: CallAnsweredPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('call.ended'),
    payload: CallEndedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('call.handoff_bridged'),
    payload: CallHandoffBridgedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('call.usage_recorded'),
    payload: CallUsageRecordedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('ledger.item_opened'),
    payload: LedgerItemOpenedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('ledger.repitched'),
    payload: LedgerRepitchedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('ledger.item_closed'),
    payload: LedgerItemClosedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('retention.touch_sent'),
    payload: RetentionTouchSentPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('retention.touch_skipped'),
    payload: RetentionTouchSkippedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('feedback.requested'),
    payload: FeedbackRequestedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('feedback.recorded'),
    payload: FeedbackRecordedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('owner_digest.sent'),
    payload: OwnerDigestSentPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('alert.raised'),
    payload: AlertRaisedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('metrics.rollup_computed'),
    payload: MetricsRollupComputedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('privacy.request_raised'),
    payload: PrivacyRequestRaisedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('privacy.export_ready'),
    payload: PrivacyExportReadyPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('privacy.deletion_completed'),
    payload: PrivacyDeletionCompletedPayloadSchema,
  }),
]);

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

/** Payload for a given event type, resolved from the union. */
export type PayloadOf<T extends EventType> = Extract<EventEnvelope, { type: T }>['payload'];

export function parseEventEnvelope(raw: unknown): EventEnvelope {
  return EventEnvelopeSchema.parse(raw);
}

export const QUEUE_NAMES = [
  'jobcard-events',
  'workitem-events',
  'config-events',
  'message-events',
  'intake-events',
  'agent-events',
  /**
   * Phase 4 splits the middle and the end of the loop onto their own queues.
   *
   * Not fastidiousness: `status-events` carries the high-frequency traffic (a
   * technician's signals and every ETA recalculation they cause) and
   * `delivery-events` carries the low-frequency, money-touching traffic. A
   * backlog of voice notes on a busy Saturday must not delay the reconcile that
   * releases somebody's car.
   */
  'status-events',
  'delivery-events',
  /**
   * Phase 5 gives voice its own queue for the same reason phase 4 split
   * delivery off: a call is a real-time thing that has already finished by the
   * time its events are dispatched, and a backlog of transcripts must not sit
   * behind a Saturday's worth of status signals.
   */
  'voice-events',
  /**
   * Phase 6 keeps retention on its own line for the opposite reason phase 4
   * split delivery off.
   *
   * Delivery got its own queue because it must not wait; retention gets one
   * because it *may*. A re-pitch that lands twenty minutes late costs nothing,
   * and a month-end backfill of a year's ledger items is exactly the kind of
   * burst that would otherwise sit in front of a customer's payment reconcile.
   * The digest and the alert stream ride here too — the alerts are latency
   * sensitive, but they are a handful of events a day rather than a backlog.
   */
  'retention-events',
] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

export const DEAD_LETTER_QUEUE = 'dead-letter' as const;

/**
 * Queues that carry *scheduled* work rather than outbox facts.
 *
 * The escalation ladder is a set of BullMQ delayed jobs keyed by the objective's
 * subject id (phase 3.7), which is a different lifecycle from an outbox event:
 * a delayed job is cancellable, and cancelling it the instant a customer decides
 * is the whole point.
 */
export const ESCALATION_QUEUE = 'escalations' as const;

/** Static routing table: every event type has exactly one home queue. */
export const QUEUE_BY_EVENT_TYPE: Readonly<Record<EventType, QueueName>> = {
  'job_card.created': 'jobcard-events',
  'job_card.state_changed': 'jobcard-events',
  'job_card.transition_rejected': 'jobcard-events',
  'work_item.created': 'workitem-events',
  'work_item.state_changed': 'workitem-events',
  'shop_config.updated': 'config-events',
  'conversation.opened': 'message-events',
  'message.received': 'message-events',
  'message.sent': 'message-events',
  'message.blocked': 'message-events',
  'message.deferred': 'message-events',
  'consent.updated': 'message-events',
  'media.ingested': 'intake-events',
  'intake.draft_created': 'intake-events',
  'intake.draft_confirmed': 'intake-events',
  'merge_suggestion.created': 'intake-events',
  'agent.run_started': 'agent-events',
  'agent.run_finished': 'agent-events',
  'evidence_bundle.created': 'agent-events',
  'approval.requested': 'agent-events',
  'approval.decided': 'agent-events',
  'escalation.rung_fired': 'agent-events',
  'escalation.cancelled': 'agent-events',
  'advisor_task.created': 'agent-events',
  'eta.requested': 'agent-events',
  'message.review_decided': 'message-events',
  'status_signal.captured': 'status-events',
  'eta.changed': 'status-events',
  'silent_bay.detected': 'status-events',
  'delivery.ready': 'delivery-events',
  'delivery.slot_chosen': 'delivery-events',
  'invoice.issued': 'delivery-events',
  'payment.link_created': 'delivery-events',
  'payment.recorded': 'delivery-events',
  'gate_pass.issued': 'delivery-events',
  'gate_pass.verified': 'delivery-events',
  'call.originated': 'voice-events',
  'call.answered': 'voice-events',
  'call.ended': 'voice-events',
  'call.handoff_bridged': 'voice-events',
  'call.usage_recorded': 'voice-events',
  'ledger.item_opened': 'retention-events',
  'ledger.repitched': 'retention-events',
  'ledger.item_closed': 'retention-events',
  'retention.touch_sent': 'retention-events',
  'retention.touch_skipped': 'retention-events',
  'feedback.requested': 'retention-events',
  'feedback.recorded': 'retention-events',
  'owner_digest.sent': 'retention-events',
  'alert.raised': 'retention-events',
  'metrics.rollup_computed': 'retention-events',
  // `message-events`, not a queue of their own. The only consumer is the
  // composer that tells the customer their archive is ready, which is an
  // outbound message like any other — and a queue with one handler on it is a
  // queue somebody forgets to run a worker for.
  'privacy.request_raised': 'message-events',
  'privacy.export_ready': 'message-events',
  'privacy.deletion_completed': 'message-events',
};

export function queueForEventType(type: EventType): QueueName {
  return QUEUE_BY_EVENT_TYPE[type];
}
