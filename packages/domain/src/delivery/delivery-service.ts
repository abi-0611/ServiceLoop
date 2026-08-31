import type { ShopConfig } from '@serviceloop/config';
import {
  formatPaise,
  systemClock,
  t,
  uuidv7,
  type Clock,
  type EventEnvelope,
  type Language,
  type Paise,
} from '@serviceloop/shared';
import type { JobCardContext, JobCardContextReader } from '../agent/ports';
import type { Actor } from '../job-card/context';
import type { ConversationStore } from '../messaging/ports';
import type { OutboundGate } from '../messaging/outbound-gate';
import { SLOT_ACTION_IDS } from '../messaging/status-actions';
import type { OutboundButton } from '../messaging/types';
import type { AuditAppender, OutboxWriter, ShopDirectory, UnitOfWork } from '../ports';
import { formatLocalTime } from '../status/status-comms';
import type { DeliveryBooking, DeliveryBookingStore } from './ports';
import { slotStillAvailable, suggestSlots, type Slot } from './slots';

/**
 * Ready-for-delivery and pickup slots (phase 4.7).
 *
 * The message that goes out when a car is ready does three jobs at once: it
 * says what was done, it says what is owed, and it asks when the customer wants
 * to come. The third is the one shops usually skip, and skipping it is why the
 * counter has a queue at six o'clock — everybody comes when they finish work,
 * because nobody offered them ten past four.
 *
 * A tap is resolved against the *stored* offer, never against a time the
 * customer's message contains. A ready message sits in WhatsApp for hours, the
 * shop fills up in the meantime, and honouring a stale button is how two people
 * are promised the same half-hour.
 */

export interface DeliveryServiceDeps<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly bookings: DeliveryBookingStore<Tx>;
  readonly cards: JobCardContextReader<Tx>;
  readonly conversations: ConversationStore<Tx>;
  readonly directory: ShopDirectory<Tx>;
  readonly gate: OutboundGate<Tx>;
  readonly audit: AuditAppender<Tx>;
  readonly outbox: OutboxWriter<Tx>;
  readonly loadConfig: (tx: Tx, shopId: string) => Promise<ShopConfig>;
  /** What the customer owes. Invoice total when one exists, else the estimate. */
  readonly amountDue: (tx: Tx, shopId: string, jobCardId: string) => Promise<Paise>;
  readonly clock?: Clock;
}

export interface AnnounceReadyInput {
  readonly shopId: string;
  readonly jobCardId: string;
  readonly actor: Actor;
  readonly traceId: string;
}

export type AnnounceReadyResult =
  | {
      readonly ok: true;
      readonly bookingId: string;
      readonly offeredSlots: readonly Slot[];
      readonly messageId: string;
      readonly gateStatus: string;
      readonly amountDuePaise: Paise;
    }
  | { readonly ok: false; readonly code: string; readonly reason: string };

export type ChooseSlotResult =
  | {
      readonly ok: true;
      readonly bookingId: string;
      readonly slotStart: Date;
      readonly slotEnd: Date;
      readonly alreadyChosen: boolean;
    }
  | { readonly ok: false; readonly code: string; readonly reason: string };

export class DeliveryService<Tx> {
  private readonly clock: Clock;

  constructor(private readonly deps: DeliveryServiceDeps<Tx>) {
    this.clock = deps.clock ?? systemClock;
  }

