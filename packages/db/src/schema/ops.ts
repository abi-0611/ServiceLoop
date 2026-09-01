import { sql } from 'drizzle-orm';
import {
  bigint,
  char,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, primaryId, timestamptz, updatedAt } from './columns';
import { customers, shops, staff, vehicles } from './core';
import { jobCards, workItems } from './jobs';
import {
  auditActorTypeEnum,
  declineKindEnum,
  declineReasonEnum,
  escalationChannelEnum,
  escalationRungTypeEnum,
  escalationStatusEnum,
  ledgerStatusEnum,
  objectiveEnum,
  outboxStatusEnum,
  repitchResponseEnum,
} from './enums';

/** Operational spine: ledger, escalations, config, audit, outbox, idempotency. */

export const declinedWorkLedger = pgTable(
  'declined_work_ledger',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    jobCardId: uuid('job_card_id')
      .notNull()
      .references(() => jobCards.id, { onDelete: 'cascade' }),
    workItemId: uuid('work_item_id')
      .notNull()
      .references(() => workItems.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'cascade' }),
    vehicleId: uuid('vehicle_id').references(() => vehicles.id, { onDelete: 'set null' }),
    kind: declineKindEnum('kind').notNull(),
    reason: text('reason').notNull(),
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull().default(0),
    /** Horizon after which phase 6 may re-pitch this work. */
    followUpAfter: timestamptz('follow_up_after'),
    /** Free-form tags ("monsoon", "next-service", "odometer>50000"). */
    triggerTags: jsonb('trigger_tags').notNull().default([]),
    status: ledgerStatusEnum('status').notNull().default('OPEN'),

    /* --- phase 6.1: the lifecycle the phase-1 row only sketched ---------- */

    /**
     * *Why* the customer said no, as opposed to `kind`, which records what the
     * work item's state became.
     *
     * Four reasons need four different follow-ups: a deferral is a timing
     * problem the horizon solves, a price objection needs the owner, and
     * distrust needs evidence rather than another quote.
     */
    declineReason: declineReasonEnum('decline_reason').notNull().default('other'),
    /** Shop-KB category ("brakes", "tyres", "cosmetic") — picks the horizon. */
    category: text('category'),
    /**
     * A snapshot of the item's title and the technician's own words at the time.
     *
     * Denormalised on purpose. A re-pitch three months later must restate what
     * the technician actually found on the day, and the work item's title may
     * since have been edited, its estimate superseded, and its media pruned by a
     * retention policy. L7 says a claim must trace to evidence; this is that
     * evidence, frozen at the moment the customer declined it.
     */
    title: text('title'),
    technicianNote: text('technician_note'),
    /** The bundle the original ask cited, so a re-pitch can cite the same one. */
    evidenceBundleId: uuid('evidence_bundle_id'),
    estimateLineIds: jsonb('estimate_line_ids').notNull().default([]),

    /** How many times this item has been re-pitched. Capped at 2 by CHECK. */
    repitchCount: integer('repitch_count').notNull().default(0),
    lastRepitchedAt: timestamptz('last_repitched_at'),
    /** What the customer tapped on the last re-pitch, if anything. */
    lastResponse: repitchResponseEnum('last_response'),

    closedAt: timestamptz('closed_at'),
    closedReason: text('closed_reason'),
    /** The visit the recovered work was done on. */
    convertedJobCardId: uuid('converted_job_card_id').references(() => jobCards.id, {
      onDelete: 'set null',
    }),
    recoveredAmountPaise: bigint('recovered_amount_paise', { mode: 'number' })
      .notNull()
      .default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('declined_work_ledger_work_item_key').on(table.workItemId),
    index('declined_work_ledger_followup_idx').on(table.shopId, table.status, table.followUpAfter),
    // The next-visit trigger's read: "what has this customer left undone?"
    index('declined_work_ledger_customer_idx').on(table.shopId, table.customerId, table.status),
    index('declined_work_ledger_vehicle_idx').on(table.shopId, table.vehicleId, table.status),
  ],
);

