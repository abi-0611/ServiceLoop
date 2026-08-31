import { z } from 'zod';
import {
  AdvisorTaskKindSchema,
  AuditActorTypeSchema,
  AutonomyLevelSchema,
  ConsentPurposeSchema,
  ConsentStatusSchema,
  ConversationKindSchema,
  ConversationStateSchema,
  DeliveryBookingStatusSchema,
  EtaMaterialitySchema,
  EtaReasonSchema,
  GatePassStatusSchema,
  GatePassVerifyResultSchema,
  IntakeDraftStatusSchema,
  IntakeSourceSchema,
  JobCardEventSchema,
  JobCardSourceSchema,
  JobCardStateSchema,
  LanguageSchema,
  InvoiceStatusSchema,
  MediaKindSchema,
  MessageKindSchema,
  MessageStatusSchema,
  PaymentStatusSchema,
  ReviewActionSchema,
  StaffRoleSchema,
  StatusSignalRouteSchema,
  StatusSignalTypeSchema,
  TaskUrgencySchema,
  WorkItemStateSchema,
} from './enums';
import { PhoneSchema } from './phone';

/**
 * Wire contracts shared by `apps/api` (DTO validation) and `apps/console`
 * (typed client). One schema, both ends — the console client cannot drift from
 * the API it calls.
 */

/* ---------------------------------- auth --------------------------------- */

export const OtpRequestSchema = z.object({ phone: PhoneSchema });
export type OtpRequest = z.infer<typeof OtpRequestSchema>;

export const OtpRequestResponseSchema = z.object({
  sent: z.literal(true),
  expiresInSeconds: z.number().int().positive(),
  /** Present only in DEMO_MODE, so the console can show the code (phase 1.8). */
  demoCode: z.string().optional(),
});
export type OtpRequestResponse = z.infer<typeof OtpRequestResponseSchema>;

export const OtpVerifySchema = z.object({
  phone: PhoneSchema,
  code: z.string().regex(/^\d{6}$/),
});
export type OtpVerify = z.infer<typeof OtpVerifySchema>;

export const SessionShopSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  city: z.string(),
  role: StaffRoleSchema,
});
export type SessionShop = z.infer<typeof SessionShopSchema>;

export const SessionSchema = z.object({
  accessToken: z.string(),
  expiresInSeconds: z.number().int().positive(),
  staff: z.object({
    id: z.string().uuid(),
    fullName: z.string(),
    role: StaffRoleSchema,
    shopId: z.string().uuid(),
  }),
  shops: z.array(SessionShopSchema),
});
export type Session = z.infer<typeof SessionSchema>;

export const SwitchShopSchema = z.object({ shopId: z.string().uuid() });
export type SwitchShop = z.infer<typeof SwitchShopSchema>;

/* -------------------------------- job cards ------------------------------- */

export const JobCardSummarySchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  state: JobCardStateSchema,
  stateChangedAt: z.string().datetime({ offset: true }),
  openedAt: z.string().datetime({ offset: true }).nullable(),
  promisedAt: z.string().datetime({ offset: true }).nullable(),
  source: JobCardSourceSchema,
  complaintText: z.string().nullable(),
  customer: z.object({
    id: z.string().uuid(),
    fullName: z.string(),
    phoneMasked: z.string(),
    preferredLanguage: LanguageSchema,
  }),
  vehicle: z.object({
    id: z.string().uuid(),
    registration: z.string(),
    registrationDisplay: z.string(),
    make: z.string().nullable(),
    model: z.string().nullable(),
  }),
  advisor: z.object({ id: z.string().uuid(), fullName: z.string() }).nullable(),
  workItemCounts: z.object({
    total: z.number().int().nonnegative(),
    pendingApproval: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
  }),
  estimateTotalPaise: z.number().int().nonnegative().nullable(),
});
export type JobCardSummary = z.infer<typeof JobCardSummarySchema>;

export const WorkItemDtoSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  description: z.string().nullable(),
  state: WorkItemStateSchema,
  requiresApproval: z.boolean(),
  technicianNote: z.string().nullable(),
  sequence: z.number().int(),
  estimatedMinutes: z.number().int().nullable(),
});
export type WorkItemDto = z.infer<typeof WorkItemDtoSchema>;

