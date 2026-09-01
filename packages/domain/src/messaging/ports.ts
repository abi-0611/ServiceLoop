import type {
  ChannelType,
  ConsentPurpose,
  ConsentSource,
  ConsentStatus,
  ConversationCategory,
  ConversationKind,
  FeedbackSentiment,
  Language,
  MediaKind,
  MessageKind,
  MessageStatus,
  RepitchResponse,
} from '@serviceloop/shared';
import type { Actor } from '../job-card/context';
import type { CaptureOutcome, ParsedStatusSignal } from '../status/types';
import type {
  ConsentSnapshotRow,
  ConversationSnapshot,
  OutboundContent,
  OutboundListSection,
  OutboundButton,
} from './types';

/**
 * Persistence and channel ports for messaging.
 *
 * Same doctrine as `../ports.ts`: the domain owns the rules, `packages/db` owns
 * the SQL, and every port is generic over an opaque `Tx` so neither package
 * ever sees the other's types.
 */

export interface CreateConversationInput {
  readonly shopId: string;
  readonly kind: ConversationKind;
  readonly channel: ChannelType;
  readonly customerId: string | null;
  readonly externalThreadId: string;
  readonly externalAddress: string | null;
  readonly displayName: string | null;
  readonly language: Language;
}

export interface ConversationStore<Tx> {
  /**
   * Looks a thread up by its provider address. This is the hot path on every
   * inbound webhook, so it is keyed on the unique (shop, channel, thread) index.
   */
  findByThreadKey(
    tx: Tx,
    shopId: string,
    channel: ChannelType,
    externalThreadId: string,
  ): Promise<ConversationSnapshot | null>;

  findById(tx: Tx, shopId: string, conversationId: string): Promise<ConversationSnapshot | null>;

  /** Locks the row so two webhooks for one thread cannot interleave. */
  lockById(tx: Tx, shopId: string, conversationId: string): Promise<ConversationSnapshot | null>;

  findByCustomer(
    tx: Tx,
    shopId: string,
    customerId: string,
    channel: ChannelType,
  ): Promise<ConversationSnapshot | null>;

  create(tx: Tx, input: CreateConversationInput): Promise<ConversationSnapshot>;

  recordInbound(
    tx: Tx,
    input: {
      readonly conversationId: string;
      readonly at: Date;
      readonly windowExpiresAt: Date;
      readonly language?: Language;
    },
  ): Promise<void>;

  recordOutbound(tx: Tx, input: { readonly conversationId: string; readonly at: Date }): Promise<void>;

  /** A human advisor replied by hand; phase 3 pauses agent objectives on this. */
  markHumanOverride(
    tx: Tx,
    input: { readonly conversationId: string; readonly at: Date },
  ): Promise<void>;

  /** Promotes an UNKNOWN thread to a customer thread once identified. */
  attachCustomer(
    tx: Tx,
    input: {
      readonly conversationId: string;
      readonly customerId: string;
      readonly displayName: string | null;
    },
  ): Promise<void>;

  clearUnread(tx: Tx, shopId: string, conversationId: string): Promise<void>;

  setLanguage(tx: Tx, conversationId: string, language: Language): Promise<void>;
}

export interface InsertMessageInput {
  readonly id: string;
  readonly shopId: string;
  readonly conversationId: string;
  readonly direction: 'INBOUND' | 'OUTBOUND';
  readonly status: MessageStatus;
  readonly channel: ChannelType;
  readonly kind: MessageKind;
  readonly language: Language;
  readonly body: string;
  readonly purpose: ConsentPurpose;
  readonly templateName?: string | null;
  readonly templateLanguage?: string | null;
  readonly templateVariables?: readonly string[] | null;
  readonly interactive?: unknown;
  readonly conversationCategory?: ConversationCategory | null;
  readonly providerMessageId?: string | null;
  readonly providerConversationId?: string | null;
  readonly mediaId?: string | null;
  readonly jobCardId?: string | null;
  readonly senderStaffId?: string | null;
  readonly replyToMessageId?: string | null;
  readonly evidenceRefs?: readonly unknown[];
  readonly createdByAgent?: boolean;
  readonly isHumanReply?: boolean;
  readonly agentRunId?: string | null;
  readonly approvedByStaffId?: string | null;
  readonly scheduledFor?: Date | null;
  readonly blockedCode?: string | null;
  readonly blockedReason?: string | null;
  readonly sentAt?: Date | null;
  readonly createdAt: Date;
}

