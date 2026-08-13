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
import { createdAt, deletedAt, primaryId, timestamptz, updatedAt } from './columns';
import { customers, shops, staff, vehicles } from './core';
import {
  approvalStatusEnum,
  estimateLineKindEnum,
  estimateStatusEnum,
  jobCardSourceEnum,
  jobCardStateEnum,
  languageEnum,
  mediaKindEnum,
  workItemStateEnum,
} from './enums';

/** The service visit and everything hanging off it. */

export const jobCards = pgTable(
  'job_cards',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => vehicles.id, { onDelete: 'restrict' }),
    /** Human reference printed on the gate pass, e.g. `JC-2026-0007`. */
    code: text('code').notNull(),
    state: jobCardStateEnum('state').notNull().default('DRAFT'),
    stateChangedAt: timestamptz('state_changed_at').notNull().defaultNow(),
    /** Optimistic-concurrency counter, bumped by every accepted transition. */
    version: integer('version').notNull().default(1),
    /** L2: a photographed paper card is a first-class source. */
    source: jobCardSourceEnum('source').notNull().default('CONSOLE'),
    complaintText: text('complaint_text'),
    odometerKm: integer('odometer_km'),
    assignedAdvisorId: uuid('assigned_advisor_id').references(() => staff.id, {
      onDelete: 'set null',
    }),
    assignedTechnicianId: uuid('assigned_technician_id').references(() => staff.id, {
      onDelete: 'set null',
    }),
    openedAt: timestamptz('opened_at'),
    promisedAt: timestamptz('promised_at'),
    deliveredAt: timestamptz('delivered_at'),
    closedAt: timestamptz('closed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    uniqueIndex('job_cards_shop_code_key').on(table.shopId, table.code),
    index('job_cards_shop_state_idx').on(table.shopId, table.state),
    index('job_cards_shop_updated_idx').on(table.shopId, table.updatedAt),
    index('job_cards_customer_idx').on(table.customerId),
    index('job_cards_vehicle_idx').on(table.vehicleId),
  ],
);

export const workItems = pgTable(
  'work_items',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    jobCardId: uuid('job_card_id')
      .notNull()
      .references(() => jobCards.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    state: workItemStateEnum('state').notNull().default('PROPOSED'),
    /** Work the customer must authorise before it may be billed. */
    requiresApproval: boolean('requires_approval').notNull().default(true),
    /** L7: the technician's own words, the anchor for any customer-facing claim. */
    technicianNote: text('technician_note'),
    estimatedMinutes: integer('estimated_minutes'),
    sequence: integer('sequence').notNull().default(0),
    approvedAt: timestamptz('approved_at'),
    startedAt: timestamptz('started_at'),
    completedAt: timestamptz('completed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('work_items_job_card_idx').on(table.jobCardId, table.sequence),
    index('work_items_shop_state_idx').on(table.shopId, table.state),
  ],
);

export const estimates = pgTable(
  'estimates',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    jobCardId: uuid('job_card_id')
      .notNull()
      .references(() => jobCards.id, { onDelete: 'cascade' }),
    /** Versioned: a revised quote supersedes rather than overwrites. */
    version: integer('version').notNull().default(1),
    status: estimateStatusEnum('status').notNull().default('DRAFT'),
    currency: text('currency').notNull().default('INR'),
    subtotalPaise: bigint('subtotal_paise', { mode: 'number' }).notNull().default(0),
    taxPaise: bigint('tax_paise', { mode: 'number' }).notNull().default(0),
    totalPaise: bigint('total_paise', { mode: 'number' }).notNull().default(0),
    acceptedAt: timestamptz('accepted_at'),
    createdById: uuid('created_by_id').references(() => staff.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('estimates_job_card_version_key').on(table.jobCardId, table.version),
    index('estimates_shop_status_idx').on(table.shopId, table.status),
  ],
);

/**
 * Immutable once their estimate is ACCEPTED — enforced by the
 * `estimate_lines_immutable_when_accepted` trigger (migration 0001) as well as
 * by the repository guard, because an accepted amount is a promise.
 */
export const estimateLines = pgTable(
  'estimate_lines',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    estimateId: uuid('estimate_id')
      .notNull()
      .references(() => estimates.id, { onDelete: 'cascade' }),
    workItemId: uuid('work_item_id').references(() => workItems.id, { onDelete: 'set null' }),
    kind: estimateLineKindEnum('kind').notNull(),
    description: text('description').notNull(),
    /** Milli-units so 1.5 labour hours is the integer 1500. */
    quantityMilli: integer('quantity_milli').notNull().default(1000),
    unitPricePaise: bigint('unit_price_paise', { mode: 'number' }).notNull(),
    lineTotalPaise: bigint('line_total_paise', { mode: 'number' }).notNull(),
    taxRateBp: integer('tax_rate_bp').notNull().default(1800),
    sequence: integer('sequence').notNull().default(0),
    createdAt: createdAt(),
  },
  (table) => [index('estimate_lines_estimate_idx').on(table.estimateId, table.sequence)],
);