export const EstimateLineDtoSchema = z.object({
  id: z.string().uuid(),
  description: z.string(),
  kind: z.enum(['LABOUR', 'PART', 'CONSUMABLE', 'FEE']),
  quantityMilli: z.number().int(),
  unitPricePaise: z.number().int(),
  lineTotalPaise: z.number().int(),
  workItemId: z.string().uuid().nullable(),
});
export type EstimateLineDto = z.infer<typeof EstimateLineDtoSchema>;

export const EstimateDtoSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int(),
  status: z.enum(['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'SUPERSEDED']),
  subtotalPaise: z.number().int(),
  taxPaise: z.number().int(),
  totalPaise: z.number().int(),
  acceptedAt: z.string().datetime({ offset: true }).nullable(),
  lines: z.array(EstimateLineDtoSchema),
});
export type EstimateDto = z.infer<typeof EstimateDtoSchema>;

export const AuditEntryDtoSchema = z.object({
  id: z.string().uuid(),
  seq: z.number().int(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  actorType: AuditActorTypeSchema,
  actorId: z.string().nullable(),
  payload: z.record(z.unknown()),
  hash: z.string(),
  prevHash: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
});
export type AuditEntryDto = z.infer<typeof AuditEntryDtoSchema>;

export const JobCardDetailSchema = JobCardSummarySchema.extend({
  workItems: z.array(WorkItemDtoSchema),
  estimates: z.array(EstimateDtoSchema),
  auditTrail: z.array(AuditEntryDtoSchema),
  allowedEvents: z.array(JobCardEventSchema),
});
export type JobCardDetail = z.infer<typeof JobCardDetailSchema>;

export const BoardColumnSchema = z.object({
  state: JobCardStateSchema,
  cards: z.array(JobCardSummarySchema),
});
export const BoardResponseSchema = z.object({
  columns: z.array(BoardColumnSchema),
  totalCards: z.number().int().nonnegative(),
});
export type BoardResponse = z.infer<typeof BoardResponseSchema>;

export const TransitionRequestSchema = z.object({
  event: JobCardEventSchema,
  meta: z.record(z.unknown()).optional(),
});
export type TransitionRequest = z.infer<typeof TransitionRequestSchema>;

export const TransitionResponseSchema = z.object({
  jobCardId: z.string().uuid(),
  from: JobCardStateSchema,
  to: JobCardStateSchema,
  auditEventId: z.string().uuid(),
});
export type TransitionResponse = z.infer<typeof TransitionResponseSchema>;

/* ------------------------------ conversations ----------------------------- */

export const ConversationSummarySchema = z.object({
  id: z.string().uuid(),
  kind: ConversationKindSchema,
  state: ConversationStateSchema,
  /** Customer name when identified, the WhatsApp profile name otherwise. */
  title: z.string(),
  customerId: z.string().uuid().nullable(),
  addressMasked: z.string(),
  language: LanguageSchema,
  unreadCount: z.number().int().nonnegative(),
  lastMessageAt: z.string().datetime({ offset: true }).nullable(),
  lastMessagePreview: z.string(),
  lastMessageDirection: z.enum(['INBOUND', 'OUTBOUND']).nullable(),
  /** Null when no window has ever opened on this thread. */
  windowExpiresAt: z.string().datetime({ offset: true }).nullable(),
  windowOpen: z.boolean(),
  humanOverrideAt: z.string().datetime({ offset: true }).nullable(),
  serviceConsent: ConsentStatusSchema.nullable(),
});
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

export const MessageMediaDtoSchema = z.object({
  id: z.string().uuid(),
  kind: MediaKindSchema,
  contentType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  durationMs: z.number().int().nullable(),
  /** Console-relative paths; the API streams the bytes behind them. */
  url: z.string(),
  thumbnailUrl: z.string().nullable(),
});
export type MessageMediaDto = z.infer<typeof MessageMediaDtoSchema>;

export const MessageDtoSchema = z.object({
  id: z.string().uuid(),
  direction: z.enum(['INBOUND', 'OUTBOUND']),
  status: MessageStatusSchema,
  kind: MessageKindSchema,
  purpose: ConsentPurposeSchema,
  language: LanguageSchema,
  body: z.string(),
  templateName: z.string().nullable(),
  /** Buttons/list as sent, or the reply that came back. */
  interactive: z.unknown().nullable(),
  media: MessageMediaDtoSchema.nullable(),
  senderName: z.string().nullable(),
  isHumanReply: z.boolean(),
  createdByAgent: z.boolean(),
  /** Why the OutboundGate refused. Rendered in the thread, never hidden. */
  blockedCode: z.string().nullable(),
  blockedReason: z.string().nullable(),
  scheduledFor: z.string().datetime({ offset: true }).nullable(),
  sentAt: z.string().datetime({ offset: true }).nullable(),
  deliveredAt: z.string().datetime({ offset: true }).nullable(),
  readAt: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
});
export type MessageDto = z.infer<typeof MessageDtoSchema>;

export const ConversationThreadSchema = z.object({
  conversation: ConversationSummarySchema,
  messages: z.array(MessageDtoSchema),
  /** Drafts awaiting confirmation on this thread, newest first. */
  openDraftIds: z.array(z.string().uuid()),
});
export type ConversationThread = z.infer<typeof ConversationThreadSchema>;

export const ConversationListSchema = z.object({
  threads: z.array(ConversationSummarySchema),
  unreadTotal: z.number().int().nonnegative(),
});
export type ConversationList = z.infer<typeof ConversationListSchema>;

export const ReplyRequestSchema = z.object({
  body: z.string().min(1).max(4096),
});
export type ReplyRequest = z.infer<typeof ReplyRequestSchema>;

/**
 * Every send outcome the gate can produce, surfaced verbatim.
 *
 * The console shows a blocked reply with its reason rather than a generic
 * failure: "consent revoked" and "quiet hours until 08:00" call for very
 * different actions from an advisor.
 */
export const SendOutcomeSchema = z.object({
  status: z.enum(['SENT', 'BLOCKED', 'DEFERRED', 'PENDING_APPROVAL', 'FAILED']),
  messageId: z.string(),
  code: z.string().nullable(),
  reason: z.string().nullable(),
  deferUntil: z.string().datetime({ offset: true }).nullable(),
});
export type SendOutcome = z.infer<typeof SendOutcomeSchema>;

/* --------------------------------- intake --------------------------------- */

export const DraftFieldDtoSchema = z.object({
  index: z.number().int().positive(),
  path: z.string(),
  label: z.string(),
  value: z.string(),
  confidence: z.number().min(0).max(1),
  uncertain: z.boolean(),
});
export type DraftFieldDto = z.infer<typeof DraftFieldDtoSchema>;

export const DraftCorrectionDtoSchema = z.object({
  path: z.string(),
  previousValue: z.string(),
  value: z.string(),
  correctedBy: z.string().nullable(),
  correctedAt: z.string().datetime({ offset: true }),
});

export const IntakeDraftSummarySchema = z.object({
  id: z.string().uuid(),
  source: IntakeSourceSchema,
  status: IntakeDraftStatusSchema,
  customerName: z.string(),
  registration: z.string(),
  overallConfidence: z.number().min(0).max(1),
  uncertainCount: z.number().int().nonnegative(),
  extractorModel: z.string().nullable(),
  conversationId: z.string().uuid().nullable(),
  mediaId: z.string().uuid().nullable(),
  jobCardId: z.string().uuid().nullable(),
  createdAt: z.string().datetime({ offset: true }),
});
export type IntakeDraftSummary = z.infer<typeof IntakeDraftSummarySchema>;

export const IntakeDraftDetailSchema = IntakeDraftSummarySchema.extend({
  fields: z.array(DraftFieldDtoSchema),
  corrections: z.array(DraftCorrectionDtoSchema),
  /** The forwarded text or the voice-note transcript, exactly as received. */
  rawInput: z.string().nullable(),
  language: LanguageSchema,
  notes: z.string(),
  /** Threshold below which a field is marked ⚠ — shop configuration. */
  confirmationThreshold: z.number().min(0).max(1),
  mediaUrl: z.string().nullable(),
});
export type IntakeDraftDetail = z.infer<typeof IntakeDraftDetailSchema>;

export const IntakeDraftListSchema = z.object({
  drafts: z.array(IntakeDraftSummarySchema),
});
export type IntakeDraftList = z.infer<typeof IntakeDraftListSchema>;

export const CorrectDraftRequestSchema = z.object({
  path: z.string().min(1).max(120),
  value: z.string().max(400),
});
export type CorrectDraftRequest = z.infer<typeof CorrectDraftRequestSchema>;

export const ConfirmDraftResponseSchema = z.object({
  draftId: z.string().uuid(),
  jobCardId: z.string().uuid(),
  code: z.string(),
  customerId: z.string().uuid(),
  vehicleId: z.string().uuid(),
  workItemCount: z.number().int().nonnegative(),
  correctedFields: z.array(z.string()),
  mergeSuggestions: z.number().int().nonnegative(),
  /** Set when the card was created but its DRAFT → OPEN transition failed. */
  openFailure: z.string().nullable(),
});
export type ConfirmDraftResponse = z.infer<typeof ConfirmDraftResponseSchema>;

/**
 * The minimal digital job card (phase 2.8) — for greenfield shops with no paper
 * at all. It builds the same `JobCardDraft` the photo path does, so it lands in
 * the same confirmation flow rather than being a second way to create a card.
 */
export const NewJobCardRequestSchema = z.object({
  customerName: z.string().min(1).max(120),
  phone: z.string().min(1).max(32),
  registration: z.string().min(1).max(24),
  make: z.string().max(60).optional(),
  model: z.string().max(60).optional(),
  odometerKm: z.number().int().min(0).max(2_000_000).optional(),
  complaints: z.array(z.string().min(1).max(400)).max(20).default([]),
  estimateLines: z
    .array(
      z.object({
        description: z.string().min(1).max(200),
        quantity: z.number().min(0.001).max(1000).default(1),
        unitPriceRupees: z.number().min(0).max(1_000_000).optional(),
      }),
    )
    .max(40)
    .default([]),
  promisedAt: z.string().max(64).optional(),
  language: LanguageSchema.default('en'),
  /** Skips the review screen: a form the advisor typed needs no proofreading. */
  confirmImmediately: z.boolean().default(true),
});
export type NewJobCardRequest = z.infer<typeof NewJobCardRequestSchema>;

/* --------------------------------- sandbox -------------------------------- */

export const SandboxPersonaSchema = z.object({
  id: z.string(),
  kind: z.enum(['CUSTOMER', 'STAFF']),
  label: z.string(),
  phone: z.string(),
  language: LanguageSchema,
  /** Set for staff personas: messages are injected into the evidence group. */
  groupId: z.string().nullable(),
  vehicle: z.string().nullable(),
});
export type SandboxPersona = z.infer<typeof SandboxPersonaSchema>;

export const SandboxPersonaListSchema = z.object({
  personas: z.array(SandboxPersonaSchema),
  staffGroupId: z.string().nullable(),
});
export type SandboxPersonaList = z.infer<typeof SandboxPersonaListSchema>;

export const SandboxInjectRequestSchema = z.object({
  personaId: z.string().min(1),
  kind: z.enum(['text', 'image', 'audio', 'button_reply']),
  text: z.string().max(4096).optional(),
  /** base64 for image/audio, so the simulator can post a browser recording. */
  mediaBase64: z.string().optional(),
  contentType: z.string().max(120).optional(),
  filename: z.string().max(200).optional(),
  caption: z.string().max(1024).optional(),
  replyId: z.string().max(256).optional(),
  replyTitle: z.string().max(120).optional(),
});
export type SandboxInjectRequest = z.infer<typeof SandboxInjectRequestSchema>;

export const TraceStepDtoSchema = z.object({
  stage: z.string(),
  detail: z.string(),
  at: z.string(),
  ok: z.boolean(),
  data: z.record(z.unknown()).nullable(),
});

export const SandboxInjectResponseSchema = z.object({
  conversationId: z.string().uuid().nullable(),
  messageId: z.string().uuid().nullable(),
  duplicate: z.boolean(),
  mediaId: z.string().uuid().nullable(),
  draftId: z.string().uuid().nullable(),
  jobCardId: z.string().uuid().nullable(),
  replies: z.array(SendOutcomeSchema),
  trace: z.array(TraceStepDtoSchema),
});
export type SandboxInjectResponse = z.infer<typeof SandboxInjectResponseSchema>;

/* ---------------------------------- audit --------------------------------- */

export const ChainVerificationSchema = z.object({
  shopId: z.string().uuid(),
  entriesChecked: z.number().int().nonnegative(),
  valid: z.boolean(),
  brokenAtIndex: z.number().int().nullable(),
  brokenEventId: z.string().uuid().nullable(),
  reason: z.string().nullable(),
});
export type ChainVerification = z.infer<typeof ChainVerificationSchema>;

/* --------------------------------- health --------------------------------- */

export const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  demoMode: z.boolean(),
  version: z.string(),
  checks: z.array(
    z.object({
      name: z.string(),
      status: z.enum(['ok', 'down']),
      latencyMs: z.number().nonnegative().nullable(),
      detail: z.string().nullable(),
    }),
  ),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/* --------------------------- review queue (3.9) --------------------------- */

/**
 * A candidate the agent drafted and the gate held.
 *
 * `checkerReasons` is what makes this queue useful rather than a slow send
 * button: an advisor needs to know *why* it was held, in words, before deciding
 * whether the agent was wrong or merely cautious.
 */
export const ReviewCandidateSchema = z.object({
  messageId: z.string().uuid(),
  conversationId: z.string().uuid(),
  customerLabel: z.string(),
  jobCardId: z.string().uuid().nullable(),
  agentRunId: z.string().uuid().nullable(),
  body: z.string(),
  language: LanguageSchema,
  checkerReasons: z.array(z.string()),
  evidenceRefs: z.array(z.string()),
  createdAt: z.string(),
  /** How long it has been waiting. The HITL cost, made visible. */
  waitedMs: z.number().int().nonnegative(),
});
export type ReviewCandidate = z.infer<typeof ReviewCandidateSchema>;

export const ReviewQueueSchema = z.object({
  candidates: z.array(ReviewCandidateSchema),
});
export type ReviewQueue = z.infer<typeof ReviewQueueSchema>;

export const ReviewDecisionRequestSchema = z
  .object({
    action: ReviewActionSchema,
    /** Required for EDIT_AND_SEND — the copy that actually goes out. */
    body: z.string().min(1).max(4000).optional(),
    /** Required for REJECT. */
    reason: z.string().min(1).max(500).optional(),
  })
  .refine((value) => value.action !== 'EDIT_AND_SEND' || value.body !== undefined, {
    message: 'Edit-then-send needs the edited copy',
    path: ['body'],
  })
  .refine((value) => value.action !== 'REJECT' || value.reason !== undefined, {
    // Without a reason the graduation report cannot tell "the agent was wrong"
    // from "the advisor was busy", and that distinction is the queue's value.
    message: 'Rejecting a candidate needs a reason',
    path: ['reason'],
  });
export type ReviewDecisionRequest = z.infer<typeof ReviewDecisionRequestSchema>;

export const ReviewDecisionResponseSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('REJECTED') }),
  z.object({
    action: z.literal('SENT'),
    edited: z.boolean(),
    status: z.string(),
    messageId: z.string().uuid(),
  }),
]);
export type ReviewDecisionResponse = z.infer<typeof ReviewDecisionResponseSchema>;

