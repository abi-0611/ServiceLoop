import type { ShopConfig } from '@serviceloop/config';
import type { EventEnvelope, JobCardState, Paise, WorkItemState } from '@serviceloop/shared';
import { uuidv7 } from '@serviceloop/shared';
import { type AuditChainEntry, chainHeadHash, computeAuditHash } from '../audit/chain';
import type { JobCardSnapshot, WorkItemSnapshot } from '../job-card/context';
import type {
  AuditAppender,
  AuditAppendInput,
  AuditRecord,
  HandoffAdvisor,
  JobCardStateWrite,
  JobCardStore,
  OutboxWriter,
  ShopConfigStore,
  ShopDirectory,
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
  readonly conversations: string;
  readonly messages: string;
  readonly consents: string;
  readonly customers: string;
  readonly staffByPhone: string;
  readonly advisors: string;
  readonly media: string;
}

/**
 * Rows the messaging module owns. Held on the same world as the job-card rows
 * so one `InMemoryUnitOfWork` rolls both back together — a router transaction
 * writes a conversation, a message *and* an audit entry, and a partial rollback
 * would be a test that proves nothing.
 */
export interface ConversationRow {
  id: string;
  shopId: string;
  kind: 'CUSTOMER' | 'STAFF_GROUP' | 'UNKNOWN';
  channel: 'WHATSAPP' | 'SMS' | 'VOICE' | 'CONSOLE';
  customerId: string | null;
  externalThreadId: string | null;
  externalAddress: string | null;
  displayName: string | null;
  state: 'OPEN' | 'SNOOZED' | 'CLOSED';
  language: 'en' | 'ta' | 'hi';
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
  windowExpiresAt: Date | null;
  unreadCount: number;
  humanOverrideAt: Date | null;
}

export interface MessageRow {
  id: string;
  shopId: string;
  conversationId: string;
  direction: 'INBOUND' | 'OUTBOUND';
  status: string;
  kind: string;
  purpose: 'SERVICE' | 'MARKETING';
  body: string;
  templateName: string | null;
  templateLanguage: string | null;
  templateVariables: readonly string[] | null;
  conversationCategory: string | null;
  interactive: unknown;
  language: 'en' | 'ta' | 'hi';
  providerMessageId: string | null;
  mediaId: string | null;
  jobCardId: string | null;
  senderStaffId: string | null;
  createdByAgent: boolean;
  isHumanReply: boolean;
  agentRunId: string | null;
  approvedByStaffId: string | null;
  scheduledFor: Date | null;
  blockedCode: string | null;
  blockedReason: string | null;
  errorCode: string | null;
  failureReason: string | null;
  sentAt: Date | null;
  createdAt: Date;
}

export interface ConsentRow {
  id: string;
  shopId: string;
  customerId: string;
  purpose: 'SERVICE' | 'MARKETING';
  status: 'PENDING' | 'GRANTED' | 'REVOKED';
  channel: string;
  source: string;
  evidence: string | null;
  grantedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface MediaRow {
  id: string;
  shopId: string;
  jobCardId: string | null;
  kind: 'PHOTO' | 'VIDEO' | 'AUDIO' | 'DOCUMENT';
  origin: 'INBOUND_WHATSAPP' | 'CONSOLE_UPLOAD' | 'GENERATED' | 'SEED';
  bucket: string;
  storageKey: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string;
  caption: string | null;
  thumbnailKey: string | null;
  widthPx: number | null;
  heightPx: number | null;
  durationMs: number | null;
  derivedKey: string | null;
  derivedContentType: string | null;
  providerMediaId: string | null;
  createdAt: Date;
}

export class InMemoryWorld {
  readonly shops = new Map<string, { timezone: string; name: string }>();
  readonly cards = new Map<string, CardRow>();
  readonly items = new Map<string, ItemRow>();
  readonly balances = new Map<string, Paise>();
  readonly configs = new Map<string, unknown>();
  readonly auditByShop = new Map<string, AuditChainEntry[]>();
  outbox: EventEnvelope[] = [];
  ledger: LedgerRow[] = [];

