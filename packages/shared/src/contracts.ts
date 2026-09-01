import { z } from 'zod';
import {
  AdvisorTaskKindSchema,
  AuditActorTypeSchema,
  AutonomyLevelSchema,
  CallDirectionSchema,
  CallEndReasonSchema,
  CallInputModeSchema,
  CallOutcomeSchema,
  CallStatusSchema,
  CallTurnRoleSchema,
  ConsentPurposeSchema,
  ConsentStatusSchema,
  ConversationKindSchema,
  ConversationStateSchema,
  DeclineReasonSchema,
  DeliveryBookingStatusSchema,
  DigestKindSchema,
  EtaMaterialitySchema,
  EtaReasonSchema,
  GatePassStatusSchema,
  GatePassVerifyResultSchema,
  AlertKindSchema,
  DocumentKindSchema,
  FeedbackSentimentSchema,
  FeedbackStatusSchema,
  IntakeDraftStatusSchema,
  IntakeSourceSchema,
  LedgerStatusSchema,
  JobCardEventSchema,
  JobCardSourceSchema,
  JobCardStateSchema,
  LanguageSchema,
  InvoiceStatusSchema,
  MediaKindSchema,
  MessageKindSchema,
  MessageStatusSchema,
  PaymentStatusSchema,
  RepitchResponseSchema,
  RetentionTouchStatusSchema,
  RetentionTriggerSchema,
  ReviewActionSchema,
  RollupSourceSchema,
  StaffRoleSchema,
  StatusSignalRouteSchema,
  StatusSignalTypeSchema,
  VoiceIntentSchema,
  TaskUrgencySchema,
  WorkItemStateSchema,
} from './enums';
import { PhoneSchema } from './phone';
import { IsoDaySchema } from './time';

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

/* -------------------------------------------------------------------------- *
 * Phase 5 — the browser softphone
 *
 * The console's `/softphone` page is the far-end handset: it answers a call the
 * loop originated, speaks (or presses keys), and hears what the agent says. The
 * transport is ordinary HTTP — a frame batch up, a frame batch down — because
 * the port boundary that matters is PCM frames, and both real adapters cross it
 * from a provider WebSocket while this one crosses it from a fetch. See the
 * deviation note in PROGRESS.md.
 * -------------------------------------------------------------------------- */

export const SoftphonePersonaSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  language: LanguageSchema,
  /** How this persona behaves: which fixture utterances it has to hand. */
  description: z.string(),
  usesKeypadOnly: z.boolean(),
});
export type SoftphonePersona = z.infer<typeof SoftphonePersonaSchema>;

export const SoftphoneCallSchema = z.object({
  callId: z.string().uuid(),
  direction: CallDirectionSchema,
  status: CallStatusSchema,
  /** The number the adapter dialled, masked to its last four digits. */
  toMasked: z.string(),
  customerName: z.string().nullable(),
  vehicleLabel: z.string().nullable(),
  jobCardCode: z.string().nullable(),
  jobCardId: z.string().uuid().nullable(),
  conversationId: z.string().uuid().nullable(),
  language: LanguageSchema,
  objective: z.string(),
  startedAt: z.string(),
  answeredAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  outcome: CallOutcomeSchema.nullable(),
  endReason: CallEndReasonSchema.nullable(),
  recording: z.object({
    active: z.boolean(),
    startedAt: z.string().nullable(),
    /** Frames captured before the notice. Must always be zero (phase 5.6). */
    framesBeforeNotice: z.number().int().min(0),
  }),
});
export type SoftphoneCall = z.infer<typeof SoftphoneCallSchema>;

export const SoftphoneTurnSchema = z.object({
  index: z.number().int().min(0),
  role: CallTurnRoleSchema,
  text: z.string(),
  inputMode: CallInputModeSchema,
  at: z.string(),
  /** Present on agent turns: the milestone timing behind the latency budget. */
  latencyMs: z.number().int().min(0).nullable(),
  bargedIn: z.boolean(),
  /** Set on the two non-removable segments, so the UI shows they were heard. */
  mandatory: z.boolean(),
});
export type SoftphoneTurn = z.infer<typeof SoftphoneTurnSchema>;

