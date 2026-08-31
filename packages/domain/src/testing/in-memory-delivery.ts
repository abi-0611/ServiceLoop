import { uuidv7, type Paise } from '@serviceloop/shared';
import type {
  DeliveryBooking,
  DeliveryBookingStore,
  GatePassRecord,
  GatePassStore,
  GeneratedMediaWriter,
  InvoiceRecord,
  InvoiceRenderInput,
  InvoiceRenderer,
  InvoiceStore,
  PaymentEventRecord,
  PaymentLinkGateway,
  PaymentRecord,
  PaymentStore,
} from '../delivery/ports';
import type { InvoiceDraft, InvoiceLineDraft } from '../delivery/invoice-builder';
import type { MemoryTx } from './in-memory';

/**
 * In-memory phase-4 delivery stores.
 *
 * The idempotency guarantees that live in SQL unique indexes are reproduced
 * here rather than assumed away — `appendEvent` returning null on a repeated
 * `providerEventId` is the property the reconcile test asserts, and a double
 * that credited it twice would let a double-crediting bug through green tests.
 */

export class InMemoryDeliveryWorld {
  readonly bookings = new Map<string, DeliveryBooking>();
  readonly invoices = new Map<string, InvoiceRecord>();
  readonly invoiceLines = new Map<string, InvoiceLineDraft[]>();
  readonly payments = new Map<string, PaymentRecord>();
  readonly paymentEvents: PaymentEventRecord[] = [];
  readonly gatePasses = new Map<string, GatePassRecord>();
  readonly media = new Map<string, { contentType: string; bytes: Buffer; caption: string }>();
  /** Per-shop, per-financial-year invoice counters. */
  private readonly sequences = new Map<string, number>();

  nextSequence(shopId: string, financialYear: string): number {
    const key = `${shopId}:${financialYear}`;
    const next = (this.sequences.get(key) ?? 0) + 1;
    this.sequences.set(key, next);
    return next;
  }
}

export class InMemoryDeliveryBookingStore implements DeliveryBookingStore<MemoryTx> {
  constructor(private readonly world: InMemoryDeliveryWorld) {}

  async insert(_tx: MemoryTx, booking: DeliveryBooking): Promise<void> {
    this.world.bookings.set(booking.id, booking);
  }

  async lockById(
    _tx: MemoryTx,
    shopId: string,
    bookingId: string,
  ): Promise<DeliveryBooking | null> {
    const found = this.world.bookings.get(bookingId);
    return found !== undefined && found.shopId === shopId ? found : null;
  }

  async findOpenForCard(
    _tx: MemoryTx,
    shopId: string,
    jobCardId: string,
  ): Promise<DeliveryBooking | null> {
    return (
      [...this.world.bookings.values()].find(
        (booking) =>
          booking.shopId === shopId &&
          booking.jobCardId === jobCardId &&
          booking.status !== 'CANCELLED' &&
          booking.status !== 'COMPLETED',
      ) ?? null
    );
  }

  async bookedSlotsBetween(
    _tx: MemoryTx,
    shopId: string,
    from: Date,
    to: Date,
  ): Promise<readonly Date[]> {
    return [...this.world.bookings.values()]
      .filter(
        (booking) =>
          booking.shopId === shopId &&
          booking.slotStart !== null &&
          booking.status !== 'CANCELLED' &&
          booking.slotStart.getTime() >= from.getTime() &&
          booking.slotStart.getTime() <= to.getTime(),
      )
      .map((booking) => booking.slotStart as Date);
  }

  async chooseSlot(
    _tx: MemoryTx,
    input: {
      readonly bookingId: string;
      readonly slotStart: Date;
      readonly slotEnd: Date;
      readonly chosenVia: string;
      readonly reminderScheduledFor: Date | null;
      readonly at: Date;
    },
  ): Promise<void> {
    const booking = this.world.bookings.get(input.bookingId);
    if (booking === undefined) return;
    this.world.bookings.set(input.bookingId, {
      ...booking,
      status: 'CHOSEN',
      slotStart: input.slotStart,
      slotEnd: input.slotEnd,
      chosenVia: input.chosenVia,
      chosenAt: input.at,
      reminderScheduledFor: input.reminderScheduledFor,
    });
  }

  async attachOfferMessage(_tx: MemoryTx, bookingId: string, messageId: string): Promise<void> {
    const booking = this.world.bookings.get(bookingId);
    if (booking !== undefined) {
      this.world.bookings.set(bookingId, { ...booking, offerMessageId: messageId });
    }
  }

