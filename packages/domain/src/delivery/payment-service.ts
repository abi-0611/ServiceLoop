import type { ShopConfig } from '@serviceloop/config';
import {
  formatPaise,
  percentOf,
  systemClock,
  t,
  uuidv7,
  type Clock,
  type EventEnvelope,
  type Language,
  type Paise,
  type PaymentEventKind,
  type PaymentMethod,
  type PaymentStatus,
} from '@serviceloop/shared';
import type { JobCardContextReader } from '../agent/ports';
import type { Actor } from '../job-card/context';
import type { JobCardTransitionService } from '../job-card/transition-service';
import type { ConversationStore } from '../messaging/ports';
import type { OutboundGate } from '../messaging/outbound-gate';
import type { AuditAppender, OutboxWriter, UnitOfWork } from '../ports';
import type {
  AdvisorTaskCreator,
  InvoiceStore,
  PaymentLinkGateway,
  PaymentRecord,
  PaymentStore,
} from './ports';

/**
 * Payments and reconciliation (phase 4.9).
 *
 * The design commitment worth naming is that **the event ledger is the truth**.
 * `payments.amount_paid_paise` is a fold over `payment_events`, never a number
 * somebody increments — because the failure mode of a mutable balance is a
 * webhook delivered twice crediting a customer twice, and the failure mode of a
 * ledger is nothing at all: the second delivery collides on
 * `provider_event_id` and is a no-op.
 *
 * The second commitment is the reminder ladder: **two rungs, then a person.**
 * This is somebody who has already paid something and already has their
 * vehicle. A third automated chase is a debt-collection cadence, and a workshop
 * that behaves like a debt collector loses the customer *and* the balance. The
 * cap is in the shop-config schema and in a database CHECK, not only here.
 */

export interface PaymentServiceDeps<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly payments: PaymentStore<Tx>;
  readonly invoices: InvoiceStore<Tx>;
  readonly cards: JobCardContextReader<Tx>;
  readonly conversations: ConversationStore<Tx>;
  readonly jobCards: JobCardTransitionService<Tx>;
  readonly gate: OutboundGate<Tx>;
  readonly gateway: PaymentLinkGateway;
  readonly audit: AuditAppender<Tx>;
  readonly outbox: OutboxWriter<Tx>;
  readonly loadConfig: (tx: Tx, shopId: string) => Promise<ShopConfig>;
  /** The customer's phone, for the provider's own notification fields. */
  readonly customerPhone: (tx: Tx, shopId: string, customerId: string) => Promise<string | null>;
  /** Raises the advisor task the ladder ends in (L6). */
  readonly tasks?: AdvisorTaskCreator;
  readonly clock?: Clock;
}

export type CreateLinkResult =
  | {
      readonly ok: true;
      readonly paymentId: string;
      readonly shortUrl: string;
      readonly amountPaise: Paise;
      readonly reused: boolean;
    }
  | { readonly ok: false; readonly code: string; readonly reason: string };

/** A provider event, already signature-verified by the adapter. */
export interface ProviderPaymentEvent {
  readonly providerEventId: string;
  readonly providerPaymentLinkId: string;
  readonly providerPaymentId: string | null;
  readonly kind: PaymentEventKind;
  readonly amountPaise: Paise;
  readonly method: PaymentMethod | null;
  readonly instrument: string | null;
  readonly failureReason: string | null;
  readonly occurredAt: Date;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface ReconcileResult {
  readonly handled: boolean;
  readonly duplicate: boolean;
  readonly paymentId: string | null;
  readonly status: PaymentStatus;
  readonly amountPaidPaise: Paise;
  readonly balancePaise: Paise;
  readonly cardMoved: boolean;
  readonly detail: string;
}

export class PaymentService<Tx> {
  private readonly clock: Clock;

  constructor(private readonly deps: PaymentServiceDeps<Tx>) {
    this.clock = deps.clock ?? systemClock;
  }

  /** The card's live payment, for the drawer and for the gate-pass check. */
  async openForCard(shopId: string, jobCardId: string): Promise<PaymentRecord | null> {
    return this.deps.uow.transaction((tx) =>
      this.deps.payments.findOpenForCard(tx, shopId, jobCardId),
    );
  }