/**
 * What the handset should play, and what it should know.
 *
 * `audioBase64` is 16 kHz mono PCM16 — the same normalised frames the port
 * carries — so the browser can feed it straight into an `AudioBuffer` without
 * the page needing a codec.
 */
export const SoftphonePollResponseSchema = z.object({
  call: SoftphoneCallSchema.nullable(),
  cursor: z.number().int().min(0),
  audioBase64: z.string(),
  sampleRate: z.number().int().min(8000),
  turns: z.array(SoftphoneTurnSchema),
  /** Set when the agent bridged: the console screen-pops this card. */
  screenPop: z
    .object({
      jobCardId: z.string().uuid().nullable(),
      conversationId: z.string().uuid().nullable(),
      whisper: z.string(),
      advisorName: z.string().nullable(),
    })
    .nullable(),
});
export type SoftphonePollResponse = z.infer<typeof SoftphonePollResponseSchema>;

export const SoftphoneOriginateRequestSchema = z.object({
  /** Omit to let the API pick the longest-waiting approval on the board. */
  jobCardId: z.string().uuid().optional(),
  approvalRequestId: z.string().uuid().optional(),
  personaId: z.string().min(1).optional(),
});
export type SoftphoneOriginateRequest = z.infer<typeof SoftphoneOriginateRequestSchema>;

export const SoftphoneInboundRequestSchema = z.object({
  /** Which seeded customer is ringing in. */
  personaId: z.string().min(1),
  intentHint: VoiceIntentSchema.optional(),
});
export type SoftphoneInboundRequest = z.infer<typeof SoftphoneInboundRequestSchema>;

/**
 * The caller's half of a turn.
 *
 * Exactly one of `utterance` (a fixture the mock recogniser knows), `dtmf` (a
 * keypad press) or `audioBase64` (a live browser recording) — the softphone is
 * a real handset in all three modes and the port cannot tell them apart.
 */
export const SoftphoneSpeakRequestSchema = z
  .object({
    utterance: z.string().max(2000).optional(),
    dtmf: z.string().length(1).optional(),
    audioBase64: z.string().optional(),
    /** Simulates the caller talking over the agent (phase 5.3 barge-in). */
    interrupt: z.boolean().optional(),
  })
  .refine(
    (value) =>
      [value.utterance, value.dtmf, value.audioBase64].filter((entry) => entry !== undefined)
        .length === 1,
    { message: 'Send exactly one of utterance, dtmf or audioBase64' },
  );
export type SoftphoneSpeakRequest = z.infer<typeof SoftphoneSpeakRequestSchema>;

export const SoftphoneStateSchema = z.object({
  enabled: z.boolean(),
  killSwitch: z.boolean(),
  driver: z.string(),
  personas: z.array(SoftphonePersonaSchema),
  calls: z.array(SoftphoneCallSchema),
  advisorName: z.string().nullable(),
});
export type SoftphoneState = z.infer<typeof SoftphoneStateSchema>;

/** One row of `call_usage`, as the console's cost panel renders it. */
export const CallUsageDtoSchema = z.object({
  callId: z.string().uuid(),
  telcoSeconds: z.number().int(),
  sttSeconds: z.number().int(),
  ttsSeconds: z.number().int(),
  llmInputTokens: z.number().int(),
  llmOutputTokens: z.number().int(),
  estimatedCostPaise: z.number().int(),
  createdAt: z.string(),
});
export type CallUsageDto = z.infer<typeof CallUsageDtoSchema>;

