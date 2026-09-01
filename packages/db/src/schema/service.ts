import { relations } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, primaryId, timestamptz, updatedAt } from './columns';
import { conversations, messages } from './comms';
import { customers, shops, staff } from './core';
import {
  deliveryBookingStatusEnum,
  etaMaterialityEnum,
  etaReasonEnum,
  gatePassStatusEnum,
  gatePassVerifyResultEnum,
  invoiceStatusEnum,
  jobCardStateEnum,
  languageEnum,
  paymentEventKindEnum,
  paymentMethodEnum,
  paymentStatusEnum,
  statusSignalRouteEnum,
  statusSignalSourceEnum,
  statusSignalTypeEnum,
} from './enums';
import { estimateLines, jobCards, mediaAssets, workItems } from './jobs';

/**
 * Phase 4 — the middle and the end of the loop.
 *
 * Status capture from technician voice notes, the ETA engine's versioned
 * history, the silent-bay sentinel, pickup slotting, invoices, payments and the
 * gate pass. Everything here hangs off a job card, and everything money-shaped
 * is append-only: `payment_events` is a ledger, not a mutable balance, because
 * "how much have they paid" must stay answerable after a refund, a reversal, or
 * a provider replaying a webhook from last Tuesday.
 */

/* -------------------------------------------------------------------------- *
 * 4.2 — technician status signals
 * -------------------------------------------------------------------------- */

/**
 * One parsed technician utterance.
 *
 * The row is written **whatever** the parser decided, including when it could
 * not find a card at all. That is deliberate: the accuracy of the status parser
 * is a number the shop should be able to see, and a parser that only records
 * its successes cannot be measured. `route` is how it was handled and
 * `confidence` is how sure it was, so "what fraction auto-applied, and were
 * they right" is one query.
 */
