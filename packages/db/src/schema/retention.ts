import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, encryptedText, primaryId, timestamptz, updatedAt } from './columns';
import { conversations, messages } from './comms';
import { customers, shops, staff, vehicles } from './core';
import { advisorTasks } from './agent';
import { jobCards, mediaAssets } from './jobs';
import {
  alertKindEnum,
  consentPurposeEnum,
  digestKindEnum,
  documentKindEnum,
  feedbackSentimentEnum,
  feedbackStatusEnum,
  languageEnum,
  retentionTouchStatusEnum,
  retentionTriggerEnum,
  rollupSourceEnum,
  taskUrgencyEnum,
} from './enums';

/**
 * Phase 6 — the loop that starts after the vehicle has left.
 *
 * Everything before this phase is about one visit. These tables are about the
 * gap between visits, and three shapes in them are worth explaining before the
 * columns:
 *
 *   - **`retention_touches` is one table for four flows.** Re-pitches, service
 *     reminders, document reminders and win-backs all write here, because the
 *     twenty-one-day floor is a property of *all of them together*. Four tables
 *     would let four flows each stay inside their own cap and jointly write to
 *     somebody weekly, which is the exact failure the floor exists to prevent.
 *   - **`retention_holds` is a table, not a flag on the customer.** A freeze has
 *     a cause, an author and an end, and "why is this customer not hearing from
 *     us" is a question an advisor will ask six weeks later. A boolean answers
 *     none of that.
 *   - **`metric_rollups` stores a hash of its own payload.** That is the audit
 *     story behind the "₹ recovered" number the whole business case rests on:
 *     a `recompute --from` that produces a different hash for a day already
 *     folded is a regression somebody can find, and the assertion is one
 *     comparison rather than a diff of forty numbers.
 */

/* -------------------------------------------------------------------------- *
 * 6.1 / 6.2 — retention touches and the freeze
 * -------------------------------------------------------------------------- */

/**
 * One retention contact: scheduled, then sent, skipped or blocked.
 *
 * The row exists **before** the message does, and survives whatever happened to
 * it. A touch the engine decided not to send is a `SKIPPED` row with a code;
 * one the gate refused is `BLOCKED` with the gate's own code. Both are silence
 * from the customer's side and completely different problems from the shop's,
 * and a system that recorded only what it sent could not tell them apart.
 *
 * `dedupeKey` is the idempotency identity — `repitch:<ledgerItemId>:<n>`,
 * `service_due:<vehicleId>:<dueDay>:<lead>`, `win_back:<customerId>:<month>`.
 * A scan that runs every ten minutes must not produce ten re-pitches.
 */