  async setStatus(
    _tx: MemoryTx,
    input: {
      readonly bookingId: string;
      readonly status: DeliveryBooking['status'];
      readonly at: Date;
    },
  ): Promise<void> {
    const booking = this.world.bookings.get(input.bookingId);
    if (booking !== undefined) {
      this.world.bookings.set(input.bookingId, { ...booking, status: input.status });
    }
  }

  async markReminded(_tx: MemoryTx, bookingId: string, at: Date): Promise<void> {
    const booking = this.world.bookings.get(bookingId);
    if (booking !== undefined) {
      this.world.bookings.set(bookingId, { ...booking, reminderSentAt: at });
    }
  }

  async claimDueReminders(
    _tx: MemoryTx,
    input: { readonly shopId: string | null; readonly dueBefore: Date; readonly limit: number },
  ): Promise<readonly DeliveryBooking[]> {
    return [...this.world.bookings.values()]
      .filter(
        (booking) =>
          (input.shopId === null || booking.shopId === input.shopId) &&
          booking.status === 'CHOSEN' &&
          booking.reminderSentAt === null &&
          booking.reminderScheduledFor !== null &&
          booking.reminderScheduledFor.getTime() <= input.dueBefore.getTime(),
      )
      .slice(0, input.limit);
  }
}

export class InMemoryInvoiceStore implements InvoiceStore<MemoryTx> {
  constructor(private readonly world: InMemoryDeliveryWorld) {}

  async nextSequence(_tx: MemoryTx, shopId: string, financialYear: string): Promise<number> {
    return this.world.nextSequence(shopId, financialYear);
  }

  async insert(
    _tx: MemoryTx,
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
    this.world.invoices.set(input.id, {
      ...input.draft,
      id: input.id,
      shopId: input.shopId,
      jobCardId: input.jobCardId,
      customerId: input.customerId,
      estimateId: input.estimateId,
      status: 'ISSUED',
      issuedAt: input.issuedAt,
      amountPaidPaise: 0,
      mediaId: null,
      renderHash: null,
      createdAt: input.issuedAt,
    });
    this.world.invoiceLines.set(input.id, [...input.draft.lines]);
  }

  async findByJobCard(
    _tx: MemoryTx,
    shopId: string,
    jobCardId: string,
  ): Promise<InvoiceRecord | null> {
    return (
      [...this.world.invoices.values()].find(
        (invoice) => invoice.shopId === shopId && invoice.jobCardId === jobCardId,
      ) ?? null
    );
  }

  async load(_tx: MemoryTx, shopId: string, invoiceId: string): Promise<InvoiceRecord | null> {
    const found = this.world.invoices.get(invoiceId);
    return found !== undefined && found.shopId === shopId ? found : null;
  }

  async lines(
    _tx: MemoryTx,
    _shopId: string,
    invoiceId: string,
  ): Promise<readonly InvoiceLineDraft[]> {
    return this.world.invoiceLines.get(invoiceId) ?? [];
  }

  async attachPdf(
    _tx: MemoryTx,
    input: { readonly invoiceId: string; readonly mediaId: string; readonly renderHash: string },
  ): Promise<void> {
    const invoice = this.world.invoices.get(input.invoiceId);
    if (invoice === undefined) return;
    this.world.invoices.set(input.invoiceId, {
      ...invoice,
      mediaId: input.mediaId,
      renderHash: input.renderHash,
    });
  }

  async setStatus(
    _tx: MemoryTx,
    input: {
      readonly invoiceId: string;
      readonly status: InvoiceRecord['status'];
      readonly amountPaidPaise: Paise;
      readonly at: Date;
    },
  ): Promise<void> {
    const invoice = this.world.invoices.get(input.invoiceId);
    if (invoice === undefined) return;
    this.world.invoices.set(input.invoiceId, {
      ...invoice,
      status: input.status,
      amountPaidPaise: input.amountPaidPaise,
    });
  }
}

export class InMemoryPaymentStore implements PaymentStore<MemoryTx> {
  constructor(private readonly world: InMemoryDeliveryWorld) {}

  async insert(_tx: MemoryTx, payment: PaymentRecord): Promise<void> {
    this.world.payments.set(payment.id, payment);
  }

  async lockById(_tx: MemoryTx, shopId: string, paymentId: string): Promise<PaymentRecord | null> {
    const found = this.world.payments.get(paymentId);
    return found !== undefined && found.shopId === shopId ? found : null;
  }