export const escalations = pgTable(
  'escalations',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    objective: objectiveEnum('objective').notNull(),
    /** Polymorphic subject (ApprovalRequest, JobCard, DeclinedWorkLedger, …). */
    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),
    ladderKey: text('ladder_key').notNull(),
    rung: integer('rung').notNull(),
    channel: escalationChannelEnum('channel').notNull(),
    /**
     * What the rung *is*, from shop config (phase 3.7) — as opposed to `channel`,
     * which is the transport it actually used. `VOICE_OR_ADVISOR` reads as
     * `HUMAN` on the channel column until phase 5 places the call itself, and
     * only this column records that the shop asked for a call.
     */
    rungType: escalationRungTypeEnum('rung_type').notNull().default('WHATSAPP'),
    /** The configured label, so an audit row reads in words, not indices. */
    label: text('label'),
    status: escalationStatusEnum('status').notNull().default('SCHEDULED'),
    scheduledAt: timestamptz('scheduled_at').notNull(),
    executedAt: timestamptz('executed_at'),
    cancelledAt: timestamptz('cancelled_at'),
    /** BullMQ delayed-job id, so a cancelled objective can drop its timer. */
    queueJobId: text('queue_job_id'),
    skipReason: text('skip_reason'),
    /** What the rung did: message id, advisor task id, or the block code. */
    resultDetail: text('result_detail'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('escalations_subject_rung_key').on(table.subjectType, table.subjectId, table.rung),
    index('escalations_due_idx').on(table.status, table.scheduledAt),
    index('escalations_shop_subject_idx').on(table.shopId, table.subjectId, table.status),
  ],
);

export const shopConfig = pgTable('shop_config', {
  shopId: uuid('shop_id')
    .primaryKey()
    .references(() => shops.id, { onDelete: 'cascade' }),
  configVersion: integer('config_version').notNull().default(1),
  /** Validated against `ShopConfigSchema` on every read and every write. */
  config: jsonb('config').notNull(),
  updatedById: uuid('updated_by_id').references(() => staff.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Append-only, hash-chained audit log (phase 1.7).
 *
 * UPDATE and DELETE are rejected by the `audit_events_append_only` trigger
 * created in migration 0001. `shop_id` is RESTRICT on purpose: a shop cannot be
 * deleted while its chain exists, so the chain can never be silently discarded.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'restrict' }),
    /** Per-shop monotonic sequence starting at 1. */
    seq: bigint('seq', { mode: 'number' }).notNull(),
    actorType: auditActorTypeEnum('actor_type').notNull(),
    actorId: uuid('actor_id'),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    payload: jsonb('payload').notNull().default({}),
    prevHash: char('prev_hash', { length: 64 }).notNull(),
    hash: char('hash', { length: 64 }).notNull(),
    traceId: text('trace_id').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('audit_events_shop_seq_key').on(table.shopId, table.seq),
    uniqueIndex('audit_events_hash_key').on(table.hash),
    index('audit_events_entity_idx').on(table.shopId, table.entityType, table.entityId),
  ],
);

/**
 * Transactional outbox (phase 1.5). Written in the same transaction as the
 * state change it describes, then drained by the dispatcher in
 * `apps/workers` with `FOR UPDATE SKIP LOCKED`.
 */
export const eventsOutbox = pgTable(
  'events_outbox',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    occurredAt: timestamptz('occurred_at').notNull(),
    traceId: text('trace_id').notNull(),
    status: outboxStatusEnum('status').notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    dispatchedAt: timestamptz('dispatched_at'),
    lastError: text('last_error'),
    createdAt: createdAt(),
  },
  (table) => [
    index('events_outbox_pending_idx')
      .on(table.status, table.occurredAt)
      .where(sql`status = 'PENDING'`),
    index('events_outbox_shop_idx').on(table.shopId, table.createdAt),
  ],
);

/**
 * Consumer-side idempotency. A handler claims `(consumer, event_id)` inside its
 * own transaction, so a redelivered event is a no-op rather than a duplicate
 * side effect.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    consumer: text('consumer').notNull(),
    eventId: uuid('event_id').notNull(),
    firstSeenAt: timestamptz('first_seen_at').notNull().defaultNow(),
    result: jsonb('result'),
  },
  (table) => [
    primaryKey({ columns: [table.consumer, table.eventId] }),
    index('idempotency_keys_seen_idx').on(table.firstSeenAt),
  ],
);