export const statusSignals = pgTable(
  'status_signals',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    /** Null when the parser could not resolve which card was meant. */
    jobCardId: uuid('job_card_id').references(() => jobCards.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    /** The staff-group message this came in on, for idempotency and context. */
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    mediaId: uuid('media_id').references(() => mediaAssets.id, { onDelete: 'set null' }),
    senderStaffId: uuid('sender_staff_id').references(() => staff.id, { onDelete: 'set null' }),
    signalType: statusSignalTypeEnum('signal_type').notNull(),
    source: statusSignalSourceEnum('source').notNull(),
    route: statusSignalRouteEnum('route').notNull(),
    confidence: integer('confidence_bp').notNull(),
    /** Verbatim, in whatever language and register it was said in (L4). */
    transcript: text('transcript').notNull(),
    language: languageEnum('language').notNull().default('en'),
    /** Recogniser confidence, kept separate: a shaky transcript is its own fact. */
    transcriptConfidence: integer('transcript_confidence_bp'),
    workItemIds: jsonb('work_item_ids').notNull().default([]),
    /** A time the technician named ("part varum 4 maniku"). */
    etaHint: timestamptz('eta_hint'),
    /** Which cards matched, when more than one did — the disambiguation ask. */
    candidateJobCardIds: jsonb('candidate_job_card_ids').notNull().default([]),
    /** How the card was found: assignment, registration fragment, reply context. */
    matchBasis: text('match_basis'),
    /** Set once an advisor confirms or corrects a low-confidence signal. */
    resolvedByStaffId: uuid('resolved_by_staff_id').references(() => staff.id, {
      onDelete: 'set null',
    }),
    resolvedAt: timestamptz('resolved_at'),
    /** The transition or bundle this produced, for the audit trail. */
    appliedDetail: text('applied_detail'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('status_signals_shop_created_idx').on(table.shopId, table.createdAt),
    index('status_signals_job_card_idx').on(table.jobCardId, table.createdAt),
    index('status_signals_pending_idx').on(table.shopId, table.route, table.createdAt),
    // One signal per inbound message: a redelivered webhook must not apply a
    // technician's "done" twice and close two work items.
    uniqueIndex('status_signals_message_key').on(table.shopId, table.messageId),
  ],
);

/* -------------------------------------------------------------------------- *
 * 4.3 — ETA history
 * -------------------------------------------------------------------------- */

/**
 * The versioned ETA history for a card.
 *
 * Append-only and versioned rather than a column that gets overwritten, because
 * the question a customer actually asks is "you said four o'clock" — and
 * answering it needs the old value, when it changed, and *why*. `reason` is an
 * enum so the customer-facing sentence is generated in their language from the
 * same fact the console shows the advisor.
 */
export const etaEntries = pgTable(
  'eta_entries',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    jobCardId: uuid('job_card_id')
      .notNull()
      .references(() => jobCards.id, { onDelete: 'cascade' }),
    /** Monotonic per card, starting at 1. */
    version: integer('version').notNull(),
    previousEta: timestamptz('previous_eta'),
    eta: timestamptz('eta').notNull(),
    promisedAt: timestamptz('promised_at'),
    reason: etaReasonEnum('reason').notNull(),
    materiality: etaMaterialityEnum('materiality').notNull(),
    /** Signed: negative means the car got earlier. */
    deltaMinutes: integer('delta_minutes').notNull().default(0),
    /** The explainable half — "brake caliper part arrives by 4pm". */
    detail: text('detail').notNull(),
    /** What triggered the recalculation, when it was a technician signal. */
    statusSignalId: uuid('status_signal_id').references(() => statusSignals.id, {
      onDelete: 'set null',
    }),
    /** Set once a customer has been told about this change. */
    notifiedAt: timestamptz('notified_at'),
    notifiedMessageId: uuid('notified_message_id'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('eta_entries_card_version_key').on(table.jobCardId, table.version),
    index('eta_entries_shop_created_idx').on(table.shopId, table.createdAt),
    // The proactive-comms worker's read: material changes nobody has been told
    // about yet.
    index('eta_entries_unnotified_idx').on(table.shopId, table.materiality, table.notifiedAt),
  ],
);

/* -------------------------------------------------------------------------- *
 * 4.6 — silent-bay sentinel
 * -------------------------------------------------------------------------- */

/**
 * One row per card per silent window.
 *
 * The unique index is the whole idempotency story: the scan claims
 * `(job_card_id, window_start)` and a scan that runs twice in the same window —
 * two workers, a restart, a clock skew — inserts nothing the second time and
 * therefore nudges nobody twice. Counting rows per card is also how
 * "repeated silence" becomes an owner-digest exception without a second table.
 */
export const silentBayNudges = pgTable(
  'silent_bay_nudges',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    jobCardId: uuid('job_card_id')
      .notNull()
      .references(() => jobCards.id, { onDelete: 'cascade' }),
    /** Start of the window this nudge covers, truncated to the window length. */
    windowStart: timestamptz('window_start').notNull(),
    state: jobCardStateEnum('state').notNull(),
    quietForMinutes: integer('quiet_for_minutes').notNull(),
    /** How many windows in a row this card has been silent. */
    consecutiveWindows: integer('consecutive_windows').notNull().default(1),
    /** The staff-group message that carried the nudge; null if the gate held it. */
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    escalatedToOwner: boolean('escalated_to_owner').notNull().default(false),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('silent_bay_nudges_card_window_key').on(table.jobCardId, table.windowStart),
    index('silent_bay_nudges_shop_idx').on(table.shopId, table.windowStart),
  ],
);

/* -------------------------------------------------------------------------- *
 * 4.7 — pickup slots
 * -------------------------------------------------------------------------- */