  async findByProviderLinkId(
    _tx: MemoryTx,
    shopId: string,
    providerPaymentLinkId: string,
  ): Promise<PaymentRecord | null> {
    return (
      [...this.world.payments.values()].find(
        (payment) =>
          payment.shopId === shopId && payment.providerPaymentLinkId === providerPaymentLinkId,
      ) ?? null
    );
  }

  async findByProviderLinkIdAnyShop(
    _tx: MemoryTx,
    providerPaymentLinkId: string,
  ): Promise<PaymentRecord | null> {
    return (
      [...this.world.payments.values()].find(
        (payment) => payment.providerPaymentLinkId === providerPaymentLinkId,
      ) ?? null
    );
  }

  async findOpenForCard(
    _tx: MemoryTx,
    shopId: string,
    jobCardId: string,
  ): Promise<PaymentRecord | null> {
    return (
      [...this.world.payments.values()].find(
        (payment) =>
          payment.shopId === shopId &&
          payment.jobCardId === jobCardId &&
          payment.status !== 'CANCELLED' &&
          payment.status !== 'EXPIRED',
      ) ?? null
    );
  }

  async appendEvent(_tx: MemoryTx, event: PaymentEventRecord): Promise<string | null> {
    // `payment_events_provider_key`. A webhook Razorpay retries six times must
    // credit the customer once.
    const duplicate = this.world.paymentEvents.some(
      (existing) =>
        existing.shopId === event.shopId && existing.providerEventId === event.providerEventId,
    );
    if (duplicate) return null;

    this.world.paymentEvents.push(event);
    return event.id;
  }

  async events(
    _tx: MemoryTx,
    shopId: string,
    paymentId: string,
  ): Promise<readonly PaymentEventRecord[]> {
    return this.world.paymentEvents
      .filter((event) => event.shopId === shopId && event.paymentId === paymentId)
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  }

  async applyLedger(
    _tx: MemoryTx,
    input: {
      readonly paymentId: string;
      readonly status: PaymentRecord['status'];
      readonly amountPaidPaise: Paise;
      readonly paidAt: Date | null;
      readonly at: Date;
    },
  ): Promise<void> {
    const payment = this.world.payments.get(input.paymentId);
    if (payment === undefined) return;
    this.world.payments.set(input.paymentId, {
      ...payment,
      status: input.status,
      amountPaidPaise: input.amountPaidPaise,
      paidAt: input.paidAt,
    });
  }

  async attachLink(
    _tx: MemoryTx,
    input: {
      readonly paymentId: string;
      readonly providerPaymentLinkId: string;
      readonly shortUrl: string;
      readonly expiresAt: Date | null;
    },
  ): Promise<void> {
    const payment = this.world.payments.get(input.paymentId);
    if (payment === undefined) return;
    this.world.payments.set(input.paymentId, {
      ...payment,
      providerPaymentLinkId: input.providerPaymentLinkId,
      shortUrl: input.shortUrl,
      expiresAt: input.expiresAt,
    });
  }

  async recordReminder(_tx: MemoryTx, paymentId: string, at: Date): Promise<void> {
    const payment = this.world.payments.get(paymentId);
    if (payment === undefined) return;
    this.world.payments.set(paymentId, {
      ...payment,
      remindersSent: payment.remindersSent + 1,
      lastReminderAt: at,
    });
  }

  async claimDueReminders(
    _tx: MemoryTx,
    input: {
      readonly shopId: string | null;
      readonly now: Date;
      readonly afterMinutes: readonly number[];
      readonly limit: number;
    },
  ): Promise<readonly PaymentRecord[]> {
    return [...this.world.payments.values()]
      .filter((payment) => {
        if (input.shopId !== null && payment.shopId !== input.shopId) return false;
        if (payment.status === 'PAID' || payment.status === 'CANCELLED') return false;
        if (payment.remindersSent >= input.afterMinutes.length) return false;
        const afterMinutes = input.afterMinutes[payment.remindersSent];
        if (afterMinutes === undefined) return false;
        const since = payment.lastReminderAt ?? payment.createdAt;
        return input.now.getTime() - since.getTime() >= afterMinutes * 60_000;
      })
      .slice(0, input.limit);
  }
}

export class InMemoryGatePassStore implements GatePassStore<MemoryTx> {
  constructor(private readonly world: InMemoryDeliveryWorld) {}

  async insert(_tx: MemoryTx, pass: GatePassRecord): Promise<void> {
    this.world.gatePasses.set(pass.id, pass);
  }

