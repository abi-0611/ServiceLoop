import type { ShopConfig } from '@serviceloop/config';
import {
  addDays,
  systemClock,
  t,
  uuidv7,
  type Clock,
  type DocumentKind,
  type EventEnvelope,
  type Language,
} from '@serviceloop/shared';
import type { Actor } from '../job-card/context';
import { SYSTEM_ACTOR } from '../job-card/context';
import type { OutboundGate } from '../messaging/outbound-gate';
import type { ConversationStore } from '../messaging/ports';
import { DOCUMENT_ACTION_IDS, documentLabelKey } from '../messaging/retention-actions';
import type { AuditAppender, OutboxWriter, ShopDirectory, UnitOfWork } from '../ports';
import type {
  OdometerStore,
  RetentionDirectory,
  RetentionHoldStore,
  RetentionTouchStore,
  ServiceDueStore,
  VehicleDocumentStore,
} from './ports';
import type { RetentionOutcome } from './types';

/**
 * Service-due and document-expiry reminders (phase 6.5).
 *
 * Two flows that look alike and are legally nothing alike, which is why they
 * are in one file with the difference stated once, loudly:
 *
 *   - **A service-due reminder is SERVICE.** It is about a vehicle this shop
 *     worked on, and the estimate of when it is next due comes from that visit.
 *     Ordinary service consent covers it.
 *   - **A document reminder is MARKETING, and needs an enrolment on top.** A
 *     shop very often knows an insurance expiry because it saw the papers at
 *     intake. Knowing a date is not being asked to remind somebody about it, so
 *     nothing is ever sent for a document whose `enrolledAt` is null — checked
 *     here, and the row itself carries a CHECK that a reminder cannot be
 *     recorded without one.
 *
 * Both ride the same `retention_touches` table and therefore the same
 * twenty-one-day floor as re-pitches and win-backs. That is the whole reason
 * the table is shared: a customer whose brake pads were re-pitched last week
 * does not also get a PUC reminder this week.
 */

export interface ReminderServiceDeps<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly forecasts: ServiceDueStore<Tx>;
  readonly documents: VehicleDocumentStore<Tx>;
  readonly touches: RetentionTouchStore<Tx>;
  readonly holds: RetentionHoldStore<Tx>;
  readonly odometer: OdometerStore<Tx>;
  readonly directory: RetentionDirectory<Tx>;
  readonly conversations: ConversationStore<Tx>;
  readonly shops: ShopDirectory<Tx>;
  readonly gate: OutboundGate<Tx>;
  readonly audit: AuditAppender<Tx>;
  readonly outbox: OutboxWriter<Tx>;
  readonly loadConfig: (tx: Tx, shopId: string) => Promise<ShopConfig>;
  readonly clock?: Clock;
}

export class ReminderService<Tx> {
  private readonly clock: Clock;

  constructor(private readonly deps: ReminderServiceDeps<Tx>) {
    this.clock = deps.clock ?? systemClock;
  }

  /**
   * Recomputes when this vehicle is next due, from the visit that just ended.
   *
   * Two rules, and which one was used is recorded on the row: the shop's
   * calendar interval, or the customer's own odometer readings when there are
   * enough of them to establish a rate. The odometer rule wins when it can be
   * computed, because a car doing 30,000km a year and one doing 4,000 do not
   * want the same six-month reminder — and the distinction is invisible in a
   * calendar.
   */
  async forecastFromVisit(input: {
    readonly shopId: string;
    readonly vehicleId: string;
    readonly customerId: string;
    readonly jobCardId: string;
    readonly deliveredAt: Date;
    readonly traceId: string;
  }): Promise<{ readonly dueAt: Date; readonly basis: string } | null> {
    return this.deps.uow.transaction(async (tx) => {
      const config = await this.deps.loadConfig(tx, input.shopId);
      if (!config.retention.serviceDue.enabled) return null;

      const plan = await this.planNextService(tx, config, input);

      await this.deps.forecasts.upsert(tx, {
        id: uuidv7(),
        shopId: input.shopId,
        vehicleId: input.vehicleId,
        customerId: input.customerId,
        jobCardId: input.jobCardId,
        dueAt: plan.dueAt,
        basis: plan.basis,
        at: this.clock.now(),
      });

      await this.deps.audit.append(tx, {
        shopId: input.shopId,
        actorType: 'SYSTEM',
        actorId: null,
        action: 'service_due.forecast',
        entityType: 'Vehicle',
        entityId: input.vehicleId,
        payload: {
          jobCardId: input.jobCardId,
          dueAt: plan.dueAt.toISOString(),
          basis: plan.basis,
        },
        traceId: input.traceId,
      });

      return plan;
    });
  }

