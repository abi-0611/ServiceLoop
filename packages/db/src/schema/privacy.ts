import { index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, primaryId, timestamptz, updatedAt } from './columns';
import { customers, shops, staff } from './core';
import {
  cascadeActionEnum,
  dataRequestKindEnum,
  dataRequestStatusEnum,
  dataRequestVerificationEnum,
} from './enums';

/**
 * DPDP data-principal workflows (phase 7.2).
 *
 * Two tables, and the split between them is the point. `data_requests` is the
 * *workflow* — who asked, how we know it was them, who approved, when it runs.
 * `data_request_steps` is the *completion report* — one row per table touched,
 * with what was done to it and how many rows.
 *
 * The report is not a convenience. Section 8 of the Act makes the data
 * fiduciary accountable for erasure, and "we ran a delete" is not an answer to
 * "show me". A per-table record written inside the same transaction as the
 * deletion itself is, and it is what the console renders back to the customer.
 */

export const dataRequests = pgTable(
  'data_requests',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    /**
     * Nullable, and it becomes null on completion of a deletion.
     *
     * A finished deletion request that still pointed at the customer row would
     * either keep that row alive (defeating the deletion) or cascade the
     * request away with it (destroying the evidence that the deletion
     * happened). The pseudonym below is what the completed row identifies
     * itself by.
     */
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    /**
     * The stable one-way pseudonym for this data principal, minted when the
     * request is created and written onto every row that survives the cascade.
     *
     * Derived from `HMAC(blindIndexKey, shopId || customerId)`, so it is
     * reproducible for a second request about the same person and useless to
     * anybody without the key. It is what lets a retained invoice, a
     * pseudonymised audit event and this request row still be joined to one
     * another after the customer is gone — which is what makes the metrics and
     * the chain survive an erasure.
     */
    subjectPseudonym: text('subject_pseudonym').notNull(),
    kind: dataRequestKindEnum('kind').notNull(),
    status: dataRequestStatusEnum('status').notNull().default('RECEIVED'),

    /** Free text as the customer put it, for the audit trail and the report. */
    requestDetail: text('request_detail'),
    /** Who lodged it: the customer on their thread, or staff at the counter. */
    requestedByStaffId: uuid('requested_by_staff_id').references(() => staff.id, {
      onDelete: 'set null',
    }),

    verification: dataRequestVerificationEnum('verification'),
    verifiedAt: timestamptz('verified_at'),
    /**
     * Approval is a *second* human act, separate from verification.
     *
     * Verifying that somebody is who they say they are and deciding to destroy
     * a shop's records about them are different judgements. In a two-person
     * workshop they are often the same person a minute apart — but the columns
     * are separate so the audit answers both questions.
     */
    approvedByStaffId: uuid('approved_by_staff_id').references(() => staff.id, {
      onDelete: 'set null',
    }),
    approvedAt: timestamptz('approved_at'),

    /** When the cascade runs. Now plus the shop's grace window. */
    scheduledFor: timestamptz('scheduled_for'),
    startedAt: timestamptz('started_at'),
    completedAt: timestamptz('completed_at'),
    /** Refusal or cancellation, in words the requester is given. */
    outcomeReason: text('outcome_reason'),

    /* --- export artefacts ------------------------------------------------ */

    /** Object-storage key of the generated archive. Null until it is built. */
    artifactKey: text('artifact_key'),
    artifactBytes: integer('artifact_bytes'),
    artifactSha256: text('artifact_sha256'),
    /**
     * SHA-256 of the download token, never the token.
     *
     * The link is the credential — anybody holding it can read a customer's
     * whole history — so the same rule applies as to a refresh token: store the
     * hash, hand out the value once, and let it expire.
     */
    downloadTokenHash: text('download_token_hash'),
    downloadExpiresAt: timestamptz('download_expires_at'),
    downloadedAt: timestamptz('downloaded_at'),

    /** The machine-readable completion report; `data_request_steps` in summary. */
    report: jsonb('report'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('data_requests_shop_status_idx').on(table.shopId, table.status),
    index('data_requests_due_idx').on(table.status, table.scheduledFor),
    index('data_requests_subject_idx').on(table.shopId, table.subjectPseudonym),
    // One download token is one request. A collision would hand a customer
    // somebody else's archive.
    uniqueIndex('data_requests_download_token_key').on(table.downloadTokenHash),
  ],
);

/**
 * One row per table the cascade touched, written in the same transaction as
 * the change it describes.
 *
 * Recorded per *step* rather than as one blob at the end, because the cascade
 * can crash halfway. On resume the executor skips steps that already have a
 * row, so a retry cannot double-count and cannot re-purge a table it has
 * already emptied.
 */
export const dataRequestSteps = pgTable(
  'data_request_steps',
  {
    id: primaryId(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => dataRequests.id, { onDelete: 'cascade' }),
    /** Execution order, so the report reads in the order it happened. */
    stepIndex: integer('step_index').notNull(),
    /** The physical table. Named, not described: this is an audit artefact. */
    tableName: text('table_name').notNull(),
    action: cascadeActionEnum('action').notNull(),
    rowsAffected: integer('rows_affected').notNull().default(0),
    /**
     * Why, in one sentence — and for `RETAINED`, which law and until when.
     * A carve-out with no clock is a carve-out that becomes permanent.
     */
    detail: text('detail').notNull(),
    retentionUntil: timestamptz('retention_until'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('data_request_steps_request_table_key').on(table.requestId, table.tableName),
    index('data_request_steps_request_idx').on(table.requestId, table.stepIndex),
  ],
);