  /**
   * Creates (or re-uses) a payment link for a card.
   *
   * Re-uses rather than mints a second: a customer with two live links for one
   * repair will eventually pay both, and refunding a duplicate costs the shop
   * the provider's fee and an afternoon.
   */
  async createLink(input: {
    readonly shopId: string;
    readonly jobCardId: string;
    readonly invoiceId?: string | null;
    readonly amountPaise?: Paise;
    readonly actor: Actor;
    readonly traceId: string;
  }): Promise<CreateLinkResult> {
    const now = this.clock.now();

    const prepared = await this.deps.uow.transaction(async (tx) => {
      const existing = await this.deps.payments.findOpenForCard(tx, input.shopId, input.jobCardId);
      const card = await this.deps.cards.load(tx, input.shopId, input.jobCardId);
      if (card === null) return null;

      const config = await this.deps.loadConfig(tx, input.shopId);
      const invoice = await this.deps.invoices.findByJobCard(tx, input.shopId, input.jobCardId);
      const phone = await this.deps.customerPhone(tx, input.shopId, card.customerId);
      return { existing, card, config, invoice, phone };
    });

    if (prepared === null) {
      return { ok: false, code: 'NO_JOB_CARD', reason: 'That job card is not in this shop' };
    }
    if (prepared.existing !== null && prepared.existing.shortUrl !== null) {
      return {
        ok: true,
        paymentId: prepared.existing.id,
        shortUrl: prepared.existing.shortUrl,
        amountPaise: prepared.existing.amountPaise,
        reused: true,
      };
    }

    const amountPaise =
      input.amountPaise ?? prepared.invoice?.totalPaise ?? prepared.card.estimate?.totalPaise ?? 0;
    if (amountPaise <= 0) {
      return {
        ok: false,
        code: 'NOTHING_TO_COLLECT',
        reason: 'There is no outstanding amount on this card',
      };
    }

    const paymentId = uuidv7();
    const referenceId = `${prepared.card.code}-${paymentId.slice(0, 8)}`;
    const acceptPartial = prepared.config.payments.acceptPartialPayment;
    const expiresAt = new Date(
      now.getTime() + prepared.config.payments.paymentLinkExpiryMinutes * 60_000,
    );

    await this.deps.uow.transaction((tx) =>
      this.deps.payments.insert(tx, {
        id: paymentId,
        shopId: input.shopId,
        jobCardId: input.jobCardId,
        invoiceId: input.invoiceId ?? prepared.invoice?.id ?? null,
        customerId: prepared.card.customerId,
        provider: this.deps.gateway.provider,
        providerPaymentLinkId: null,
        status: 'PENDING',
        amountPaise,
        amountPaidPaise: 0,
        acceptPartial,
        shortUrl: null,
        referenceId,
        expiresAt,
        paidAt: null,
        remindersSent: 0,
        lastReminderAt: null,
        createdAt: now,
      }),
    );

    // The row exists before the provider call, so a link created at the
    // provider but lost on the way back is a row an operator can see and
    // reconcile — rather than money collected against nothing.
    const link = await this.deps.gateway.createPaymentLink({
      shopId: input.shopId,
      jobCardId: input.jobCardId,
      referenceId,
      amountPaise,
      description: `${prepared.card.code} — ${prepared.card.vehicleLabel}`,
      customerName: prepared.card.customerName,
      customerPhone: prepared.phone,
      acceptPartial,
      minimumFirstAmountPaise: acceptPartial
        ? percentOf(amountPaise, prepared.config.payments.minimumFirstPaymentPercent)
        : null,
      expiresAt,
      traceId: input.traceId,
    });

    await this.deps.uow.transaction(async (tx) => {
      await this.deps.payments.attachLink(tx, {
        paymentId,
        providerPaymentLinkId: link.providerPaymentLinkId,
        shortUrl: link.shortUrl,
        expiresAt: link.expiresAt ?? expiresAt,
      });

      await this.deps.audit.append(tx, {
        shopId: input.shopId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'payment.link_created',
        entityType: 'payment',
        entityId: paymentId,
        payload: {
          jobCardId: input.jobCardId,
          provider: this.deps.gateway.provider,
          providerPaymentLinkId: link.providerPaymentLinkId,
          amountPaise,
          acceptPartial,
        },
        traceId: input.traceId,
      });

      const envelope: EventEnvelope = {
        id: uuidv7(),
        occurredAt: now.toISOString(),
        shopId: input.shopId,
        traceId: input.traceId,
        type: 'payment.link_created',
        payload: {
          paymentId,
          jobCardId: input.jobCardId,
          invoiceId: input.invoiceId ?? prepared.invoice?.id ?? null,
          provider: this.deps.gateway.provider,
          providerPaymentLinkId: link.providerPaymentLinkId,
          amountPaise,
          shortUrl: link.shortUrl,
          expiresAt: (link.expiresAt ?? expiresAt).toISOString(),
          actor: { type: input.actor.type, id: input.actor.id },
        },
      };
      await this.deps.outbox.enqueue(tx, envelope);
    });

    await this.sendLink(input, prepared.card, link.shortUrl, amountPaise);

    return { ok: true, paymentId, shortUrl: link.shortUrl, amountPaise, reused: false };
  }

