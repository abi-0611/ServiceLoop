import type { RetentionRuntime } from '@serviceloop/agent-core';
import type { Tx } from '@serviceloop/db';
import { PgJobCardContextReader } from '@serviceloop/db';
import { sql } from 'drizzle-orm';
import type { EventHandler } from './registry';

/**
 * The phase-6 event handlers.
 *
 * Every one of them is a *consumer* of a fact some other phase already
 * committed, which is the shape the outbox exists to make possible: retention
 * adds handlers rather than call sites, and nothing in phases 1–5 had to learn
 * that a ledger, a feedback ask or an alert stream exists.
 *
 * Two of them are only correct because they are idempotent by index rather than
 * by care. `ledger.open` collides on `work_item_id` and
 * `feedback.scheduleForDelivery` on `(shop, job_card)`, so a redelivered event —
 * which the outbox guarantees will happen — writes nothing the second time.
 */

/**
 * A work item was declined or deferred → the ledger learns why, and when to
 * raise it again (phase 6.1).
 *
 * The work-item transition already wrote a bare row inside its own transaction;
 * this fills in the horizon, the category and the frozen copy of what the
 * technician said. Doing it from the event rather than inside the transition
 * keeps the phase-3 service ignorant of phase 6 and means the shop-KB lookup —
 * which is a read of a different aggregate — does not lengthen a transaction
 * that holds a row lock on a job card.
 */
export function createLedgerHandler(
  retention: RetentionRuntime<Tx>,
  cards: PgJobCardContextReader = new PgJobCardContextReader(),
): EventHandler {
  return {
    name: 'retention-ledger',
    handles: ['work_item.state_changed'],

    async handle({ envelope, tx, logger }) {
      if (envelope.type !== 'work_item.state_changed') return { ignored: envelope.type };
      const { to, workItemId, jobCardId } = envelope.payload;
      if (to !== 'DECLINED' && to !== 'DEFERRED') return { ignored: to };

      const card = await cards.load(tx, envelope.shopId, jobCardId);
      if (card === null) return { skipped: 'no card context' };

      const reason = typeof envelope.payload.meta['reason'] === 'string'
        ? envelope.payload.meta['reason']
        : '';
      const item = card.workItems.find((candidate) => candidate.id === workItemId);
      const line = card.estimate?.lines.find((candidate) => candidate.workItemId === workItemId);

      const result = await retention.ledger.open({
        shopId: envelope.shopId,
        jobCardId,
        workItemId,
        customerId: card.customerId,
        vehicleId: await vehicleForCard(tx, envelope.shopId, jobCardId),
        kind: to,
        // The transition's own reason string is free text an advisor typed; the
        // structured reason is what the four different follow-ups key off, and
        // classifying it here from the words available is the honest amount of
        // inference to do. Anything richer belongs to a person, not a regex.
        declineReason: classifyReason(reason),
        reason: reason === '' ? 'Declined' : reason,
        amountPaise: line?.lineTotalPaise ?? 0,
        category: categoryFor(item?.title ?? ''),
        title: item?.title ?? null,
        technicianNote: item?.technicianNote ?? null,
        evidenceBundleId: null,
        estimateLineIds: line === undefined ? [] : [line.id],
        traceId: envelope.traceId,
      });

      logger.info(
        { workItemId, ledgerItemId: result.ledgerItemId, created: result.created },
        'ledger item opened',
      );
      return { ledgerItemId: result.ledgerItemId, created: result.created };
    },
  };
}

/**
 * A vehicle went home → ask how it went, and work out when it is next due
 * (phases 6.4 and 6.5).
 *
 * Both hang off `DELIVERED` rather than off a scan for the reason the phase
 * file gives for the feedback ask: "the customer has their car back" is an
 * event the system already has, and re-deriving it from a state scan would be a
 * second answer to a question that has one.
 */
export function createDeliveredHandler(
  retention: RetentionRuntime<Tx>,
  cards: PgJobCardContextReader = new PgJobCardContextReader(),
): EventHandler {
  return {
    name: 'retention-delivered',
    handles: ['job_card.state_changed'],

    async handle({ envelope, tx, logger }) {
      if (envelope.type !== 'job_card.state_changed') return { ignored: envelope.type };
      if (envelope.payload.to !== 'DELIVERED') return { ignored: envelope.payload.to };

      const jobCardId = envelope.payload.jobCardId;
      const card = await cards.load(tx, envelope.shopId, jobCardId);
      if (card === null) return { skipped: 'no card context' };

      const deliveredAt = new Date(envelope.occurredAt);
      const conversationId = await conversationForCustomer(tx, envelope.shopId, card.customerId);
      const vehicleId = await vehicleForCard(tx, envelope.shopId, jobCardId);

      const feedbackId = await retention.feedback.scheduleForDelivery({
        shopId: envelope.shopId,
        jobCardId,
        customerId: card.customerId,
        conversationId,
        deliveredAt,
        traceId: envelope.traceId,
      });

      const forecast =
        vehicleId === null
          ? null
          : await retention.reminders.forecastFromVisit({
              shopId: envelope.shopId,
              vehicleId,
              customerId: card.customerId,
              jobCardId,
              deliveredAt,
              traceId: envelope.traceId,
            });

      logger.info(
        { jobCardId, feedbackId, nextServiceDue: forecast?.dueAt?.toISOString() ?? null },
        'delivery scheduled feedback and the next-service forecast',
      );
      return { feedbackId, forecast: forecast?.basis ?? null };
    },
  };
}

