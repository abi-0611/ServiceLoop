import type {
  AlertKind,
  ConsentPurpose,
  DigestKind,
  DocumentKind,
  EventEnvelope,
  FeedbackSentiment,
  IsoDay,
  Language,
  LedgerStatus,
  Paise,
  RepitchResponse,
  RetentionTouchStatus,
  RetentionTrigger,
  RollupSource,
  TaskUrgency,
} from '@serviceloop/shared';
import type {
  FeedbackRecord,
  LedgerItem,
  OdometerReading,
  OpenLedgerItemInput,
  ServiceDueForecast,
  TouchSnapshot,
  VehicleDocument,
} from './types';

/**
 * The gate's retention reader lives in `messaging/ports` — see the note there.
 * Re-exported so a store implementation gets every retention port from one
 * import.
 */
export type { RetentionFrequencyReader, RetentionGateFacts } from '../messaging/ports';

/**
 * Persistence ports for the retention module (phase 6).
 *
 * Same doctrine as everywhere: the domain owns the rules, `packages/db` owns
 * the SQL, every port is generic over an opaque `Tx`.
 *
 * One of these is not like the others. `EventLogReader` reads the **outbox** —
 * the append-only stream every phase already writes — rather than any table the
 * metrics service owns. That is the whole design of 6.9: a rollup is a fold
 * over facts, so `recompute --from` replays the same facts and must arrive at
 * the same numbers. A metrics service that read live tables would produce a
 * different answer every time the tables moved on, and the "₹ recovered" figure
 * would be a number nobody could defend.
 */

/* -------------------------------------------------------------------------- *
 * 6.1 — the declined-work ledger
 * -------------------------------------------------------------------------- */

export interface LedgerStore<Tx> {
  /**
   * Creates or completes the ledger row for a declined or deferred item.
   *
   * Three outcomes, and `created` distinguishes the one that matters:
   *
   *   - no row → insert it, `created: true`;
   *   - a **bare** row, which is what phase 3's work-item transition writes
   *     inside its own transaction (kind, reason, nothing else) → fill in the
   *     horizon, the category and the frozen technician note, `created: true`,
   *     because this call is what brought the item into existence as far as
   *     retention is concerned;
   *   - a row that already has all of that → `created: false`.
   *
   * The distinction is load-bearing rather than cosmetic. `created` is what the
   * service uses to decide whether to emit `ledger.item_opened`, and that event
   * is the denominator of the recovery rate: emitting it twice would halve the
   * headline number, and never emitting it would make the number infinite.
   */
  open(
    tx: Tx,
    id: string,
    input: OpenLedgerItemInput & { readonly followUpAfter: Date | null; readonly triggerTags: readonly string[] },
    at: Date,
  ): Promise<{ readonly id: string; readonly created: boolean }>;

  /** Locks the row: two taps on one re-pitch must not both close it. */
  lockById(tx: Tx, shopId: string, ledgerItemId: string): Promise<LedgerItem | null>;

  load(tx: Tx, shopId: string, ledgerItemId: string): Promise<LedgerItem | null>;

  loadMany(
    tx: Tx,
    shopId: string,
    ledgerItemIds: readonly string[],
  ): Promise<readonly LedgerItem[]>;

  /** Open items for a customer — the next-visit prompt and the freeze both read this. */
  openForCustomer(tx: Tx, shopId: string, customerId: string): Promise<readonly LedgerItem[]>;

  openForVehicle(tx: Tx, shopId: string, vehicleId: string): Promise<readonly LedgerItem[]>;

  /**
   * Every open item in the shop, for the trigger scan.
   *
   * Deliberately not "items whose horizon has passed": the season and odometer
   * triggers do not look at `followUpAfter` at all, and a store method that
   * pre-filtered on it would quietly make two of the phase's four triggers
   * unreachable.
   */
  openForShop(tx: Tx, shopId: string, limit: number): Promise<readonly LedgerItem[]>;

  /**
   * Ledger items the given work items are picking up, with what they cost on
   * the *new* visit (phase 6.1).
   *
   * The link is `work_items.ledger_item_id`, written when an advisor adds
   * deferred work to a card from the drawer's "while it's here" prompt. The
   * amount is the new card's estimate lines for that work item rather than the
   * ledgered figure, because "₹ recovered" has to be what the customer actually
   * spent — a part whose price moved recovers the new number, not the old one.
   */
  linkedLedgerItems(
    tx: Tx,
    shopId: string,
    workItemIds: readonly string[],
  ): Promise<readonly { readonly ledgerItemId: string; readonly workItemId: string; readonly amountPaise: Paise }[]>;