export const deliveryBookings = pgTable(
  'delivery_bookings',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    jobCardId: uuid('job_card_id')
      .notNull()
      .references(() => jobCards.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    status: deliveryBookingStatusEnum('status').notNull().default('OFFERED'),
    /** The slots put to the customer, as ISO instants, in the order shown. */
    offeredSlots: jsonb('offered_slots').notNull().default([]),
    slotStart: timestamptz('slot_start'),
    slotEnd: timestamptz('slot_end'),
    chosenVia: text('chosen_via'),
    chosenAt: timestamptz('chosen_at'),
    /** The interactive message carrying the slot buttons. */
    offerMessageId: uuid('offer_message_id'),
    reminderScheduledFor: timestamptz('reminder_scheduled_for'),
    reminderSentAt: timestamptz('reminder_sent_at'),
    amountDuePaise: bigint('amount_due_paise', { mode: 'number' }).notNull().default(0),
    completedAt: timestamptz('completed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('delivery_bookings_job_card_idx').on(table.jobCardId),
    index('delivery_bookings_shop_status_idx').on(table.shopId, table.status),
    // The slotting cap counts bookings per bin, so the bin has to be indexed.
    index('delivery_bookings_slot_idx').on(table.shopId, table.slotStart),
    index('delivery_bookings_reminder_idx').on(table.status, table.reminderScheduledFor),
  ],
);

/* -------------------------------------------------------------------------- *
 * 4.8 — invoices
 * -------------------------------------------------------------------------- */

/**
 * A tax invoice.
 *
 * The letterhead fields are **copied onto the row**, not read from shop config
 * at render time. An invoice is a legal statement about who charged whom on a
 * date; re-rendering last month's invoice after the shop corrected its address
 * must reproduce last month's document, not today's.
 */
export const invoices = pgTable(
  'invoices',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    jobCardId: uuid('job_card_id')
      .notNull()
      .references(() => jobCards.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    estimateId: uuid('estimate_id'),
    /**
     * Set when the customer this invoice belongs to has been erased
     * (phase 7.2). The invoice itself is retained under the GST record-keeping
     * carve-out; what is erased is who it was for.
     */
    subjectPseudonym: text('subject_pseudonym'),
    /** End of the statutory retention window for this retained record. */
    retainedUntil: timestamptz('retained_until'),
    number: text('number').notNull(),
    status: invoiceStatusEnum('status').notNull().default('DRAFT'),
    issuedAt: timestamptz('issued_at'),
    currency: text('currency').notNull().default('INR'),
    subtotalPaise: bigint('subtotal_paise', { mode: 'number' }).notNull().default(0),
    /** Split out so the PDF can print the two halves a GST invoice must show. */
    cgstPaise: bigint('cgst_paise', { mode: 'number' }).notNull().default(0),
    sgstPaise: bigint('sgst_paise', { mode: 'number' }).notNull().default(0),
    igstPaise: bigint('igst_paise', { mode: 'number' }).notNull().default(0),
    totalPaise: bigint('total_paise', { mode: 'number' }).notNull().default(0),
    amountPaidPaise: bigint('amount_paid_paise', { mode: 'number' }).notNull().default(0),
    /** Frozen letterhead. See the note above. */
    sellerName: text('seller_name').notNull(),
    sellerGstin: text('seller_gstin'),
    sellerAddress: jsonb('seller_address').notNull().default([]),
    sellerStateCode: text('seller_state_code'),
    placeOfSupplyStateCode: text('place_of_supply_state_code'),
    /** True when seller and place of supply share a state: CGST + SGST. */
    intraState: boolean('intra_state').notNull().default(true),
    footerNote: text('footer_note').notNull().default(''),
    /** The rendered PDF in object storage. */
    mediaId: uuid('media_id').references(() => mediaAssets.id, { onDelete: 'set null' }),
    /** Media ids reproduced in the evidence appendix, in print order. */
    evidenceMediaIds: jsonb('evidence_media_ids').notNull().default([]),
    /** sha256 of the rendered bytes — what the golden test pins. */
    renderHash: text('render_hash'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('invoices_shop_number_key').on(table.shopId, table.number),
    // One live invoice per card. A second is a correction, and a correction
    // that silently coexisted with the original is how two totals get quoted.
    uniqueIndex('invoices_job_card_key').on(table.jobCardId),
    index('invoices_shop_status_idx').on(table.shopId, table.status),
  ],
);

export const invoiceLines = pgTable(
  'invoice_lines',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    /** The approved estimate line this bills. Null once that line is erased. */
    estimateLineId: uuid('estimate_line_id').references(() => estimateLines.id, {
      onDelete: 'set null',
    }),
    workItemId: uuid('work_item_id').references(() => workItems.id, { onDelete: 'set null' }),
    description: text('description').notNull(),
    hsnSac: text('hsn_sac'),
    quantityMilli: integer('quantity_milli').notNull().default(1000),
    unitPricePaise: bigint('unit_price_paise', { mode: 'number' }).notNull(),
    lineTotalPaise: bigint('line_total_paise', { mode: 'number' }).notNull(),
    taxRateBp: integer('tax_rate_bp').notNull().default(1800),
    cgstPaise: bigint('cgst_paise', { mode: 'number' }).notNull().default(0),
    sgstPaise: bigint('sgst_paise', { mode: 'number' }).notNull().default(0),
    igstPaise: bigint('igst_paise', { mode: 'number' }).notNull().default(0),
    /**
     * True when this line was added after intake and approved by the customer.
     * The evidence appendix prints a block for exactly these.
     */
    isAdditionalWork: boolean('is_additional_work').notNull().default(false),
    approvedAt: timestamptz('approved_at'),
    evidenceMediaIds: jsonb('evidence_media_ids').notNull().default([]),
    sequence: integer('sequence').notNull().default(0),
    createdAt: createdAt(),
  },
  (table) => [index('invoice_lines_invoice_idx').on(table.invoiceId, table.sequence)],
);

/* -------------------------------------------------------------------------- *
 * 4.9 — payments
 * -------------------------------------------------------------------------- */

export const payments = pgTable(
  'payments',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    jobCardId: uuid('job_card_id')
      .notNull()
      .references(() => jobCards.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id').references(() => invoices.id, { onDelete: 'set null' }),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    provider: text('provider').notNull(),
    /** The provider's own handle for the link — the webhook's join key. */
    providerPaymentLinkId: text('provider_payment_link_id'),
    status: paymentStatusEnum('status').notNull().default('PENDING'),
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
    /** Derived from the event ledger, never written by hand. */
    amountPaidPaise: bigint('amount_paid_paise', { mode: 'number' }).notNull().default(0),
    acceptPartial: boolean('accept_partial').notNull().default(false),
    shortUrl: text('short_url'),
    referenceId: text('reference_id'),
    expiresAt: timestamptz('expires_at'),
    paidAt: timestamptz('paid_at'),
    /** How many gentle reminders have gone out. Hard-capped at two (4.9). */
    remindersSent: integer('reminders_sent').notNull().default(0),
    lastReminderAt: timestamptz('last_reminder_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('payments_job_card_idx').on(table.jobCardId),
    index('payments_shop_status_idx').on(table.shopId, table.status),
    uniqueIndex('payments_provider_link_key').on(table.shopId, table.providerPaymentLinkId),
  ],
);

/**
 * Append-only ledger of everything a provider told us about a payment.
 *
 * `provider_event_id` is unique per shop and that is the idempotency guard:
 * Razorpay retries a webhook until it gets a 2xx, and the second delivery of
 * `payment_link.paid` must not credit the customer twice. Recording the raw
 * payload alongside is what makes a disputed payment answerable a year later.
 */
export const paymentEvents = pgTable(
  'payment_events',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id, { onDelete: 'cascade' }),
    kind: paymentEventKindEnum('kind').notNull(),
    /** Provider event id, or a synthesised one for a manually recorded payment. */
    providerEventId: text('provider_event_id').notNull(),
    providerPaymentId: text('provider_payment_id'),
    method: paymentMethodEnum('method'),
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull().default(0),
    /** The running total after this event, so the ledger reads without a fold. */
    runningPaidPaise: bigint('running_paid_paise', { mode: 'number' }).notNull().default(0),
    /** Provider VPA / masked instrument, for the advisor's reconciliation. */
    instrument: text('instrument'),
    failureReason: text('failure_reason'),
    rawPayload: jsonb('raw_payload').notNull().default({}),
    recordedByStaffId: uuid('recorded_by_staff_id').references(() => staff.id, {
      onDelete: 'set null',
    }),
    occurredAt: timestamptz('occurred_at').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('payment_events_provider_key').on(table.shopId, table.providerEventId),
    index('payment_events_payment_idx').on(table.paymentId, table.occurredAt),
  ],
);