  readonly conversations = new Map<string, ConversationRow>();
  messages: MessageRow[] = [];
  consents: ConsentRow[] = [];
  /** `${shopId}:${phoneE164}` → customer id, standing in for the blind index. */
  readonly customers = new Map<
    string,
    { id: string; language: 'en' | 'ta' | 'hi'; vehicleLabel: string | null }
  >();
  readonly staffByPhone = new Map<string, string>();
  /** `${shopId}` → the person a handoff request names. */
  readonly advisors = new Map<string, { id: string; fullName: string }>();
  readonly media = new Map<string, MediaRow>();

  addCustomer(
    shopId: string,
    phoneE164: string,
    id: string,
    language: 'en' | 'ta' | 'hi' = 'en',
    vehicleLabel: string | null = null,
  ): void {
    this.customers.set(`${shopId}:${phoneE164}`, { id, language, vehicleLabel });
  }

  addStaff(shopId: string, phoneE164: string, staffId: string, fullName?: string): void {
    this.staffByPhone.set(`${shopId}:${phoneE164}`, staffId);
    if (fullName !== undefined && !this.advisors.has(shopId)) {
      this.advisors.set(shopId, { id: staffId, fullName });
    }
  }

  messagesFor(conversationId: string): MessageRow[] {
    return this.messages.filter((row) => row.conversationId === conversationId);
  }

  eventsOfType(type: string): EventEnvelope[] {
    return this.outbox.filter((envelope) => envelope.type === type);
  }

  auditActions(): string[] {
    return [...this.auditByShop.values()].flat().map((entry) => entry.action);
  }

  addShop(shopId: string, timezone = 'Asia/Kolkata', name = 'Sri Murugan Auto Works'): void {
    this.shops.set(shopId, { timezone, name });
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
      conversations: JSON.stringify([...this.conversations]),
      messages: JSON.stringify(this.messages),
      consents: JSON.stringify(this.consents),
      customers: JSON.stringify([...this.customers]),
      staffByPhone: JSON.stringify([...this.staffByPhone]),
      advisors: JSON.stringify([...this.advisors]),
      media: JSON.stringify([...this.media]),
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

    replaceMap(this.conversations, snapshot.conversations, reviveConversation);
    replaceMap(this.customers, snapshot.customers);
    replaceMap(this.staffByPhone, snapshot.staffByPhone);
    replaceMap(this.advisors, snapshot.advisors);
    replaceMap(this.media, snapshot.media, (row) => ({
      ...row,
      createdAt: new Date(row.createdAt),
    }));
    this.messages = (JSON.parse(snapshot.messages) as MessageRow[]).map(reviveMessage);
    this.consents = (JSON.parse(snapshot.consents) as ConsentRow[]).map(reviveConsent);
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

/** JSON round-tripping turns Dates into strings; rollback must restore Dates. */
function date(value: Date | string | null): Date | null {
  return value === null ? null : new Date(value);
}

function reviveConversation(row: ConversationRow): ConversationRow {
  return {
    ...row,
    lastInboundAt: date(row.lastInboundAt),
    lastOutboundAt: date(row.lastOutboundAt),
    windowExpiresAt: date(row.windowExpiresAt),
    humanOverrideAt: date(row.humanOverrideAt),
  };
}

function reviveMessage(row: MessageRow): MessageRow {
  return {
    ...row,
    scheduledFor: date(row.scheduledFor),
    sentAt: date(row.sentAt),
    createdAt: new Date(row.createdAt),
  };
}

function reviveConsent(row: ConsentRow): ConsentRow {
  return {
    ...row,
    grantedAt: date(row.grantedAt),
    revokedAt: date(row.revokedAt),
    createdAt: new Date(row.createdAt),
  };
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

/** Shop identity, kept separate from configuration for the same reason the port is. */
export class InMemoryShopDirectory implements ShopDirectory<MemoryTx> {
  constructor(private readonly world: InMemoryWorld) {}

  async loadShopName(_tx: MemoryTx, shopId: string): Promise<string | null> {
    return this.world.shops.get(shopId)?.name ?? null;
  }

  async loadHandoffAdvisor(_tx: MemoryTx, shopId: string): Promise<HandoffAdvisor | null> {
    return this.world.advisors.get(shopId) ?? null;
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
  readonly directory: InMemoryShopDirectory;
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
    directory: new InMemoryShopDirectory(world),
  };
}