  recordRepitch(
    tx: Tx,
    input: {
      readonly shopId: string;
      readonly ledgerItemId: string;
      readonly repitchCount: number;
      readonly followUpAfter: Date | null;
      readonly at: Date;
    },
  ): Promise<void>;

  recordResponse(
    tx: Tx,
    input: {
      readonly shopId: string;
      readonly ledgerItemId: string;
      readonly response: RepitchResponse;
      readonly followUpAfter: Date | null;
      readonly at: Date;
    },
  ): Promise<void>;

  close(
    tx: Tx,
    input: {
      readonly shopId: string;
      readonly ledgerItemId: string;
      readonly status: LedgerStatus;
      readonly reason: string;
      readonly convertedJobCardId: string | null;
      readonly recoveredAmountPaise: Paise;
      readonly at: Date;
    },
  ): Promise<void>;
}

/* -------------------------------------------------------------------------- *
 * 6.2 / 6.3 — touches and the frequency floor
 * -------------------------------------------------------------------------- */

export interface RetentionTouchStore<Tx> {
  /**
   * Claims a touch by its dedupe key, or returns null when it already exists.
   *
   * The unique index is the idempotency, exactly as it is for escalation rungs:
   * a scan that runs every ten minutes and a worker that retries a failed pass
   * must between them produce one re-pitch.
   */
  claim(
    tx: Tx,
    input: {
      readonly id: string;
      readonly shopId: string;
      readonly customerId: string;
      readonly vehicleId: string | null;
      readonly jobCardId: string | null;
      readonly conversationId: string | null;
      readonly trigger: RetentionTrigger;
      readonly purpose: ConsentPurpose;
      readonly ledgerItemIds: readonly string[];
      readonly amountPaise: Paise;
      readonly language: Language;
      readonly dedupeKey: string;
      readonly scheduledFor: Date;
      readonly traceId: string;
    },
  ): Promise<string | null>;

  settle(
    tx: Tx,
    input: {
      readonly shopId: string;
      readonly touchId: string;
      readonly status: RetentionTouchStatus;
      readonly messageId: string | null;
      readonly skipCode: string | null;
      readonly skipReason: string | null;
      /**
       * Frees the dedupe key so the same touch may be attempted again.
       *
       * Set when the touch was **refused**, never when it went out or is
       * waiting. A re-pitch the gate blocked on the twenty-one-day floor is one
       * that should go out three weeks later; a slot held for ever by a
       * refusal would turn a temporary block into a permanent silence, which is
       * the opposite of what the floor is for. The row itself is kept either
       * way — the key is released by rewriting it to a spent form, so the
       * refusal stays visible in the history it belongs to.
       */
      readonly releaseDedupeKey?: boolean;
      readonly at: Date;
    },
  ): Promise<void>;

  load(tx: Tx, shopId: string, touchId: string): Promise<TouchSnapshot | null>;

  /** The most recent touch that actually reached this customer. */
  lastSentAt(tx: Tx, shopId: string, customerId: string): Promise<Date | null>;

  /**
   * The same, for one trigger.
   *
   * The win-back cooldown needs this and could not be built on a calendar
   * block: "once every six months" measured in fixed blocks since some epoch
   * means a customer written to on the last day of a block can be written to
   * again the next morning. Measured from their own last win-back, six months
   * means six months for everybody.
   */
  lastSentAtForTrigger(
    tx: Tx,
    shopId: string,
    customerId: string,
    trigger: RetentionTrigger,
  ): Promise<Date | null>;

  listForCustomer(
    tx: Tx,
    shopId: string,
    customerId: string,
    limit: number,
  ): Promise<readonly TouchSnapshot[]>;
}

/** The freeze a negative review puts on a customer (phase 6.4). */
export interface RetentionHoldStore<Tx> {
  open(
    tx: Tx,
    input: {
      readonly id: string;
      readonly shopId: string;
      readonly customerId: string;
      readonly reason: string;
      readonly sourceType: string;
      readonly sourceId: string | null;
      readonly taskId: string | null;
      readonly at: Date;
    },
  ): Promise<string>;