/* -------------------------------------------------------------------------- *
 * Phase 6 — retention, the owner digest and analytics
 *
 * Two rules shape every DTO below, and both are the phase's own.
 *
 * The first: **the console never computes a KPI.** Every rate on an analytics
 * page is a field the metrics service put there, because the same numbers are
 * quoted in a WhatsApp digest an owner keeps, and a page that recomputed them
 * client-side would be a second answer to a question that has one. `RollupKpis`
 * rates are therefore nullable — "no data" is a different fact from "zero", and
 * flattening the two is how an empty week reads as a catastrophic one.
 *
 * The second: **money is paise, integers, everywhere.** No formatted strings
 * cross this boundary; formatting is the renderer's job and the locale's.
 * -------------------------------------------------------------------------- */

export const RollupKpisSchema = z.object({
  approvalTurnaroundMedianMinutes: z.number().nullable(),
  approvalTurnaroundP90Minutes: z.number().nullable(),
  approvalConversionRate: z.number().nullable(),
  statusDeflectionRate: z.number().nullable(),
  onTimeDeliveryRate: z.number().nullable(),
  declinedWorkRecoveryRate: z.number().nullable(),
  repeatVisitRate: z.number().nullable(),
  agentContainmentRate: z.number().nullable(),
  draftAcceptedWithoutEditRate: z.number().nullable(),
  voiceContainmentRate: z.number().nullable(),
});
export type RollupKpisDto = z.infer<typeof RollupKpisSchema>;

export const PendingApprovalSchema = z.object({
  approvalId: z.string().uuid(),
  jobCardId: z.string().uuid(),
  amountPaise: z.number().int(),
  requestedAt: z.string(),
  waitedMinutes: z.number().int(),
});
export type PendingApprovalDto = z.infer<typeof PendingApprovalSchema>;

/**
 * One shop-day, folded.
 *
 * Every count is a plain integer so a CSV export is a projection of this object
 * rather than a second computation of it. `turnaroundMinutes` carries the raw
 * samples because a percentile over a merged week is only correct when it is
 * taken over the week's samples — a mean of daily medians is a different and
 * wrong number.
 */
export const DailyRollupSchema = z.object({
  day: z.string(),
  timezone: z.string(),
  vehiclesIn: z.number().int(),
  vehiclesOut: z.number().int(),
  approvalsRequested: z.number().int(),
  approvalsDecided: z.number().int(),
  requestedValuePaise: z.number().int(),
  approvedValuePaise: z.number().int(),
  turnaroundMinutes: z.array(z.number()),
  pendingApprovals: z.array(PendingApprovalSchema),
  statusQueriesAnswered: z.number().int(),
  statusQueriesHandedOff: z.number().int(),
  deliveriesOnTime: z.number().int(),
  deliveriesLate: z.number().int(),
  deliveriesUnpromised: z.number().int(),
  ledgeredPaise: z.number().int(),
  ledgeredCount: z.number().int(),
  recoveredPaise: z.number().int(),
  recoveredCount: z.number().int(),
  cohortLedgeredPaise: z.number().int(),
  cohortRecoveredPaise: z.number().int(),
  optedOutCount: z.number().int(),
  repitchesSent: z.number().int(),
  retentionTouchesSent: z.number().int(),
  retentionTouchesSkipped: z.number().int(),
  visits: z.number().int(),
  repeatVisits: z.number().int(),
  feedbackPositive: z.number().int(),
  feedbackNeutral: z.number().int(),
  feedbackNegative: z.number().int(),
  reviewAsks: z.number().int(),
  agentRuns: z.number().int(),
  agentObjectiveMet: z.number().int(),
  agentHandoffs: z.number().int(),
  agentBlocked: z.number().int(),
  draftsApprovedWithoutEdit: z.number().int(),
  draftsEdited: z.number().int(),
  draftsRejected: z.number().int(),
  callsPlaced: z.number().int(),
  callsContained: z.number().int(),
  callsHandedOff: z.number().int(),
  messagesBlocked: z.number().int(),
  consentRevocations: z.number().int(),
  silentBays: z.number().int(),
  alertsRaised: z.number().int(),
});
export type DailyRollupDto = z.infer<typeof DailyRollupSchema>;