export const mediaAssets = pgTable(
  'media_assets',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    jobCardId: uuid('job_card_id').references(() => jobCards.id, { onDelete: 'cascade' }),
    workItemId: uuid('work_item_id').references(() => workItems.id, { onDelete: 'set null' }),
    kind: mediaKindEnum('kind').notNull(),
    bucket: text('bucket').notNull(),
    storageKey: text('storage_key').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    checksumSha256: text('checksum_sha256').notNull(),
    caption: text('caption'),
    capturedById: uuid('captured_by_id').references(() => staff.id, { onDelete: 'set null' }),
    capturedAt: timestamptz('captured_at'),
    createdAt: createdAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    uniqueIndex('media_assets_bucket_key_key').on(table.bucket, table.storageKey),
    index('media_assets_job_card_idx').on(table.jobCardId),
  ],
);

/**
 * The composed artifact a customer actually sees: media + itemised lines +
 * plain-language explanation. Member ids are stored as JSON arrays rather than
 * join tables so that hard-deleting a media asset (DPDP) cannot break a bundle
 * that has already been sent — the bundle records what it cited at send time.
 */
export const evidenceBundles = pgTable(
  'evidence_bundles',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    jobCardId: uuid('job_card_id')
      .notNull()
      .references(() => jobCards.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    summaryText: text('summary_text').notNull(),
    language: languageEnum('language').notNull().default('en'),
    mediaIds: jsonb('media_ids').notNull().default([]),
    estimateLineIds: jsonb('estimate_line_ids').notNull().default([]),
    workItemIds: jsonb('work_item_ids').notNull().default([]),
    createdAt: createdAt(),
  },
  (table) => [index('evidence_bundles_job_card_idx').on(table.jobCardId)],
);

export const approvalRequests = pgTable(
  'approval_requests',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    jobCardId: uuid('job_card_id')
      .notNull()
      .references(() => jobCards.id, { onDelete: 'cascade' }),
    estimateId: uuid('estimate_id').references(() => estimates.id, { onDelete: 'set null' }),
    evidenceBundleId: uuid('evidence_bundle_id').references(() => evidenceBundles.id, {
      onDelete: 'set null',
    }),
    objective: text('objective').notNull().default('APPROVAL'),
    status: approvalStatusEnum('status').notNull().default('PENDING'),
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull().default(0),
    requestedAt: timestamptz('requested_at').notNull().defaultNow(),
    /** L3: the ladder's hard stop for this objective. */
    deadlineAt: timestamptz('deadline_at'),
    decidedAt: timestamptz('decided_at'),
    decisionChannel: text('decision_channel'),
    decisionNote: text('decision_note'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('approval_requests_job_card_idx').on(table.jobCardId),
    index('approval_requests_shop_status_idx').on(table.shopId, table.status),
  ],
);

export const jobCardsRelations = relations(jobCards, ({ one, many }) => ({
  shop: one(shops, { fields: [jobCards.shopId], references: [shops.id] }),
  customer: one(customers, { fields: [jobCards.customerId], references: [customers.id] }),
  vehicle: one(vehicles, { fields: [jobCards.vehicleId], references: [vehicles.id] }),
  advisor: one(staff, { fields: [jobCards.assignedAdvisorId], references: [staff.id] }),
  workItems: many(workItems),
  estimates: many(estimates),
  mediaAssets: many(mediaAssets),
  approvalRequests: many(approvalRequests),
}));

export const workItemsRelations = relations(workItems, ({ one }) => ({
  jobCard: one(jobCards, { fields: [workItems.jobCardId], references: [jobCards.id] }),
}));

export const estimatesRelations = relations(estimates, ({ one, many }) => ({
  jobCard: one(jobCards, { fields: [estimates.jobCardId], references: [jobCards.id] }),
  lines: many(estimateLines),
}));

export const estimateLinesRelations = relations(estimateLines, ({ one }) => ({
  estimate: one(estimates, { fields: [estimateLines.estimateId], references: [estimates.id] }),
  workItem: one(workItems, { fields: [estimateLines.workItemId], references: [workItems.id] }),
}));
