import type {
  CascadeAction,
  DataRequestKind,
  DataRequestStatus,
  DataRequestVerification,
} from '@serviceloop/shared';

/** A data-principal request as the console and the API see it. */
export interface DataRequestRecord {
  readonly id: string;
  readonly shopId: string;
  readonly customerId: string | null;
  readonly subjectPseudonym: string;
  readonly kind: DataRequestKind;
  readonly status: DataRequestStatus;
  readonly requestDetail: string | null;
  readonly requestedByStaffId: string | null;
  readonly verification: DataRequestVerification | null;
  readonly verifiedAt: Date | null;
  readonly approvedByStaffId: string | null;
  readonly approvedAt: Date | null;
  readonly scheduledFor: Date | null;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly outcomeReason: string | null;
  readonly artifactKey: string | null;
  readonly artifactBytes: number | null;
  readonly artifactSha256: string | null;
  readonly downloadExpiresAt: Date | null;
  readonly downloadedAt: Date | null;
  readonly report: CompletionReport | null;
  readonly createdAt: Date;
}

export interface CascadeStepRecord {
  readonly stepIndex: number;
  readonly tableName: string;
  readonly action: CascadeAction;
  readonly rowsAffected: number;
  readonly detail: string;
  readonly retentionUntil: Date | null;
}

/**
 * What the customer is told, and what the shop keeps.
 *
 * Deliberately arithmetic rather than prose: "42 rows purged across 28 tables,
 * 3 invoices retained until 2034-03-31 under the GST record-keeping
 * obligation" is checkable. "Your data has been deleted" is not, and is the
 * sentence every company says whether or not it is true.
 */
export interface CompletionReport {
  readonly requestId: string;
  readonly kind: DataRequestKind;
  readonly subjectPseudonym: string;
  readonly completedAt: string;
  readonly totals: {
    readonly purgedRows: number;
    readonly pseudonymisedRows: number;
    readonly retainedRows: number;
    readonly tablesTouched: number;
  };
  readonly steps: readonly {
    readonly table: string;
    readonly action: CascadeAction;
    readonly rows: number;
    readonly detail: string;
    readonly retentionUntil: string | null;
  }[];
  /** Human-readable, in the customer's language, for the console and the reply. */
  readonly summary: string;
}

/* -------------------------------------------------------------------------- *
 * Export
 * -------------------------------------------------------------------------- */

/**
 * A customer's data as a portable bundle.
 *
 * Section 11 of the Act gives a right of access, and the useful reading of
 * "access" for somebody with a phone is a file they can open. Each section
 * below becomes one JSON document inside the archive, plus a `README.txt` that
 * says in plain words what each file is — because a ZIP of raw JSON is
 * technically an export and practically a refusal.
 */
export interface ExportBundle {
  readonly profile: ExportProfile;
  readonly vehicles: readonly Record<string, unknown>[];
  readonly jobCards: readonly Record<string, unknown>[];
  readonly invoices: readonly Record<string, unknown>[];
  readonly messages: readonly Record<string, unknown>[];
  readonly calls: readonly Record<string, unknown>[];
  readonly consents: readonly Record<string, unknown>[];
  /**
   * An *index* of media, not the bytes.
   *
   * A customer's photographs can be tens of megabytes and the archive is
   * delivered over WhatsApp on a phone. The index gives each file's date,
   * kind and size with a per-file link that expires with the archive, so the
   * customer can fetch the ones they want. This is a deliberate deviation from
   * "everything in one file" and it is written on the README.
   */
  readonly mediaIndex: readonly ExportMediaEntry[];
  readonly generatedAt: string;
}

export interface ExportProfile {
  readonly customerId: string;
  readonly fullName: string;
  readonly phone: string;
  readonly preferredLanguage: string;
  readonly shopName: string;
  readonly customerSince: string;
}

export interface ExportMediaEntry {
  readonly mediaId: string;
  readonly kind: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly capturedAt: string;
  readonly jobCardCode: string | null;
  /** Expires with the archive link. Null when storage cannot sign a URL. */
  readonly downloadUrl: string | null;
}

/** One file inside the archive. */
export interface ArchiveEntry {
  readonly name: string;
  readonly bytes: Buffer;
}

export interface StoredArchive {
  readonly key: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}
