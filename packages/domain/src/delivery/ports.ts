import type {
  DeliveryBookingStatus,
  GatePassStatus,
  GatePassVerifyResult,
  InvoiceStatus,
  Language,
  Paise,
  PaymentEventKind,
  PaymentMethod,
  PaymentStatus,
} from '@serviceloop/shared';
import type { InvoiceDraft, InvoiceLineDraft } from './invoice-builder';

/**
 * Persistence and egress ports for the end of the loop (phase 4.7–4.10).
 *
 * Same doctrine throughout: the domain owns the rules, `packages/db` owns the
 * SQL, `packages/adapters` owns anything that leaves the process, and every
 * port is generic over an opaque `Tx`.
 */

/* -------------------------------------------------------------------------- *
 * 4.7 — pickup bookings
 * -------------------------------------------------------------------------- */

export interface DeliveryBooking {
  readonly id: string;
  readonly shopId: string;
  readonly jobCardId: string;
  readonly customerId: string;
  readonly conversationId: string | null;
  readonly status: DeliveryBookingStatus;
  readonly offeredSlots: readonly Date[];
  readonly slotStart: Date | null;
  readonly slotEnd: Date | null;
  readonly chosenVia: string | null;
  readonly chosenAt: Date | null;
  readonly offerMessageId: string | null;
  readonly reminderScheduledFor: Date | null;
  readonly reminderSentAt: Date | null;
  readonly amountDuePaise: Paise;
  readonly createdAt: Date;
}

export interface DeliveryBookingStore<Tx> {
  insert(tx: Tx, booking: DeliveryBooking): Promise<void>;

  /** Locks the row: two taps on the slot buttons must book one slot. */
  lockById(tx: Tx, shopId: string, bookingId: string): Promise<DeliveryBooking | null>;

  findOpenForCard(tx: Tx, shopId: string, jobCardId: string): Promise<DeliveryBooking | null>;

  /** Chosen slot starts already booked in a window — the per-bin cap's input. */
  bookedSlotsBetween(
    tx: Tx,
    shopId: string,
    from: Date,
    to: Date,
  ): Promise<readonly Date[]>;

  chooseSlot(
    tx: Tx,
    input: {
      readonly bookingId: string;
      readonly slotStart: Date;
      readonly slotEnd: Date;
      readonly chosenVia: string;
      readonly reminderScheduledFor: Date | null;
      readonly at: Date;
    },
  ): Promise<void>;

  attachOfferMessage(tx: Tx, bookingId: string, messageId: string): Promise<void>;

  setStatus(
    tx: Tx,
    input: {
      readonly bookingId: string;
      readonly status: DeliveryBookingStatus;
      readonly at: Date;
    },
  ): Promise<void>;

  markReminded(tx: Tx, bookingId: string, at: Date): Promise<void>;

  /** Bookings whose reminder is due. `FOR UPDATE SKIP LOCKED` in Postgres. */
  claimDueReminders(
    tx: Tx,
    input: { readonly shopId: string | null; readonly dueBefore: Date; readonly limit: number },
  ): Promise<readonly DeliveryBooking[]>;
}

/* -------------------------------------------------------------------------- *
 * 4.8 — invoices
 * -------------------------------------------------------------------------- */

export interface InvoiceRecord extends InvoiceDraft {
  readonly id: string;
  readonly shopId: string;
  readonly jobCardId: string;
  readonly customerId: string;
  readonly estimateId: string | null;
  readonly status: InvoiceStatus;
  readonly issuedAt: Date | null;
  readonly amountPaidPaise: Paise;
  readonly mediaId: string | null;
  readonly renderHash: string | null;
  readonly createdAt: Date;
}

export interface InvoiceStore<Tx> {
  /** Allocates the next number under an advisory lock, so the series is gapless. */
  nextSequence(tx: Tx, shopId: string, financialYear: string): Promise<number>;

  insert(
    tx: Tx,
    input: {
      readonly id: string;
      readonly shopId: string;
      readonly jobCardId: string;
      readonly customerId: string;
      readonly estimateId: string | null;
      readonly draft: InvoiceDraft;
      readonly issuedAt: Date;
    },
  ): Promise<void>;

  findByJobCard(tx: Tx, shopId: string, jobCardId: string): Promise<InvoiceRecord | null>;

  load(tx: Tx, shopId: string, invoiceId: string): Promise<InvoiceRecord | null>;

  lines(tx: Tx, shopId: string, invoiceId: string): Promise<readonly InvoiceLineDraft[]>;

  attachPdf(
    tx: Tx,
    input: { readonly invoiceId: string; readonly mediaId: string; readonly renderHash: string },
  ): Promise<void>;

  setStatus(
    tx: Tx,
    input: {
      readonly invoiceId: string;
      readonly status: InvoiceStatus;
      readonly amountPaidPaise: Paise;
      readonly at: Date;
    },
  ): Promise<void>;
}