  /**
   * Sends the ready message and opens a booking.
   *
   * The booking row is written **before** the send, for the same reason the
   * approval row is (phase 3.6): at L0 the gate holds the message for review,
   * and treating "not sent" as "not offered" would mean the advisor's approval
   * released a message whose buttons pointed at nothing.
   */
  async announceReady(input: AnnounceReadyInput): Promise<AnnounceReadyResult> {
    const now = this.clock.now();

    const loaded = await this.deps.uow.transaction(async (tx) => {
      const card = await this.deps.cards.load(tx, input.shopId, input.jobCardId);
      if (card === null) return null;

      const existing = await this.deps.bookings.findOpenForCard(tx, input.shopId, input.jobCardId);
      const config = await this.deps.loadConfig(tx, input.shopId);
      const conversation = await this.deps.conversations.findByCustomer(
        tx,
        input.shopId,
        card.customerId,
        'WHATSAPP',
      );
      const shopName = (await this.deps.directory.loadShopName(tx, input.shopId)) ?? 'the workshop';
      const amountDuePaise = await this.deps.amountDue(tx, input.shopId, input.jobCardId);

      const horizonEnd = new Date(now.getTime() + SLOT_HORIZON_MS);
      const booked = await this.deps.bookings.bookedSlotsBetween(
        tx,
        input.shopId,
        now,
        horizonEnd,
      );

      return { card, existing, config, conversation, shopName, amountDuePaise, booked };
    });

    if (loaded === null) {
      return { ok: false, code: 'NO_JOB_CARD', reason: 'That job card is not in this shop' };
    }
    if (loaded.existing !== null) {
      return {
        ok: false,
        code: 'ALREADY_OFFERED',
        reason: `Pickup slots have already been offered for this card (booking ${loaded.existing.id})`,
      };
    }
    if (loaded.conversation === null) {
      return {
        ok: false,
        code: 'NO_THREAD',
        reason: 'This customer has no WhatsApp thread to send a ready message on',
      };
    }

    const slots = suggestSlots({
      from: now,
      timezone: loaded.config.quietHours.timezone,
      workingHours: loaded.config.workingHours,
      config: loaded.config.delivery,
      booked: loaded.booked,
    });

    const bookingId = uuidv7();
    const language = loaded.card.customerLanguage;

    await this.deps.uow.transaction(async (tx) => {
      await this.deps.bookings.insert(tx, {
        id: bookingId,
        shopId: input.shopId,
        jobCardId: input.jobCardId,
        customerId: loaded.card.customerId,
        conversationId: loaded.conversation?.id ?? null,
        status: 'OFFERED',
        offeredSlots: slots.map((slot) => slot.start),
        slotStart: null,
        slotEnd: null,
        chosenVia: null,
        chosenAt: null,
        offerMessageId: null,
        reminderScheduledFor: null,
        reminderSentAt: null,
        amountDuePaise: loaded.amountDuePaise,
        createdAt: now,
      });
    });

    const body = this.composeReadyBody({
      card: loaded.card,
      shopName: loaded.shopName,
      amountDuePaise: loaded.amountDuePaise,
      language,
      slots,
      timezone: loaded.config.quietHours.timezone,
    });

    // Three buttons is what a WhatsApp reply row holds, and the config caps
    // `suggestionCount` at three for that reason.
    const buttons: readonly OutboundButton[] = slots.map((slot, index) => ({
      id: SLOT_ACTION_IDS.pick(bookingId, index),
      title: formatLocalTime(slot.start, loaded.config.quietHours.timezone).slice(0, 20),
    }));

    const outcome = await this.deps.gate.send({
      shopId: input.shopId,
      conversationId: loaded.conversation.id,
      customerId: loaded.card.customerId,
      purpose: 'SERVICE',
      content:
        buttons.length === 0
          ? { kind: 'text', body }
          : { kind: 'interactive', body, buttons },
      actor: input.actor,
      traceId: input.traceId,
      flow: 'delivery',
      language,
      jobCardId: input.jobCardId,
      // A ready alert is the templated class master §6 names by example, and it
      // is one of the three messages exempt from the coalescing window: the
      // customer has been waiting for exactly this.
      templated: true,
    });

    await this.deps.uow.transaction(async (tx) => {
      await this.deps.bookings.attachOfferMessage(tx, bookingId, outcome.messageId);

      await this.deps.audit.append(tx, {
        shopId: input.shopId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'delivery.ready_announced',
        entityType: 'job_card',
        entityId: input.jobCardId,
        payload: {
          bookingId,
          amountDuePaise: loaded.amountDuePaise,
          offeredSlots: slots.map((slot) => slot.start.toISOString()),
          gateStatus: outcome.status,
          messageId: outcome.messageId,
        },
        traceId: input.traceId,
      });

      const envelope: EventEnvelope = {
        id: uuidv7(),
        occurredAt: now.toISOString(),
        shopId: input.shopId,
        traceId: input.traceId,
        type: 'delivery.ready',
        payload: {
          jobCardId: input.jobCardId,
          bookingId,
          customerId: loaded.card.customerId,
          conversationId: loaded.conversation?.id ?? null,
          amountDuePaise: loaded.amountDuePaise,
          offeredSlots: slots.map((slot) => slot.start.toISOString()),
          actor: { type: input.actor.type, id: input.actor.id },
        },
      };
      await this.deps.outbox.enqueue(tx, envelope);
    });

    return {
      ok: true,
      bookingId,
      offeredSlots: slots,
      messageId: outcome.messageId,
      gateStatus: outcome.status,
      amountDuePaise: loaded.amountDuePaise,
    };
  }