  /**
   * Sends whatever service-due reminders are inside a lead window.
   *
   * The lead days are the shop's, defaulting to T-7 and T-1. `remindedLeads` on
   * the forecast row is what stops a daily scan sending seven of them: a lead is
   * marked the moment it goes out, and a forecast that moves because the
   * customer came in early is superseded rather than re-armed.
   */
  async sendServiceDue(input: {
    readonly shopId: string;
    readonly limit?: number;
    readonly traceId: string;
    readonly actor?: Actor;
  }): Promise<readonly RetentionOutcome[]> {
    const actor = input.actor ?? SYSTEM_ACTOR;
    const now = this.clock.now();

    const batch = await this.deps.uow.transaction(async (tx) => {
      const config = await this.deps.loadConfig(tx, input.shopId);
      if (!config.retention.enabled || !config.retention.serviceDue.enabled) return null;

      const widest = Math.max(...config.retention.serviceDue.leadDays);
      const due = await this.deps.forecasts.dueWithin(tx, {
        shopId: input.shopId,
        before: addDays(now, widest),
        limit: input.limit ?? 100,
      });
      return { config, due };
    });

    if (batch === null) return [];

    const results: RetentionOutcome[] = [];
    const leadDays = [...batch.config.retention.serviceDue.leadDays].sort((a, b) => b - a);

    for (const forecast of batch.due) {
      const daysAway = Math.ceil((forecast.dueAt.getTime() - now.getTime()) / 86_400_000);
      // The *tightest* lead whose window has opened and which has not been sent.
      // Sorting descending and taking the last match means a scan that missed
      // the T-7 window sends T-1 rather than a stale seven-day warning.
      const lead = leadDays
        .filter((candidate) => daysAway <= candidate && !forecast.remindedLeads.includes(candidate))
        .at(-1);
      if (lead === undefined) continue;

      results.push(
        await this.sendServiceReminder({
          shopId: input.shopId,
          forecastId: forecast.id,
          vehicleId: forecast.vehicleId,
          customerId: forecast.customerId,
          dueAt: forecast.dueAt,
          lead,
          config: batch.config,
          traceId: input.traceId,
          actor,
        }),
      );
    }

    return results;
  }

  /**
   * Records the dates a customer has shared, without enrolling them.
   *
   * Splitting "we know this" from "we may write about this" is the whole design
   * of 6.5's document half. Intake can record a PUC expiry off the papers all
   * day long; the row it writes is inert until somebody taps yes.
   */
  async recordDocument(input: {
    readonly shopId: string;
    readonly vehicleId: string;
    readonly customerId: string;
    readonly kind: DocumentKind;
    readonly expiresOn: string;
    readonly traceId: string;
  }): Promise<string> {
    return this.deps.uow.transaction((tx) =>
      this.deps.documents.upsert(tx, {
        id: uuidv7(),
        shopId: input.shopId,
        vehicleId: input.vehicleId,
        customerId: input.customerId,
        kind: input.kind,
        expiresOn: input.expiresOn,
        at: this.clock.now(),
      }),
    );
  }