export interface MessageStore<Tx> {
  insert(tx: Tx, input: InsertMessageInput): Promise<void>;

  /**
   * Idempotency for redelivered webhooks: Meta retries aggressively, and a
   * duplicate inbound must not produce a second job-card draft.
   */
  findByProviderMessageId(
    tx: Tx,
    shopId: string,
    providerMessageId: string,
  ): Promise<{ readonly id: string; readonly conversationId: string } | null>;

  markSent(
    tx: Tx,
    input: {
      readonly messageId: string;
      readonly providerMessageId: string;
      readonly providerConversationId: string | null;
      readonly conversationCategory: ConversationCategory | null;
      readonly sentAt: Date;
    },
  ): Promise<void>;

  /**
   * Puts a message back in the send queue for a later time.
   *
   * The quiet-hours path on `release()` needs this: a candidate an advisor
   * approved at 21:30 has left `PENDING_APPROVAL`, and without a `QUEUED` row
   * carrying a `scheduledFor` the deferred sender would never pick it up — the
   * message would sit in the review queue for ever, looking un-actioned to
   * everyone including the advisor who actioned it.
   */
  reschedule(
    tx: Tx,
    input: { readonly messageId: string; readonly scheduledFor: Date },
  ): Promise<void>;

  markFailed(
    tx: Tx,
    input: {
      readonly messageId: string;
      readonly errorCode: string | null;
      readonly failureReason: string;
    },
  ): Promise<void>;

  updateDeliveryState(
    tx: Tx,
    input: {
      readonly shopId: string;
      readonly providerMessageId: string;
      readonly status: MessageStatus;
      readonly at: Date;
      readonly errorCode?: string | null;
      readonly failureReason?: string | null;
    },
  ): Promise<boolean>;

  /** Outbound timestamps for this customer, newest first — the frequency cap input. */
  recentOutboundAt(
    tx: Tx,
    shopId: string,
    customerId: string,
    since: Date,
  ): Promise<readonly Date[]>;

  /** True when nothing has been sent on this thread yet (disclosure check). */
  countOutbound(tx: Tx, conversationId: string): Promise<number>;

  /**
   * Claims quiet-hours holds whose time has come.
   *
   * `FOR UPDATE SKIP LOCKED` in the Postgres implementation, so two workers
   * draining the queue take disjoint batches rather than both releasing the
   * same message — which the customer would receive twice.
   */
  claimDueScheduled(
    tx: Tx,
    input: {
      readonly shopId: string | null;
      readonly dueBefore: Date;
      readonly limit: number;
    },
  ): Promise<readonly ScheduledMessage[]>;
}

/** Enough of a held message to re-run the gate over it. */
export interface ScheduledMessage {
  readonly id: string;
  readonly shopId: string;
  readonly conversationId: string;
  readonly customerId: string | null;
  readonly purpose: ConsentPurpose;
  readonly kind: MessageKind;
  readonly language: Language;
  readonly body: string;
  readonly templateName: string | null;
  readonly templateLanguage: string | null;
  readonly templateVariables: readonly string[] | null;
  readonly conversationCategory: ConversationCategory | null;
  readonly interactive: unknown;
  readonly mediaId: string | null;
  readonly jobCardId: string | null;
  readonly createdByAgent: boolean;
  readonly isHumanReply: boolean;
  readonly agentRunId: string | null;
  readonly approvedByStaffId: string | null;
  readonly scheduledFor: Date;
}

export interface ConsentStore<Tx> {
  /** Latest row per purpose — the registry is append-oriented, newest wins. */
  current(tx: Tx, shopId: string, customerId: string): Promise<readonly ConsentSnapshotRow[]>;

  record(
    tx: Tx,
    input: {
      readonly id: string;
      readonly shopId: string;
      readonly customerId: string;
      readonly purpose: ConsentPurpose;
      readonly status: ConsentStatus;
      readonly channel: ChannelType;
      readonly source: ConsentSource;
      readonly evidence: string | null;
      readonly messageId: string | null;
      readonly capturedByStaffId: string | null;
      readonly at: Date;
    },
  ): Promise<void>;
}