export const AnalyticsRangeSchema = z.object({
  from: z.string(),
  to: z.string(),
  days: z.array(DailyRollupSchema),
  total: DailyRollupSchema,
  kpis: RollupKpisSchema,
  /** The same KPIs over the immediately preceding window of equal length. */
  previousKpis: RollupKpisSchema.nullable(),
});
export type AnalyticsRange = z.infer<typeof AnalyticsRangeSchema>;

export const RecomputeRequestSchema = z.object({
  from: IsoDaySchema,
  to: IsoDaySchema.optional(),
});
export type RecomputeRequest = z.infer<typeof RecomputeRequestSchema>;

/**
 * What a backfill found.
 *
 * `changedDays` is the number that matters, and the reason this endpoint
 * exists: a rollup is a derived value with exactly one right answer, so a
 * recompute that changes anything is either a bug that has just been fixed or a
 * bug that has just been introduced. Either way somebody should be told, which
 * is why it is a field rather than a log line.
 *
 * `filledDays` is the number that must **not** be confused with it. A day the
 * fold had never seen is filled in, not changed — backfilling a fortnight a
 * shop was live for before analytics existed writes rollups where none stood,
 * and none of that is a regression. Counting those as changes would make the
 * alarm fire on its own first run and be ignored for ever after.
 */
export const RecomputeResultSchema = z.object({
  from: z.string(),
  to: z.string(),
  days: z.number().int(),
  /** Days that had no rollup before. Not an alarm. */
  filledDays: z.number().int(),
  /** Days that already had one and produced different numbers. The alarm. */
  changedDays: z.number().int(),
  changed: z.array(
    z.object({ day: z.string(), previousHash: z.string().nullable(), hash: z.string() }),
  ),
  source: RollupSourceSchema,
});
export type RecomputeResult = z.infer<typeof RecomputeResultSchema>;

export const LedgerItemDtoSchema = z.object({
  id: z.string().uuid(),
  jobCardId: z.string().uuid(),
  workItemId: z.string().uuid(),
  customerId: z.string().uuid().nullable(),
  vehicleId: z.string().uuid().nullable(),
  vehicleLabel: z.string().nullable(),
  customerName: z.string().nullable(),
  title: z.string().nullable(),
  technicianNote: z.string().nullable(),
  declineReason: DeclineReasonSchema,
  reason: z.string(),
  amountPaise: z.number().int(),
  category: z.string().nullable(),
  followUpAfter: z.string().nullable(),
  triggerTags: z.array(z.string()),
  status: LedgerStatusSchema,
  repitchCount: z.number().int(),
  lastRepitchedAt: z.string().nullable(),
  lastResponse: RepitchResponseSchema.nullable(),
  recoveredAmountPaise: z.number().int(),
  createdAt: z.string(),
});
export type LedgerItemDto = z.infer<typeof LedgerItemDtoSchema>;

export const LedgerListSchema = z.object({
  items: z.array(LedgerItemDtoSchema),
  openValuePaise: z.number().int(),
  recoveredValuePaise: z.number().int(),
});
export type LedgerList = z.infer<typeof LedgerListSchema>;

/**
 * The "while it's here" line in the advisor's card drawer (6.2).
 *
 * The cheapest conversion moment in the product, and the reason this is its own
 * DTO rather than a filter on the ledger list: it is read on every card open,
 * so it carries only what fits on one line and nothing that needs a join.
 */
export const NextVisitPromptSchema = z.object({
  ledgerItemId: z.string().uuid(),
  title: z.string(),
  technicianNote: z.string().nullable(),
  amountPaise: z.number().int(),
  declinedAt: z.string(),
  declineReason: DeclineReasonSchema,
  repitchCount: z.number().int(),
});
export type NextVisitPromptDto = z.infer<typeof NextVisitPromptSchema>;

export const NextVisitPromptListSchema = z.object({
  prompts: z.array(NextVisitPromptSchema),
});
export type NextVisitPromptList = z.infer<typeof NextVisitPromptListSchema>;