/**
 * The numbers an owner sees before deciding whether to raise autonomy.
 *
 * `recommendedLevel` is null whenever any gate is unmet, and `rationale` always
 * says which — a recommendation an owner cannot check is one they should not
 * act on.
 */
export const GraduationReportSchema = z.object({
  shopId: z.string().uuid(),
  flow: z.string(),
  runs: z.number().int().nonnegative(),
  approvedWithoutEdit: z.number().int().nonnegative(),
  approvedWithEdit: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  checkerBlocks: z.number().int().nonnegative(),
  approvedWithoutEditRate: z.number().min(0).max(1),
  checkerBlockRate: z.number().min(0).max(1),
  medianReviewWaitMs: z.number().nonnegative(),
  currentLevel: AutonomyLevelSchema,
  recommendedLevel: AutonomyLevelSchema.nullable(),
  rationale: z.string(),
});
export type GraduationReportDto = z.infer<typeof GraduationReportSchema>;

/** Work queued for a person (L6). */
export const AdvisorTaskDtoSchema = z.object({
  id: z.string().uuid(),
  kind: AdvisorTaskKindSchema,
  urgency: TaskUrgencySchema,
  brief: z.string(),
  jobCardId: z.string().uuid().nullable(),
  conversationId: z.string().uuid().nullable(),
  createdAt: z.string(),
});
export type AdvisorTaskDto = z.infer<typeof AdvisorTaskDtoSchema>;

