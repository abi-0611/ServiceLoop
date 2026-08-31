import type {
  DeliveryBooking,
  DeliveryBookingStore,
  GatePassRecord,
  GatePassStore,
  GeneratedMediaWriter,
  InvoiceDraft,
  InvoiceLineDraft,
  InvoiceRecord,
  InvoiceStore,
  PaymentEventRecord,
  PaymentRecord,
  PaymentStore,
} from '@serviceloop/domain';
import type {
  DeliveryBookingStatus,
  EstimateLineKind,
  GatePassStatus,
  GatePassVerifyResult,
  InvoiceStatus,
  Paise,
  PaymentEventKind,
  PaymentMethod,
  PaymentStatus,
} from '@serviceloop/shared';
import { uuidv7 } from '@serviceloop/shared';
import { sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { mediaKey, type StoragePort } from '@serviceloop/adapters';

/**
 * Postgres implementations of the phase-4 delivery ports.
 *
 * Written against the in-memory doubles in `@serviceloop/domain/testing`, which
 * are the specification — including three idempotency guarantees that come
 * from unique indexes rather than from careful callers:
 *
 *   - `invoices_job_card_key`  — one live invoice per visit.
 *   - `payment_events_provider_key` — a webhook retried six times credits once.
 *   - `gate_passes_shop_code_key` — a short code identifies one pass.
 *
 * Money never round-trips through a float. `bigint` columns arrive from the
 * driver as strings, and every read below goes through `Number(...)` at this
 * boundary rather than leaving a string to be added to an integer somewhere
 * downstream — which is how phase 2 lost an afternoon (deviation 17b).
 */

function date(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function maybeDate(value: Date | string | null): Date | null {
  return value === null ? null : date(value);
}

function paise(value: string | number | null): Paise {
  return value === null ? 0 : Number(value);
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function dateArray(value: unknown): readonly Date[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => new Date(entry))
    : [];
}

/* -------------------------------------------------------------------------- *
 * 4.7 — pickup bookings
 * -------------------------------------------------------------------------- */

type BookingRow = {
  id: string;
  shop_id: string;
  job_card_id: string;
  customer_id: string;
  conversation_id: string | null;
  status: DeliveryBookingStatus;
  offered_slots: unknown;
  slot_start: Date | string | null;
  slot_end: Date | string | null;
  chosen_via: string | null;
  chosen_at: Date | string | null;
  offer_message_id: string | null;
  reminder_scheduled_for: Date | string | null;
  reminder_sent_at: Date | string | null;
  amount_due_paise: string | number;
  created_at: Date | string;
}

function toBooking(row: BookingRow): DeliveryBooking {
  return {
    id: row.id,
    shopId: row.shop_id,
    jobCardId: row.job_card_id,
    customerId: row.customer_id,
    conversationId: row.conversation_id,
    status: row.status,
    offeredSlots: dateArray(row.offered_slots),
    slotStart: maybeDate(row.slot_start),
    slotEnd: maybeDate(row.slot_end),
    chosenVia: row.chosen_via,
    chosenAt: maybeDate(row.chosen_at),
    offerMessageId: row.offer_message_id,
    reminderScheduledFor: maybeDate(row.reminder_scheduled_for),
    reminderSentAt: maybeDate(row.reminder_sent_at),
    amountDuePaise: paise(row.amount_due_paise),
    createdAt: date(row.created_at),
  };
}

const SELECT_BOOKING = sql`
  select
    id, shop_id, job_card_id, customer_id, conversation_id, status::text as status,
    offered_slots, slot_start, slot_end, chosen_via, chosen_at, offer_message_id,
    reminder_scheduled_for, reminder_sent_at, amount_due_paise, created_at
  from delivery_bookings
`;

export class PgDeliveryBookingStore implements DeliveryBookingStore<Tx> {
  async insert(tx: Tx, booking: DeliveryBooking): Promise<void> {
    await tx.execute(sql`
      insert into delivery_bookings (
        id, shop_id, job_card_id, customer_id, conversation_id, status,
        offered_slots, amount_due_paise, created_at
      ) values (
        ${booking.id}, ${booking.shopId}, ${booking.jobCardId}, ${booking.customerId},
        ${booking.conversationId}, ${booking.status}::delivery_booking_status,
        ${JSON.stringify(booking.offeredSlots.map((slot) => slot.toISOString()))}::jsonb,
        ${booking.amountDuePaise}, ${booking.createdAt}
      )
    `);
  }

  /** `FOR UPDATE`: two taps on the slot buttons must book one slot. */
  async lockById(tx: Tx, shopId: string, bookingId: string): Promise<DeliveryBooking | null> {
    const result = await tx.execute<BookingRow>(sql`
      ${SELECT_BOOKING} where id = ${bookingId} and shop_id = ${shopId} for update
    `);
    const row = result.rows[0];
    return row === undefined ? null : toBooking(row);
  }

  async findOpenForCard(
    tx: Tx,
    shopId: string,
    jobCardId: string,
  ): Promise<DeliveryBooking | null> {
    const result = await tx.execute<BookingRow>(sql`
      ${SELECT_BOOKING}
      where shop_id = ${shopId} and job_card_id = ${jobCardId}
        and status not in ('CANCELLED', 'COMPLETED')
      order by created_at desc
      limit 1
    `);
    const row = result.rows[0];
    return row === undefined ? null : toBooking(row);
  }

  /**
   * Chosen slot starts in a window — the per-bin cap's input.
   *
   * Only rows that actually hold a slot count: an `OFFERED` booking has put
   * three times to a customer and reserved none of them, and counting offers
   * against the cap would make a shop look full because it was being helpful.
   */
  async bookedSlotsBetween(
    tx: Tx,
    shopId: string,
    from: Date,
    to: Date,
  ): Promise<readonly Date[]> {
    const result = await tx.execute<{ slot_start: Date | string }>(sql`
      select slot_start
      from delivery_bookings
      where shop_id = ${shopId}
        and slot_start is not null
        and status <> 'CANCELLED'
        and slot_start >= ${from}
        and slot_start <= ${to}
    `);
    return result.rows.map((row) => date(row.slot_start));
  }

  async chooseSlot(
    tx: Tx,
    input: {
      readonly bookingId: string;
      readonly slotStart: Date;
      readonly slotEnd: Date;
      readonly chosenVia: string;
      readonly reminderScheduledFor: Date | null;
      readonly at: Date;
    },
  ): Promise<void> {
    await tx.execute(sql`
      update delivery_bookings
      set status = 'CHOSEN'::delivery_booking_status,
          slot_start = ${input.slotStart},
          slot_end = ${input.slotEnd},
          chosen_via = ${input.chosenVia},
          chosen_at = ${input.at},
          reminder_scheduled_for = ${input.reminderScheduledFor},
          updated_at = now()
      where id = ${input.bookingId}
    `);
  }

  async attachOfferMessage(tx: Tx, bookingId: string, messageId: string): Promise<void> {
    await tx.execute(sql`
      update delivery_bookings
      set offer_message_id = ${messageId}, updated_at = now()
      where id = ${bookingId}
    `);
  }

  async setStatus(
    tx: Tx,
    input: {
      readonly bookingId: string;
      readonly status: DeliveryBookingStatus;
      readonly at: Date;
    },
  ): Promise<void> {
    await tx.execute(sql`
      update delivery_bookings
      set status = ${input.status}::delivery_booking_status,
          completed_at = case when ${input.status} = 'COMPLETED' then ${input.at} else completed_at end,
          updated_at = now()
      where id = ${input.bookingId}
    `);
  }

  async markReminded(tx: Tx, bookingId: string, at: Date): Promise<void> {
    await tx.execute(sql`
      update delivery_bookings set reminder_sent_at = ${at}, updated_at = now()
      where id = ${bookingId}
    `);
  }

  /** `FOR UPDATE SKIP LOCKED` so two workers take disjoint batches. */
  async claimDueReminders(
    tx: Tx,
    input: { readonly shopId: string | null; readonly dueBefore: Date; readonly limit: number },
  ): Promise<readonly DeliveryBooking[]> {
    const result = await tx.execute<BookingRow>(sql`
      ${SELECT_BOOKING}
      where status = 'CHOSEN'
        and reminder_sent_at is null
        and reminder_scheduled_for is not null
        and reminder_scheduled_for <= ${input.dueBefore}
        and (${input.shopId}::uuid is null or shop_id = ${input.shopId}::uuid)
      order by reminder_scheduled_for asc
      limit ${input.limit}
      for update skip locked
    `);
    return result.rows.map(toBooking);
  }
}

/* -------------------------------------------------------------------------- *
 * 4.8 — invoices
 * -------------------------------------------------------------------------- */

type InvoiceRow = {
  id: string;
  shop_id: string;
  job_card_id: string;
  customer_id: string;
  estimate_id: string | null;
  number: string;
  status: InvoiceStatus;
  issued_at: Date | string | null;
  subtotal_paise: string | number;
  cgst_paise: string | number;
  sgst_paise: string | number;
  igst_paise: string | number;
  total_paise: string | number;
  amount_paid_paise: string | number;
  seller_name: string;
  seller_gstin: string | null;
  seller_address: unknown;
  seller_state_code: string | null;
  place_of_supply_state_code: string | null;
  intra_state: boolean;
  footer_note: string;
  media_id: string | null;
  evidence_media_ids: unknown;
  render_hash: string | null;
  created_at: Date | string;
}

type InvoiceLineRow = {
  estimate_line_id: string | null;
  work_item_id: string | null;
  description: string;
  hsn_sac: string | null;
  quantity_milli: number;
  unit_price_paise: string | number;
  line_total_paise: string | number;
  tax_rate_bp: number;
  cgst_paise: string | number;
  sgst_paise: string | number;
  igst_paise: string | number;
  is_additional_work: boolean;
  approved_at: Date | string | null;
  evidence_media_ids: unknown;
  sequence: number;
  kind: EstimateLineKind | null;
}

function toInvoiceLine(row: InvoiceLineRow): InvoiceLineDraft {
  return {
    estimateLineId: row.estimate_line_id,
    workItemId: row.work_item_id,
    description: row.description,
    // The kind is joined from the estimate line that backs this invoice line;
    // a line whose estimate row has since been erased bills as labour, which is
    // the honest default for work somebody did by hand.
    kind: row.kind ?? 'LABOUR',
    hsnSac: row.hsn_sac,
    quantityMilli: row.quantity_milli,
    unitPricePaise: paise(row.unit_price_paise),
    lineTotalPaise: paise(row.line_total_paise),
    taxRateBp: row.tax_rate_bp,
    cgstPaise: paise(row.cgst_paise),
    sgstPaise: paise(row.sgst_paise),
    igstPaise: paise(row.igst_paise),
    isAdditionalWork: row.is_additional_work,
    approvedAt: maybeDate(row.approved_at),
    evidenceMediaIds: stringArray(row.evidence_media_ids),
    sequence: row.sequence,
  };
}

function toInvoice(row: InvoiceRow, lines: readonly InvoiceLineDraft[]): InvoiceRecord {
  return {
    id: row.id,
    shopId: row.shop_id,
    jobCardId: row.job_card_id,
    customerId: row.customer_id,
    estimateId: row.estimate_id,
    status: row.status,
    issuedAt: maybeDate(row.issued_at),
    amountPaidPaise: paise(row.amount_paid_paise),
    mediaId: row.media_id,
    renderHash: row.render_hash,
    createdAt: date(row.created_at),
    number: row.number,
    subtotalPaise: paise(row.subtotal_paise),
    cgstPaise: paise(row.cgst_paise),
    sgstPaise: paise(row.sgst_paise),
    igstPaise: paise(row.igst_paise),
    totalPaise: paise(row.total_paise),
    intraState: row.intra_state,
    sellerName: row.seller_name,
    sellerGstin: row.seller_gstin,
    sellerAddress: stringArray(row.seller_address),
    sellerStateCode: row.seller_state_code,
    placeOfSupplyStateCode: row.place_of_supply_state_code,
    footerNote: row.footer_note,
    lines,
    evidenceMediaIds: stringArray(row.evidence_media_ids),
  };
}

const SELECT_INVOICE = sql`
  select
    id, shop_id, job_card_id, customer_id, estimate_id, number, status::text as status,
    issued_at, subtotal_paise, cgst_paise, sgst_paise, igst_paise, total_paise,
    amount_paid_paise, seller_name, seller_gstin, seller_address, seller_state_code,
    place_of_supply_state_code, intra_state, footer_note, media_id, evidence_media_ids,
    render_hash, created_at
  from invoices
`;

export class PgInvoiceStore implements InvoiceStore<Tx> {
  /**
   * The next number in the shop's series for a financial year.
   *
   * Under a transaction-scoped advisory lock, so the series is **gapless and
   * contiguous** even when two advisors issue an invoice in the same second.
   * A tax series with a hole in it is a question an auditor asks, and "two
   * requests raced" is not an answer anybody wants to give. The same technique
   * phase 2 used for job-card codes.
   */
  async nextSequence(tx: Tx, shopId: string, financialYear: string): Promise<number> {
    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtext(${`invoice-seq:${shopId}:${financialYear}`}))
    `);

    const result = await tx.execute<{ count: string | number }>(sql`
      select count(*) as count
      from invoices
      where shop_id = ${shopId} and number like ${`%${financialYear}%`}
    `);

    return Number(result.rows[0]?.count ?? 0) + 1;
  }

  async insert(
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
  ): Promise<void> {
    const { draft } = input;

    await tx.execute(sql`
      insert into invoices (
        id, shop_id, job_card_id, customer_id, estimate_id, number, status, issued_at,
        subtotal_paise, cgst_paise, sgst_paise, igst_paise, total_paise,
        seller_name, seller_gstin, seller_address, seller_state_code,
        place_of_supply_state_code, intra_state, footer_note, evidence_media_ids
      ) values (
        ${input.id}, ${input.shopId}, ${input.jobCardId}, ${input.customerId},
        ${input.estimateId}, ${draft.number}, 'ISSUED'::invoice_status, ${input.issuedAt},
        ${draft.subtotalPaise}, ${draft.cgstPaise}, ${draft.sgstPaise}, ${draft.igstPaise},
        ${draft.totalPaise}, ${draft.sellerName}, ${draft.sellerGstin},
        ${JSON.stringify(draft.sellerAddress)}::jsonb, ${draft.sellerStateCode},
        ${draft.placeOfSupplyStateCode}, ${draft.intraState}, ${draft.footerNote},
        ${JSON.stringify(draft.evidenceMediaIds)}::jsonb
      )
    `);

    for (const line of draft.lines) {
      await tx.execute(sql`
        insert into invoice_lines (
          id, shop_id, invoice_id, estimate_line_id, work_item_id, description, hsn_sac,
          quantity_milli, unit_price_paise, line_total_paise, tax_rate_bp,
          cgst_paise, sgst_paise, igst_paise, is_additional_work, approved_at,
          evidence_media_ids, sequence
        ) values (
          ${uuidv7()}, ${input.shopId}, ${input.id}, ${line.estimateLineId}, ${line.workItemId},
          ${line.description}, ${line.hsnSac}, ${line.quantityMilli}, ${line.unitPricePaise},
          ${line.lineTotalPaise}, ${line.taxRateBp}, ${line.cgstPaise}, ${line.sgstPaise},
          ${line.igstPaise}, ${line.isAdditionalWork}, ${line.approvedAt},
          ${JSON.stringify(line.evidenceMediaIds)}::jsonb, ${line.sequence}
        )
      `);
    }
  }

  async findByJobCard(tx: Tx, shopId: string, jobCardId: string): Promise<InvoiceRecord | null> {
    const result = await tx.execute<InvoiceRow>(sql`
      ${SELECT_INVOICE} where shop_id = ${shopId} and job_card_id = ${jobCardId} limit 1
    `);
    const row = result.rows[0];
    if (row === undefined) return null;
    return toInvoice(row, await this.lines(tx, shopId, row.id));
  }

  async load(tx: Tx, shopId: string, invoiceId: string): Promise<InvoiceRecord | null> {
    const result = await tx.execute<InvoiceRow>(sql`
      ${SELECT_INVOICE} where id = ${invoiceId} and shop_id = ${shopId}
    `);
    const row = result.rows[0];
    if (row === undefined) return null;
    return toInvoice(row, await this.lines(tx, shopId, invoiceId));
  }

  async lines(tx: Tx, shopId: string, invoiceId: string): Promise<readonly InvoiceLineDraft[]> {
    const result = await tx.execute<InvoiceLineRow>(sql`
      select
        il.estimate_line_id, il.work_item_id, il.description, il.hsn_sac, il.quantity_milli,
        il.unit_price_paise, il.line_total_paise, il.tax_rate_bp, il.cgst_paise, il.sgst_paise,
        il.igst_paise, il.is_additional_work, il.approved_at, il.evidence_media_ids, il.sequence,
        el.kind::text as kind
      from invoice_lines il
      left join estimate_lines el on el.id = il.estimate_line_id
      where il.shop_id = ${shopId} and il.invoice_id = ${invoiceId}
      order by il.sequence asc
    `);
    return result.rows.map(toInvoiceLine);
  }

  async attachPdf(
    tx: Tx,
    input: { readonly invoiceId: string; readonly mediaId: string; readonly renderHash: string },
  ): Promise<void> {
    await tx.execute(sql`
      update invoices
      set media_id = ${input.mediaId}, render_hash = ${input.renderHash}, updated_at = now()
      where id = ${input.invoiceId}
    `);
  }

  async setStatus(
    tx: Tx,
    input: {
      readonly invoiceId: string;
      readonly status: InvoiceStatus;
      readonly amountPaidPaise: Paise;
      readonly at: Date;
    },
  ): Promise<void> {
    await tx.execute(sql`
      update invoices
      set status = ${input.status}::invoice_status,
          amount_paid_paise = ${input.amountPaidPaise},
          updated_at = now()
      where id = ${input.invoiceId}
    `);
  }
}

/* -------------------------------------------------------------------------- *
 * 4.9 — payments
 * -------------------------------------------------------------------------- */

type PaymentRow = {
  id: string;
  shop_id: string;
  job_card_id: string;
  invoice_id: string | null;
  customer_id: string | null;
  provider: string;
  provider_payment_link_id: string | null;
  status: PaymentStatus;
  amount_paise: string | number;
  amount_paid_paise: string | number;
  accept_partial: boolean;
  short_url: string | null;
  reference_id: string | null;
  expires_at: Date | string | null;
  paid_at: Date | string | null;
  reminders_sent: number;
  last_reminder_at: Date | string | null;
  created_at: Date | string;
}

type PaymentEventRow = {
  id: string;
  shop_id: string;
  payment_id: string;
  kind: PaymentEventKind;
  provider_event_id: string;
  provider_payment_id: string | null;
  method: PaymentMethod | null;
  amount_paise: string | number;
  running_paid_paise: string | number;
  instrument: string | null;
  failure_reason: string | null;
  raw_payload: unknown;
  recorded_by_staff_id: string | null;
  occurred_at: Date | string;
}

function toPayment(row: PaymentRow): PaymentRecord {
  return {
    id: row.id,
    shopId: row.shop_id,
    jobCardId: row.job_card_id,
    invoiceId: row.invoice_id,
    customerId: row.customer_id,
    provider: row.provider,
    providerPaymentLinkId: row.provider_payment_link_id,
    status: row.status,
    amountPaise: paise(row.amount_paise),
    amountPaidPaise: paise(row.amount_paid_paise),
    acceptPartial: row.accept_partial,
    shortUrl: row.short_url,
    referenceId: row.reference_id,
    expiresAt: maybeDate(row.expires_at),
    paidAt: maybeDate(row.paid_at),
    remindersSent: row.reminders_sent,
    lastReminderAt: maybeDate(row.last_reminder_at),
    createdAt: date(row.created_at),
  };
}

const SELECT_PAYMENT = sql`
  select
    id, shop_id, job_card_id, invoice_id, customer_id, provider, provider_payment_link_id,
    status::text as status, amount_paise, amount_paid_paise, accept_partial, short_url,
    reference_id, expires_at, paid_at, reminders_sent, last_reminder_at, created_at
  from payments
`;

export class PgPaymentStore implements PaymentStore<Tx> {
  /**
   * `created_at` is written from the record, not left to `defaultNow()`.
   *
   * The balance ladder reads `coalesce(last_reminder_at, created_at)` to decide
   * when the next gentle rung is due, so a store that substituted its own clock
   * would silently ignore the one the domain passed — and every fake-clock test
   * of the ladder would pass in memory and behave differently against SQL. The
   * same correction the status-signal store needed (deviation 61).
   */
  async insert(tx: Tx, payment: PaymentRecord): Promise<void> {
    await tx.execute(sql`
      insert into payments (
        id, shop_id, job_card_id, invoice_id, customer_id, provider, status,
        amount_paise, accept_partial, reference_id, expires_at, created_at
      ) values (
        ${payment.id}, ${payment.shopId}, ${payment.jobCardId}, ${payment.invoiceId},
        ${payment.customerId}, ${payment.provider}, ${payment.status}::payment_status,
        ${payment.amountPaise}, ${payment.acceptPartial}, ${payment.referenceId},
        ${payment.expiresAt}, ${payment.createdAt}
      )
    `);
  }

  /** `FOR UPDATE`: two webhook deliveries must not both credit this row. */
  async lockById(tx: Tx, shopId: string, paymentId: string): Promise<PaymentRecord | null> {
    const result = await tx.execute<PaymentRow>(sql`
      ${SELECT_PAYMENT} where id = ${paymentId} and shop_id = ${shopId} for update
    `);
    const row = result.rows[0];
    return row === undefined ? null : toPayment(row);
  }

  async findByProviderLinkId(
    tx: Tx,
    shopId: string,
    providerPaymentLinkId: string,
  ): Promise<PaymentRecord | null> {
    const result = await tx.execute<PaymentRow>(sql`
      ${SELECT_PAYMENT}
      where shop_id = ${shopId} and provider_payment_link_id = ${providerPaymentLinkId}
    `);
    const row = result.rows[0];
    return row === undefined ? null : toPayment(row);
  }

  /**
   * Resolves a payment from a provider link id **without** a shop id.
   *
   * One webhook URL serves every tenant and the payload carries no shop of
   * ours, so the provider's own link id is the only thing that says whose money
   * this is. Safe because that id is globally unique at the provider and unique
   * per shop here — and because the row, not the payload, is what decides the
   * shop from this point on.
   */
  async findByProviderLinkIdAnyShop(
    tx: Tx,
    providerPaymentLinkId: string,
  ): Promise<PaymentRecord | null> {
    const result = await tx.execute<PaymentRow>(sql`
      ${SELECT_PAYMENT} where provider_payment_link_id = ${providerPaymentLinkId} limit 1
    `);
    const row = result.rows[0];
    return row === undefined ? null : toPayment(row);
  }

  async findOpenForCard(
    tx: Tx,
    shopId: string,
    jobCardId: string,
  ): Promise<PaymentRecord | null> {
    const result = await tx.execute<PaymentRow>(sql`
      ${SELECT_PAYMENT}
      where shop_id = ${shopId} and job_card_id = ${jobCardId}
        and status not in ('CANCELLED', 'EXPIRED')
      order by created_at desc
      limit 1
    `);
    const row = result.rows[0];
    return row === undefined ? null : toPayment(row);
  }

  /**
   * Appends a provider event, or returns null when it has already been seen.
   *
   * `payment_events_provider_key` on `(shop_id, provider_event_id)` is the
   * whole idempotency story for money: Razorpay retries a webhook until it gets
   * a 2xx, and the second delivery of `payment_link.paid` must credit nothing.
   */
  async appendEvent(tx: Tx, event: PaymentEventRecord): Promise<string | null> {
    const result = await tx.execute<{ id: string }>(sql`
      insert into payment_events (
        id, shop_id, payment_id, kind, provider_event_id, provider_payment_id, method,
        amount_paise, running_paid_paise, instrument, failure_reason, raw_payload,
        recorded_by_staff_id, occurred_at
      ) values (
        ${event.id}, ${event.shopId}, ${event.paymentId}, ${event.kind}::payment_event_kind,
        ${event.providerEventId}, ${event.providerPaymentId},
        ${event.method === null ? null : sql`${event.method}::payment_method`},
        ${event.amountPaise}, ${event.runningPaidPaise}, ${event.instrument},
        ${event.failureReason}, ${JSON.stringify(event.rawPayload)}::jsonb,
        ${event.recordedByStaffId}, ${event.occurredAt}
      )
      on conflict (shop_id, provider_event_id) do nothing
      returning id
    `);

    return result.rows[0]?.id ?? null;
  }

  async events(
    tx: Tx,
    shopId: string,
    paymentId: string,
  ): Promise<readonly PaymentEventRecord[]> {
    const result = await tx.execute<PaymentEventRow>(sql`
      select
        id, shop_id, payment_id, kind::text as kind, provider_event_id, provider_payment_id,
        method::text as method, amount_paise, running_paid_paise, instrument, failure_reason,
        raw_payload, recorded_by_staff_id, occurred_at
      from payment_events
      where shop_id = ${shopId} and payment_id = ${paymentId}
      order by occurred_at asc
    `);

    return result.rows.map((row) => ({
      id: row.id,
      shopId: row.shop_id,
      paymentId: row.payment_id,
      kind: row.kind,
      providerEventId: row.provider_event_id,
      providerPaymentId: row.provider_payment_id,
      method: row.method,
      amountPaise: paise(row.amount_paise),
      runningPaidPaise: paise(row.running_paid_paise),
      instrument: row.instrument,
      failureReason: row.failure_reason,
      rawPayload:
        typeof row.raw_payload === 'object' && row.raw_payload !== null
          ? (row.raw_payload as Record<string, unknown>)
          : {},
      recordedByStaffId: row.recorded_by_staff_id,
      occurredAt: date(row.occurred_at),
    }));
  }

  async applyLedger(
    tx: Tx,
    input: {
      readonly paymentId: string;
      readonly status: PaymentStatus;
      readonly amountPaidPaise: Paise;
      readonly paidAt: Date | null;
      readonly at: Date;
    },
  ): Promise<void> {
    await tx.execute(sql`
      update payments
      set status = ${input.status}::payment_status,
          amount_paid_paise = ${input.amountPaidPaise},
          paid_at = ${input.paidAt},
          updated_at = now()
      where id = ${input.paymentId}
    `);
  }

  async attachLink(
    tx: Tx,
    input: {
      readonly paymentId: string;
      readonly providerPaymentLinkId: string;
      readonly shortUrl: string;
      readonly expiresAt: Date | null;
    },
  ): Promise<void> {
    await tx.execute(sql`
      update payments
      set provider_payment_link_id = ${input.providerPaymentLinkId},
          short_url = ${input.shortUrl},
          expires_at = ${input.expiresAt},
          updated_at = now()
      where id = ${input.paymentId}
    `);
  }

  async recordReminder(tx: Tx, paymentId: string, at: Date): Promise<void> {
    await tx.execute(sql`
      update payments
      set reminders_sent = reminders_sent + 1, last_reminder_at = ${at}, updated_at = now()
      where id = ${paymentId}
    `);
  }

  /**
   * Balances whose next gentle reminder is due.
   *
   * The rung index is `reminders_sent`, so the ladder's own cap does the
   * filtering: past the last configured interval a payment simply stops being
   * selected, and the advisor task takes over. Two rungs, then a person.
   */
  async claimDueReminders(
    tx: Tx,
    input: {
      readonly shopId: string | null;
      readonly now: Date;
      readonly afterMinutes: readonly number[];
      readonly limit: number;
    },
  ): Promise<readonly PaymentRecord[]> {
    if (input.afterMinutes.length === 0) return [];

    const intervals = sql.raw(
      `ARRAY[${input.afterMinutes.map((minutes) => Math.round(minutes)).join(',')}]::int[]`,
    );

    const result = await tx.execute<PaymentRow>(sql`
      ${SELECT_PAYMENT}
      where status not in ('PAID', 'CANCELLED')
        and reminders_sent < ${input.afterMinutes.length}
        and (${input.shopId}::uuid is null or shop_id = ${input.shopId}::uuid)
        and coalesce(last_reminder_at, created_at)
              <= ${input.now}::timestamptz - make_interval(mins => (${intervals})[reminders_sent + 1])
      order by created_at asc
      limit ${input.limit}
      for update skip locked
    `);

    return result.rows.map(toPayment);
  }
}

/* -------------------------------------------------------------------------- *
 * 4.10 — gate passes
 * -------------------------------------------------------------------------- */

type GatePassRow = {
  id: string;
  shop_id: string;
  job_card_id: string;
  customer_id: string | null;
  code: string;
  token_hash: string;
  status: GatePassStatus;
  issued_at: Date | string;
  expires_at: Date | string;
  used_at: Date | string | null;
  verified_by_staff_id: string | null;
  override_reason: string | null;
  override_by_staff_id: string | null;
  verification_attempts: number;
  last_verify_result: GatePassVerifyResult | null;
  message_id: string | null;
}

function toGatePass(row: GatePassRow): GatePassRecord {
  return {
    id: row.id,
    shopId: row.shop_id,
    jobCardId: row.job_card_id,
    customerId: row.customer_id,
    code: row.code,
    tokenHash: row.token_hash,
    status: row.status,
    issuedAt: date(row.issued_at),
    expiresAt: date(row.expires_at),
    usedAt: maybeDate(row.used_at),
    verifiedByStaffId: row.verified_by_staff_id,
    overrideReason: row.override_reason,
    overrideByStaffId: row.override_by_staff_id,
    verificationAttempts: row.verification_attempts,
    lastVerifyResult: row.last_verify_result,
    messageId: row.message_id,
  };
}

const SELECT_GATE_PASS = sql`
  select
    id, shop_id, job_card_id, customer_id, code, token_hash, status::text as status,
    issued_at, expires_at, used_at, verified_by_staff_id, override_reason,
    override_by_staff_id, verification_attempts, last_verify_result::text as last_verify_result,
    message_id
  from gate_passes
`;

export class PgGatePassStore implements GatePassStore<Tx> {
  async insert(tx: Tx, pass: GatePassRecord): Promise<void> {
    await tx.execute(sql`
      insert into gate_passes (
        id, shop_id, job_card_id, customer_id, code, token_hash, status,
        issued_at, expires_at, override_reason, override_by_staff_id
      ) values (
        ${pass.id}, ${pass.shopId}, ${pass.jobCardId}, ${pass.customerId}, ${pass.code},
        ${pass.tokenHash}, ${pass.status}::gate_pass_status, ${pass.issuedAt}, ${pass.expiresAt},
        ${pass.overrideReason}, ${pass.overrideByStaffId}
      )
    `);
  }

  /**
   * Locks by short code, for the gate person who typed it.
   *
   * `FOR UPDATE` because a pass can be presented twice in ten seconds — the
   * scan failed, so they typed it — and only one of those may mark it used.
   */
  async lockByCode(tx: Tx, shopId: string, code: string): Promise<GatePassRecord | null> {
    const result = await tx.execute<GatePassRow>(sql`
      ${SELECT_GATE_PASS}
      where shop_id = ${shopId} and code = ${code.toUpperCase()}
      for update
    `);
    const row = result.rows[0];
    return row === undefined ? null : toGatePass(row);
  }

  async lockById(tx: Tx, shopId: string, gatePassId: string): Promise<GatePassRecord | null> {
    const result = await tx.execute<GatePassRow>(sql`
      ${SELECT_GATE_PASS} where id = ${gatePassId} and shop_id = ${shopId} for update
    `);
    const row = result.rows[0];
    return row === undefined ? null : toGatePass(row);
  }

  async findActiveForCard(
    tx: Tx,
    shopId: string,
    jobCardId: string,
  ): Promise<GatePassRecord | null> {
    const result = await tx.execute<GatePassRow>(sql`
      ${SELECT_GATE_PASS}
      where shop_id = ${shopId} and job_card_id = ${jobCardId} and status = 'ISSUED'
      order by issued_at desc
      limit 1
    `);
    const row = result.rows[0];
    return row === undefined ? null : toGatePass(row);
  }

  /**
   * Records the scan.
   *
   * The attempt counter is incremented on **every** verification, valid or not:
   * a code being rejected repeatedly at a gate is the pattern nobody notices
   * until they go looking, and this column plus the audit chain are the only
   * two places it could have been recorded.
   */
  async recordVerification(
    tx: Tx,
    input: {
      readonly gatePassId: string;
      readonly result: GatePassVerifyResult;
      readonly staffId: string | null;
      readonly markUsed: boolean;
      readonly at: Date;
    },
  ): Promise<void> {
    await tx.execute(sql`
      update gate_passes
      set verification_attempts = verification_attempts + 1,
          last_verify_result = ${input.result}::gate_pass_verify_result,
          status = case when ${input.markUsed} then 'USED'::gate_pass_status else status end,
          used_at = case when ${input.markUsed} then ${input.at} else used_at end,
          verified_by_staff_id = case when ${input.markUsed} then ${input.staffId}::uuid else verified_by_staff_id end,
          updated_at = now()
      where id = ${input.gatePassId}
    `);
  }

  async attachMessage(tx: Tx, gatePassId: string, messageId: string): Promise<void> {
    await tx.execute(sql`
      update gate_passes set message_id = ${messageId}, updated_at = now() where id = ${gatePassId}
    `);
  }

  async revoke(tx: Tx, shopId: string, gatePassId: string, _at: Date): Promise<void> {
    await tx.execute(sql`
      update gate_passes
      set status = 'REVOKED'::gate_pass_status, updated_at = now()
      where id = ${gatePassId} and shop_id = ${shopId}
    `);
  }
}

/* -------------------------------------------------------------------------- *
 * Generated media (the invoice PDF)
 * -------------------------------------------------------------------------- */

/**
 * Stores bytes this system produced as a `MediaAsset`.
 *
 * `origin: GENERATED` is what keeps an invoice PDF distinguishable from a
 * customer's photograph in a DPDP export — one is a document the shop
 * authored, the other is the data principal's own data, and an export that
 * conflated them would be answering the wrong question.
 */
export class PgGeneratedMediaWriter implements GeneratedMediaWriter {
  constructor(
    private readonly storage: StoragePort,
    private readonly runInTransaction: <T>(work: (tx: Tx) => Promise<T>) => Promise<T>,
  ) {}

  async store(input: {
    readonly shopId: string;
    readonly jobCardId: string | null;
    readonly contentType: string;
    readonly bytes: Buffer;
    readonly filename: string;
    readonly caption: string;
    readonly traceId: string;
  }): Promise<{ readonly mediaId: string; readonly storageKey: string }> {
    const mediaId = uuidv7();
    const key = mediaKey({
      shopId: input.shopId,
      // A shop-level document with no card is filed under a `shop` pseudo-card
      // so the key layout stays uniform — a DPDP deletion enumerates by prefix,
      // and a second layout would be a second prefix to remember.
      jobCardId: input.jobCardId ?? 'shop',
      mediaId,
      kind: 'DOCUMENT',
      extension: input.filename.split('.').pop() ?? 'bin',
    });

    const stored = await this.storage.put({
      key,
      body: input.bytes,
      contentType: input.contentType,
    });

    await this.runInTransaction(async (tx) => {
      await tx.execute(sql`
        insert into media_assets (
          id, shop_id, job_card_id, kind, origin, bucket, storage_key, content_type,
          size_bytes, checksum_sha256, caption
        ) values (
          ${mediaId}, ${input.shopId}, ${input.jobCardId}, 'DOCUMENT'::media_kind,
          'GENERATED'::media_origin, ${stored.bucket}, ${key}, ${input.contentType},
          ${input.bytes.length}, ${stored.checksumSha256}, ${input.caption}
        )
      `);
    });

    return { mediaId, storageKey: key };
  }
}
