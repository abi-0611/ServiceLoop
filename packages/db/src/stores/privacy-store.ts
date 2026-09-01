import type {
  CascadeStepRecord,
  CompletionReport,
  CreateDataRequestInput,
  DataRequestRecord,
  DataRequestStore,
} from '@serviceloop/domain';
import {
  uuidv7,
  type DataRequestKind,
  type DataRequestStatus,
  type DataRequestVerification,
} from '@serviceloop/shared';
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { dataRequests, dataRequestSteps } from '../schema/privacy';
import type { Tx } from '../client';

/**
 * Postgres implementation of the DPDP request workflow (phase 7.2).
 *
 * All SQL, no policy: which states may follow which, what the grace window is
 * and what the cascade does live in `DataPrincipalService`. This decides only
 * how rows are read and written.
 */
export class PgDataRequestStore implements DataRequestStore<Tx> {
  async create(tx: Tx, input: CreateDataRequestInput): Promise<DataRequestRecord> {
    const [row] = await tx
      .insert(dataRequests)
      .values({
        id: uuidv7(),
        shopId: input.shopId,
        customerId: input.customerId,
        subjectPseudonym: input.subjectPseudonym,
        kind: input.kind,
        status: 'RECEIVED',
        requestDetail: input.requestDetail,
        requestedByStaffId: input.requestedByStaffId,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      })
      .returning();

    if (row === undefined) throw new Error('Failed to create the data request');
    return toRecord(row);
  }

  async findById(tx: Tx, shopId: string, requestId: string): Promise<DataRequestRecord | null> {
    const [row] = await tx
      .select()
      .from(dataRequests)
      .where(and(eq(dataRequests.shopId, shopId), eq(dataRequests.id, requestId)))
      .limit(1);
    return row === undefined ? null : toRecord(row);
  }

  /**
   * `FOR UPDATE`, and it is not optional.
   *
   * Two advisors on the same request at 6pm — one approving, one cancelling —
   * is the ordinary case, not the exotic one, and without the lock both
   * transactions read `VERIFIED`, both pass their state check, and the deletion
   * runs on a request somebody cancelled.
   */
  async lockById(tx: Tx, shopId: string, requestId: string): Promise<DataRequestRecord | null> {
    const [row] = await tx
      .select()
      .from(dataRequests)
      .where(and(eq(dataRequests.shopId, shopId), eq(dataRequests.id, requestId)))
      .limit(1)
      .for('update');
    return row === undefined ? null : toRecord(row);
  }

  async list(
    tx: Tx,
    shopId: string,
    filter: { readonly status?: DataRequestStatus; readonly limit: number },
  ): Promise<readonly DataRequestRecord[]> {
    const rows = await tx
      .select()
      .from(dataRequests)
      .where(
        filter.status === undefined
          ? eq(dataRequests.shopId, shopId)
          : and(eq(dataRequests.shopId, shopId), eq(dataRequests.status, filter.status)),
      )
      .orderBy(desc(dataRequests.createdAt))
      .limit(filter.limit);
    return rows.map(toRecord);
  }

  async findOpenFor(
    tx: Tx,
    shopId: string,
    customerId: string,
    kind: DataRequestKind,
  ): Promise<DataRequestRecord | null> {
    const [row] = await tx
      .select()
      .from(dataRequests)
      .where(
        and(
          eq(dataRequests.shopId, shopId),
          eq(dataRequests.customerId, customerId),
          eq(dataRequests.kind, kind),
          inArray(dataRequests.status, ['RECEIVED', 'VERIFIED', 'APPROVED', 'SCHEDULED', 'RUNNING']),
        ),
      )
      .orderBy(desc(dataRequests.createdAt))
      .limit(1);
    return row === undefined ? null : toRecord(row);
  }

  async markVerified(
    tx: Tx,
    requestId: string,
    input: { readonly verification: DataRequestVerification; readonly at: Date },
  ): Promise<void> {
    await tx
      .update(dataRequests)
      .set({ verification: input.verification, verifiedAt: input.at, updatedAt: input.at })
      .where(eq(dataRequests.id, requestId));
  }