/**
 * Renders an invoice to PDF bytes.
 *
 * A port because `@react-pdf/renderer` is a dependency the domain has no
 * business carrying, and because the golden-render test wants to drive the
 * renderer directly with fixed inputs and hash the bytes.
 */
export interface InvoiceRenderer {
  render(input: InvoiceRenderInput): Promise<{ readonly bytes: Buffer; readonly hash: string }>;
}

export interface InvoiceRenderInput {
  readonly invoice: InvoiceRecord;
  readonly lines: readonly InvoiceLineDraft[];
  readonly shopName: string;
  readonly customerName: string;
  readonly vehicleLabel: string;
  readonly registration: string;
  readonly jobCardCode: string;
  readonly language: Language;
  readonly timezone: string;
  readonly paymentStatus: string;
  readonly amountPaidPaise: Paise;
  /** Thumbnails and captions for the evidence appendix, in print order. */
  readonly evidence: readonly InvoiceEvidenceBlock[];
}

export interface InvoiceEvidenceBlock {
  readonly lineDescription: string;
  readonly approvedAt: Date | null;
  readonly media: readonly {
    readonly id: string;
    readonly caption: string | null;
    /** PNG/JPEG bytes of the thumbnail. Absent when the object has been erased. */
    readonly thumbnail: Buffer | null;
  }[];
}

/**
 * Stores bytes this system produced (an invoice PDF) as a MediaAsset.
 *
 * Narrower than the phase-2 `MediaService`, deliberately: that one ingests
 * *inbound* media and owns sniffing, size caps and rejection copy, none of
 * which apply to a document this process just rendered. `origin: GENERATED` is
 * what keeps the two provenances distinguishable for a DPDP export.
 */
export interface GeneratedMediaWriter {
  store(input: {
    readonly shopId: string;
    readonly jobCardId: string | null;
    readonly contentType: string;
    readonly bytes: Buffer;
    readonly filename: string;
    readonly caption: string;
    readonly traceId: string;
  }): Promise<{ readonly mediaId: string; readonly storageKey: string }>;
}

/* -------------------------------------------------------------------------- *
 * 4.9 — payments
 * -------------------------------------------------------------------------- */

/**
 * The slice of `PaymentsPort` the domain needs.
 *
 * Declared here and implemented in `packages/adapters`, exactly like
 * `ChannelSender`: the domain states what it needs a payment provider to do and
 * never learns that Razorpay exists.
 */
export interface PaymentLinkGateway {
  readonly provider: string;
  createPaymentLink(input: {
    readonly shopId: string;
    readonly jobCardId: string;
    readonly referenceId: string;
    readonly amountPaise: Paise;
    readonly description: string;
    readonly customerName: string | null;
    readonly customerPhone: string | null;
    readonly acceptPartial: boolean;
    readonly minimumFirstAmountPaise: Paise | null;
    readonly expiresAt: Date | null;
    readonly traceId: string;
  }): Promise<{
    readonly providerPaymentLinkId: string;
    readonly shortUrl: string;
    readonly expiresAt: Date | null;
  }>;
}

export interface PaymentRecord {
  readonly id: string;
  readonly shopId: string;
  readonly jobCardId: string;
  readonly invoiceId: string | null;
  readonly customerId: string | null;
  readonly provider: string;
  readonly providerPaymentLinkId: string | null;
  readonly status: PaymentStatus;
  readonly amountPaise: Paise;
  readonly amountPaidPaise: Paise;
  readonly acceptPartial: boolean;
  readonly shortUrl: string | null;
  readonly referenceId: string | null;
  readonly expiresAt: Date | null;
  readonly paidAt: Date | null;
  readonly remindersSent: number;
  readonly lastReminderAt: Date | null;
  readonly createdAt: Date;
}

export interface PaymentEventRecord {
  readonly id: string;
  readonly shopId: string;
  readonly paymentId: string;
  readonly kind: PaymentEventKind;
  readonly providerEventId: string;
  readonly providerPaymentId: string | null;
  readonly method: PaymentMethod | null;
  readonly amountPaise: Paise;
  readonly runningPaidPaise: Paise;
  readonly instrument: string | null;
  readonly failureReason: string | null;
  readonly rawPayload: Readonly<Record<string, unknown>>;
  readonly recordedByStaffId: string | null;
  readonly occurredAt: Date;
}

export interface PaymentStore<Tx> {
  insert(tx: Tx, payment: PaymentRecord): Promise<void>;

  /** Locks the payment so two webhook deliveries cannot both credit it. */
  lockById(tx: Tx, shopId: string, paymentId: string): Promise<PaymentRecord | null>;

  findByProviderLinkId(
    tx: Tx,
    shopId: string,
    providerPaymentLinkId: string,
  ): Promise<PaymentRecord | null>;

  /**
   * Resolves a payment from a provider link id **without** a shop id.
   *
   * A webhook arrives on one URL for every tenant and carries no shop of ours,
   * so the link id is the only thing that identifies which shop's money this
   * is. Scoped by uniqueness of the provider's own id rather than by trust in
   * the payload.
   */
  findByProviderLinkIdAnyShop(
    tx: Tx,
    providerPaymentLinkId: string,
  ): Promise<PaymentRecord | null>;