export const retentionTouches = pgTable(
  'retention_touches',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    vehicleId: uuid('vehicle_id').references(() => vehicles.id, { onDelete: 'set null' }),
    /** The visit this touch is about, when it is about one. */
    jobCardId: uuid('job_card_id').references(() => jobCards.id, { onDelete: 'set null' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    trigger: retentionTriggerEnum('trigger').notNull(),
    /**
     * SERVICE or MARKETING, decided per touch and never per flow.
     *
     * A re-pitch of a safety-relevant technician finding is SERVICE; the same
     * composer pitching a cosmetic item is MARKETING. The gate enforces the
     * matching consent, which is why this is stored rather than inferred.
     */
    purpose: consentPurposeEnum('purpose').notNull(),
    status: retentionTouchStatusEnum('status').notNull().default('SCHEDULED'),
    /** Ledger items this touch pitches. Empty for reminders and win-backs. */
    ledgerItemIds: jsonb('ledger_item_ids').notNull().default([]),
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull().default(0),
    language: languageEnum('language').notNull().default('en'),
    dedupeKey: text('dedupe_key').notNull(),
    scheduledFor: timestamptz('scheduled_for').notNull(),
    sentAt: timestamptz('sent_at'),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    agentRunId: uuid('agent_run_id'),
    /** Why it did not go: the engine's own code, or the gate's. */
    skipCode: text('skip_code'),
    skipReason: text('skip_reason'),
    traceId: text('trace_id').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('retention_touches_dedupe_key').on(table.shopId, table.dedupeKey),
    index('retention_touches_due_idx').on(table.shopId, table.status, table.scheduledFor),
    // The twenty-one-day floor reads this, per customer, on every send.
    index('retention_touches_customer_idx').on(table.shopId, table.customerId, table.sentAt),
  ],
);

/**
 * A customer nobody may pitch to right now (phase 6.4).
 *
 * Raised by negative feedback and released when the recovery task closes.
 * Deliberately generic — the hold has a reason and a source rather than being
 * a `negative_feedback` flag — because the next thing that needs to silence
 * retention (a complaint, a dispute, an owner's instruction) should reuse this
 * rather than adding a second way for the engine to be quiet.
 */
export const retentionHolds = pgTable(
  'retention_holds',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    reason: text('reason').notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: uuid('source_id'),
    /** The advisor task whose closure lifts the hold. */
    taskId: uuid('task_id').references(() => advisorTasks.id, { onDelete: 'set null' }),
    releasedAt: timestamptz('released_at'),
    releasedByStaffId: uuid('released_by_staff_id').references(() => staff.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('retention_holds_active_idx').on(table.shopId, table.customerId, table.releasedAt),
  ],
);

/**
 * Odometer readings the **customer** volunteered (phase 6.2).
 *
 * A table rather than a column on `vehicles`, because the trigger is a delta —
 * "three thousand kilometres since we flagged the pads" — and a single mutable
 * column cannot answer that. Append-only, and `source` is recorded on every row
 * so the odometer trigger can be restricted to what a person actually told us:
 * ServiceLoop reads nobody's telematics, and a reading a service advisor typed
 * off the dashboard at intake is a different kind of fact from one the customer
 * offered in a thread.
 */
export const odometerReadings = pgTable(
  'odometer_readings',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => vehicles.id, { onDelete: 'cascade' }),
    odometerKm: integer('odometer_km').notNull(),
    /** `CUSTOMER_VOLUNTEERED`, `INTAKE`, `CONSOLE`. Only the first fires triggers. */
    source: text('source').notNull(),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    jobCardId: uuid('job_card_id').references(() => jobCards.id, { onDelete: 'set null' }),
    readAt: timestamptz('read_at').notNull(),
    createdAt: createdAt(),
  },
  (table) => [index('odometer_readings_vehicle_idx').on(table.vehicleId, table.readAt)],
);

/* -------------------------------------------------------------------------- *
 * 6.4 — feedback, review routing and service recovery
 * -------------------------------------------------------------------------- */

/**
 * One post-service feedback ask, and whatever came back.
 *
 * One per job card, enforced by a unique index: a customer is asked about a
 * visit once, and the review ask that may follow a positive answer is a column
 * on this row rather than a second record — which is how "ask once, never nag"
 * is a property of the schema and not of a service somebody has to remember to
 * check.
 *
 * The comment is encrypted. It is the customer's own words about a business
 * they used, frequently including their name, their complaint and occasionally
 * their opinion of a named technician.
 */
export const feedbackRequests = pgTable(
  'feedback_requests',
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
    status: feedbackStatusEnum('status').notNull().default('SCHEDULED'),
    deliveredAt: timestamptz('delivered_at').notNull(),
    /** When the ask becomes due — `deliveredAt` plus the shop's configured lag. */
    dueAt: timestamptz('due_at').notNull(),
    askedAt: timestamptz('asked_at'),
    askMessageId: uuid('ask_message_id').references(() => messages.id, { onDelete: 'set null' }),
    remindedAt: timestamptz('reminded_at'),
    expiresAt: timestamptz('expires_at').notNull(),
    answeredAt: timestamptz('answered_at'),
    sentiment: feedbackSentimentEnum('sentiment'),
    commentEncrypted: encryptedText('comment_encrypted'),
    viaVoiceNote: boolean('via_voice_note').notNull().default(false),
    /** The voice note itself, when the comment was spoken. */
    mediaId: uuid('media_id').references(() => mediaAssets.id, { onDelete: 'set null' }),
    reviewAskedAt: timestamptz('review_asked_at'),
    reviewMessageId: uuid('review_message_id').references(() => messages.id, {
      onDelete: 'set null',
    }),
    /** The service-recovery task a negative answer raises. */
    recoveryTaskId: uuid('recovery_task_id').references(() => advisorTasks.id, {
      onDelete: 'set null',
    }),
    holdId: uuid('hold_id').references(() => retentionHolds.id, { onDelete: 'set null' }),
    traceId: text('trace_id').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('feedback_requests_job_card_key').on(table.shopId, table.jobCardId),
    index('feedback_requests_due_idx').on(table.shopId, table.status, table.dueAt),
    index('feedback_requests_customer_idx').on(table.shopId, table.customerId, table.answeredAt),
  ],
);

