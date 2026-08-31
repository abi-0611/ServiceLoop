import { z } from 'zod';
import {
  AdvisorTaskKindSchema,
  AgentObjectiveSchema,
  AgentRunOutcomeSchema,
  ChannelTypeSchema,
  ConsentPurposeSchema,
  ConsentStatusSchema,
  ConversationKindSchema,
  CustomerDecisionSchema,
  EscalationRungTypeSchema,
  EtaMaterialitySchema,
  EtaReasonSchema,
  GatePassVerifyResultSchema,
  IntakeSourceSchema,
  JobCardEventSchema,
  JobCardStateSchema,
  LanguageSchema,
  MediaKindSchema,
  MergeSuggestionKindSchema,
  MessageKindSchema,
  ObjectiveSchema,
  PaymentEventKindSchema,
  PaymentMethodSchema,
  PaymentStatusSchema,
  ReviewActionSchema,
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
};

export function queueForEventType(type: EventType): QueueName {
  return QUEUE_BY_EVENT_TYPE[type];
}