export const AdvisorTaskListSchema = z.object({ tasks: z.array(AdvisorTaskDtoSchema) });
export type AdvisorTaskList = z.infer<typeof AdvisorTaskListSchema>;

/* --------------------- status sentinel & delivery (4.x) -------------------- */

/**
 * A signal the parser was not sure enough about to apply on its own.
 *
 * `transcript` leads because it is what the advisor is actually judging — the
 * eight words a technician said. Everything else on the row exists to answer
 * "why am I being asked?": the confidence, whether the recogniser itself was
 * shaky, and which cards were in the running when the match failed.
 */
const SignalCardSchema = z.object({
  jobCardId: z.string().uuid(),
  code: z.string(),
  registration: z.string(),
  vehicle: z.string(),
  state: JobCardStateSchema,
});
export type SignalCardDto = z.infer<typeof SignalCardSchema>;

export const PendingStatusSignalSchema = z.object({
  signalId: z.string().uuid(),
  jobCardId: z.string().uuid().nullable(),
  signalType: StatusSignalTypeSchema,
  route: StatusSignalRouteSchema,
  confidence: z.number().min(0).max(1),
  transcript: z.string(),
  language: LanguageSchema,
  transcriptConfidence: z.number().min(0).max(1).nullable(),
  workItemIds: z.array(z.string().uuid()),
  candidateJobCardIds: z.array(z.string().uuid()),
  etaHint: z.string().nullable(),
  matchBasis: z.string().nullable(),
  createdAt: z.string(),
  /** The matched card, named. Null when nothing matched. */
  card: SignalCardSchema.nullable(),
  /** The cards the parser could not decide between — the disambiguation ask. */
  candidates: z.array(SignalCardSchema),
});
export type PendingStatusSignalDto = z.infer<typeof PendingStatusSignalSchema>;

