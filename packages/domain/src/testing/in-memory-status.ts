import { uuidv7, type JobCardState } from '@serviceloop/shared';
import type {
  CardCandidate,
  CardResolver,
  EtaEntry,
  EtaHead,
  EtaStore,
  SilentBayStore,
  SilentCard,
  StatusCommsStore,
  StatusSignalRecord,
  StatusSignalStore,
} from '../status/ports';
import { registrationMatches } from '../status/card-matching';
import type { MemoryTx } from './in-memory';

/**
 * In-memory phase-4 status stores.
 *
 * Same doctrine as the phase-1 and phase-3 doubles: these implement the *same
 * contract* as the Postgres adapters, including the idempotency guarantees that
 * come from unique indexes in SQL. `claimWindow` returning null on a repeat is
 * not a convenience here — it is the property the silent-bay test asserts, and
 * a double that quietly allowed the duplicate would make that test pass against
 * a system that nudges twice.
 */

export class InMemoryStatusWorld {
  readonly etaEntries: EtaEntry[] = [];
  readonly signals = new Map<string, StatusSignalRecord>();
  readonly nudges: {
    id: string;
    shopId: string;
    jobCardId: string;
    windowStart: number;
    state: JobCardState;
    quietForMinutes: number;
    consecutiveWindows: number;
    messageId: string | null;
    escalated: boolean;
    createdAt: Date;
  }[] = [];

  /** Card heads the ETA service reads and writes. */
  readonly heads = new Map<string, EtaHead>();
  /** Candidate cards the resolver searches. */
  readonly cards: CardCandidate[] = [];
  /** Active cards and last-heard-from times, for the silent-bay scan. */
  readonly activeCards: SilentCard[] = [];
  /** Last outbound status message per card, for the coalescing window. */
  readonly lastStatusUpdate = new Map<string, Date>();
  /** Card a staff-group message was pinned to, for reply-context resolution. */
  readonly replyContext = new Map<string, string>();

  seedCard(head: EtaHead): void {
    this.heads.set(head.jobCardId, head);
  }
}

export class InMemoryEtaStore implements EtaStore<MemoryTx> {
  constructor(private readonly world: InMemoryStatusWorld) {}

  async lockHead(_tx: MemoryTx, _shopId: string, jobCardId: string): Promise<EtaHead | null> {
    return this.world.heads.get(jobCardId) ?? null;
  }

  async append(_tx: MemoryTx, entry: EtaEntry): Promise<void> {
    const head = this.world.heads.get(entry.jobCardId);
    if (head === undefined) throw new Error(`No ETA head for ${entry.jobCardId}`);
    if (this.world.etaEntries.some((row) => row.jobCardId === entry.jobCardId && row.version === entry.version)) {
      // The `eta_entries_card_version_key` unique index, in miniature.
      throw new Error(`ETA version ${entry.version} already exists for ${entry.jobCardId}`);
    }

    this.world.etaEntries.push(entry);
    this.world.heads.set(entry.jobCardId, {
      ...head,
      version: entry.version,
      currentEta: entry.eta,
    });
  }

  async history(
    _tx: MemoryTx,
    shopId: string,
    jobCardId: string,
    limit: number,
  ): Promise<readonly EtaEntry[]> {
    return this.world.etaEntries
      .filter((entry) => entry.shopId === shopId && entry.jobCardId === jobCardId)
      .sort((a, b) => b.version - a.version)
      .slice(0, limit);
  }

  async latest(tx: MemoryTx, shopId: string, jobCardId: string): Promise<EtaEntry | null> {
    const [newest] = await this.history(tx, shopId, jobCardId, 1);
    return newest ?? null;
  }

  async markNotified(
    _tx: MemoryTx,
    input: { readonly entryId: string; readonly messageId: string | null; readonly at: Date },
  ): Promise<void> {
    const index = this.world.etaEntries.findIndex((entry) => entry.id === input.entryId);
    const entry = this.world.etaEntries[index];
    if (entry === undefined) return;
    this.world.etaEntries[index] = { ...entry, notifiedAt: input.at };
  }