export const RetentionTouchDtoSchema = z.object({
  id: z.string().uuid(),
  customerId: z.string().uuid(),
  customerName: z.string().nullable(),
  vehicleLabel: z.string().nullable(),
  trigger: RetentionTriggerSchema,
  purpose: ConsentPurposeSchema,
  status: RetentionTouchStatusSchema,
  amountPaise: z.number().int(),
  scheduledFor: z.string(),
  sentAt: z.string().nullable(),
  skipCode: z.string().nullable(),
  skipReason: z.string().nullable(),
});
export type RetentionTouchDto = z.infer<typeof RetentionTouchDtoSchema>;

export const RetentionTouchListSchema = z.object({
  touches: z.array(RetentionTouchDtoSchema),
});
export type RetentionTouchList = z.infer<typeof RetentionTouchListSchema>;

export const FeedbackDtoSchema = z.object({
  id: z.string().uuid(),
  jobCardId: z.string().uuid(),
  customerId: z.string().uuid(),
  customerName: z.string().nullable(),
  vehicleLabel: z.string().nullable(),
  status: FeedbackStatusSchema,
  sentiment: FeedbackSentimentSchema.nullable(),
  comment: z.string().nullable(),
  viaVoiceNote: z.boolean(),
  deliveredAt: z.string(),
  askedAt: z.string().nullable(),
  answeredAt: z.string().nullable(),
  reviewAskedAt: z.string().nullable(),
  recoveryTaskId: z.string().uuid().nullable(),
});
export type FeedbackDto = z.infer<typeof FeedbackDtoSchema>;

export const FeedbackListSchema = z.object({
  feedback: z.array(FeedbackDtoSchema),
  positive: z.number().int(),
  neutral: z.number().int(),
  negative: z.number().int(),
});
export type FeedbackList = z.infer<typeof FeedbackListSchema>;

export const AlertDtoSchema = z.object({
  id: z.string().uuid(),
  kind: AlertKindSchema,
  detail: z.string(),
  raisedAt: z.string(),
});
export type AlertDto = z.infer<typeof AlertDtoSchema>;

export const AlertListSchema = z.object({ alerts: z.array(AlertDtoSchema) });
export type AlertList = z.infer<typeof AlertListSchema>;

/**
 * The brief, as the console renders it.
 *
 * Deliberately the *same* payload the WhatsApp message was composed from —
 * stored on the digest row, replayed here — rather than a re-composition. An
 * owner comparing the page with the message they got last night must not find
 * two different evenings.
 */
export const OwnerDigestDtoSchema = z.object({
  id: z.string().uuid(),
  kind: DigestKindSchema,
  day: z.string(),
  shopName: z.string(),
  lines: z.array(z.string()),
  numbers: z.object({
    vehiclesIn: z.number().int(),
    vehiclesOut: z.number().int(),
    approvedPaise: z.number().int(),
    recoveredPaise: z.number().int(),
    approvalsPending: z.number().int(),
    feedbackFlags: z.number().int(),
    silentBays: z.number().int(),
  }),
  actions: z.array(z.object({ id: z.string(), title: z.string() })),
  sentAt: z.string().nullable(),
});
export type OwnerDigestDto = z.infer<typeof OwnerDigestDtoSchema>;

export const OwnerDigestListSchema = z.object({ digests: z.array(OwnerDigestDtoSchema) });
export type OwnerDigestList = z.infer<typeof OwnerDigestListSchema>;

export const DocumentEnrolmentRequestSchema = z.object({
  vehicleId: z.string().uuid(),
  kind: DocumentKindSchema,
  /** A date, not an instant — nobody's PUC expires at 14:32. */
  expiresOn: IsoDaySchema,
});
export type DocumentEnrolmentRequest = z.infer<typeof DocumentEnrolmentRequestSchema>;

export const OdometerReadingRequestSchema = z.object({
  vehicleId: z.string().uuid(),
  odometerKm: z.number().int().min(0).max(2_000_000),
});
export type OdometerReadingRequest = z.infer<typeof OdometerReadingRequestSchema>;