  /** The open hold on this customer, if any. */
  active(tx: Tx, shopId: string, customerId: string): Promise<{ readonly id: string; readonly reason: string } | null>;

  release(
    tx: Tx,
    input: {
      readonly shopId: string;
      readonly holdId: string;
      readonly staffId: string | null;
      readonly at: Date;
    },
  ): Promise<void>;

  /** Releases every hold tied to a task the advisor has just closed. */
  releaseForTask(tx: Tx, shopId: string, taskId: string, at: Date): Promise<number>;
}

/** Customer-volunteered odometer readings (phase 6.2). */
export interface OdometerStore<Tx> {
  record(
    tx: Tx,
    input: {
      readonly id: string;
      readonly shopId: string;
      readonly vehicleId: string;
      readonly odometerKm: number;
      readonly source: 'CUSTOMER_VOLUNTEERED' | 'INTAKE' | 'CONSOLE';
      readonly messageId: string | null;
      readonly jobCardId: string | null;
      readonly readAt: Date;
    },
  ): Promise<void>;

  latest(tx: Tx, shopId: string, vehicleId: string): Promise<OdometerReading | null>;

  /** The reading closest to (and at or before) an instant — the ledger baseline. */
  asOf(tx: Tx, shopId: string, vehicleId: string, at: Date): Promise<OdometerReading | null>;
}

/* -------------------------------------------------------------------------- *
 * 6.4 — feedback
 * -------------------------------------------------------------------------- */

export interface FeedbackStore<Tx> {
  /** One per job card, enforced by a unique index. Null when one exists. */
  schedule(
    tx: Tx,
    input: {
      readonly id: string;
      readonly shopId: string;
      readonly jobCardId: string;
      readonly customerId: string;
      readonly conversationId: string | null;
      readonly deliveredAt: Date;
      readonly dueAt: Date;
      readonly expiresAt: Date;
      readonly traceId: string;
    },
  ): Promise<string | null>;

  lockById(tx: Tx, shopId: string, feedbackId: string): Promise<FeedbackRecord | null>;

  load(tx: Tx, shopId: string, feedbackId: string): Promise<FeedbackRecord | null>;

  /**
   * Claims asks whose time has come. `FOR UPDATE SKIP LOCKED` in Postgres, so
   * two workers draining take disjoint batches rather than both asking one
   * customer.
   */
  claimDue(
    tx: Tx,
    input: { readonly shopId: string; readonly dueBefore: Date; readonly limit: number },
  ): Promise<readonly FeedbackRecord[]>;

  markAsked(
    tx: Tx,
    input: {
      readonly shopId: string;
      readonly feedbackId: string;
      readonly messageId: string | null;
      readonly reminder: boolean;
      readonly at: Date;
    },
  ): Promise<void>;

  recordAnswer(
    tx: Tx,
    input: {
      readonly shopId: string;
      readonly feedbackId: string;
      readonly sentiment: FeedbackSentiment;
      readonly comment: string | null;
      readonly viaVoiceNote: boolean;
      readonly mediaId: string | null;
      readonly at: Date;
    },
  ): Promise<void>;

  recordReviewAsk(
    tx: Tx,
    input: {
      readonly shopId: string;
      readonly feedbackId: string;
      readonly messageId: string | null;
      readonly at: Date;
    },
  ): Promise<void>;

  attachRecovery(
    tx: Tx,
    input: {
      readonly shopId: string;
      readonly feedbackId: string;
      readonly taskId: string | null;
      readonly holdId: string | null;
    },
  ): Promise<void>;

  expire(
    tx: Tx,
    input: { readonly shopId: string; readonly before: Date; readonly limit: number },
  ): Promise<number>;

  /** The open ask on a customer's thread — what a stray comment attaches to. */
  findOpenForCustomer(
    tx: Tx,
    shopId: string,
    customerId: string,
  ): Promise<FeedbackRecord | null>;
}

/* -------------------------------------------------------------------------- *
 * 6.5 — reminders
 * -------------------------------------------------------------------------- */