  findOpenForCard(tx: Tx, shopId: string, jobCardId: string): Promise<PaymentRecord | null>;

  /**
   * Appends a provider event, or returns null when `providerEventId` has
   * already been recorded — the idempotency guard for a retried webhook.
   */
  appendEvent(tx: Tx, event: PaymentEventRecord): Promise<string | null>;

  events(tx: Tx, shopId: string, paymentId: string): Promise<readonly PaymentEventRecord[]>;

  applyLedger(
    tx: Tx,
    input: {
      readonly paymentId: string;
      readonly status: PaymentStatus;
      readonly amountPaidPaise: Paise;
      readonly paidAt: Date | null;
      readonly at: Date;
    },
  ): Promise<void>;

  attachLink(
    tx: Tx,
    input: {
      readonly paymentId: string;
      readonly providerPaymentLinkId: string;
      readonly shortUrl: string;
      readonly expiresAt: Date | null;
    },
  ): Promise<void>;

  recordReminder(tx: Tx, paymentId: string, at: Date): Promise<void>;

  /** Unpaid balances whose next gentle reminder is due. */
  claimDueReminders(
    tx: Tx,
    input: {
      readonly shopId: string | null;
      readonly now: Date;
      readonly afterMinutes: readonly number[];
      readonly limit: number;
    },
  ): Promise<readonly PaymentRecord[]>;
}

/* -------------------------------------------------------------------------- *
 * 4.10 — gate passes
 * -------------------------------------------------------------------------- */

export interface GatePassRecord {
  readonly id: string;
  readonly shopId: string;
  readonly jobCardId: string;
  readonly customerId: string | null;
  readonly code: string;
  readonly tokenHash: string;
  readonly status: GatePassStatus;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
  readonly verifiedByStaffId: string | null;
  readonly overrideReason: string | null;
  readonly overrideByStaffId: string | null;
  readonly verificationAttempts: number;
  readonly lastVerifyResult: GatePassVerifyResult | null;
  readonly messageId: string | null;
}

export interface GatePassStore<Tx> {
  insert(tx: Tx, pass: GatePassRecord): Promise<void>;

  /** Locks by short code, for the gate person who typed it. */
  lockByCode(tx: Tx, shopId: string, code: string): Promise<GatePassRecord | null>;

  lockById(tx: Tx, shopId: string, gatePassId: string): Promise<GatePassRecord | null>;

  findActiveForCard(tx: Tx, shopId: string, jobCardId: string): Promise<GatePassRecord | null>;

  recordVerification(
    tx: Tx,
    input: {
      readonly gatePassId: string;
      readonly result: GatePassVerifyResult;
      readonly staffId: string | null;
      readonly markUsed: boolean;
      readonly at: Date;
    },
  ): Promise<void>;

  attachMessage(tx: Tx, gatePassId: string, messageId: string): Promise<void>;

  revoke(tx: Tx, shopId: string, gatePassId: string, at: Date): Promise<void>;
}

/**
 * The narrow slice of `AdvisorTaskService` the payment ladder needs (L6).
 *
 * A structural interface rather than the class, because `agent/advisor-tasks`
 * imports from `messaging/`, and `delivery/` importing the class would add an
 * edge to a graph that is currently acyclic. The real service satisfies this
 * without knowing it exists.
 */
export interface AdvisorTaskCreator {
  create(input: {
    readonly shopId: string;
    readonly kind: 'CALL_CUSTOMER' | 'REVIEW_MESSAGE' | 'HANDOFF' | 'OWNER_EXCEPTION' | 'FOLLOW_UP';
    readonly urgency: 'LOW' | 'NORMAL' | 'HIGH';
    readonly brief: string;
    readonly context: Readonly<Record<string, unknown>>;
    readonly jobCardId?: string | null;
    readonly conversationId?: string | null;
    readonly customerId?: string | null;
    readonly dedupeKey?: string | null;
    readonly actor: { readonly type: string; readonly id: string | null };
    readonly traceId: string;
  }): Promise<string>;
}

/**
 * Renders a gate-pass token as something a phone camera can read (phase 4.10).
 *
 * A port because QR encoding is a library and a raster, neither of which the
 * domain carries — and because the *shape* of the pass is a channel concern:
 * what the domain owns is that the image encodes a signed, expiring token and
 * nothing else. No card details, no customer name, no shop identity: a QR
 * photographed off someone's screen in a car park should reveal a capability
 * that expires, not a person.
 */
export interface QrRenderer {
  render(text: string): Promise<{ readonly bytes: Buffer; readonly contentType: string }>;
}

/**
 * The signing secret for gate-pass tokens.
 *
 * A function rather than a value so the composition root can hand over an env
 * secret without the domain importing `@serviceloop/config`, and so a future
 * rotation can return a different key without a code change here.
 */
export type GatePassSecretProvider = () => string;