export const PendingStatusSignalListSchema = z.object({
  signals: z.array(PendingStatusSignalSchema),
});
export type PendingStatusSignalList = z.infer<typeof PendingStatusSignalListSchema>;

export const StatusSignalDecisionSchema = z.object({
  signalId: z.string().uuid(),
  route: StatusSignalRouteSchema,
  jobCardId: z.string().uuid().nullable(),
  workItemIds: z.array(z.string().uuid()),
  detail: z.string(),
  alreadyActioned: z.boolean().optional(),
});
export type StatusSignalDecision = z.infer<typeof StatusSignalDecisionSchema>;

/**
 * One change to the answer to "when will it be ready?", and why.
 *
 * `customerWasTold` is on every entry deliberately: an advisor picking up the
 * phone needs to know not just what the ETA is but whether the person on the
 * other end has heard it yet.
 */
export const EtaEntryDtoSchema = z.object({
  version: z.number().int().positive(),
  eta: z.string(),
  previousEta: z.string().nullable(),
  reason: EtaReasonSchema,
  materiality: EtaMaterialitySchema,
  deltaMinutes: z.number().int(),
  detail: z.string(),
  customerWasTold: z.boolean(),
  changedAt: z.string(),
});
export type EtaEntryDto = z.infer<typeof EtaEntryDtoSchema>;

