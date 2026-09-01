import type { Paise } from '@serviceloop/shared';
import { uuidv7 } from '@serviceloop/shared';
import type {
  BlockedCallInput,
  CallConsentEventRecord,
  CallConsentStore,
  CallDestinationReader,
  CallRecord,
  CallRecordingWriter,
  CallStore,
  CallTurnRecord,
  CallTurnStore,
  CallUsageRecord,
  CallUsageStore,
  FinishCallInput,
  OpenCallInput,
} from '../voice/index';
import type { MemoryTx } from './in-memory';

/**
 * In-memory phase-5 voice stores.
 *
 * The same doctrine as every other double here: these implement the *contract*,
 * not a convenient subset of it, and the two properties the voice layer leans
 * hardest on are properties of unique indexes in SQL rather than of taste:
 *
 *   - `open` returns null when a provider sid is already recorded, so a
 *     redelivered webhook is a non-event rather than a second call row.
 *   - `append` returns null when `(callId, turnIndex)` exists, so a retried
 *     write cannot duplicate a sentence in a transcript somebody will later
 *     read as the record of what a customer was told.
 *
 * A double that silently allowed either would make the idempotency tests pass
 * against a system that double-bills and double-speaks.
 *
 * `VoiceWorld` is standalone rather than folded into `InMemoryWorld` for the
 * same reason `InMemoryStatusWorld` is: the voice tables are written by a
 * runtime that holds a telephone line open, and nothing in a call's lifetime is
 * inside one job-card transaction that could roll it back.
 */

export interface CallRow extends CallRecord {
  /** The plaintext number. Encrypted at rest in Postgres; never logged here. */
  readonly to: string;
}

export class VoiceWorld {
  readonly calls = new Map<string, CallRow>();
  readonly turns: CallTurnRecord[] = [];
  readonly consentEvents: CallConsentEventRecord[] = [];
  readonly usage = new Map<string, CallUsageRecord>();
  /** `mediaId` → the stored WAV, so a test can assert what was persisted. */
  readonly recordings = new Map<string, { callId: string; wav: Buffer; durationMs: number }>();

  /** `${shopId}:${customerId}` → E.164. What `originate` is allowed to dial. */
  readonly customerPhones = new Map<string, string>();
  /** `${shopId}:${phone}` → customer id, for identifying an inbound caller. */
  readonly phoneToCustomer = new Map<string, string>();
  readonly advisorPhones = new Map<
    string,
    { staffId: string; fullName: string; phone: string }
  >();

  addCustomerPhone(shopId: string, customerId: string, phone: string): void {
    this.customerPhones.set(`${shopId}:${customerId}`, phone);
    this.phoneToCustomer.set(`${shopId}:${phone}`, customerId);
  }

  addAdvisorPhone(shopId: string, staffId: string, fullName: string, phone: string): void {
    this.advisorPhones.set(shopId, { staffId, fullName, phone });
  }

  /** Every call in creation order — the console's call list, and a test's. */
  callList(shopId?: string): CallRow[] {
    return [...this.calls.values()].filter((row) => shopId === undefined || row.shopId === shopId);
  }

  turnsFor(callId: string): CallTurnRecord[] {
    return this.turns
      .filter((turn) => turn.callId === callId)
      .sort((left, right) => left.turnIndex - right.turnIndex);
  }

  factsFor(callId: string): CallConsentEventRecord[] {
    return this.consentEvents.filter((event) => event.callId === callId);
  }
}

export class InMemoryCallStore implements CallStore<MemoryTx> {
  constructor(private readonly world: VoiceWorld) {}

  async open(_tx: MemoryTx, input: OpenCallInput): Promise<string | null> {
    if (input.providerCallSid !== null) {
      const clash = [...this.world.calls.values()].some(
        (row) => row.shopId === input.shopId && row.providerCallSid === input.providerCallSid,
      );
      if (clash) return null;
    }
    if (this.world.calls.has(input.id)) return null;

    this.world.calls.set(input.id, {
      ...blankCall(input),
      status: input.direction === 'INBOUND' ? 'IN_PROGRESS' : 'ORIGINATING',
      ringingAt: input.startedAt,
    });

    return input.id;
  }

