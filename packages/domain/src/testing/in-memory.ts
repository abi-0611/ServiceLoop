import type { ShopConfig } from '@serviceloop/config';
import type { EventEnvelope, JobCardState, Paise, WorkItemState } from '@serviceloop/shared';
import { uuidv7 } from '@serviceloop/shared';
import { type AuditChainEntry, chainHeadHash, computeAuditHash } from '../audit/chain';
import type { JobCardSnapshot, WorkItemSnapshot } from '../job-card/context';
import type {
  AuditAppender,
  AuditAppendInput,
  AuditRecord,
  JobCardStateWrite,
  JobCardStore,
  OutboxWriter,
  ShopConfigStore,
  StoredShopConfig,
  UnitOfWork,
  WorkItemStateWrite,
  WorkItemStore,
} from '../ports';

/**
 * In-memory implementations of every domain port.
 *
 * These are not throwaway mocks: they implement the same contract as the
 * Postgres adapters, including transaction rollback (by snapshot/restore), so
 * the state-machine, guardrail and audit-chain rules can be exercised
 * exhaustively without a database. `packages/db` runs the identical scenarios
 * against real SQL.
 */

export interface MemoryTx {
  readonly id: string;
}

interface CardRow {
  id: string;
  shopId: string;
  state: JobCardState;
  version: number;
  stateChangedAt: Date;
}

interface ItemRow {
  id: string;
  shopId: string;
  jobCardId: string;
  state: WorkItemState;
  requiresApproval: boolean;
}

export interface LedgerRow {
  readonly shopId: string;
  readonly workItemId: string;
  readonly jobCardId: string;
  readonly kind: 'DECLINED' | 'DEFERRED';
  readonly reason: string;
  readonly followUpAfter: Date | null;
}

interface WorldSnapshot {
  readonly shops: string;
  readonly cards: string;
  readonly items: string;
  readonly balances: string;
  readonly configs: string;
  readonly audit: string;
  readonly outbox: string;
  readonly ledger: string;
}

export class InMemoryWorld {
  readonly shops = new Map<string, { timezone: string }>();
  readonly cards = new Map<string, CardRow>();
  readonly items = new Map<string, ItemRow>();
  readonly balances = new Map<string, Paise>();
  readonly configs = new Map<string, unknown>();
  readonly auditByShop = new Map<string, AuditChainEntry[]>();
  outbox: EventEnvelope[] = [];
  ledger: LedgerRow[] = [];

  addShop(shopId: string, timezone = 'Asia/Kolkata'): void {
    this.shops.set(shopId, { timezone });
  }

  addCard(row: { id?: string; shopId: string; state: JobCardState }): CardRow {
    const card: CardRow = {
      id: row.id ?? uuidv7(),
      shopId: row.shopId,
      state: row.state,
      version: 1,
      stateChangedAt: new Date(0),
    };
    this.cards.set(card.id, card);
    return card;
  }

  addWorkItem(row: {
    id?: string;
    shopId: string;
    jobCardId: string;
    state: WorkItemState;
    requiresApproval?: boolean;
  }): ItemRow {
    const item: ItemRow = {
      id: row.id ?? uuidv7(),
      shopId: row.shopId,
      jobCardId: row.jobCardId,
      state: row.state,
      requiresApproval: row.requiresApproval ?? true,
    };
    this.items.set(item.id, item);
    return item;
  }

  auditFor(shopId: string): AuditChainEntry[] {
    const existing = this.auditByShop.get(shopId);
    if (existing !== undefined) return existing;
    const created: AuditChainEntry[] = [];
    this.auditByShop.set(shopId, created);
    return created;
  }

  snapshot(): WorldSnapshot {
    return {
      shops: JSON.stringify([...this.shops]),
      cards: JSON.stringify([...this.cards]),
      items: JSON.stringify([...this.items]),
      balances: JSON.stringify([...this.balances]),
      configs: JSON.stringify([...this.configs]),
      audit: JSON.stringify([...this.auditByShop]),
      outbox: JSON.stringify(this.outbox),
      ledger: JSON.stringify(this.ledger),
    };
  }

  restore(snapshot: WorldSnapshot): void {
    replaceMap(this.shops, snapshot.shops);
    replaceMap(this.cards, snapshot.cards, reviveCard);
    replaceMap(this.items, snapshot.items);
    replaceMap(this.balances, snapshot.balances);
    replaceMap(this.configs, snapshot.configs);
    replaceMap(this.auditByShop, snapshot.audit);
    this.outbox = JSON.parse(snapshot.outbox) as EventEnvelope[];
    this.ledger = (JSON.parse(snapshot.ledger) as LedgerRow[]).map((row) => ({
      ...row,
      followUpAfter: row.followUpAfter === null ? null : new Date(row.followUpAfter),
    }));
  }
}

function replaceMap<K, V>(target: Map<K, V>, serialised: string, revive?: (value: V) => V): void {
  target.clear();
  for (const [key, value] of JSON.parse(serialised) as Array<[K, V]>) {
    target.set(key, revive === undefined ? value : revive(value));
  }
}

function reviveCard(row: CardRow): CardRow {
  return { ...row, stateChangedAt: new Date(row.stateChangedAt) };
}

export class InMemoryUnitOfWork implements UnitOfWork<MemoryTx> {
  constructor(private readonly world: InMemoryWorld) {}

  async transaction<T>(work: (tx: MemoryTx) => Promise<T>): Promise<T> {
    const snapshot = this.world.snapshot();
    try {
      return await work({ id: uuidv7() });
    } catch (error) {
      this.world.restore(snapshot);
      throw error;
    }
  }
}