/* -------------------------------------------------------------------------- *
 * Channel egress
 * -------------------------------------------------------------------------- */

export interface ChannelSendResult {
  readonly providerMessageId: string;
  readonly providerConversationId: string | null;
  readonly category: ConversationCategory | null;
}

export interface ChannelSendRequest {
  readonly shopId: string;
  /** E.164 for a person, `group:<id>` for the staff evidence channel. */
  readonly to: string;
  readonly content: OutboundContent;
}

/**
 * The transport the gate hands an approved message to. `packages/adapters`
 * provides the WhatsApp implementation; the domain never imports it.
 */
export interface ChannelSender {
  readonly channel: ChannelType;
  send(request: ChannelSendRequest): Promise<ChannelSendResult>;
}

/**
 * What the three approval buttons do (phase 3.6).
 *
 * A port rather than a direct call to `ApprovalService`, and the direction of
 * the dependency is why: the agent module already imports `OutboundGate` from
 * here, so `InboundHandler` importing the agent would close a cycle. The
 * handler knows a button was tapped; this port knows what that means.
 *
 * Optional on the handler's dependencies — a deployment without the agent still
 * routes messages, it just has no buttons to answer.
 */
export interface ApprovalReplyPort {
  /** Approve everything that was put to them. */
  approve(input: ApprovalReplyInput): Promise<ApprovalReplyResult>;
  /**
   * "Approve partially · ask a question" — opens the `resolve_partial_approval`
   * objective on the thread rather than guessing what they meant.
   */
  openObjection(input: ApprovalReplyInput): Promise<ApprovalReplyResult>;
  /** "Call me" — an immediate handoff at high urgency (L6). */
  requestCall(input: ApprovalReplyInput): Promise<ApprovalReplyResult>;
}

export interface ApprovalReplyInput {
  readonly shopId: string;
  readonly conversationId: string;
  readonly customerId: string | null;
  /** The message the customer's tap arrived on, for idempotency. */
  readonly triggerMessageId: string | null;
  readonly replyTitle: string | null;
  readonly traceId: string;
}

export interface ApprovalReplyResult {
  readonly handled: boolean;
  readonly detail: string;
  readonly approvalId: string | null;
}

/**
 * What a staff-group note becomes (phase 4.2).
 *
 * Same shape of argument as `ApprovalReplyPort` above, and for the same reason:
 * the status module imports `OutboundGate` from here, so `InboundHandler`
 * importing the status service would close a cycle. The handler knows a
 * technician said something; this port knows what it means.
 *
 * Split into `read` and `capture` deliberately. Reading is transcription plus
 * an extraction and writes nothing; capturing resolves the vehicle and can move
 * a customer's job card. Between the two sits a decision the *handler* has to
 * make — is this a status note at all, or a new car arriving? — and a port with
 * one method would have taken that decision away from the only place that has
 * the context to make it.
 */
export interface TechnicianNotePort {
  /** Audio or text in, transcript and parse out. No writes. */
  read(input: TechnicianNoteReadInput): Promise<TechnicianNoteReading | null>;

  /** Resolves the vehicle and routes the signal. */
  capture(input: TechnicianNoteCaptureInput): Promise<CaptureOutcome>;

  /** A tap on ✅ in the staff group. */
  confirm(input: StatusTapInput): Promise<CaptureOutcome>;

  /** A tap on ✏️ — the note was wrong, and saying so is worth recording. */
  discard(input: StatusTapInput): Promise<CaptureOutcome>;
}

export interface TechnicianNoteReadInput {
  readonly shopId: string;
  /** The words, when there are any: a typed line or a photo's caption. */
  readonly text: string;
  /** The voice note, when there is one. Transcribed before parsing. */
  readonly audio: { readonly bytes: Buffer; readonly contentType: string } | null;
  readonly languageHint: Language;
  readonly traceId: string;
}

export interface TechnicianNoteReading {
  readonly transcript: string;
  /** 0–1 from the recogniser, or null when the note was typed. */
  readonly transcriptConfidence: number | null;
  readonly parsed: ParsedStatusSignal;
}

/**
 * Structurally identical to `CaptureStatusSignalInput` on the status service,
 * and declared here rather than imported: `status/` imports `OutboundGate` from
 * this module, and a value import back the other way would close the cycle the
 * port exists to avoid.
 */