  /**
   * Never deduplicated. A second refusal of the same rung is a second fact —
   * the ladder tried again and was stopped again — and collapsing them hides
   * how long a shop has been unable to reach anybody.
   */
  async recordBlocked(_tx: MemoryTx, input: BlockedCallInput): Promise<string> {
    this.world.calls.set(input.id, {
      ...blankCall({ ...input, providerCallSid: null }),
      status: 'BLOCKED',
      outcome: 'NOT_PLACED',
      blockedCode: input.code,
      blockedReason: input.reason,
      endedAt: input.startedAt,
    });

    return input.id;
  }

  async load(_tx: MemoryTx, shopId: string, callId: string): Promise<CallRecord | null> {
    const row = this.world.calls.get(callId);
    return row === undefined || row.shopId !== shopId ? null : row;
  }

  async findByProviderSid(
    _tx: MemoryTx,
    shopId: string,
    sid: string,
  ): Promise<CallRecord | null> {
    return (
      this.world.callList(shopId).find((row) => row.providerCallSid === sid) ?? null
    );
  }

  async setStatus(
    _tx: MemoryTx,
    shopId: string,
    callId: string,
    status: CallRecord['status'],
    at: Date,
    providerCallSid?: string | null,
  ): Promise<void> {
    this.patch(shopId, callId, (row) => ({
      status,
      ringingAt: status === 'RINGING' ? (row.ringingAt ?? at) : row.ringingAt,
      providerCallSid: providerCallSid ?? row.providerCallSid,
    }));
  }

  async markAnswered(_tx: MemoryTx, shopId: string, callId: string, at: Date): Promise<void> {
    this.patch(shopId, callId, (row) => ({
      status: 'IN_PROGRESS',
      answeredAt: row.answeredAt ?? at,
    }));
  }

  async finish(_tx: MemoryTx, input: FinishCallInput): Promise<void> {
    this.patch(input.shopId, input.callId, (row) => ({
      status: input.status,
      outcome: input.outcome,
      endReason: input.endReason,
      endedAt: input.endedAt,
      durationSeconds: input.durationSeconds,
      turnCount: input.turnCount,
      handedOff: input.handedOff,
      degradedToIvr: input.degradedToIvr,
      poorTurnCount: input.poorTurnCount,
      bargeInCount: input.bargeInCount,
      maxTurnLatencyMs: input.maxTurnLatencyMs,
      intent: input.intent,
      agentRunId: input.agentRunId ?? row.agentRunId,
    }));
  }

  async attachRecording(
    _tx: MemoryTx,
    shopId: string,
    callId: string,
    mediaId: string,
    retentionUntil: Date,
  ): Promise<void> {
    this.patch(shopId, callId, () => ({ recordingMediaId: mediaId, retentionUntil }));
  }

  async recordBridge(
    _tx: MemoryTx,
    input: {
      readonly shopId: string;
      readonly callId: string;
      readonly advisorStaffId: string | null;
      readonly whisperText: string;
      readonly at: Date;
    },
  ): Promise<void> {
    this.patch(input.shopId, input.callId, () => ({
      handedOff: true,
      bridgedToStaffId: input.advisorStaffId,
      whisperText: input.whisperText,
    }));
  }

  async attachAdvisorTask(
    _tx: MemoryTx,
    shopId: string,
    callId: string,
    taskId: string,
  ): Promise<void> {
    this.patch(shopId, callId, () => ({ advisorTaskId: taskId }));
  }

  async attachAgentRun(
    _tx: MemoryTx,
    shopId: string,
    callId: string,
    agentRunId: string,
  ): Promise<void> {
    this.patch(shopId, callId, () => ({ agentRunId }));
  }