/* -------------------------------------------------------------------------- *
 * 4.10 — gate pass
 * -------------------------------------------------------------------------- */

/**
 * The pass that lets a vehicle leave.
 *
 * Only the **hash** of the signed token is stored. The token itself lives in
 * the customer's WhatsApp message and nowhere else, so a database read cannot
 * mint a pass — which is the entire point of signing it. The short code is for
 * a gate person whose phone camera has given up on a rainy evening.
 */
export const gatePasses = pgTable(
  'gate_passes',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    jobCardId: uuid('job_card_id')
      .notNull()
      .references(() => jobCards.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    /** Short, human-typeable, unique per shop. */
    code: text('code').notNull(),
    tokenHash: text('token_hash').notNull(),
    status: gatePassStatusEnum('status').notNull().default('ISSUED'),
    issuedAt: timestamptz('issued_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
    usedAt: timestamptz('used_at'),
    verifiedByStaffId: uuid('verified_by_staff_id').references(() => staff.id, {
      onDelete: 'set null',
    }),
    /** Set when an owner released a vehicle with a balance outstanding. */
    overrideReason: text('override_reason'),
    overrideByStaffId: uuid('override_by_staff_id').references(() => staff.id, {
      onDelete: 'set null',
    }),
    /** Every scan, valid or not, so a repeatedly-rejected code is visible. */
    verificationAttempts: integer('verification_attempts').notNull().default(0),
    lastVerifyResult: gatePassVerifyResultEnum('last_verify_result'),
    messageId: uuid('message_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('gate_passes_shop_code_key').on(table.shopId, table.code),
    index('gate_passes_job_card_idx').on(table.jobCardId),
    index('gate_passes_shop_status_idx').on(table.shopId, table.status),
  ],
);

/* -------------------------------------------------------------------------- *
 * Relations
 * -------------------------------------------------------------------------- */

export const statusSignalsRelations = relations(statusSignals, ({ one }) => ({
  jobCard: one(jobCards, { fields: [statusSignals.jobCardId], references: [jobCards.id] }),
  sender: one(staff, { fields: [statusSignals.senderStaffId], references: [staff.id] }),
}));

export const etaEntriesRelations = relations(etaEntries, ({ one }) => ({
  jobCard: one(jobCards, { fields: [etaEntries.jobCardId], references: [jobCards.id] }),
  signal: one(statusSignals, {
    fields: [etaEntries.statusSignalId],
    references: [statusSignals.id],
  }),
}));

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  jobCard: one(jobCards, { fields: [invoices.jobCardId], references: [jobCards.id] }),
  lines: many(invoiceLines),
  payments: many(payments),
}));

export const invoiceLinesRelations = relations(invoiceLines, ({ one }) => ({
  invoice: one(invoices, { fields: [invoiceLines.invoiceId], references: [invoices.id] }),
}));

export const paymentsRelations = relations(payments, ({ one, many }) => ({
  jobCard: one(jobCards, { fields: [payments.jobCardId], references: [jobCards.id] }),
  invoice: one(invoices, { fields: [payments.invoiceId], references: [invoices.id] }),
  events: many(paymentEvents),
}));

export const paymentEventsRelations = relations(paymentEvents, ({ one }) => ({
  payment: one(payments, { fields: [paymentEvents.paymentId], references: [payments.id] }),
}));

export const deliveryBookingsRelations = relations(deliveryBookings, ({ one }) => ({
  jobCard: one(jobCards, { fields: [deliveryBookings.jobCardId], references: [jobCards.id] }),
  customer: one(customers, { fields: [deliveryBookings.customerId], references: [customers.id] }),
}));

export const gatePassesRelations = relations(gatePasses, ({ one }) => ({
  jobCard: one(jobCards, { fields: [gatePasses.jobCardId], references: [jobCards.id] }),
}));