/**
 * An approval was decided → previously-declined work may just have converted
 * (phase 6.1).
 *
 * The other half of the arc, and the moment "₹ recovered" gets a rupee in it.
 * The advisor did nothing here beyond adding the deferred line to the new card
 * from the drawer prompt; that wrote `work_items.ledger_item_id`, and this
 * follows it.
 */
export function createConversionHandler(retention: RetentionRuntime<Tx>): EventHandler {
  return {
    name: 'retention-conversion',
    handles: ['approval.decided'],

    async handle({ envelope, logger }) {
      if (envelope.type !== 'approval.decided') return { ignored: envelope.type };
      const approved = envelope.payload.approvedWorkItemIds;
      if (approved.length === 0) return { converted: 0 };

      const converted = await retention.retention.convertFromApproval({
        shopId: envelope.shopId,
        jobCardId: envelope.payload.jobCardId,
        approvedWorkItemIds: approved,
        traceId: envelope.traceId,
        actor: envelope.payload.actor,
      });

      if (converted.length > 0) {
        logger.info(
          {
            jobCardId: envelope.payload.jobCardId,
            converted: converted.length,
            recoveredPaise: converted.reduce((sum, row) => sum + row.recoveredPaise, 0),
          },
          'declined work recovered',
        );
      }
      return { converted: converted.length };
    },
  };
}

/**
 * The two exceptions phases 4 and 5 emit that an owner should hear about now
 * (phase 6.8).
 *
 * A repeat silent bay and a payment that has failed twice. Both are already
 * facts on the log; all this does is decide that they are worth interrupting
 * somebody for, and the alert store's incident key decides they are worth
 * interrupting them *once*.
 */
export function createExceptionAlertHandler(retention: RetentionRuntime<Tx>): EventHandler {
  return {
    name: 'retention-alerts',
    handles: ['silent_bay.detected', 'payment.recorded'],

    async handle({ envelope, tx, logger }) {
      if (envelope.type === 'silent_bay.detected') {
        const payload = envelope.payload;
        // One window is a technician on a tea break. The shop's own threshold
        // decides how many in a row is a vehicle nobody is working on.
        const threshold = await silentWindowThreshold(tx, envelope.shopId);
        if (payload.consecutiveWindows < threshold) {
          return { skipped: `only ${payload.consecutiveWindows} window(s)` };
        }

        const result = await retention.alerts.silentBayRepeat({
          shopId: envelope.shopId,
          jobCardId: payload.jobCardId,
          vehicleLabel: payload.code,
          windows: payload.consecutiveWindows,
          traceId: envelope.traceId,
        });
        logger.info({ jobCardId: payload.jobCardId, alertId: result.alertId }, 'silent bay alert');
        return { alertId: result.alertId };
      }

      if (envelope.type !== 'payment.recorded') return { ignored: envelope.type };
      if (envelope.payload.kind !== 'FAILED') return { ignored: envelope.payload.kind };

      const failures = await failureCount(tx, envelope.shopId, envelope.payload.paymentId);
      const threshold = await paymentFailureThreshold(tx, envelope.shopId);
      if (failures < threshold) return { skipped: `${failures} failure(s)` };

      const result = await retention.alerts.paymentFailedTwice({
        shopId: envelope.shopId,
        paymentId: envelope.payload.paymentId,
        jobCardId: envelope.payload.jobCardId,
        vehicleLabel: await vehicleLabelForCard(tx, envelope.shopId, envelope.payload.jobCardId),
        amountPaise: envelope.payload.amountPaise,
        traceId: envelope.traceId,
      });
      logger.info(
        { paymentId: envelope.payload.paymentId, alertId: result.alertId },
        'payment failure alert',
      );
      return { alertId: result.alertId };
    },
  };
}

/* -------------------------------------------------------------------------- *
 * The three SQL reads these handlers need
 * -------------------------------------------------------------------------- */