  async markApproved(
    tx: Tx,
    requestId: string,
    input: {
      readonly approvedByStaffId: string;
      readonly at: Date;
      readonly scheduledFor: Date | null;
    },
  ): Promise<void> {
    await tx
      .update(dataRequests)
      .set({
        approvedByStaffId: input.approvedByStaffId,
        approvedAt: input.at,
        scheduledFor: input.scheduledFor,
        updatedAt: input.at,
      })
      .where(eq(dataRequests.id, requestId));
  }

  async markStatus(
    tx: Tx,
    requestId: string,
    input: {
      readonly status: DataRequestStatus;
      readonly at: Date;
      readonly outcomeReason?: string | null;
    },
  ): Promise<void> {
    await tx
      .update(dataRequests)
      .set({
        status: input.status,
        updatedAt: input.at,
        ...(input.status === 'RUNNING' ? { startedAt: input.at } : {}),
        ...(input.outcomeReason === undefined ? {} : { outcomeReason: input.outcomeReason }),
      })
      .where(eq(dataRequests.id, requestId));
  }

  async markCompleted(
    tx: Tx,
    requestId: string,
    input: { readonly at: Date; readonly report: CompletionReport },
  ): Promise<void> {
    await tx
      .update(dataRequests)
      .set({
        status: 'COMPLETED',
        completedAt: input.at,
        report: input.report,
        updatedAt: input.at,
      })
      .where(eq(dataRequests.id, requestId));
  }

  /**
   * Severs the request's link to the customer once a deletion has run.
   *
   * Without this, the request row would keep a resolvable pointer to the person
   * it just erased — and worse, a `customers` row cannot be reduced to a
   * pseudonym while something still joins to it by identity. The request row
   * afterwards names nobody and still proves what happened.
   */
  async detachCustomer(tx: Tx, requestId: string): Promise<void> {
    await tx
      .update(dataRequests)
      .set({ customerId: null })
      .where(eq(dataRequests.id, requestId));
  }

  async attachArchive(
    tx: Tx,
    requestId: string,
    input: {
      readonly archive: { readonly key: string; readonly sizeBytes: number; readonly sha256: string };
      readonly downloadTokenHash: string;
      readonly expiresAt: Date;
    },
  ): Promise<void> {
    await tx
      .update(dataRequests)
      .set({
        artifactKey: input.archive.key,
        artifactBytes: input.archive.sizeBytes,
        artifactSha256: input.archive.sha256,
        downloadTokenHash: input.downloadTokenHash,
        downloadExpiresAt: input.expiresAt,
        updatedAt: new Date(),
      })
      .where(eq(dataRequests.id, requestId));
  }

  async findByDownloadTokenHash(tx: Tx, hash: string): Promise<DataRequestRecord | null> {
    // Deliberately not shop-scoped: the token *is* the credential, and it is
    // handed to a customer who has no session and no shop context. The unique
    // index on the column is what makes this a lookup rather than a search.
    const [row] = await tx
      .select()
      .from(dataRequests)
      .where(eq(dataRequests.downloadTokenHash, hash))
      .limit(1);
    return row === undefined ? null : toRecord(row);
  }

  async markDownloaded(tx: Tx, requestId: string, at: Date): Promise<void> {
    await tx
      .update(dataRequests)
      .set({ downloadedAt: at, updatedAt: at })
      .where(eq(dataRequests.id, requestId));
  }

  async recordStep(tx: Tx, requestId: string, step: CascadeStepRecord): Promise<void> {
    await tx
      .insert(dataRequestSteps)
      .values({
        id: uuidv7(),
        requestId,
        stepIndex: step.stepIndex,
        tableName: step.tableName,
        action: step.action,
        rowsAffected: step.rowsAffected,
        detail: step.detail,
        retentionUntil: step.retentionUntil,
      })
      // A resumed cascade re-runs steps it has already recorded. The unique
      // index on (request, table) makes that a no-op rather than a duplicate
      // line in the completion report.
      .onConflictDoNothing({
        target: [dataRequestSteps.requestId, dataRequestSteps.tableName],
      });
  }