/* -------------------------------------------------------------------------- *
 * 6.5 — reminders: the next service, and the papers
 * -------------------------------------------------------------------------- */

/**
 * When this vehicle is next due (phase 6.5).
 *
 * One live forecast per vehicle, superseded on every visit. `basis` records
 * which rule produced it — the shop's calendar interval, or the customer's own
 * odometer readings — because a reminder that arrives three weeks early is a
 * different bug depending on which one was used, and only the row can say.
 *
 * `remindedLeads` is the list of lead days already sent. A forecast that moved
 * because the customer came in early therefore does not re-send a T-7 reminder
 * it has already sent for the same due date.
 */
export const serviceDueForecasts = pgTable(
  'service_due_forecasts',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => vehicles.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    /** The visit the forecast was computed from. */
    jobCardId: uuid('job_card_id').references(() => jobCards.id, { onDelete: 'set null' }),
    dueAt: timestamptz('due_at').notNull(),
    basis: text('basis').notNull(),
    remindedLeads: jsonb('reminded_leads').notNull().default([]),
    supersededAt: timestamptz('superseded_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // One live forecast per vehicle. A superseded one keeps its row for history.
    uniqueIndex('service_due_forecasts_live_key')
      .on(table.shopId, table.vehicleId)
      .where(sql`superseded_at IS NULL`),
    index('service_due_forecasts_due_idx').on(table.shopId, table.dueAt),
  ],
);

/**
 * A document the customer **asked** us to keep track of (phase 6.5).
 *
 * The enrolment is the point of the table. A shop frequently knows an insurance
 * expiry because it saw the papers at intake; that is not permission to write to
 * somebody about it. `enrolledAt` is the record of them saying yes, `revokedAt`
 * of them changing their mind, and a row with neither is a date we hold and do
 * not act on.
 *
 * `lastRemindedCycle` stores the expiry date the last reminder was *about*, so
 * a renewal that pushes the date out a year re-arms the reminder and a scan
 * that runs daily does not send fifteen.
 */
export const vehicleDocuments = pgTable(
  'vehicle_documents',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => vehicles.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    kind: documentKindEnum('kind').notNull(),
    expiresOn: date('expires_on').notNull(),
    enrolledAt: timestamptz('enrolled_at'),
    enrolledVia: text('enrolled_via'),
    revokedAt: timestamptz('revoked_at'),
    lastRemindedAt: timestamptz('last_reminded_at'),
    lastRemindedCycle: date('last_reminded_cycle'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('vehicle_documents_kind_key').on(table.shopId, table.vehicleId, table.kind),
    index('vehicle_documents_expiry_idx').on(table.shopId, table.expiresOn),
  ],
);

/* -------------------------------------------------------------------------- *
 * 6.7 / 6.8 — the owner's brief and the exceptions that cannot wait for it
 * -------------------------------------------------------------------------- */

/**
 * One assembled digest, with the payload it printed.
 *
 * Stored rather than recomputed on demand, because "what did the owner see on
 * the 14th" is a different question from "what were the numbers for the 14th":
 * the second is recomputable from the rollup for ever, and the first is a fact
 * about a message that was sent, which stops being derivable the moment the
 * rollup is corrected.
 */
export const ownerDigests = pgTable(
  'owner_digests',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    kind: digestKindEnum('kind').notNull(),
    /** The shop-local calendar day the digest covers. */
    day: date('day').notNull(),
    recipientStaffId: uuid('recipient_staff_id').references(() => staff.id, {
      onDelete: 'cascade',
    }),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    language: languageEnum('language').notNull().default('en'),
    /** The rendered lines and every number behind them. */
    payload: jsonb('payload').notNull(),
    sentAt: timestamptz('sent_at'),
    blockedReason: text('blocked_reason'),
    traceId: text('trace_id').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('owner_digests_day_key').on(
      table.shopId,
      table.kind,
      table.day,
      table.recipientStaffId,
    ),
    index('owner_digests_shop_day_idx').on(table.shopId, table.day),
  ],
);

/**
 * An exception the owner hears about now (phase 6.8).
 *
 * `incidentKey` is unique per shop and *is* the dedup: one alert per incident,
 * however many times a scan that runs every two minutes re-observes the same
 * stuck approval. The key names the incident rather than the observation —
 * `approval_stuck:<approvalId>`, not `approval_stuck:<approvalId>:<timestamp>`.
 */