async function vehicleForCard(tx: Tx, shopId: string, jobCardId: string): Promise<string | null> {
  const result = await tx.execute<{ vehicle_id: string | null }>(sql`
    select vehicle_id from job_cards where id = ${jobCardId} and shop_id = ${shopId}
  `);
  return result.rows[0]?.vehicle_id ?? null;
}

async function vehicleLabelForCard(tx: Tx, shopId: string, jobCardId: string): Promise<string> {
  const result = await tx.execute<{ label: string | null; registration: string | null }>(sql`
    select trim(concat_ws(' ', v.make, v.model)) as label, v.registration_normalised as registration
    from job_cards j left join vehicles v on v.id = j.vehicle_id
    where j.id = ${jobCardId} and j.shop_id = ${shopId}
  `);
  const row = result.rows[0];
  const label = row?.label ?? '';
  return label.length > 0 ? label : (row?.registration ?? 'the vehicle');
}

async function conversationForCustomer(
  tx: Tx,
  shopId: string,
  customerId: string,
): Promise<string | null> {
  const result = await tx.execute<{ id: string }>(sql`
    select id from conversations
    where shop_id = ${shopId} and customer_id = ${customerId} and channel = 'WHATSAPP'
    order by created_at desc limit 1
  `);
  return result.rows[0]?.id ?? null;
}

async function failureCount(tx: Tx, shopId: string, paymentId: string): Promise<number> {
  const result = await tx.execute<{ count: number }>(sql`
    select count(*)::int as count from payment_events
    where shop_id = ${shopId} and payment_id = ${paymentId} and kind = 'FAILED'
  `);
  return Number(result.rows[0]?.count ?? 0);
}

async function silentWindowThreshold(tx: Tx, shopId: string): Promise<number> {
  const result = await tx.execute<{ value: number | null }>(sql`
    select (config -> 'statusComms' ->> 'silentWindowsBeforeEscalation')::int as value
    from shop_config where shop_id = ${shopId}
  `);
  return Number(result.rows[0]?.value ?? 2);
}

async function paymentFailureThreshold(tx: Tx, shopId: string): Promise<number> {
  const result = await tx.execute<{ value: number | null }>(sql`
    select (config -> 'alerts' ->> 'paymentFailuresBeforeAlert')::int as value
    from shop_config where shop_id = ${shopId}
  `);
  return Number(result.rows[0]?.value ?? 2);
}

/**
 * The shop-KB category of a work item, from its title.
 *
 * A keyword table rather than a model, and deliberately conservative: an
 * uncategorised item gets `null`, which means no timed re-pitch at all. Getting
 * this wrong in the permissive direction would put brake work on a cosmetic
 * horizon or, worse, pitch a cosmetic item as a safety finding on SERVICE
 * consent — so the failure mode is silence, and the fix is a shop editing its
 * own category rules rather than a classifier being retrained.
 */
const CATEGORY_KEYWORDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['brakes', ['brake', 'pad', 'caliper', 'disc', 'rotor']],
  ['tyres', ['tyre', 'tire', 'wheel align', 'balanc']],
  ['suspension', ['suspension', 'shock', 'strut', 'bush', 'link rod']],
  ['battery', ['battery', 'alternator']],
  ['wipers', ['wiper', 'blade', 'washer']],
  ['underbody', ['underbody', 'anti-rust', 'antirust', 'chassis']],
  ['ac', ['a/c', ' ac ', 'aircon', 'air con', 'cooling coil', 'compressor']],
  ['cosmetic', ['scratch', 'dent', 'polish', 'respray', 'paint', 'alloy refurb']],
];

export function categoryFor(title: string): string | null {
  const haystack = ` ${title.toLowerCase()} `;
  for (const [category, keywords] of CATEGORY_KEYWORDS) {
    if (keywords.some((keyword) => haystack.includes(keyword))) return category;
  }
  return null;
}

/**
 * Which of the four decline reasons the advisor's words describe.
 *
 * The same conservatism: `other` is the answer whenever the words do not say,
 * and `other` gets the shop's default horizon, which ships as "never re-pitch
 * on a timer". A misread reason is a re-pitch aimed at the wrong objection.
 */
export function classifyReason(
  reason: string,
): 'customer_deferred' | 'customer_partial' | 'price' | 'distrust' | 'other' {
  const words = reason.toLowerCase();
  if (/(price|cost|expensive|budget|discount|afford)/.test(words)) return 'price';
  if (/(later|next (time|month|visit)|defer|wait|after)/.test(words)) return 'customer_deferred';
  if (/(partial|only|just the)/.test(words)) return 'customer_partial';
  if (/(really need|not sure|second opinion|trust|doubt)/.test(words)) return 'distrust';
  return 'other';
}
