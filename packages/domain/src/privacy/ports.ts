import type {
  CascadeAction,
  DataRequestKind,
  DataRequestStatus,
  DataRequestVerification,
} from '@serviceloop/shared';
import type {
  ArchiveEntry,
  CascadeStepRecord,
  CompletionReport,
  DataRequestRecord,
  ExportBundle,
  StoredArchive,
} from './types';

/**
 * Ports for the DPDP workflows.
 *
 * Same doctrine as everywhere else: the domain owns the rules and the plan,
 * `packages/db` owns the SQL. The erasure executor is the interesting one — it
 * takes a *step* from the declared plan and reports what it did, so the domain
 * decides what happens to which table and the database package decides how.
 */

export interface CreateDataRequestInput {
  readonly shopId: string;
  readonly customerId: string;
  readonly subjectPseudonym: string;
  readonly kind: DataRequestKind;
  readonly requestDetail: string | null;
  readonly requestedByStaffId: string | null;
  readonly createdAt: Date;
}

export interface DataRequestStore<Tx> {
  create(tx: Tx, input: CreateDataRequestInput): Promise<DataRequestRecord>;
  findById(tx: Tx, shopId: string, requestId: string): Promise<DataRequestRecord | null>;
  /** Locks the row, so two operators cannot approve one request twice. */
  lockById(tx: Tx, shopId: string, requestId: string): Promise<DataRequestRecord | null>;
  list(
    tx: Tx,
    shopId: string,
    filter: { readonly status?: DataRequestStatus; readonly limit: number },
  ): Promise<readonly DataRequestRecord[]>;
  /**
   * An open request of this kind for this customer, if any.
   *
   * Used to refuse a duplicate: a customer who asks twice should get their
   * existing request back, not a second cascade racing the first.
   */
  findOpenFor(
    tx: Tx,
    shopId: string,
    customerId: string,
    kind: DataRequestKind,
  ): Promise<DataRequestRecord | null>;

  markVerified(
    tx: Tx,
    requestId: string,
    input: { readonly verification: DataRequestVerification; readonly at: Date },
  ): Promise<void>;
  markApproved(
    tx: Tx,
    requestId: string,
    input: {
      readonly approvedByStaffId: string;
      readonly at: Date;
      readonly scheduledFor: Date | null;
    },
  ): Promise<void>;
  markStatus(
    tx: Tx,
    requestId: string,
    input: {
      readonly status: DataRequestStatus;
      readonly at: Date;
      readonly outcomeReason?: string | null;
    },
  ): Promise<void>;
  markCompleted(
    tx: Tx,
    requestId: string,
    input: { readonly at: Date; readonly report: CompletionReport },
  ): Promise<void>;
  /** Detaches the customer link once a deletion has run. */
  detachCustomer(tx: Tx, requestId: string): Promise<void>;

  attachArchive(
    tx: Tx,
    requestId: string,
    input: {
      readonly archive: StoredArchive;
      readonly downloadTokenHash: string;
      readonly expiresAt: Date;
    },
  ): Promise<void>;
  findByDownloadTokenHash(tx: Tx, hash: string): Promise<DataRequestRecord | null>;
  markDownloaded(tx: Tx, requestId: string, at: Date): Promise<void>;

  recordStep(tx: Tx, requestId: string, step: CascadeStepRecord): Promise<void>;
  steps(tx: Tx, requestId: string): Promise<readonly CascadeStepRecord[]>;

  /** Requests whose grace window has elapsed. Polled by the worker sentinel. */
  dueForExecution(tx: Tx, now: Date, limit: number): Promise<readonly DataRequestRecord[]>;
}

/**
 * Executes one step of the cascade against one table.
 *
 * The result is what actually happened, not what was intended: an executor that
 * returned the planned action regardless would make the completion report a
 * restatement of the plan, which is exactly the document nobody can rely on.
 */
export interface ErasureExecutor<Tx> {
  execute(
    tx: Tx,
    input: {
      readonly shopId: string;
      readonly customerId: string;
      readonly subjectPseudonym: string;
      readonly table: string;
      readonly action: CascadeAction;
      readonly retentionUntil: Date | null;
      readonly now: Date;
    },
  ): Promise<{ readonly rowsAffected: number; readonly detail: string }>;
}

/** Reads the customer's data for an export. */
export interface ExportSource<Tx> {
  collect(tx: Tx, shopId: string, customerId: string, now: Date): Promise<ExportBundle>;
}

/** Writes the archive to object storage and reports its size and digest. */
export interface ArchiveWriter {
  write(input: {
    readonly shopId: string;
    readonly requestId: string;
    readonly entries: readonly ArchiveEntry[];
  }): Promise<StoredArchive>;
  /** Reads it back for the download endpoint. */
  read(key: string): Promise<Buffer>;
  /** Removes an expired archive. A link that expires and leaves the bytes is not an expiry. */
  remove(key: string): Promise<void>;
}

/**
 * Deletes the object-storage objects behind a customer's media.
 *
 * Separate from `ErasureExecutor` because the bytes live somewhere the
 * transaction cannot reach: a rollback cannot un-delete a GCS object, so the
 * order is fixed and deliberate — the rows go first, inside the transaction,
 * and the objects go after it commits. An orphaned object with no row is
 * garbage the nightly sweeper collects; a row pointing at a deleted object is a
 * broken console page.
 */
export interface MediaPurger {
  purge(keys: readonly string[]): Promise<{ readonly deleted: number; readonly failed: number }>;
}