  /**
   * Applies a verified provider event.
   *
   * Idempotent by construction: `appendEvent` collides on `providerEventId` and
   * returns null, so a webhook Razorpay retries six times moves the card once.
   */
  async reconcile(input: {
    readonly event: ProviderPaymentEvent;
    readonly actor: Actor;
    readonly traceId: string;
  }): Promise<ReconcileResult> {
    const now = this.clock.now();
    const event = input.event;

    const resolved = await this.deps.uow.transaction((tx) =>
      this.deps.payments.findByProviderLinkIdAnyShop(tx, event.providerPaymentLinkId),
    );

    if (resolved === null) {
      return {
        handled: false,
        duplicate: false,
        paymentId: null,
        status: 'PENDING',
        amountPaidPaise: 0,
        balancePaise: 0,
        cardMoved: false,
        detail: `No payment matches provider link ${event.providerPaymentLinkId}`,
      };
    }

    const shopId = resolved.shopId;

    const applied = await this.deps.uow.transaction(async (tx) => {
      const payment = await this.deps.payments.lockById(tx, shopId, resolved.id);
      if (payment === null) return null;

      const credited = CREDITING_KINDS.has(event.kind) ? event.amountPaise : 0;
      const amountPaidPaise = payment.amountPaidPaise + credited;
      const status = nextStatus(event.kind, amountPaidPaise, payment.amountPaise);

      const eventId = await this.deps.payments.appendEvent(tx, {
        id: uuidv7(),
        shopId,
        paymentId: payment.id,
        kind: event.kind,
        providerEventId: event.providerEventId,
        providerPaymentId: event.providerPaymentId,
        method: event.method,
        amountPaise: event.amountPaise,
        runningPaidPaise: amountPaidPaise,
        instrument: event.instrument,
        failureReason: event.failureReason,
        rawPayload: event.raw,
        recordedByStaffId: null,
        occurredAt: event.occurredAt,
      });

      if (eventId === null) {
        return { duplicate: true as const, payment, status: payment.status, amountPaidPaise: payment.amountPaidPaise };
      }

      await this.deps.payments.applyLedger(tx, {
        paymentId: payment.id,
        status,
        amountPaidPaise,
        paidAt: status === 'PAID' ? event.occurredAt : payment.paidAt,
        at: now,
      });

      if (payment.invoiceId !== null) {
        await this.deps.invoices.setStatus(tx, {
          invoiceId: payment.invoiceId,
          status: status === 'PAID' ? 'PAID' : 'ISSUED',
          amountPaidPaise,
          at: now,
        });
      }

      await this.deps.audit.append(tx, {
        shopId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'payment.recorded',
        entityType: 'payment',
        entityId: payment.id,
        payload: {
          jobCardId: payment.jobCardId,
          kind: event.kind,
          providerEventId: event.providerEventId,
          providerPaymentId: event.providerPaymentId,
          method: event.method,
          amountPaise: event.amountPaise,
          amountPaidPaise,
          status,
        },
        traceId: input.traceId,
      });

      const envelope: EventEnvelope = {
        id: uuidv7(),
        occurredAt: now.toISOString(),
        shopId,
        traceId: input.traceId,
        type: 'payment.recorded',
        payload: {
          paymentId: payment.id,
          paymentEventId: eventId,
          jobCardId: payment.jobCardId,
          kind: event.kind,
          status,
          method: event.method,
          amountPaise: event.amountPaise,
          amountPaidPaise,
          balancePaise: payment.amountPaise - amountPaidPaise,
          actor: { type: input.actor.type, id: input.actor.id },
        },
      };
      await this.deps.outbox.enqueue(tx, envelope);

      return { duplicate: false as const, payment, status, amountPaidPaise };
    });

    if (applied === null) {
      return {
        handled: false,
        duplicate: false,
        paymentId: resolved.id,
        status: resolved.status,
        amountPaidPaise: resolved.amountPaidPaise,
        balancePaise: resolved.amountPaise - resolved.amountPaidPaise,
        cardMoved: false,
        detail: 'The payment row disappeared between lookup and lock',
      };
    }

    const balancePaise = applied.payment.amountPaise - applied.amountPaidPaise;

    if (applied.duplicate) {
      return {
        handled: true,
        duplicate: true,
        paymentId: applied.payment.id,
        status: applied.status,
        amountPaidPaise: applied.amountPaidPaise,
        balancePaise,
        cardMoved: false,
        detail: `Provider event ${event.providerEventId} had already been applied`,
      };
    }

    const cardMoved =
      applied.status === 'PAID'
        ? await this.settleCard(shopId, applied.payment.jobCardId, input.actor, input.traceId)
        : false;

    await this.acknowledge(shopId, applied.payment, applied.status, applied.amountPaidPaise, input);

    return {
      handled: true,
      duplicate: false,
      paymentId: applied.payment.id,
      status: applied.status,
      amountPaidPaise: applied.amountPaidPaise,
      balancePaise,
      cardMoved,
      detail: `Recorded ${formatPaise(event.amountPaise)} (${event.kind})`,
    };
  }

