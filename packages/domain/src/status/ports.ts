import type {
  EtaMateriality,
  EtaReason,
  JobCardState,
  Language,
  StatusSignalRoute,
  StatusSignalSource,
  StatusSignalType,
} from '@serviceloop/shared';

/**
 * Persistence ports for the status sentinel (phase 4.2 / 4.3 / 4.6).
 *
 * Same doctrine as everywhere else: the domain owns the rules, `packages/db`
 * owns the SQL, every port is generic over an opaque `Tx`.
 */

/* -------------------------------------------------------------------------- *
 * ETA history
 * -------------------------------------------------------------------------- */

export interface EtaEntry {
  readonly id: string;
  readonly shopId: string;
  readonly jobCardId: string;
  readonly version: number;
  readonly previousEta: Date | null;
  readonly eta: Date;
  readonly promisedAt: Date | null;
  readonly reason: EtaReason;
  readonly materiality: EtaMateriality;
  readonly deltaMinutes: number;
  readonly detail: string;
  readonly statusSignalId: string | null;
  readonly notifiedAt: Date | null;
  readonly createdAt: Date;
}

/** The card's current ETA head, read under a row lock before recalculating. */
export interface EtaHead {
  readonly jobCardId: string;
  readonly version: number;
  readonly currentEta: Date | null;
  readonly promisedAt: Date | null;
  readonly state: JobCardState;
}

export interface EtaStore<Tx> {
  /**
   * Locks the card and reads its ETA head.
   *
   * The lock is what makes two recalculations racing — an approval landing at
   * the same moment as a technician's "done" — produce two ordered versions
   * rather than two rows claiming to be version 4.
   */
  lockHead(tx: Tx, shopId: string, jobCardId: string): Promise<EtaHead | null>;

  /**
   * Appends a history entry and updates the card's denormalised head in the
   * same transaction, so `job_cards.current_eta` can never disagree with the
   * newest `eta_entries` row.
   */
  append(tx: Tx, entry: EtaEntry): Promise<void>;

  history(tx: Tx, shopId: string, jobCardId: string, limit: number): Promise<readonly EtaEntry[]>;

  latest(tx: Tx, shopId: string, jobCardId: string): Promise<EtaEntry | null>;

  markNotified(
    tx: Tx,
    input: { readonly entryId: string; readonly messageId: string | null; readonly at: Date },
  ): Promise<void>;

  /**
   * Material changes nobody has been told about yet. `FOR UPDATE SKIP LOCKED`
   * in the Postgres implementation so two workers take disjoint batches.
   */
  claimUnnotified(
    tx: Tx,
    input: { readonly shopId: string | null; readonly limit: number },
  ): Promise<readonly EtaEntry[]>;
}

/**
 * What the coalescing window needs to know (phase 4.4).
 *
 * Deliberately a read over `messages` rather than a new table: "when did we
 * last write to this customer about this car" is a fact the message log already
 * holds, and a second counter would be a second thing to keep in step with it.
 */
export interface StatusCommsStore<Tx> {
  /** Newest outbound message on this card, whatever its send outcome. */
  lastStatusUpdateAt(tx: Tx, shopId: string, jobCardId: string): Promise<Date | null>;
}

/* -------------------------------------------------------------------------- *
 * Technician status signals
 * -------------------------------------------------------------------------- */

export interface StatusSignalRecord {
  readonly id: string;
  readonly shopId: string;
  readonly jobCardId: string | null;
  readonly conversationId: string | null;
  readonly messageId: string | null;
  readonly mediaId: string | null;
  readonly senderStaffId: string | null;
  readonly signalType: StatusSignalType;
  readonly source: StatusSignalSource;
  readonly route: StatusSignalRoute;
  /** 0–1. Stored as basis points; the domain speaks in the 0–1 fraction. */
  readonly confidence: number;
  readonly transcript: string;
  readonly language: Language;
  readonly transcriptConfidence: number | null;
  readonly workItemIds: readonly string[];
  readonly etaHint: Date | null;
  readonly candidateJobCardIds: readonly string[];
  readonly matchBasis: string | null;
  readonly appliedDetail: string | null;
  readonly createdAt: Date;
}

export interface StatusSignalStore<Tx> {
  /**
   * Inserts, or returns null when this inbound message already produced a
   * signal. A redelivered staff-group webhook must not close the same work
   * item twice.
   */
  insert(tx: Tx, record: StatusSignalRecord): Promise<string | null>;

  load(tx: Tx, shopId: string, signalId: string): Promise<StatusSignalRecord | null>;