  /**
   * Records the customer's choice.
   *
   * Everything happens under the booking's row lock: two taps produce one
   * booking and one confirmation, which matters because a customer who taps and
   * sees nothing taps again.
   */
  async chooseSlot(input: {
    readonly shopId: string;
    readonly bookingId: string;
    readonly slotIndex: number;
    readonly chosenVia: string;
    readonly actor: Actor;
    readonly traceId: string;
  }): Promise<ChooseSlotResult> {
    const now = this.clock.now();

    const decided = await this.deps.uow.transaction(async (tx) => {
      const booking = await this.deps.bookings.lockById(tx, input.shopId, input.bookingId);
      if (booking === null) return { kind: 'missing' as const };

      if (booking.slotStart !== null) {
        return {
          kind: 'already' as const,
          booking,
          slotStart: booking.slotStart,
          slotEnd: booking.slotEnd ?? booking.slotStart,
        };
      }

      const slotStart = booking.offeredSlots[input.slotIndex];
      if (slotStart === undefined) {
        return { kind: 'unknown-slot' as const };
      }

      const config = await this.deps.loadConfig(tx, input.shopId);
      const slotMs = config.delivery.slotMinutes * 60_000;
      const slotEnd = new Date(slotStart.getTime() + slotMs);

      if (slotStart.getTime() <= now.getTime()) {
        return { kind: 'past' as const };
      }

      const booked = await this.deps.bookings.bookedSlotsBetween(
        tx,
        input.shopId,
        new Date(slotStart.getTime() - slotMs),
        new Date(slotStart.getTime() + slotMs),
      );
      if (!slotStillAvailable(slotStart, booked, config.delivery)) {
        return { kind: 'full' as const };
      }

      const reminderScheduledFor =
        config.delivery.reminderLeadMinutes === 0
          ? null
          : new Date(slotStart.getTime() - config.delivery.reminderLeadMinutes * 60_000);

      await this.deps.bookings.chooseSlot(tx, {
        bookingId: input.bookingId,
        slotStart,
        slotEnd,
        chosenVia: input.chosenVia,
        reminderScheduledFor,
        at: now,
      });

      await this.deps.audit.append(tx, {
        shopId: input.shopId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'delivery.slot_chosen',
        entityType: 'delivery_booking',
        entityId: input.bookingId,
        payload: {
          jobCardId: booking.jobCardId,
          slotStart: slotStart.toISOString(),
          slotEnd: slotEnd.toISOString(),
          chosenVia: input.chosenVia,
          reminderScheduledFor: reminderScheduledFor?.toISOString() ?? null,
        },
        traceId: input.traceId,
      });

      const envelope: EventEnvelope = {
        id: uuidv7(),
        occurredAt: now.toISOString(),
        shopId: input.shopId,
        traceId: input.traceId,
        type: 'delivery.slot_chosen',
        payload: {
          bookingId: input.bookingId,
          jobCardId: booking.jobCardId,
          slotStart: slotStart.toISOString(),
          slotEnd: slotEnd.toISOString(),
          chosenVia: input.chosenVia,
          actor: { type: input.actor.type, id: input.actor.id },
        },
      };
      await this.deps.outbox.enqueue(tx, envelope);

      return { kind: 'chosen' as const, booking, slotStart, slotEnd, config };
    });

    switch (decided.kind) {
      case 'missing':
        return { ok: false, code: 'NO_BOOKING', reason: 'That booking is not in this shop' };
      case 'unknown-slot':
        return {
          ok: false,
          code: 'SLOT_NOT_OFFERED',
          reason: 'That slot was not one of the times offered',
        };
      case 'past':
        return {
          ok: false,
          code: 'SLOT_IN_PAST',
          reason: 'That time has already passed; we will offer new ones',
        };
      case 'full':
        return {
          ok: false,
          code: 'SLOT_FULL',
          reason: 'Somebody else took that slot while this message was waiting',
        };
      case 'already':
        return {
          ok: true,
          bookingId: input.bookingId,
          slotStart: decided.slotStart,
          slotEnd: decided.slotEnd,
          alreadyChosen: true,
        };
      case 'chosen':
        break;
    }

    await this.confirmSlot(input, decided.booking, decided.slotStart, decided.config);

    return {
      ok: true,
      bookingId: input.bookingId,
      slotStart: decided.slotStart,
      slotEnd: decided.slotEnd,
      alreadyChosen: false,
    };
  }

  /**
   * The card's open booking, for the drawer.
   *
   * A read on the service rather than the store for the same reason the claim
   * is: there is one way in, and a console that could reach a store could also
   * reach one belonging to another shop.
   */
  async openBooking(shopId: string, jobCardId: string): Promise<DeliveryBooking | null> {
    return this.deps.uow.transaction((tx) =>
      this.deps.bookings.findOpenForCard(tx, shopId, jobCardId),
    );
  }

  /** What the customer owes right now — the number on the ready message. */
  async amountDue(shopId: string, jobCardId: string): Promise<Paise> {
    return this.deps.uow.transaction((tx) => this.deps.amountDue(tx, shopId, jobCardId));
  }