  /**
   * Blocked rows do not count.
   *
   * A call that never dialled did not reach the customer, and counting it
   * against the per-customer cap would mean a shop whose kill switch is on
   * silently exhausts every customer's daily allowance.
   */
  async countForCustomerSince(
    _tx: MemoryTx,
    shopId: string,
    customerId: string,
    since: Date,
  ): Promise<number> {
    return this.world
      .callList(shopId)
      .filter(
        (row) =>
          row.customerId === customerId &&
          row.status !== 'BLOCKED' &&
          row.createdAt.getTime() >= since.getTime(),
      ).length;
  }

  async countForShopSince(_tx: MemoryTx, shopId: string, since: Date): Promise<number> {
    return this.world
      .callList(shopId)
      .filter(
        (row) =>
          row.direction === 'OUTBOUND' &&
          row.status !== 'BLOCKED' &&
          row.createdAt.getTime() >= since.getTime(),
      ).length;
  }

  async countForEscalation(
    _tx: MemoryTx,
    shopId: string,
    escalationId: string,
  ): Promise<number> {
    return this.world
      .callList(shopId)
      .filter((row) => row.escalationId === escalationId && row.status !== 'BLOCKED').length;
  }

  async findExpiredRetention(
    _tx: MemoryTx,
    before: Date,
    limit: number,
  ): Promise<readonly CallRecord[]> {
    return this.world
      .callList()
      .filter(
        (row) => row.retentionUntil !== null && row.retentionUntil.getTime() < before.getTime(),
      )
      .slice(0, limit);
  }

  private patch(
    shopId: string,
    callId: string,
    change: (row: CallRow) => Partial<CallRow>,
  ): void {
    const row = this.world.calls.get(callId);
    if (row === undefined || row.shopId !== shopId) return;
    this.world.calls.set(callId, { ...row, ...change(row) });
  }
}

export class InMemoryCallTurnStore implements CallTurnStore<MemoryTx> {
  constructor(private readonly world: VoiceWorld) {}

  async append(_tx: MemoryTx, turn: CallTurnRecord): Promise<string | null> {
    const exists = this.world.turns.some(
      (row) => row.callId === turn.callId && row.turnIndex === turn.turnIndex,
    );
    if (exists) return null;

    this.world.turns.push(turn);
    return uuidv7();
  }

  async load(
    _tx: MemoryTx,
    shopId: string,
    callId: string,
  ): Promise<readonly CallTurnRecord[]> {
    return this.world.turnsFor(callId).filter((turn) => turn.shopId === shopId);
  }
}

export class InMemoryCallConsentStore implements CallConsentStore<MemoryTx> {
  constructor(private readonly world: VoiceWorld) {}

  async record(_tx: MemoryTx, event: CallConsentEventRecord): Promise<string | null> {
    const exists = this.world.consentEvents.some(
      (row) => row.callId === event.callId && row.fact === event.fact,
    );
    if (exists) return null;

    this.world.consentEvents.push(event);
    return uuidv7();
  }

  async load(
    _tx: MemoryTx,
    shopId: string,
    callId: string,
  ): Promise<readonly CallConsentEventRecord[]> {
    return this.world.factsFor(callId).filter((event) => event.shopId === shopId);
  }
}

export class InMemoryCallUsageStore implements CallUsageStore<MemoryTx> {
  constructor(private readonly world: VoiceWorld) {}

  async record(_tx: MemoryTx, usage: CallUsageRecord): Promise<string | null> {
    if (this.world.usage.has(usage.callId)) return null;
    this.world.usage.set(usage.callId, usage);
    return uuidv7();
  }

  async spendSince(_tx: MemoryTx, shopId: string, since: Date): Promise<Paise> {
    return this.sum((usage) => usage.shopId === shopId, since);
  }

  async platformSpendSince(_tx: MemoryTx, since: Date): Promise<Paise> {
    return this.sum(() => true, since);
  }

  async load(_tx: MemoryTx, shopId: string, callId: string): Promise<CallUsageRecord | null> {
    const row = this.world.usage.get(callId);
    return row === undefined || row.shopId !== shopId ? null : row;
  }