export interface ServiceDueStore<Tx> {
  /** Writes the live forecast, superseding whatever the vehicle had before. */
  upsert(
    tx: Tx,
    input: {
      readonly id: string;
      readonly shopId: string;
      readonly vehicleId: string;
      readonly customerId: string;
      readonly jobCardId: string | null;
      readonly dueAt: Date;
      readonly basis: string;
      readonly at: Date;
    },
  ): Promise<string>;

  live(tx: Tx, shopId: string, vehicleId: string): Promise<ServiceDueForecast | null>;

  /** Forecasts due inside the widest configured lead window. */
  dueWithin(
    tx: Tx,
    input: { readonly shopId: string; readonly before: Date; readonly limit: number },
  ): Promise<readonly ServiceDueForecast[]>;

  markLeadSent(
    tx: Tx,
    input: {
      readonly shopId: string;
      readonly forecastId: string;
      readonly leadDays: number;
      readonly at: Date;
    },
  ): Promise<void>;
}

export interface VehicleDocumentStore<Tx> {
  upsert(
    tx: Tx,
    input: {
      readonly id: string;
      readonly shopId: string;
      readonly vehicleId: string;
      readonly customerId: string;
      readonly kind: DocumentKind;
      readonly expiresOn: string;
      readonly at: Date;
    },
  ): Promise<string>;

  /** Records the customer's yes. Nothing is ever sent without one. */
  enrol(
    tx: Tx,
    input: {
      readonly shopId: string;
      readonly vehicleId: string;
      readonly via: string;
      readonly at: Date;
    },
  ): Promise<number>;

  revoke(
    tx: Tx,
    input: { readonly shopId: string; readonly vehicleId: string; readonly at: Date },
  ): Promise<number>;

  /** Enrolled documents expiring on or before `before`, not yet reminded this cycle. */
  dueWithin(
    tx: Tx,
    input: { readonly shopId: string; readonly before: string; readonly limit: number },
  ): Promise<readonly VehicleDocument[]>;

  markReminded(
    tx: Tx,
    input: {
      readonly shopId: string;
      readonly documentId: string;
      readonly cycle: string;
      readonly at: Date;
    },
  ): Promise<void>;

  listForVehicle(tx: Tx, shopId: string, vehicleId: string): Promise<readonly VehicleDocument[]>;
}

/* -------------------------------------------------------------------------- *
 * 6.7 / 6.8 — the digest and the alert stream
 * -------------------------------------------------------------------------- */

export interface OwnerDigestStore<Tx> {
  /** Claims the slot for one shop, kind, day and recipient. Null when taken. */
  claim(
    tx: Tx,
    input: {
      readonly id: string;
      readonly shopId: string;
      readonly kind: DigestKind;
      readonly day: IsoDay;
      readonly recipientStaffId: string | null;
      readonly conversationId: string | null;
      readonly language: Language;
      readonly payload: unknown;
      readonly traceId: string;
    },
  ): Promise<string | null>;

  settle(
    tx: Tx,
    input: {
      readonly shopId: string;
      readonly digestId: string;
      readonly messageId: string | null;
      readonly blockedReason: string | null;
      readonly at: Date;
    },
  ): Promise<void>;

  load(
    tx: Tx,
    shopId: string,
    digestId: string,
  ): Promise<{ readonly id: string; readonly payload: unknown; readonly sentAt: Date | null } | null>;

  latest(
    tx: Tx,
    shopId: string,
    kind: DigestKind,
    limit: number,
  ): Promise<readonly { readonly id: string; readonly day: IsoDay; readonly payload: unknown }[]>;
}

export interface AlertStore<Tx> {
  /**
   * Claims an incident. Null when this shop has already alerted on it.
   *
   * The dedupe is the unique index on `(shop, incidentKey)`, which is why the
   * key names the *incident* and not the observation: a scan every two minutes
   * re-observes one stuck approval thirty times an hour.
   */
  claim(
    tx: Tx,
    input: {
      readonly id: string;
      readonly shopId: string;
      readonly kind: AlertKind;
      readonly incidentKey: string;
      readonly subjectType: string;
      readonly subjectId: string | null;
      readonly urgency: TaskUrgency;
      readonly detail: string;
      readonly recipientStaffId: string | null;
      readonly raisedAt: Date;
      readonly traceId: string;
    },
  ): Promise<string | null>;