  /**
   * Bookings whose day-of reminder is due.
   *
   * Exposed on the service rather than leaving the worker to reach into the
   * store: a caller that can claim rows can also skip the rules, and the point
   * of the service layer is that there is one way in.
   */
  async claimDueReminders(
    tx: Tx,
    shopId: string | null,
    limit: number,
  ): Promise<readonly DeliveryBooking[]> {
    return this.deps.bookings.claimDueReminders(tx, {
      shopId,
      dueBefore: this.clock.now(),
      limit,
    });
  }

  /** The day-of reminder, driven by the worker's due scan. */
  async sendReminder(input: {
    readonly shopId: string;
    readonly booking: DeliveryBooking;
    readonly actor: Actor;
    readonly traceId: string;
  }): Promise<{ readonly sent: boolean; readonly status: string }> {
    const now = this.clock.now();
    const slotStart = input.booking.slotStart;
    if (slotStart === null || input.booking.conversationId === null) {
      return { sent: false, status: 'NOTHING_TO_REMIND' };
    }

    const context = await this.deps.uow.transaction(async (tx) => {
      const card = await this.deps.cards.load(tx, input.shopId, input.booking.jobCardId);
      const config = await this.deps.loadConfig(tx, input.shopId);
      return card === null ? null : { card, config };
    });
    if (context === null) return { sent: false, status: 'NO_JOB_CARD' };

    const language = context.card.customerLanguage;
    const outcome = await this.deps.gate.send({
      shopId: input.shopId,
      conversationId: input.booking.conversationId,
      customerId: input.booking.customerId,
      purpose: 'SERVICE',
      content: {
        kind: 'text',
        body: t(language, 'delivery.slot_reminder', {
          vehicle: context.card.vehicleLabel,
          when: formatLocalTime(slotStart, context.config.quietHours.timezone),
        }),
      },
      actor: input.actor,
      traceId: input.traceId,
      flow: 'delivery',
      language,
      jobCardId: input.booking.jobCardId,
      templated: true,
    });

    await this.deps.uow.transaction(async (tx) => {
      await this.deps.bookings.markReminded(tx, input.booking.id, now);
      await this.deps.bookings.setStatus(tx, {
        bookingId: input.booking.id,
        status: 'REMINDED',
        at: now,
      });
    });

    return { sent: outcome.status === 'SENT', status: outcome.status };
  }

  private async confirmSlot(
    input: {
      readonly shopId: string;
      readonly actor: Actor;
      readonly traceId: string;
    },
    booking: DeliveryBooking,
    slotStart: Date,
    config: ShopConfig,
  ): Promise<void> {
    if (booking.conversationId === null) return;

    const card = await this.deps.uow.transaction((tx) =>
      this.deps.cards.load(tx, input.shopId, booking.jobCardId),
    );
    if (card === null) return;

    await this.deps.gate.send({
      shopId: input.shopId,
      conversationId: booking.conversationId,
      customerId: booking.customerId,
      purpose: 'SERVICE',
      content: {
        kind: 'text',
        body: t(card.customerLanguage, 'delivery.slot_confirmed', {
          vehicle: card.vehicleLabel,
          when: formatLocalTime(slotStart, config.quietHours.timezone),
        }),
      },
      actor: input.actor,
      traceId: input.traceId,
      flow: 'delivery',
      language: card.customerLanguage,
      jobCardId: booking.jobCardId,
      templated: true,
      // They just tapped a button. Silence here reads as "it did not work" and
      // produces a second tap — the exact repetition the cap exists to stop.
      isAcknowledgement: true,
    });
  }

  private composeReadyBody(input: {
    readonly card: JobCardContext;
    readonly shopName: string;
    readonly amountDuePaise: Paise;
    readonly language: Language;
    readonly slots: readonly Slot[];
    readonly timezone: string;
  }): string {
    const done = input.card.workItems
      .filter((item) => item.state === 'DONE')
      .map((item) => item.title);

    const lines = [
      t(input.language, 'delivery.ready_intro', {
        vehicle: input.card.vehicleLabel,
        shopName: input.shopName,
      }),
    ];

    if (done.length > 0) {
      lines.push(t(input.language, 'delivery.work_summary', { summary: done.join(', ') }));
    }
    lines.push(
      t(input.language, 'delivery.amount_due', { amount: formatPaise(input.amountDuePaise) }),
    );
    lines.push(
      input.slots.length === 0
        ? t(input.language, 'delivery.no_slots', {
            vehicle: input.card.vehicleLabel,
            shopName: input.shopName,
          })
        : t(input.language, 'delivery.slot_prompt'),
    );

    return lines.join('\n');
  }
}

/** How far ahead the cap query looks when composing an offer. */
const SLOT_HORIZON_MS = 14 * 24 * 60 * 60 * 1000;