export const EtaHistorySchema = z.object({
  jobCardId: z.string().uuid(),
  currentEta: z.string().nullable(),
  promisedAt: z.string().nullable(),
  entries: z.array(EtaEntryDtoSchema),
});
export type EtaHistoryDto = z.infer<typeof EtaHistorySchema>;

/** The end of the loop for one card, as the drawer shows it. */
export const DeliverySummarySchema = z.object({
  jobCardId: z.string().uuid(),
  amountDuePaise: z.number().int().nonnegative(),
  eta: z
    .object({
      eta: z.string(),
      version: z.number().int().positive(),
      reason: EtaReasonSchema,
      materiality: EtaMaterialitySchema,
      detail: z.string(),
      customerWasTold: z.boolean(),
    })
    .nullable(),
  booking: z
    .object({
      bookingId: z.string().uuid(),
      status: DeliveryBookingStatusSchema,
      offeredSlots: z.array(z.string()),
      slotStart: z.string().nullable(),
      slotEnd: z.string().nullable(),
      chosenVia: z.string().nullable(),
      reminderSentAt: z.string().nullable(),
    })
    .nullable(),
  invoice: z
    .object({
      invoiceId: z.string().uuid(),
      number: z.string(),
      status: InvoiceStatusSchema,
      totalPaise: z.number().int().nonnegative(),
      amountPaidPaise: z.number().int().nonnegative(),
      /** Null when the render failed — the console offers "regenerate". */
      mediaId: z.string().uuid().nullable(),
      issuedAt: z.string().nullable(),
    })
    .nullable(),
  payment: z
    .object({
      paymentId: z.string().uuid(),
      status: PaymentStatusSchema,
      provider: z.string(),
      amountPaise: z.number().int().nonnegative(),
      amountPaidPaise: z.number().int().nonnegative(),
      shortUrl: z.string().nullable(),
      remindersSent: z.number().int().nonnegative(),
    })
    .nullable(),
  gatePass: z
    .object({
      gatePassId: z.string().uuid(),
      code: z.string(),
      status: GatePassStatusSchema,
      expiresAt: z.string(),
      usedAt: z.string().nullable(),
    })
    .nullable(),
});
export type DeliverySummaryDto = z.infer<typeof DeliverySummarySchema>;