  /** Offers the enrolment. Sent at delivery, when the papers are in hand. */
  async offerEnrolment(input: {
    readonly shopId: string;
    readonly vehicleId: string;
    readonly customerId: string;
    readonly conversationId: string;
    readonly traceId: string;
    readonly actor?: Actor;
  }): Promise<boolean> {
    const actor = input.actor ?? SYSTEM_ACTOR;

    const context = await this.deps.uow.transaction(async (tx) => {
      const config = await this.deps.loadConfig(tx, input.shopId);
      if (!config.retention.documents.enabled) return null;
      const customer = await this.deps.directory.loadCustomer(tx, input.shopId, input.customerId);
      const vehicle = await this.deps.directory.loadVehicle(tx, input.shopId, input.vehicleId);
      return { customer, vehicle };
    });

    if (context === null || context.customer === null) return false;
    const language = context.customer.language;

    const outcome = await this.deps.gate.send({
      shopId: input.shopId,
      conversationId: input.conversationId,
      customerId: input.customerId,
      // The *ask* is SERVICE — it is a question about the visit that is ending,
      // and it asks for permission rather than exercising any. What it enrols
      // them into is MARKETING, and that is what the reminders themselves ride.
      purpose: 'SERVICE',
      content: {
        kind: 'interactive',
        body: t(language, 'reminder.enrol_ask', {
          vehicle: context.vehicle?.label ?? 'your vehicle',
        }),
        buttons: [
          {
            id: DOCUMENT_ACTION_IDS.enrol(input.vehicleId),
            title: t(language, 'retention.action.book') === '' ? 'Yes' : 'Yes, please',
          },
          { id: DOCUMENT_ACTION_IDS.decline(input.vehicleId), title: 'No thanks' },
        ],
      },
      actor,
      traceId: input.traceId,
      flow: 'retention',
      language,
      templated: true,
    });

    return outcome.status === 'SENT';
  }

  /** The customer's yes. Every document on the vehicle becomes actionable. */
  async enrol(input: {
    readonly shopId: string;
    readonly vehicleId: string;
    readonly customerId: string;
    readonly conversationId: string | null;
    readonly via: string;
    readonly traceId: string;
    readonly actor?: Actor;
  }): Promise<number> {
    const actor = input.actor ?? SYSTEM_ACTOR;
    const now = this.clock.now();

    const enrolled = await this.deps.uow.transaction(async (tx) => {
      const count = await this.deps.documents.enrol(tx, {
        shopId: input.shopId,
        vehicleId: input.vehicleId,
        via: input.via,
        at: now,
      });
      await this.deps.audit.append(tx, {
        shopId: input.shopId,
        actorType: actor.type,
        actorId: actor.id,
        action: 'document_tracking.enrolled',
        entityType: 'Vehicle',
        entityId: input.vehicleId,
        payload: { documents: count, via: input.via },
        traceId: input.traceId,
      });
      return count;
    });

    if (enrolled > 0 && input.conversationId !== null) {
      const language = await this.deps.uow.transaction(async (tx) => {
        const customer = await this.deps.directory.loadCustomer(
          tx,
          input.shopId,
          input.customerId,
        );
        return customer?.language ?? 'en';
      });

      await this.deps.gate.send({
        shopId: input.shopId,
        conversationId: input.conversationId,
        customerId: input.customerId,
        purpose: 'SERVICE',
        content: { kind: 'text', body: t(language, 'reminder.enrol_ack') },
        actor,
        traceId: input.traceId,
        flow: 'retention',
        language,
        isAcknowledgement: true,
        templated: true,
      });
    }

    return enrolled;
  }

  async revokeEnrolment(input: {
    readonly shopId: string;
    readonly vehicleId: string;
    readonly traceId: string;
    readonly actor?: Actor;
  }): Promise<number> {
    const actor = input.actor ?? SYSTEM_ACTOR;
    const now = this.clock.now();
    return this.deps.uow.transaction(async (tx) => {
      const count = await this.deps.documents.revoke(tx, {
        shopId: input.shopId,
        vehicleId: input.vehicleId,
        at: now,
      });
      await this.deps.audit.append(tx, {
        shopId: input.shopId,
        actorType: actor.type,
        actorId: actor.id,
        action: 'document_tracking.revoked',
        entityType: 'Vehicle',
        entityId: input.vehicleId,
        payload: { documents: count },
        traceId: input.traceId,
      });
      return count;
    });
  }