export interface TechnicianNoteCaptureInput {
  readonly shopId: string;
  readonly parsed: ParsedStatusSignal;
  readonly source: 'VOICE_NOTE' | 'PHOTO' | 'TEXT' | 'CONSOLE';
  readonly transcript: string;
  readonly transcriptConfidence: number | null;
  readonly conversationId: string | null;
  readonly messageId: string | null;
  readonly mediaId: string | null;
  readonly senderStaffId: string | null;
  /** The staff-group message this note replied to, if any. */
  readonly replyToMessageId: string | null;
  readonly actor: Actor;
  readonly traceId: string;
}

export interface StatusTapInput {
  readonly shopId: string;
  readonly signalId: string;
  readonly staffId: string | null;
  /** Set when the tap was answering "which of these two cards?". */
  readonly jobCardId?: string | null;
  readonly actor: Actor;
  readonly traceId: string;
}

/**
 * Does this note say which vehicle it is about? (phase 4.2)
 *
 * The staff group carries two kinds of note that sound alike — *"4432 brake
 * pads done"* and *"new Swift just came in, AC not cooling"* — and only one of
 * them may move an existing job card. Nothing in the words separates them
 * reliably, so the system uses the one thing that does: whether the speaker
 * identified a vehicle the shop already has open.
 *
 * A plate fragment, a job-card code, or a reply to the message about that car
 * counts. A bare note does not, and falls through to intake, which ends in a
 * draft an advisor proofreads rather than a transition nobody asked for.
 *
 * The cost is one advisor tap that would otherwise have been offered — a note
 * naming no vehicle can never reach the auto-apply bar anyway, because the
 * parser docks it for exactly that. The instruction to technicians is a
 * sentence: say the last four digits, or reply to the car's message.
 */
export function noteIdentifiesAVehicle(input: {
  readonly parsed: ParsedStatusSignal;
  readonly hasReplyContext: boolean;
}): boolean {
  return (
    input.parsed.registrationFragment !== null ||
    input.parsed.jobCardCode !== null ||
    input.hasReplyContext
  );
}

/**
 * The customer's pickup-slot tap (phase 4.7).
 *
 * Optional on the handler, like the approval buttons: a deployment with no
 * delivery module still routes the message, it just has no slot to book.
 */
export interface SlotReplyPort {
  chooseSlot(input: {
    readonly shopId: string;
    readonly bookingId: string;
    readonly slotIndex: number;
    readonly chosenVia: string;
    readonly actor: Actor;
    readonly traceId: string;
  }): Promise<{ readonly ok: boolean; readonly code?: string; readonly reason?: string }>;
}

/**
 * What the phase-6 taps do (6.3, 6.4, 6.5, 6.6, 6.7).
 *
 * Optional on the handler, like `ApprovalReplyPort` and `SlotReplyPort`, and
 * for the same reason: a deployment without the retention module still routes
 * every message — a tap is recognised, logged and nothing else happens. What it
 * must never do is fall through to the intake pipeline, which would turn "Not
 * interested" into a draft job card.
 *
 * Five methods rather than one dispatcher because the five taps mean five
 * different things to five different services, and a single `handle(replyId)`
 * would put the routing decision behind an interface where nothing could test
 * it. The parsing lives in `retention-actions.ts`; this is what the parse is
 * *for*.
 */
export interface RetentionReplyPort {
  /** Book a slot / Remind me later / Not interested, on a re-pitch (6.3). */
  answerRepitch(input: {
    readonly shopId: string;
    readonly ledgerItemId: string;
    readonly response: RepitchResponse;
    readonly conversationId: string;
    readonly customerId: string | null;
    readonly actor: Actor;
    readonly traceId: string;
  }): Promise<{ readonly handled: boolean; readonly detail: string }>;

  /** 😊 😐 😞 on a post-service ask (6.4). */
  answerFeedback(input: {
    readonly shopId: string;
    readonly feedbackId: string;
    readonly sentiment: FeedbackSentiment;
    readonly conversationId: string | null;
    readonly actor: Actor;
    readonly traceId: string;
  }): Promise<{ readonly handled: boolean; readonly detail: string }>;