export const ReadyAnnouncementSchema = z.object({
  bookingId: z.string().uuid(),
  messageId: z.string().uuid().nullable(),
  gateStatus: z.string(),
  amountDuePaise: z.number().int().nonnegative(),
  offeredSlots: z.array(z.object({ start: z.string(), end: z.string() })),
});
export type ReadyAnnouncement = z.infer<typeof ReadyAnnouncementSchema>;

export const IssuedInvoiceSchema = z.object({
  invoiceId: z.string().uuid(),
  number: z.string(),
  totalPaise: z.number().int().nonnegative(),
  mediaId: z.string().uuid().nullable(),
  renderHash: z.string().nullable(),
  evidenceBlocks: z.number().int().nonnegative(),
  alreadyIssued: z.boolean(),
});
export type IssuedInvoice = z.infer<typeof IssuedInvoiceSchema>;

export const PaymentLinkSchema = z.object({
  paymentId: z.string().uuid(),
  shortUrl: z.string(),
  amountPaise: z.number().int().nonnegative(),
  reused: z.boolean(),
});
export type PaymentLinkDto = z.infer<typeof PaymentLinkSchema>;

export const IssuedGatePassSchema = z.object({
  gatePassId: z.string().uuid(),
  code: z.string(),
  /** Returned once, at issue, so the console can render the QR. */
  token: z.string(),
  expiresAt: z.string(),
  reused: z.boolean(),
});
export type IssuedGatePass = z.infer<typeof IssuedGatePassSchema>;

/**
 * What the gate person's screen shows.
 *
 * `allow` is a separate boolean from `result` on purpose: the barrier depends
 * on exactly one thing, and a screen that made a person read an enum to decide
 * whether to lift it would be the wrong screen.
 */
export const GatePassVerdictSchema = z.object({
  result: GatePassVerifyResultSchema,
  allow: z.boolean(),
  detail: z.string(),
  gatePassId: z.string().uuid().nullable(),
  jobCardId: z.string().uuid().nullable(),
  summary: z
    .object({
      code: z.string(),
      registration: z.string(),
      vehicle: z.string(),
      customerName: z.string(),
      state: JobCardStateSchema,
      balance: z.string(),
      balancePaise: z.number().int().nonnegative(),
    })
    .nullable(),
});
export type GatePassVerdict = z.infer<typeof GatePassVerdictSchema>;

/* ------------------------------- problem json ----------------------------- */

export const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  detail: z.string(),
  instance: z.string().optional(),
  details: z.record(z.unknown()).optional(),
});
export type Problem = z.infer<typeof ProblemSchema>;