  async lockByCode(
    _tx: MemoryTx,
    shopId: string,
    code: string,
  ): Promise<GatePassRecord | null> {
    return (
      [...this.world.gatePasses.values()].find(
        (pass) => pass.shopId === shopId && pass.code === code.toUpperCase(),
      ) ?? null
    );
  }

  async lockById(
    _tx: MemoryTx,
    shopId: string,
    gatePassId: string,
  ): Promise<GatePassRecord | null> {
    const found = this.world.gatePasses.get(gatePassId);
    return found !== undefined && found.shopId === shopId ? found : null;
  }

  async findActiveForCard(
    _tx: MemoryTx,
    shopId: string,
    jobCardId: string,
  ): Promise<GatePassRecord | null> {
    return (
      [...this.world.gatePasses.values()].find(
        (pass) =>
          pass.shopId === shopId && pass.jobCardId === jobCardId && pass.status === 'ISSUED',
      ) ?? null
    );
  }

  async recordVerification(
    _tx: MemoryTx,
    input: {
      readonly gatePassId: string;
      readonly result: GatePassRecord['lastVerifyResult'];
      readonly staffId: string | null;
      readonly markUsed: boolean;
      readonly at: Date;
    },
  ): Promise<void> {
    const pass = this.world.gatePasses.get(input.gatePassId);
    if (pass === undefined) return;
    this.world.gatePasses.set(input.gatePassId, {
      ...pass,
      verificationAttempts: pass.verificationAttempts + 1,
      lastVerifyResult: input.result,
      ...(input.markUsed
        ? { status: 'USED' as const, usedAt: input.at, verifiedByStaffId: input.staffId }
        : {}),
    });
  }

  async attachMessage(_tx: MemoryTx, gatePassId: string, messageId: string): Promise<void> {
    const pass = this.world.gatePasses.get(gatePassId);
    if (pass !== undefined) {
      this.world.gatePasses.set(gatePassId, { ...pass, messageId });
    }
  }

  async revoke(_tx: MemoryTx, shopId: string, gatePassId: string, _at: Date): Promise<void> {
    const pass = this.world.gatePasses.get(gatePassId);
    if (pass !== undefined && pass.shopId === shopId) {
      this.world.gatePasses.set(gatePassId, { ...pass, status: 'REVOKED' });
    }
  }
}

export class InMemoryGeneratedMediaWriter implements GeneratedMediaWriter {
  constructor(private readonly world: InMemoryDeliveryWorld) {}

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
    this.world.media.set(mediaId, {
      contentType: input.contentType,
      bytes: input.bytes,
      caption: input.caption,
    });
    return { mediaId, storageKey: `${input.shopId}/generated/${input.filename}` };
  }
}

/**
 * A renderer that produces stable, inspectable bytes with no PDF engine.
 *
 * The real `@react-pdf/renderer` adapter is exercised by its own golden test;
 * every *other* test that happens to issue an invoice wants the invoice, not a
 * PDF, and spending a second per test laying out a document nobody reads is a
 * suite people stop running.
 */
export class StubInvoiceRenderer implements InvoiceRenderer {
  readonly rendered: InvoiceRenderInput[] = [];

  async render(
    input: InvoiceRenderInput,
  ): Promise<{ readonly bytes: Buffer; readonly hash: string }> {
    this.rendered.push(input);
    const summary = [
      input.invoice.number,
      input.invoice.totalPaise,
      input.lines.length,
      input.evidence.length,
    ].join('|');
    return { bytes: Buffer.from(summary, 'utf8'), hash: `stub-${summary}` };
  }
}

/** A payment gateway that mints predictable links without a provider. */
export class StubPaymentGateway implements PaymentLinkGateway {
  readonly provider = 'stub';
  readonly created: { readonly referenceId: string; readonly amountPaise: Paise }[] = [];

  async createPaymentLink(input: {
    readonly referenceId: string;
    readonly amountPaise: Paise;
    readonly expiresAt: Date | null;
  }): Promise<{
    readonly providerPaymentLinkId: string;
    readonly shortUrl: string;
    readonly expiresAt: Date | null;
  }> {
    this.created.push({ referenceId: input.referenceId, amountPaise: input.amountPaise });
    const id = `plink_stub_${this.created.length}`;
    return { providerPaymentLinkId: id, shortUrl: `https://pay.test/${id}`, expiresAt: input.expiresAt };
  }
}