  /** Locks a signal awaiting an advisor's tap, so two taps decide it once. */
  lockPending(tx: Tx, shopId: string, signalId: string): Promise<StatusSignalRecord | null>;

  resolve(
    tx: Tx,
    input: {
      readonly signalId: string;
      readonly route: StatusSignalRoute;
      readonly jobCardId: string | null;
      readonly workItemIds: readonly string[];
      readonly staffId: string | null;
      readonly appliedDetail: string;
      readonly at: Date;
    },
  ): Promise<void>;

  /** Signals waiting on a human, newest first — the console's confirm queue. */
  pending(tx: Tx, shopId: string, limit: number): Promise<readonly StatusSignalRecord[]>;

  /** The newest signal per card, for the silent-bay scan's "last heard from". */
  lastSignalAt(
    tx: Tx,
    shopId: string,
    jobCardIds: readonly string[],
  ): Promise<ReadonlyMap<string, Date>>;
}

/* -------------------------------------------------------------------------- *
 * Card resolution — never require an id from a technician (L2)
 * -------------------------------------------------------------------------- */

export interface CardCandidate {
  readonly jobCardId: string;
  readonly code: string;
  readonly registration: string;
  readonly vehicleLabel: string;
  readonly state: JobCardState;
  /** How this candidate was found, for the audit row and the ambiguity ask. */
  readonly basis: 'REGISTRATION' | 'ASSIGNMENT' | 'REPLY_CONTEXT' | 'CODE';
  readonly assignedTechnicianId: string | null;
  readonly lastTouchedAt: Date;
}

/**
 * Resolves "which car is Suresh talking about" without asking him.
 *
 * The bar for a technician is a five-second voice note (master L2). Requiring a
 * job-card id would mean requiring them to look one up, which means they will
 * not send the note at all — so the resolver works from what they actually say
 * and what the system already knows about them.
 */
export interface CardResolver<Tx> {
  /** Exact match on a normalised registration or a fragment of one. */
  byRegistrationFragment(
    tx: Tx,
    shopId: string,
    fragment: string,
  ): Promise<readonly CardCandidate[]>;

  /** Cards currently assigned to this technician and still in active states. */
  byTechnician(tx: Tx, shopId: string, staffId: string): Promise<readonly CardCandidate[]>;

  /** The card a staff-group message was a reply to, when it was one. */
  byReplyContext(tx: Tx, shopId: string, messageId: string): Promise<CardCandidate | null>;

  byCode(tx: Tx, shopId: string, code: string): Promise<CardCandidate | null>;

  /**
   * Labels for cards already identified — the confirm queue's "on TN09BX4432".
   *
   * A resolution that has already happened, read back. It exists because the
   * question an advisor is answering is about a *vehicle*, and a queue that
   * printed job-card uuids would be asking them to look each one up.
   */
  byIds(tx: Tx, shopId: string, ids: readonly string[]): Promise<readonly CardCandidate[]>;
}

/* -------------------------------------------------------------------------- *
 * Silent-bay sentinel
 * -------------------------------------------------------------------------- */

export interface SilentCard {
  readonly jobCardId: string;
  readonly code: string;
  readonly state: JobCardState;
  readonly registration: string;
  readonly vehicleLabel: string;
  readonly assignedTechnicianId: string | null;
  readonly assignedTechnicianName: string | null;
  /** Newest of: last state change, last technician signal, last media capture. */
  readonly lastSignalAt: Date;
}

export interface SilentBayStore<Tx> {
  /**
   * Active cards and when each was last heard from.
   *
   * "Heard from" is deliberately broader than a status signal: a photo in the
   * evidence group or a state transition is a bay that is plainly being worked
   * in, and nudging about it would be noise the staff group learns to ignore.
   */
  activeCards(tx: Tx, shopId: string): Promise<readonly SilentCard[]>;

  /**
   * Claims `(jobCardId, windowStart)`. Returns null when this window was
   * already claimed — which is what makes exactly one nudge per window, even
   * with two workers and a restart in between.
   */
  claimWindow(
    tx: Tx,
    input: {
      readonly id: string;
      readonly shopId: string;
      readonly jobCardId: string;
      readonly windowStart: Date;
      readonly state: JobCardState;
      readonly quietForMinutes: number;
      readonly consecutiveWindows: number;
    },
  ): Promise<string | null>;

  /** How many windows in a row this card has been silent, including none. */
  consecutiveWindows(
    tx: Tx,
    shopId: string,
    jobCardId: string,
    since: Date,
  ): Promise<number>;

  attachMessage(tx: Tx, nudgeId: string, messageId: string | null): Promise<void>;

  markEscalated(tx: Tx, nudgeIds: readonly string[]): Promise<void>;
}