  async steps(tx: Tx, requestId: string): Promise<readonly CascadeStepRecord[]> {
    const rows = await tx
      .select()
      .from(dataRequestSteps)
      .where(eq(dataRequestSteps.requestId, requestId))
      .orderBy(asc(dataRequestSteps.stepIndex));

    return rows.map((row) => ({
      stepIndex: row.stepIndex,
      tableName: row.tableName,
      action: row.action,
      rowsAffected: row.rowsAffected,
      detail: row.detail,
      retentionUntil: row.retentionUntil,
    }));
  }

  /**
   * Requests whose grace window has elapsed.
   *
   * `RUNNING` is included, and that is the resume path: a worker that died
   * mid-cascade leaves a request in RUNNING, and nothing else would ever pick
   * it up. Re-running is safe because every step is idempotent — a purge of
   * rows already purged affects zero rows, and the steps table refuses a
   * duplicate line.
   */
  async dueForExecution(
    tx: Tx,
    now: Date,
    limit: number,
  ): Promise<readonly DataRequestRecord[]> {
    const rows = await tx
      .select()
      .from(dataRequests)
      .where(
        and(
          inArray(dataRequests.status, ['APPROVED', 'SCHEDULED', 'RUNNING']),
          or(isNull(dataRequests.scheduledFor), lte(dataRequests.scheduledFor, now)),
        ),
      )
      .orderBy(asc(dataRequests.scheduledFor))
      .limit(limit)
      .for('update', { skipLocked: true });
    return rows.map(toRecord);
  }

  /**
   * Archives whose download link has expired.
   *
   * The sweeper reads this and deletes the bytes. A link that expires while the
   * object survives is not an expiry; it is a promise the console makes and the
   * bucket does not keep.
   */
  async expiredArchives(
    tx: Tx,
    now: Date,
    limit: number,
  ): Promise<readonly { readonly requestId: string; readonly artifactKey: string }[]> {
    const rows = await tx
      .select({ id: dataRequests.id, artifactKey: dataRequests.artifactKey })
      .from(dataRequests)
      .where(
        and(
          sql`${dataRequests.artifactKey} is not null`,
          lte(dataRequests.downloadExpiresAt, now),
        ),
      )
      .limit(limit);

    return rows
      .filter((row): row is { id: string; artifactKey: string } => row.artifactKey !== null)
      .map((row) => ({ requestId: row.id, artifactKey: row.artifactKey }));
  }

  async clearArchive(tx: Tx, requestId: string): Promise<void> {
    await tx
      .update(dataRequests)
      .set({
        artifactKey: null,
        downloadTokenHash: null,
        downloadExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(eq(dataRequests.id, requestId));
  }
}

type Row = typeof dataRequests.$inferSelect;

function toRecord(row: Row): DataRequestRecord {
  return {
    id: row.id,
    shopId: row.shopId,
    customerId: row.customerId,
    subjectPseudonym: row.subjectPseudonym,
    kind: row.kind,
    status: row.status,
    requestDetail: row.requestDetail,
    requestedByStaffId: row.requestedByStaffId,
    verification: row.verification,
    verifiedAt: row.verifiedAt,
    approvedByStaffId: row.approvedByStaffId,
    approvedAt: row.approvedAt,
    scheduledFor: row.scheduledFor,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    outcomeReason: row.outcomeReason,
    artifactKey: row.artifactKey,
    artifactBytes: row.artifactBytes,
    artifactSha256: row.artifactSha256,
    downloadExpiresAt: row.downloadExpiresAt,
    downloadedAt: row.downloadedAt,
    report: (row.report as CompletionReport | null) ?? null,
    createdAt: row.createdAt,
  };
}