export const exceptionAlerts = pgTable(
  'exception_alerts',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    kind: alertKindEnum('kind').notNull(),
    incidentKey: text('incident_key').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id'),
    urgency: taskUrgencyEnum('urgency').notNull().default('HIGH'),
    detail: text('detail').notNull(),
    recipientStaffId: uuid('recipient_staff_id').references(() => staff.id, {
      onDelete: 'set null',
    }),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    taskId: uuid('task_id').references(() => advisorTasks.id, { onDelete: 'set null' }),
    /** Set when the alert was held rather than delivered — quiet hours, a block. */
    heldReason: text('held_reason'),
    raisedAt: timestamptz('raised_at').notNull(),
    resolvedAt: timestamptz('resolved_at'),
    traceId: text('trace_id').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('exception_alerts_incident_key').on(table.shopId, table.incidentKey),
    index('exception_alerts_shop_raised_idx').on(table.shopId, table.raisedAt),
  ],
);

/* -------------------------------------------------------------------------- *
 * 6.9 — the metrics service
 * -------------------------------------------------------------------------- */

/**
 * One day of KPIs for one shop, folded from the event log.
 *
 * The primary key is `(shop, day)` and a recompute overwrites in place, because
 * a rollup is a **derived value with exactly one correct answer**, not a record
 * of an opinion held at a point in time. `payloadHash` is the equality the
 * phase's audit story rests on: a backfill that changes a day's numbers is
 * visible as a changed hash, and the property test that proves
 * `recompute --from` reproduces the fold compares one string rather than forty
 * fields.
 */
export const metricRollups = pgTable(
  'metric_rollups',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    timezone: text('timezone').notNull(),
    payload: jsonb('payload').notNull(),
    /** sha256 of the canonical JSON of `payload`. */
    payloadHash: text('payload_hash').notNull(),
    source: rollupSourceEnum('source').notNull().default('LIVE'),
    eventsRead: integer('events_read').notNull().default(0),
    computedAt: timestamptz('computed_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('metric_rollups_shop_day_key').on(table.shopId, table.day),
    index('metric_rollups_day_idx').on(table.day),
  ],
);

/* -------------------------------------------------------------------------- *
 * Relations
 * -------------------------------------------------------------------------- */

export const retentionTouchesRelations = relations(retentionTouches, ({ one }) => ({
  shop: one(shops, { fields: [retentionTouches.shopId], references: [shops.id] }),
  customer: one(customers, {
    fields: [retentionTouches.customerId],
    references: [customers.id],
  }),
  message: one(messages, { fields: [retentionTouches.messageId], references: [messages.id] }),
}));

export const retentionHoldsRelations = relations(retentionHolds, ({ one }) => ({
  customer: one(customers, { fields: [retentionHolds.customerId], references: [customers.id] }),
  task: one(advisorTasks, { fields: [retentionHolds.taskId], references: [advisorTasks.id] }),
}));

export const feedbackRequestsRelations = relations(feedbackRequests, ({ one }) => ({
  jobCard: one(jobCards, { fields: [feedbackRequests.jobCardId], references: [jobCards.id] }),
  customer: one(customers, {
    fields: [feedbackRequests.customerId],
    references: [customers.id],
  }),
  recoveryTask: one(advisorTasks, {
    fields: [feedbackRequests.recoveryTaskId],
    references: [advisorTasks.id],
  }),
}));

export const vehicleDocumentsRelations = relations(vehicleDocuments, ({ one }) => ({
  vehicle: one(vehicles, { fields: [vehicleDocuments.vehicleId], references: [vehicles.id] }),
}));

export const serviceDueForecastsRelations = relations(serviceDueForecasts, ({ one }) => ({
  vehicle: one(vehicles, { fields: [serviceDueForecasts.vehicleId], references: [vehicles.id] }),
}));

export const odometerReadingsRelations = relations(odometerReadings, ({ one }) => ({
  vehicle: one(vehicles, { fields: [odometerReadings.vehicleId], references: [vehicles.id] }),
}));

export const ownerDigestsRelations = relations(ownerDigests, ({ one }) => ({
  shop: one(shops, { fields: [ownerDigests.shopId], references: [shops.id] }),
  recipient: one(staff, { fields: [ownerDigests.recipientStaffId], references: [staff.id] }),
}));

export const exceptionAlertsRelations = relations(exceptionAlerts, ({ one }) => ({
  shop: one(shops, { fields: [exceptionAlerts.shopId], references: [shops.id] }),
}));

export const metricRollupsRelations = relations(metricRollups, ({ one }) => ({
  shop: one(shops, { fields: [metricRollups.shopId], references: [shops.id] }),
}));