export class InMemoryJobCardStore implements JobCardStore<MemoryTx> {
  constructor(private readonly world: InMemoryWorld) {}

  async lockCard(
    _tx: MemoryTx,
    shopId: string,
    jobCardId: string,
  ): Promise<JobCardSnapshot | null> {
    const row = this.world.cards.get(jobCardId);
    if (row === undefined || row.shopId !== shopId) return null;
    return { id: row.id, shopId: row.shopId, state: row.state, version: row.version };
  }

  async loadWorkItems(
    _tx: MemoryTx,
    shopId: string,
    jobCardId: string,
  ): Promise<WorkItemSnapshot[]> {
    return [...this.world.items.values()]
      .filter((item) => item.shopId === shopId && item.jobCardId === jobCardId)
      .map((item) => ({
        id: item.id,
        shopId: item.shopId,
        jobCardId: item.jobCardId,
        state: item.state,
        requiresApproval: item.requiresApproval,
      }));
  }

  async loadOutstandingBalancePaise(
    _tx: MemoryTx,
    _shopId: string,
    jobCardId: string,
  ): Promise<Paise> {
    return this.world.balances.get(jobCardId) ?? 0;
  }

  async writeState(_tx: MemoryTx, write: JobCardStateWrite): Promise<void> {
    const row = this.world.cards.get(write.jobCardId);
    if (row === undefined) throw new Error(`No such card ${write.jobCardId}`);
    if (row.version !== write.expectedVersion) {
      throw new Error(
        `Optimistic lock failure on ${write.jobCardId}: expected v${write.expectedVersion}, found v${row.version}`,
      );
    }
    row.state = write.to;
    row.version += 1;
    row.stateChangedAt = write.at;
  }
}

export class InMemoryWorkItemStore implements WorkItemStore<MemoryTx> {
  constructor(private readonly world: InMemoryWorld) {}

  async lockWorkItem(
    _tx: MemoryTx,
    shopId: string,
    workItemId: string,
  ): Promise<WorkItemSnapshot | null> {
    const row = this.world.items.get(workItemId);
    if (row === undefined || row.shopId !== shopId) return null;
    return {
      id: row.id,
      shopId: row.shopId,
      jobCardId: row.jobCardId,
      state: row.state,
      requiresApproval: row.requiresApproval,
    };
  }

  async writeState(_tx: MemoryTx, write: WorkItemStateWrite): Promise<void> {
    const row = this.world.items.get(write.workItemId);
    if (row === undefined) throw new Error(`No such work item ${write.workItemId}`);
    row.state = write.to;
  }

  async recordDeclineOrDefer(_tx: MemoryTx, input: LedgerRow): Promise<void> {
    this.world.ledger.push(input);
  }
}

export class InMemoryAuditAppender implements AuditAppender<MemoryTx> {
  constructor(
    private readonly world: InMemoryWorld,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async append(_tx: MemoryTx, input: AuditAppendInput): Promise<AuditRecord> {
    const entries = this.world.auditFor(input.shopId);
    const prevHash = chainHeadHash(entries);
    const createdAt = this.now();
    const facts = {
      shopId: input.shopId,
      seq: entries.length + 1,
      actorType: input.actorType,
      actorId: input.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      payload: input.payload,
      createdAt: createdAt.toISOString(),
    };
    const hash = computeAuditHash(prevHash, facts);
    const entry: AuditChainEntry = { ...facts, id: uuidv7(), prevHash, hash };
    entries.push(entry);
    return { id: entry.id, seq: entry.seq, hash, prevHash, createdAt };
  }
}

export class InMemoryOutboxWriter implements OutboxWriter<MemoryTx> {
  constructor(private readonly world: InMemoryWorld) {}

  async enqueue(_tx: MemoryTx, envelope: EventEnvelope): Promise<void> {
    this.world.outbox.push(envelope);
  }
}

export class InMemoryShopConfigStore implements ShopConfigStore<MemoryTx> {
  constructor(private readonly world: InMemoryWorld) {}

  async load(_tx: MemoryTx, shopId: string): Promise<StoredShopConfig | null> {
    const raw = this.world.configs.get(shopId);
    if (raw === undefined) return null;
    const version =
      typeof raw === 'object' && raw !== null && 'configVersion' in raw
        ? Number((raw as { configVersion: unknown }).configVersion)
        : 0;
    return { raw, configVersion: Number.isFinite(version) ? version : 0 };
  }

  async save(_tx: MemoryTx, shopId: string, config: ShopConfig): Promise<void> {
    this.world.configs.set(shopId, JSON.parse(JSON.stringify(config)) as unknown);
  }

  async loadShopTimezone(_tx: MemoryTx, shopId: string): Promise<string | null> {
    return this.world.shops.get(shopId)?.timezone ?? null;
  }
}

export interface DomainTestHarness {
  readonly world: InMemoryWorld;
  readonly uow: InMemoryUnitOfWork;
  readonly cards: InMemoryJobCardStore;
  readonly items: InMemoryWorkItemStore;
  readonly audit: InMemoryAuditAppender;
  readonly outbox: InMemoryOutboxWriter;
  readonly config: InMemoryShopConfigStore;
}

export function createDomainTestHarness(now: () => Date = () => new Date()): DomainTestHarness {
  const world = new InMemoryWorld();
  return {
    world,
    uow: new InMemoryUnitOfWork(world),
    cards: new InMemoryJobCardStore(world),
    items: new InMemoryWorkItemStore(world),
    audit: new InMemoryAuditAppender(world, now),
    outbox: new InMemoryOutboxWriter(world),
    config: new InMemoryShopConfigStore(world),
  };
}