  /**
   * One reminder per document per renewal cycle (phase 6.5).
   *
   * The cycle is the expiry date itself, stored on the row when a reminder goes
   * out. A renewal that pushes the date out by a year therefore re-arms the
   * reminder automatically, and a daily scan over an un-renewed document sends
   * exactly one.
   */
  async sendDocumentReminders(input: {
    readonly shopId: string;
    readonly limit?: number;
    readonly traceId: string;
    readonly actor?: Actor;
  }): Promise<readonly RetentionOutcome[]> {
    const actor = input.actor ?? SYSTEM_ACTOR;
    const now = this.clock.now();

    const batch = await this.deps.uow.transaction(async (tx) => {
      const config = await this.deps.loadConfig(tx, input.shopId);
      if (!config.retention.enabled || !config.retention.documents.enabled) return null;

      const before = addDays(now, config.retention.documents.leadDays)
        .toISOString()
        .slice(0, 10);
      const due = await this.deps.documents.dueWithin(tx, {
        shopId: input.shopId,
        before,
        limit: input.limit ?? 100,
      });
      return { config, due };
    });

    if (batch === null) return [];

    const results: RetentionOutcome[] = [];
    for (const document of batch.due) {
      // The store filters on enrolment; this is the second gate on the same
      // fact, and it stays because "we only send to enrolled customers" is the
      // sentence a regulator would ask us to point at, and pointing at a WHERE
      // clause is less convincing than pointing at both.
      if (document.enrolledAt === null || document.revokedAt !== null) continue;
      results.push(
        await this.sendDocumentReminder({
          shopId: input.shopId,
          document,
          traceId: input.traceId,
          actor,
        }),
      );
    }
    return results;
  }

  /* --------------------------------------------------------------- private */

  private async planNextService(
    tx: Tx,
    config: ShopConfig,
    input: {
      readonly shopId: string;
      readonly vehicleId: string;
      readonly deliveredAt: Date;
    },
  ): Promise<{ readonly dueAt: Date; readonly basis: string }> {
    const calendar = {
      dueAt: addDays(input.deliveredAt, config.retention.serviceDue.intervalDays),
      basis: 'interval_days',
    };

    const latest = await this.deps.odometer.latest(tx, input.shopId, input.vehicleId);
    if (latest === null) return calendar;

    const earlier = await this.deps.odometer.asOf(
      tx,
      input.shopId,
      input.vehicleId,
      addDays(latest.readAt, -365),
    );
    if (earlier === null || earlier.readAt.getTime() >= latest.readAt.getTime()) return calendar;

    const days = (latest.readAt.getTime() - earlier.readAt.getTime()) / 86_400_000;
    const km = latest.odometerKm - earlier.odometerKm;
    if (days < 30 || km <= 0) return calendar;

    const kmPerDay = km / days;
    const daysToInterval = Math.round(config.retention.serviceDue.intervalKm / kmPerDay);
    // Clamped to a year: a rate computed from a fortnight of holiday driving
    // would otherwise put the next service in six weeks, and a rate from a car
    // that sat in a garage would put it in 2031.
    const clamped = Math.min(Math.max(daysToInterval, 30), 365);
    return { dueAt: addDays(input.deliveredAt, clamped), basis: 'odometer' };
  }