  /**
   * Records a payment taken at the counter.
   *
   * Cash is how most of these shops are still paid, and a system that can only
   * see UPI would show every one of those cards as unpaid for ever — which
   * would then chase the customer with reminders for money they have already
   * handed over.
   */
  async recordManualPayment(input: {
    readonly shopId: string;
    readonly paymentId: string;
    readonly amountPaise: Paise;
    readonly method: PaymentMethod;
    readonly staffId: string | null;
    readonly note: string;
    readonly actor: Actor;
    readonly traceId: string;
  }): Promise<ReconcileResult> {
    const payment = await this.deps.uow.transaction((tx) =>
      this.deps.payments.lockById(tx, input.shopId, input.paymentId),
    );
    if (payment === null || payment.providerPaymentLinkId === null) {
      return {
        handled: false,
        duplicate: false,
        paymentId: input.paymentId,
        status: 'PENDING',
        amountPaidPaise: 0,
        balancePaise: 0,
        cardMoved: false,
        detail: 'That payment is not in this shop, or has no provider link to reconcile against',
      };
    }

    return this.reconcile({
      event: {
        // A synthesised id in the provider's namespace, so a counter payment
        // and a webhook cannot collide and both are equally idempotent.
        providerEventId: `manual:${uuidv7()}`,
        providerPaymentLinkId: payment.providerPaymentLinkId,
        providerPaymentId: null,
        kind: 'MANUAL_RECORD',
        amountPaise: input.amountPaise,
        method: input.method,
        instrument: input.note,
        failureReason: null,
        occurredAt: this.clock.now(),
        raw: { recordedByStaffId: input.staffId, note: input.note },
      },
      actor: input.actor,
      traceId: input.traceId,
    });
  }

  /**
   * Balances whose next gentle rung is due.
   *
   * The intervals come from the shop's own configuration, so a shop that has
   * shortened its ladder is honoured by the next scan rather than by whatever
   * a timer captured when the payment was created.
   */
  async claimDueReminders(
    tx: Tx,
    shopId: string,
    limit: number,
  ): Promise<readonly PaymentRecord[]> {
    const config = await this.deps.loadConfig(tx, shopId);
    return this.deps.payments.claimDueReminders(tx, {
      shopId,
      now: this.clock.now(),
      afterMinutes: config.payments.balanceReminderAfterMinutes,
      limit,
    });
  }