  async claimUnnotified(
    _tx: MemoryTx,
    input: { readonly shopId: string | null; readonly limit: number },
  ): Promise<readonly EtaEntry[]> {
    return this.world.etaEntries
      .filter(
        (entry) =>
          entry.notifiedAt === null &&
          entry.materiality !== 'IMMATERIAL' &&
          (input.shopId === null || entry.shopId === input.shopId),
      )
      .slice(0, input.limit);
  }
}

export class InMemoryStatusSignalStore implements StatusSignalStore<MemoryTx> {
  constructor(private readonly world: InMemoryStatusWorld) {}

  async insert(_tx: MemoryTx, record: StatusSignalRecord): Promise<string | null> {
    if (record.messageId !== null) {
      const duplicate = [...this.world.signals.values()].some(
        (existing) =>
          existing.shopId === record.shopId && existing.messageId === record.messageId,
      );
      // `status_signals_message_key`. A redelivered staff-group webhook must
      // not close the same work item twice.
      if (duplicate) return null;
    }
    this.world.signals.set(record.id, record);
    return record.id;
  }

  async load(_tx: MemoryTx, shopId: string, signalId: string): Promise<StatusSignalRecord | null> {
    const found = this.world.signals.get(signalId);
    return found !== undefined && found.shopId === shopId ? found : null;
  }

  async lockPending(
    tx: MemoryTx,
    shopId: string,
    signalId: string,
  ): Promise<StatusSignalRecord | null> {
    const found = await this.load(tx, shopId, signalId);
    if (found === null) return null;
    return found.route === 'PENDING_CONFIRMATION' || found.route === 'AMBIGUOUS' ? found : null;
  }

  async resolve(
    _tx: MemoryTx,
    input: {
      readonly signalId: string;
      readonly route: StatusSignalRecord['route'];
      readonly jobCardId: string | null;
      readonly workItemIds: readonly string[];
      readonly staffId: string | null;
      readonly appliedDetail: string;
      readonly at: Date;
    },
  ): Promise<void> {
    const existing = this.world.signals.get(input.signalId);
    if (existing === undefined) return;
    this.world.signals.set(input.signalId, {
      ...existing,
      route: input.route,
      jobCardId: input.jobCardId ?? existing.jobCardId,
      workItemIds: input.workItemIds,
      appliedDetail: input.appliedDetail,
    });
  }