  private async sendServiceReminder(input: {
    readonly shopId: string;
    readonly forecastId: string;
    readonly vehicleId: string;
    readonly customerId: string;
    readonly dueAt: Date;
    readonly lead: number;
    readonly config: ShopConfig;
    readonly traceId: string;
    readonly actor: Actor;
  }): Promise<RetentionOutcome> {
    const now = this.clock.now();
    const dedupeKey = `service_due:${input.vehicleId}:${input.dueAt.toISOString().slice(0, 10)}:${input.lead}`;

    const plan = await this.deps.uow.transaction(async (tx) => {
      const hold = await this.deps.holds.active(tx, input.shopId, input.customerId);
      if (hold !== null) {
        return { kind: 'refuse' as const, code: 'RETENTION_FROZEN', reason: hold.reason };
      }

      const customer = await this.deps.directory.loadCustomer(tx, input.shopId, input.customerId);
      const conversation = await this.deps.conversations.findByCustomer(
        tx,
        input.shopId,
        input.customerId,
        'WHATSAPP',
      );
      if (customer === null || conversation === null) {
        return { kind: 'refuse' as const, code: 'NO_THREAD', reason: 'No thread to write on' };
      }
      const vehicle = await this.deps.directory.loadVehicle(tx, input.shopId, input.vehicleId);

      const touchId = uuidv7();
      const claimed = await this.deps.touches.claim(tx, {
        id: touchId,
        shopId: input.shopId,
        customerId: input.customerId,
        vehicleId: input.vehicleId,
        jobCardId: null,
        conversationId: conversation.id,
        trigger: 'service_due',
        purpose: 'SERVICE',
        ledgerItemIds: [],
        amountPaise: 0,
        language: customer.language,
        dedupeKey,
        scheduledFor: now,
        traceId: input.traceId,
      });
      if (claimed === null) {
        return { kind: 'refuse' as const, code: 'ALREADY_SENT', reason: 'This lead already went out' };
      }

      return {
        kind: 'send' as const,
        touchId,
        conversationId: conversation.id,
        language: customer.language,
        vehicleLabel: vehicle?.label ?? 'your vehicle',
      };
    });

    if (plan.kind === 'refuse') {
      return {
        touchId: '',
        status: 'SKIPPED',
        messageId: null,
        detail: `${plan.code}: ${plan.reason}`,
      };
    }

    const when = formatDueWindow(input.dueAt, plan.language);
    const outcome = await this.deps.gate.send({
      shopId: input.shopId,
      conversationId: plan.conversationId,
      customerId: input.customerId,
      purpose: 'SERVICE',
      content: {
        kind: 'text',
        body:
          input.lead <= 1
            ? t(plan.language, 'reminder.service_due_soon', {
                vehicle: plan.vehicleLabel,
                when,
              })
            : t(plan.language, 'reminder.service_due', { vehicle: plan.vehicleLabel, when }),
      },
      actor: input.actor,
      traceId: input.traceId,
      flow: 'retention',
      language: plan.language,
      templated: true,
    });

    await this.deps.uow.transaction(async (tx) => {
      await this.deps.touches.settle(tx, {
        shopId: input.shopId,
        touchId: plan.touchId,
        status: outcome.status === 'SENT' ? 'SENT' : 'BLOCKED',
        messageId: outcome.status === 'SENT' ? outcome.messageId : null,
        skipCode: outcome.status === 'SENT' ? null : outcome.status,
        skipReason: outcome.status === 'SENT' ? null : 'reason' in outcome ? outcome.reason : null,
        releaseDedupeKey: outcome.status !== 'SENT',
        at: now,
      });

      if (outcome.status === 'SENT') {
        await this.deps.forecasts.markLeadSent(tx, {
          shopId: input.shopId,
          forecastId: input.forecastId,
          leadDays: input.lead,
          at: now,
        });

        const envelope: EventEnvelope = {
          id: uuidv7(),
          type: 'retention.touch_sent',
          occurredAt: now.toISOString(),
          shopId: input.shopId,
          traceId: input.traceId,
          payload: {
            touchId: plan.touchId,
            customerId: input.customerId,
            trigger: 'service_due',
            purpose: 'SERVICE',
            ledgerItemIds: [],
            jobCardId: null,
            vehicleId: input.vehicleId,
            messageId: outcome.messageId,
            amountPaise: 0,
            actor: { type: input.actor.type, id: input.actor.id },
          },
        };
        await this.deps.outbox.enqueue(tx, envelope);
      }
    });

    return {
      touchId: plan.touchId,
      status: outcome.status === 'SENT' ? 'SENT' : 'BLOCKED',
      messageId: outcome.status === 'SENT' ? outcome.messageId : null,
      detail: outcome.status === 'SENT' ? `T-${input.lead} reminder sent` : outcome.status,
    };
  }