  /**
   * A free-text or voice-note comment following a face (6.4).
   *
   * Separate from `answerFeedback` because it arrives as an ordinary message
   * minutes later, not as a tap, and because a comment with no open feedback
   * record is just a message — the handler needs to be told that, not to guess.
   */
  attachFeedbackComment(input: {
    readonly shopId: string;
    readonly customerId: string;
    readonly comment: string;
    readonly viaVoiceNote: boolean;
    readonly mediaId: string | null;
    readonly traceId: string;
  }): Promise<boolean>;

  /** Yes / no to tracking insurance and PUC dates (6.5). */
  answerDocumentEnrolment(input: {
    readonly shopId: string;
    readonly vehicleId: string;
    readonly customerId: string;
    readonly enrol: boolean;
    readonly conversationId: string | null;
    readonly actor: Actor;
    readonly traceId: string;
  }): Promise<{ readonly handled: boolean; readonly detail: string }>;

  /** The second, explicit MARKETING ask (6.6). */
  answerMarketingConsent(input: {
    readonly shopId: string;
    readonly customerId: string;
    readonly conversationId: string;
    readonly decision: 'GRANT' | 'DECLINE';
    readonly evidence: string;
    readonly actor: Actor;
    readonly traceId: string;
  }): Promise<{ readonly handled: boolean; readonly detail: string }>;

  /**
   * A bare number that might be an odometer reading (6.2).
   *
   * Returns null when it is not one, which is the ordinary case: the caller
   * then carries on treating the message as whatever else it is.
   */
  recordVolunteeredOdometer(input: {
    readonly shopId: string;
    readonly customerId: string;
    readonly text: string;
    readonly messageId: string | null;
    readonly actor: Actor;
    readonly traceId: string;
  }): Promise<{ readonly vehicleId: string; readonly odometerKm: number } | null>;

  /** "I'll call" on a digest line — staff, not a customer (6.7). */
  claimDigestLine(input: {
    readonly shopId: string;
    readonly approvalId: string;
    readonly claimedByStaffId: string | null;
    readonly conversationId: string | null;
    readonly actor: Actor;
    readonly traceId: string;
  }): Promise<{ readonly handled: boolean; readonly detail: string }>;
}

/**
 * The retention half of the gate's frequency layer (phase 6.1).
 *
 * Declared here rather than in `retention/` for the reason `SlotReplyPort` is:
 * the retention module imports `OutboundGate` from this one, so a value import
 * back the other way would close a cycle. It is also the narrowest possible
 * surface on purpose — `packages/domain/messaging` must not learn what a ledger
 * item is in order to enforce a cap.
 *
 * Two questions, two answers: when did we last write to this person for
 * retention, and is there a hold on them. The gate applies the shop's
 * twenty-one-day floor to the first and refuses outright on the second.
 *
 * Optional on the gate's dependencies. A deployment without the retention
 * module still sends messages; it simply has no retention traffic to apply a
 * retention floor to.
 */
export interface RetentionGateFacts {
  /** The last retention touch that actually reached this customer. */
  readonly lastTouchAt: Date | null;
  /** Non-null while a hold is open — a negative review, a complaint. */
  readonly frozenReason: string | null;
}

export interface RetentionFrequencyReader<Tx> {
  facts(tx: Tx, shopId: string, customerId: string): Promise<RetentionGateFacts>;
}

export interface CustomerLookup<Tx> {
  /** Resolves a caller by phone. Null when this shop has never seen the number. */
  findCustomerIdByPhone(tx: Tx, shopId: string, phoneE164: string): Promise<string | null>;
  /** Staff are matched on the same number, so the evidence group attributes lines. */
  findStaffIdByPhone(tx: Tx, shopId: string, phoneE164: string): Promise<string | null>;
  loadCustomerLanguage(tx: Tx, shopId: string, customerId: string): Promise<Language | null>;
  /**
   * A human-readable vehicle for consent copy ("updates about your Swift
   * TN09BX4432"). Naming the vehicle is what makes the ask specific enough to
   * be a real purpose limitation rather than a blanket permission.
   */
  loadCustomerVehicleLabel(tx: Tx, shopId: string, customerId: string): Promise<string | null>;
}

/** Re-exported so store implementations get the shapes from one import. */
export type {
  ConversationSnapshot,
  OutboundContent,
  OutboundButton,
  OutboundListSection,
  ConsentSnapshotRow,
  MediaKind,
};