  settle(
    tx: Tx,
    input: {
      readonly shopId: string;
      readonly alertId: string;
      readonly messageId: string | null;
      readonly taskId: string | null;
      readonly heldReason: string | null;
    },
  ): Promise<void>;

  resolve(tx: Tx, shopId: string, incidentKey: string, at: Date): Promise<boolean>;

  since(
    tx: Tx,
    shopId: string,
    from: Date,
    limit: number,
  ): Promise<readonly { readonly id: string; readonly kind: AlertKind; readonly detail: string; readonly raisedAt: Date }[]>;
}

/* -------------------------------------------------------------------------- *
 * 6.9 — the metrics service
 * -------------------------------------------------------------------------- */

/**
 * Reads the event log.
 *
 * The **outbox** is the log: every phase already writes its facts there in the
 * same transaction as the state change, which is what makes it a trustworthy
 * source rather than a second copy that can drift. Rows are never deleted after
 * dispatch — they are marked `DISPATCHED` — so the stream a backfill replays is
 * the stream the live fold saw.
 */
export interface EventLogReader<Tx> {
  /**
   * Events for one shop in `[from, to)`, ordered by `occurredAt` then id.
   *
   * A total order is required, not merely nice: the fold's output is hashed and
   * compared against a recomputation, and two runs that saw the same events in
   * different orders would produce different sample arrays and different
   * hashes for identical data.
   */
  read(
    tx: Tx,
    input: {
      readonly shopId: string;
      readonly from: Date;
      readonly to: Date;
      readonly types?: readonly string[];
    },
  ): Promise<readonly EventEnvelope[]>;
}

export interface RollupStore<Tx> {
  upsert(
    tx: Tx,
    input: {
      readonly id: string;
      readonly shopId: string;
      readonly day: IsoDay;
      readonly timezone: string;
      readonly payload: unknown;
      readonly payloadHash: string;
      readonly source: RollupSource;
      readonly eventsRead: number;
      readonly computedAt: Date;
    },
  ): Promise<{ readonly changed: boolean; readonly previousHash: string | null }>;

  load(
    tx: Tx,
    shopId: string,
    day: IsoDay,
  ): Promise<{ readonly payload: unknown; readonly payloadHash: string } | null>;

  range(
    tx: Tx,
    shopId: string,
    from: IsoDay,
    to: IsoDay,
  ): Promise<readonly { readonly day: IsoDay; readonly payload: unknown }[]>;
}

/* -------------------------------------------------------------------------- *
 * Facts the retention module reads from elsewhere
 * -------------------------------------------------------------------------- */

/**
 * The customer and vehicle facts a retention message interpolates.
 *
 * A port rather than a join, because the retention module has no business
 * knowing that a customer's name lives in an encrypted column: it needs a name,
 * a language and a vehicle label, and `packages/db` knows how to produce them.
 */
export interface RetentionDirectory<Tx> {
  loadCustomer(
    tx: Tx,
    shopId: string,
    customerId: string,
  ): Promise<{
    readonly id: string;
    readonly name: string;
    readonly language: Language;
    readonly lastVisitAt: Date | null;
  } | null>;

  loadVehicle(
    tx: Tx,
    shopId: string,
    vehicleId: string,
  ): Promise<{
    readonly id: string;
    readonly label: string;
    readonly registration: string;
    readonly customerId: string;
    readonly modelYear: number | null;
  } | null>;

  /** The vehicle a job card was for. Null for a card with no vehicle attached. */
  vehicleForJobCard(tx: Tx, shopId: string, jobCardId: string): Promise<string | null>;

  /** Customers with no visit since `before` — the win-back scan (6.10). */
  lapsedCustomers(
    tx: Tx,
    input: { readonly shopId: string; readonly before: Date; readonly limit: number },
  ): Promise<
    readonly {
      readonly customerId: string;
      readonly vehicleId: string | null;
      readonly lastVisitAt: Date;
    }[]
  >;

  /** The owner(s) a digest and an alert go to. */
  owners(
    tx: Tx,
    shopId: string,
  ): Promise<readonly { readonly staffId: string; readonly name: string; readonly language: Language }[]>;

  /** The shops one owner can see, for the consolidated multi-shop digest. */
  shopsForOwner(
    tx: Tx,
    staffId: string,
  ): Promise<readonly { readonly shopId: string; readonly name: string }[]>;
}