  private async sendDocumentReminder(input: {
    readonly shopId: string;
    readonly document: {
      readonly id: string;
      readonly vehicleId: string;
      readonly customerId: string;
      readonly kind: DocumentKind;
      readonly expiresOn: string;
    };
    readonly traceId: string;
    readonly actor: Actor;
  }): Promise<RetentionOutcome> {
    const now = this.clock.now();
    const { document } = input;
    const dedupeKey = `document:${document.id}:${document.expiresOn}`;

    const plan = await this.deps.uow.transaction(async (tx) => {
      const hold = await this.deps.holds.active(tx, input.shopId, document.customerId);
      if (hold !== null) {
        return { kind: 'refuse' as const, code: 'RETENTION_FROZEN', reason: hold.reason };
      }

      const customer = await this.deps.directory.loadCustomer(
        tx,
        input.shopId,
        document.customerId,
      );
      const conversation = await this.deps.conversations.findByCustomer(
        tx,
        input.shopId,
        document.customerId,
        'WHATSAPP',
      );
      if (customer === null || conversation === null) {
        return { kind: 'refuse' as const, code: 'NO_THREAD', reason: 'No thread to write on' };
      }
      const vehicle = await this.deps.directory.loadVehicle(tx, input.shopId, document.vehicleId);
      const shopName = (await this.deps.shops.loadShopName(tx, input.shopId)) ?? 'the workshop';

      const touchId = uuidv7();
      const claimed = await this.deps.touches.claim(tx, {
        id: touchId,
        shopId: input.shopId,
        customerId: document.customerId,
        vehicleId: document.vehicleId,
        jobCardId: null,
        conversationId: conversation.id,
        trigger: 'document_expiry',
        // MARKETING, always. Renewing somebody's insurance is not this shop's
        // service to this vehicle; it is a thing the shop would like to sell.
        purpose: 'MARKETING',
        ledgerItemIds: [],
        amountPaise: 0,
        language: customer.language,
        dedupeKey,
        scheduledFor: now,
        traceId: input.traceId,
      });
      if (claimed === null) {
        return { kind: 'refuse' as const, code: 'ALREADY_SENT', reason: 'Already reminded this cycle' };
      }

      return {
        kind: 'send' as const,
        touchId,
        conversationId: conversation.id,
        language: customer.language,
        vehicleLabel: vehicle?.label ?? 'your vehicle',
        shopName,
      };
    });

    if (plan.kind === 'refuse') {
      return {
        touchId: '',
        status: 'SKIPPED',
        messageId: null,
        detail: `${plan.code}: ${plan.reason}`,
      };
    }

    const outcome = await this.deps.gate.send({
      shopId: input.shopId,
      conversationId: plan.conversationId,
      customerId: document.customerId,
      purpose: 'MARKETING',
      content: {
        kind: 'text',
        body: t(plan.language, 'reminder.document', {
          vehicle: plan.vehicleLabel,
          document: t(plan.language, documentLabelKey(document.kind)),
          date: document.expiresOn,
          shopName: plan.shopName,
        }),
      },
      actor: input.actor,
      traceId: input.traceId,
      flow: 'retention',
      language: plan.language,
      templated: true,
    });

    await this.deps.uow.transaction(async (tx) => {
      await this.deps.touches.settle(tx, {
        shopId: input.shopId,
        touchId: plan.touchId,
        status: outcome.status === 'SENT' ? 'SENT' : 'BLOCKED',
        messageId: outcome.status === 'SENT' ? outcome.messageId : null,
        skipCode: outcome.status === 'SENT' ? null : outcome.status,
        skipReason: outcome.status === 'SENT' ? null : 'reason' in outcome ? outcome.reason : null,
        releaseDedupeKey: outcome.status !== 'SENT',
        at: now,
      });

      if (outcome.status === 'SENT') {
        await this.deps.documents.markReminded(tx, {
          shopId: input.shopId,
          documentId: document.id,
          cycle: document.expiresOn,
          at: now,
        });

        const envelope: EventEnvelope = {
          id: uuidv7(),
          type: 'retention.touch_sent',
          occurredAt: now.toISOString(),
          shopId: input.shopId,
          traceId: input.traceId,
          payload: {
            touchId: plan.touchId,
            customerId: document.customerId,
            trigger: 'document_expiry',
            purpose: 'MARKETING',
            ledgerItemIds: [],
            jobCardId: null,
            vehicleId: document.vehicleId,
            messageId: outcome.messageId,
            amountPaise: 0,
            actor: { type: input.actor.type, id: input.actor.id },
          },
        };
        await this.deps.outbox.enqueue(tx, envelope);
      }
    });

    return {
      touchId: plan.touchId,
      status: outcome.status === 'SENT' ? 'SENT' : 'BLOCKED',
      messageId: outcome.status === 'SENT' ? outcome.messageId : null,
      detail: outcome.status === 'SENT' ? `${document.kind} reminder sent` : outcome.status,
    };
  }
}

/**
 * "around 14 March" rather than an instant.
 *
 * A service-due date is an estimate with a week of slack in it either way, and
 * printing `2026-03-14T09:00:00Z` would state a precision the forecast does not
 * have. The date alone is the honest rendering.
 */
function formatDueWindow(dueAt: Date, _language: Language): string {
  return dueAt.toISOString().slice(0, 10);
}
