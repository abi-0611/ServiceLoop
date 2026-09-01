import type { ShopConfig } from '@serviceloop/config';
import type {
  AuditActorType,
  EventEnvelope,
  JobCardState,
  Paise,
  WorkItemState,
} from '@serviceloop/shared';
import type { JobCardSnapshot, WorkItemSnapshot } from './job-card/context';

/**
 * Persistence ports.
 *
 * The domain owns the rules; `packages/db` owns the SQL. Every port is generic
 * over an opaque transaction handle `Tx` so the domain never sees a Drizzle or
 * pg type, and the db package never has to cast.
 */

export interface UnitOfWork<Tx> {
  /**
   * Runs `work` inside one database transaction. Implementations must roll back
   * on throw — the state write, the audit append and the outbox insert of a
   * transition either all land or none do.
   */
  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
}

export interface AuditAppendInput {
  readonly shopId: string;
  readonly actorType: AuditActorType;
  readonly actorId: string | null;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly traceId: string;
}

export interface AuditRecord {
  readonly id: string;
  readonly seq: number;
  readonly hash: string;
  readonly prevHash: string;
  readonly createdAt: Date;
}

export interface AuditAppender<Tx> {
  append(tx: Tx, input: AuditAppendInput): Promise<AuditRecord>;
}

export interface OutboxWriter<Tx> {
  enqueue(tx: Tx, envelope: EventEnvelope): Promise<void>;
}

export interface JobCardStateWrite {
  readonly shopId: string;
  readonly jobCardId: string;
  readonly from: JobCardState;
  readonly to: JobCardState;
  readonly at: Date;
  readonly expectedVersion: number;
}

export interface JobCardStore<Tx> {
  /**
   * Loads the card with a row lock (`SELECT … FOR UPDATE`). Two concurrent
   * transitions on one card therefore serialise, and the loser re-reads the
   * winner's state — which is what makes exactly one of them legal.
   */
  lockCard(tx: Tx, shopId: string, jobCardId: string): Promise<JobCardSnapshot | null>;
  loadWorkItems(tx: Tx, shopId: string, jobCardId: string): Promise<WorkItemSnapshot[]>;
  loadOutstandingBalancePaise(tx: Tx, shopId: string, jobCardId: string): Promise<Paise>;
  writeState(tx: Tx, write: JobCardStateWrite): Promise<void>;
}

export interface WorkItemStateWrite {
  readonly shopId: string;
  readonly workItemId: string;
  readonly from: WorkItemState;
  readonly to: WorkItemState;
  readonly at: Date;
}

export interface WorkItemStore<Tx> {
  lockWorkItem(tx: Tx, shopId: string, workItemId: string): Promise<WorkItemSnapshot | null>;
  writeState(tx: Tx, write: WorkItemStateWrite): Promise<void>;
  /** DECLINED and DEFERRED items must land in the ledger in the same transaction. */
  recordDeclineOrDefer(
    tx: Tx,
    input: {
      readonly shopId: string;
      readonly workItemId: string;
      readonly jobCardId: string;
      readonly kind: 'DECLINED' | 'DEFERRED';
      readonly reason: string;
      readonly followUpAfter: Date | null;
      /**
       * When the customer said no.
       *
       * Passed rather than left to the database's `now()`, because this instant
       * is quoted back to that customer months later — "when we serviced your
       * Swift in April" — and folded into the recovery cohort. A row whose
       * declined-at came from the database clock while every event about it
       * came from the domain clock is a row that disagrees with its own audit
       * trail, and the message it produces is wrong in front of a customer.
       */
      readonly at: Date;
    },
  ): Promise<void>;
}

export interface StoredShopConfig {
  readonly raw: unknown;
  readonly configVersion: number;
}

export interface ShopConfigStore<Tx> {
  load(tx: Tx, shopId: string): Promise<StoredShopConfig | null>;
  save(tx: Tx, shopId: string, config: ShopConfig, actorId: string | null): Promise<void>;
  /** Shop timezone, used as the default when a config document predates the field. */
  loadShopTimezone(tx: Tx, shopId: string): Promise<string | null>;
}

export interface HandoffAdvisor {
  readonly id: string;
  readonly fullName: string;
}

/**
 * Facts about the shop itself that customer-facing copy interpolates.
 *
 * Separate from `ShopConfigStore` because the two answer different questions:
 * that one is "what has this shop configured", this one is "who is this shop,
 * and who does a customer reach when they ask for a person" (L6).
 */
export interface ShopDirectory<Tx> {
  loadShopName(tx: Tx, shopId: string): Promise<string | null>;
  /** The advisor a handoff request names. Null when the shop has no staff. */
  loadHandoffAdvisor(tx: Tx, shopId: string): Promise<HandoffAdvisor | null>;
}