  /**
   * One rung of the gentle balance ladder.
   *
   * Refuses past the second rung and raises an advisor task instead. The
   * refusal is a *feature*: everything else in this system retries, and this is
   * the one place where the retry is a message to a person about money.
   */
  async sendBalanceReminder(input: {
    readonly shopId: string;
    readonly paymentId: string;
    readonly actor: Actor;
    readonly traceId: string;
  }): Promise<{ readonly sent: boolean; readonly rung: number; readonly detail: string }> {
    const now = this.clock.now();

    const context = await this.deps.uow.transaction(async (tx) => {
      const payment = await this.deps.payments.lockById(tx, input.shopId, input.paymentId);
      if (payment === null) return null;
      const config = await this.deps.loadConfig(tx, input.shopId);
      const card = await this.deps.cards.load(tx, input.shopId, payment.jobCardId);
      const conversation =
        card === null
          ? null
          : await this.deps.conversations.findByCustomer(tx, input.shopId, card.customerId, 'WHATSAPP');
      return { payment, config, card, conversation };
    });

    if (context === null || context.card === null) {
      return { sent: false, rung: 0, detail: 'That payment is not in this shop' };
    }

    const { payment, config } = context;
    const maxRungs = config.payments.balanceReminderAfterMinutes.length;

    if (payment.status === 'PAID') {
      return { sent: false, rung: payment.remindersSent, detail: 'Already paid in full' };
    }
    if (payment.remindersSent >= maxRungs) {
      const taskId = await this.deps.tasks?.create({
        shopId: input.shopId,
        kind: 'FOLLOW_UP',
        urgency: 'NORMAL',
        brief: `Outstanding ${formatPaise(payment.amountPaise - payment.amountPaidPaise)} on ${context.card.code} (${context.card.registration}) — two reminders sent, please call.`,
        context: { paymentId: payment.id, jobCardId: payment.jobCardId },
        jobCardId: payment.jobCardId,
        conversationId: context.conversation?.id ?? null,
        customerId: payment.customerId,
        dedupeKey: `payment-balance:${payment.id}`,
        actor: input.actor,
        traceId: input.traceId,
      });
      return {
        sent: false,
        rung: payment.remindersSent,
        detail: `The reminder ladder is exhausted after ${maxRungs} rungs; raised advisor task ${taskId ?? '(none)'}`,
      };
    }

    if (context.conversation === null || payment.shortUrl === null) {
      return { sent: false, rung: payment.remindersSent, detail: 'No thread or link to remind on' };
    }

    const language = context.card.customerLanguage;
    const outcome = await this.deps.gate.send({
      shopId: input.shopId,
      conversationId: context.conversation.id,
      customerId: payment.customerId,
      purpose: 'SERVICE',
      content: {
        kind: 'text',
        body: t(language, 'payment.balance_reminder', {
          balance: formatPaise(payment.amountPaise - payment.amountPaidPaise),
          vehicle: context.card.vehicleLabel,
          url: payment.shortUrl,
        }),
      },
      actor: input.actor,
      traceId: input.traceId,
      flow: 'delivery',
      language,
      jobCardId: payment.jobCardId,
      templated: true,
    });

    await this.deps.uow.transaction((tx) =>
      this.deps.payments.recordReminder(tx, payment.id, now),
    );

    return {
      sent: outcome.status === 'SENT',
      rung: payment.remindersSent + 1,
      detail: `Rung ${payment.remindersSent + 1} of ${maxRungs}: ${outcome.status}`,
    };
  }

  /**
   * Moves the card once the money has landed **in full**.
   *
   * Two events, not one, and that is the correction the phase-4 demo forced. A
   * card that is merely *ready* has never been asked for money — the shop
   * created a link and the customer paid it in one go — so it needs
   * `PAYMENT_REQUESTED` before `PAYMENT_SETTLED` can be legal. Stopping after
   * the first successful transition left a fully paid vehicle sitting in
   * `AWAITING_PAYMENT`, which is the one state that means "this shop is still
   * owed money", and the balance ladder would eventually have chased a customer
   * who had already paid.
   *
   * A card that has already been delivered is left alone. Under the
   * delivery-first ordering somebody paying the link after driving away is
   * ordinary, and bouncing the card back through `AWAITING_PAYMENT` to record
   * it would write two transitions that never happened.
   */
  private async settleCard(
    shopId: string,
    jobCardId: string,
    actor: Actor,
    traceId: string,
  ): Promise<boolean> {
    const card = await this.deps.uow.transaction((tx) =>
      this.deps.cards.load(tx, shopId, jobCardId),
    );
    if (card === null) return false;

    const events =
      card.state === 'READY_FOR_DELIVERY'
        ? (['PAYMENT_REQUESTED', 'PAYMENT_SETTLED'] as const)
        : card.state === 'AWAITING_PAYMENT'
          ? (['PAYMENT_SETTLED'] as const)
          : ([] as const);

    let moved = false;
    for (const event of events) {
      try {
        await this.deps.jobCards.transition({
          shopId,
          jobCardId,
          event,
          actor,
          traceId,
          meta: { source: 'payment_reconcile' },
        });
        moved = true;
      } catch {
        // An illegal transition is not a webhook failure. Whatever the card did
        // between the lock and here, the money is recorded either way.
        break;
      }
    }
    return moved;
  }