  async pending(
    _tx: MemoryTx,
    shopId: string,
    limit: number,
  ): Promise<readonly StatusSignalRecord[]> {
    return [...this.world.signals.values()]
      .filter(
        (signal) =>
          signal.shopId === shopId &&
          (signal.route === 'PENDING_CONFIRMATION' || signal.route === 'AMBIGUOUS'),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async lastSignalAt(
    _tx: MemoryTx,
    shopId: string,
    jobCardIds: readonly string[],
  ): Promise<ReadonlyMap<string, Date>> {
    const result = new Map<string, Date>();
    for (const signal of this.world.signals.values()) {
      if (signal.shopId !== shopId || signal.jobCardId === null) continue;
      if (!jobCardIds.includes(signal.jobCardId)) continue;
      const current = result.get(signal.jobCardId);
      if (current === undefined || signal.createdAt > current) {
        result.set(signal.jobCardId, signal.createdAt);
      }
    }
    return result;
  }
}

export class InMemoryCardResolver implements CardResolver<MemoryTx> {
  constructor(private readonly world: InMemoryStatusWorld) {}

  async byRegistrationFragment(
    _tx: MemoryTx,
    _shopId: string,
    fragment: string,
  ): Promise<readonly CardCandidate[]> {
    return this.world.cards
      .filter((card) => registrationMatches(fragment, card.registration))
      .map((card) => ({ ...card, basis: 'REGISTRATION' as const }));
  }

  async byTechnician(
    _tx: MemoryTx,
    _shopId: string,
    staffId: string,
  ): Promise<readonly CardCandidate[]> {
    return this.world.cards
      .filter((card) => card.assignedTechnicianId === staffId)
      .map((card) => ({ ...card, basis: 'ASSIGNMENT' as const }));
  }

  async byReplyContext(
    _tx: MemoryTx,
    _shopId: string,
    messageId: string,
  ): Promise<CardCandidate | null> {
    const jobCardId = this.world.replyContext.get(messageId);
    if (jobCardId === undefined) return null;
    const card = this.world.cards.find((candidate) => candidate.jobCardId === jobCardId);
    return card === undefined ? null : { ...card, basis: 'REPLY_CONTEXT' };
  }

  async byCode(_tx: MemoryTx, _shopId: string, code: string): Promise<CardCandidate | null> {
    const card = this.world.cards.find(
      (candidate) => candidate.code.toUpperCase() === code.toUpperCase(),
    );
    return card === undefined ? null : { ...card, basis: 'CODE' };
  }

  async byIds(
    _tx: MemoryTx,
    _shopId: string,
    ids: readonly string[],
  ): Promise<readonly CardCandidate[]> {
    return this.world.cards
      .filter((card) => ids.includes(card.jobCardId))
      .map((card) => ({ ...card, basis: 'CODE' as const }));
  }
}

export class InMemorySilentBayStore implements SilentBayStore<MemoryTx> {
  constructor(private readonly world: InMemoryStatusWorld) {}

  async activeCards(_tx: MemoryTx, shopId: string): Promise<readonly SilentCard[]> {
    return this.world.activeCards.filter(() => shopId.length > 0);
  }

  async claimWindow(
    _tx: MemoryTx,
    input: {
      readonly id: string;
      readonly shopId: string;
      readonly jobCardId: string;
      readonly windowStart: Date;
      readonly state: JobCardState;
      readonly quietForMinutes: number;
      readonly consecutiveWindows: number;
    },
  ): Promise<string | null> {
    // `silent_bay_nudges_card_window_key` — the whole idempotency story.
    const taken = this.world.nudges.some(
      (nudge) =>
        nudge.jobCardId === input.jobCardId &&
        nudge.windowStart === input.windowStart.getTime(),
    );
    if (taken) return null;

    this.world.nudges.push({
      id: input.id,
      shopId: input.shopId,
      jobCardId: input.jobCardId,
      windowStart: input.windowStart.getTime(),
      state: input.state,
      quietForMinutes: input.quietForMinutes,
      consecutiveWindows: input.consecutiveWindows,
      messageId: null,
      escalated: false,
      createdAt: new Date(),
    });
    return input.id;
  }

  async consecutiveWindows(
    _tx: MemoryTx,
    shopId: string,
    jobCardId: string,
    since: Date,
  ): Promise<number> {
    return this.world.nudges.filter(
      (nudge) =>
        nudge.shopId === shopId &&
        nudge.jobCardId === jobCardId &&
        nudge.windowStart >= since.getTime(),
    ).length;
  }

  async attachMessage(_tx: MemoryTx, nudgeId: string, messageId: string | null): Promise<void> {
    const nudge = this.world.nudges.find((row) => row.id === nudgeId);
    if (nudge !== undefined) nudge.messageId = messageId;
  }

  async markEscalated(_tx: MemoryTx, nudgeIds: readonly string[]): Promise<void> {
    for (const nudge of this.world.nudges) {
      if (nudgeIds.includes(nudge.id)) nudge.escalated = true;
    }
  }
}

export class InMemoryStatusCommsStore implements StatusCommsStore<MemoryTx> {
  constructor(private readonly world: InMemoryStatusWorld) {}

  async lastStatusUpdateAt(
    _tx: MemoryTx,
    _shopId: string,
    jobCardId: string,
  ): Promise<Date | null> {
    return this.world.lastStatusUpdate.get(jobCardId) ?? null;
  }
}

/** A candidate card for the resolver's fixtures. */
export function candidateCard(input: {
  readonly jobCardId?: string;
  readonly code: string;
  readonly registration: string;
  readonly state?: JobCardState;
  readonly assignedTechnicianId?: string | null;
}): CardCandidate {
  return {
    jobCardId: input.jobCardId ?? uuidv7(),
    code: input.code,
    registration: input.registration,
    vehicleLabel: 'Maruti Swift',
    state: input.state ?? 'IN_PROGRESS',
    basis: 'REGISTRATION',
    assignedTechnicianId: input.assignedTechnicianId ?? null,
    lastTouchedAt: new Date(),
  };
}