  /**
   * Spend is summed over the calls it belongs to, not over a timestamp on the
   * usage row itself — which is what the SQL does by joining `calls`, and the
   * reason a usage row has no clock of its own.
   */
  private sum(match: (usage: CallUsageRecord) => boolean, since: Date): Paise {
    let total = 0;
    for (const usage of this.world.usage.values()) {
      if (!match(usage)) continue;
      const call = this.world.calls.get(usage.callId);
      if (call === undefined || call.createdAt.getTime() < since.getTime()) continue;
      total += usage.estimatedCostPaise;
    }
    return total;
  }
}

export class InMemoryCallRecordingWriter implements CallRecordingWriter<MemoryTx> {
  constructor(private readonly world: VoiceWorld) {}

  async store(
    _tx: MemoryTx,
    input: {
      readonly shopId: string;
      readonly callId: string;
      readonly wav: Buffer;
      readonly durationMs: number;
      readonly at: Date;
    },
  ): Promise<string> {
    const mediaId = uuidv7();
    this.world.recordings.set(mediaId, {
      callId: input.callId,
      wav: input.wav,
      durationMs: input.durationMs,
    });
    return mediaId;
  }
}

export class InMemoryCallDestinationReader implements CallDestinationReader<MemoryTx> {
  constructor(private readonly world: VoiceWorld) {}

  async loadCustomerPhone(
    _tx: MemoryTx,
    shopId: string,
    customerId: string,
  ): Promise<string | null> {
    return this.world.customerPhones.get(`${shopId}:${customerId}`) ?? null;
  }

  async loadAdvisorPhone(
    _tx: MemoryTx,
    shopId: string,
  ): Promise<{ readonly staffId: string; readonly fullName: string; readonly phone: string } | null> {
    return this.world.advisorPhones.get(shopId) ?? null;
  }

  async findCustomerByPhone(
    _tx: MemoryTx,
    shopId: string,
    phone: string,
  ): Promise<string | null> {
    return this.world.phoneToCustomer.get(`${shopId}:${phone}`) ?? null;
  }
}

export interface VoiceTestHarness {
  readonly world: VoiceWorld;
  readonly calls: InMemoryCallStore;
  readonly turns: InMemoryCallTurnStore;
  readonly consentEvents: InMemoryCallConsentStore;
  readonly usage: InMemoryCallUsageStore;
  readonly recordings: InMemoryCallRecordingWriter;
  readonly destinations: InMemoryCallDestinationReader;
}

export function createVoiceTestHarness(world: VoiceWorld = new VoiceWorld()): VoiceTestHarness {
  return {
    world,
    calls: new InMemoryCallStore(world),
    turns: new InMemoryCallTurnStore(world),
    consentEvents: new InMemoryCallConsentStore(world),
    usage: new InMemoryCallUsageStore(world),
    recordings: new InMemoryCallRecordingWriter(world),
    destinations: new InMemoryCallDestinationReader(world),
  };
}

function blankCall(input: OpenCallInput): CallRow {
  return {
    id: input.id,
    shopId: input.shopId,
    direction: input.direction,
    status: 'ORIGINATING',
    driver: input.driver,
    providerCallSid: input.providerCallSid,
    to: input.to,
    toMasked: input.toMasked,
    fromNumber: input.fromNumber,
    jobCardId: input.jobCardId,
    customerId: input.customerId,
    conversationId: input.conversationId,
    approvalRequestId: input.approvalRequestId,
    escalationId: input.escalationId,
    agentRunId: null,
    objective: input.objective,
    language: input.language,
    intent: null,
    outcome: null,
    endReason: null,
    blockedReason: null,
    blockedCode: null,
    ringingAt: null,
    answeredAt: null,
    endedAt: null,
    durationSeconds: 0,
    turnCount: 0,
    handedOff: false,
    bridgedToStaffId: null,
    whisperText: null,
    advisorTaskId: null,
    degradedToIvr: false,
    poorTurnCount: 0,
    bargeInCount: 0,
    maxTurnLatencyMs: 0,
    recordingMediaId: null,
    retentionUntil: input.retentionUntil,
    retryOfCallId: input.retryOfCallId,
    traceId: input.traceId,
    createdAt: input.startedAt,
  };
}