  private async acknowledge(
    shopId: string,
    payment: PaymentRecord,
    status: PaymentStatus,
    amountPaidPaise: Paise,
    input: { readonly actor: Actor; readonly traceId: string },
  ): Promise<void> {
    if (status !== 'PAID' && status !== 'PARTIALLY_PAID') return;

    const context = await this.deps.uow.transaction(async (tx) => {
      const card = await this.deps.cards.load(tx, shopId, payment.jobCardId);
      if (card === null) return null;
      const conversation = await this.deps.conversations.findByCustomer(
        tx,
        shopId,
        card.customerId,
        'WHATSAPP',
      );
      return { card, conversation };
    });
    if (context === null || context.conversation === null) return;

    const language = context.card.customerLanguage;
    const body =
      status === 'PAID'
        ? t(language, 'payment.received_full', { amount: formatPaise(amountPaidPaise) })
        : t(language, 'payment.received_partial', {
            amount: formatPaise(amountPaidPaise),
            balance: formatPaise(payment.amountPaise - amountPaidPaise),
          });

    await this.deps.gate.send({
      shopId,
      conversationId: context.conversation.id,
      customerId: payment.customerId,
      purpose: 'SERVICE',
      content: { kind: 'text', body },
      actor: input.actor,
      traceId: input.traceId,
      flow: 'delivery',
      language,
      jobCardId: payment.jobCardId,
      templated: true,
      // Somebody just paid. Silence after money leaves an account is the single
      // most alarming thing this system could do.
      isAcknowledgement: true,
    });
  }

  private async sendLink(
    input: { readonly shopId: string; readonly actor: Actor; readonly traceId: string },
    card: {
      readonly customerId: string;
      readonly customerLanguage: Language;
      readonly vehicleLabel: string;
    },
    shortUrl: string,
    amountPaise: Paise,
  ): Promise<void> {
    const conversation = await this.deps.uow.transaction((tx) =>
      this.deps.conversations.findByCustomer(tx, input.shopId, card.customerId, 'WHATSAPP'),
    );
    if (conversation === null) return;

    await this.deps.gate.send({
      shopId: input.shopId,
      conversationId: conversation.id,
      customerId: card.customerId,
      purpose: 'SERVICE',
      content: {
        kind: 'text',
        body: t(card.customerLanguage, 'payment.link_message', {
          amount: formatPaise(amountPaise),
          vehicle: card.vehicleLabel,
          url: shortUrl,
        }),
      },
      actor: input.actor,
      traceId: input.traceId,
      flow: 'delivery',
      language: card.customerLanguage,
      templated: true,
    });
  }
}

/** Event kinds that move money. `FAILED` and `EXPIRED` credit nothing. */
const CREDITING_KINDS: ReadonlySet<PaymentEventKind> = new Set<PaymentEventKind>([
  'PAID',
  'PARTIALLY_PAID',
  'MANUAL_RECORD',
]);

/**
 * The payment's status after an event.
 *
 * Amount-driven rather than name-driven for the crediting kinds: a provider
 * that reports `partially_paid` twice for amounts that together cover the
 * invoice has been paid in full, and taking its label at face value would leave
 * a settled card being chased for a balance of zero.
 */
export function nextStatus(
  kind: PaymentEventKind,
  amountPaidPaise: Paise,
  amountPaise: Paise,
): PaymentStatus {
  switch (kind) {
    case 'FAILED':
      return amountPaidPaise > 0 ? 'PARTIALLY_PAID' : 'FAILED';
    case 'EXPIRED':
      return amountPaidPaise > 0 ? 'PARTIALLY_PAID' : 'EXPIRED';
    case 'CANCELLED':
      return amountPaidPaise > 0 ? 'PARTIALLY_PAID' : 'CANCELLED';
    case 'LINK_CREATED':
      return 'PENDING';
    case 'PAID':
    case 'PARTIALLY_PAID':
    case 'MANUAL_RECORD':
      if (amountPaidPaise >= amountPaise) return 'PAID';
      return amountPaidPaise > 0 ? 'PARTIALLY_PAID' : 'PENDING';
  }
}
