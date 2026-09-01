import { uuidv7, type EventEnvelope, type IsoDay, type Language } from '@serviceloop/shared';
import type {
  AlertStore,
  EventLogReader,
  FeedbackStore,
  LedgerStore,
  OdometerStore,
  OwnerDigestStore,
  RetentionDirectory,
  RetentionFrequencyReader,
  RetentionGateFacts,
  RetentionHoldStore,
  RetentionTouchStore,
  RollupStore,
  ServiceDueStore,
  VehicleDocumentStore,
} from '../retention/ports';
import type {
  FeedbackRecord,
  LedgerItem,
  OdometerReading,
  ServiceDueForecast,
  TouchSnapshot,
  VehicleDocument,
} from '../retention/types';
import type { MemoryTx } from './in-memory';

/**
 * In-memory phase-6 stores.
 *
 * Same doctrine as every double in this directory: they implement the *same
 * contract* as the Postgres adapters, including the guarantees that come from
 * unique indexes in SQL. Three of those are load-bearing rather than incidental,
 * and a double that quietly allowed them would make a green test prove nothing:
 *
 *   - `RetentionTouchStore.claim` returns null on a repeated dedupe key. That
 *     is the two-re-pitch cap and the once-per-cycle reminder.
 *   - `FeedbackStore.schedule` returns null when a job card already has an ask.
 *     That is "one ask per visit".
 *   - `AlertStore.claim` returns null on a repeated incident key. That is "one
 *     alert per incident, however many times a scan re-observes it".
 */

export class RetentionWorld {
  readonly ledger = new Map<string, LedgerItem>();
  readonly touches = new Map<string, TouchSnapshot>();
  readonly holds = new Map<
    string,
    { id: string; shopId: string; customerId: string; reason: string; taskId: string | null; releasedAt: Date | null }
  >();
  readonly odometer: (OdometerReading & { shopId: string })[] = [];
  readonly feedback = new Map<string, FeedbackRecord>();
  readonly forecasts = new Map<string, ServiceDueForecast & { supersededAt: Date | null }>();
  readonly documents = new Map<string, VehicleDocument>();
  readonly digests = new Map<
    string,
    {
      id: string;
      shopId: string;
      kind: 'DAILY' | 'WEEKLY';
      day: IsoDay;
      recipientStaffId: string | null;
      conversationId: string | null;
      payload: unknown;
      messageId: string | null;
      sentAt: Date | null;
      blockedReason: string | null;
    }
  >();
  readonly alerts = new Map<
    string,
    {
      id: string;
      shopId: string;
      kind: string;
      incidentKey: string;
      subjectType: string;
      subjectId: string | null;
      detail: string;
      messageId: string | null;
      taskId: string | null;
      heldReason: string | null;
      raisedAt: Date;
      resolvedAt: Date | null;
    }
  >();
  readonly rollups = new Map<string, { payload: unknown; payloadHash: string }>();

  /** Customers and vehicles the directory answers from. */
  readonly customerRows = new Map<
    string,
    { id: string; name: string; language: Language; lastVisitAt: Date | null }
  >();
  readonly vehicleRows = new Map<
    string,
    { id: string; label: string; registration: string; customerId: string; modelYear: number | null }
  >();
  readonly vehicleByJobCard = new Map<string, string>();
  readonly ownerRows: { shopId: string; staffId: string; name: string; language: Language }[] = [];
  readonly ownerShops = new Map<string, { shopId: string; name: string }[]>();
  /** Cards open right now, keyed by vehicle — the next-visit trigger's input. */
  readonly openVisits = new Map<string, string>();
  /**
   * `work_items.ledger_item_id`, and what that line costs on the new card.
   *
   * The advisor picking deferred work off the drawer prompt is what writes it,
   * and it is what makes a conversion exact rather than a title match.
   */
  readonly workItemLinks = new Map<string, { ledgerItemId: string; amountPaise: number }>();
  /** The event log the metrics fold reads. */
  events: EventEnvelope[] = [];

  seedLedgerItem(item: Partial<LedgerItem> & Pick<LedgerItem, 'id' | 'shopId' | 'jobCardId'>): LedgerItem {
    const row: LedgerItem = {
      workItemId: uuidv7(),
      customerId: null,
      vehicleId: null,
      kind: 'DEFERRED',
      declineReason: 'customer_deferred',
      reason: 'Customer wants to wait',
      amountPaise: 0,
      category: null,
      title: null,
      technicianNote: null,
      evidenceBundleId: null,
      estimateLineIds: [],
      followUpAfter: null,
      triggerTags: [],
      status: 'OPEN',
      repitchCount: 0,
      lastRepitchedAt: null,
      lastResponse: null,
      closedAt: null,
      closedReason: null,
      convertedJobCardId: null,
      recoveredAmountPaise: 0,
      createdAt: new Date(0),
      ...item,
    };
    this.ledger.set(row.id, row);
    return row;
  }

  sentTouches(): TouchSnapshot[] {
    return [...this.touches.values()].filter((touch) => touch.status === 'SENT');
  }
}

export class InMemoryLedgerStore implements LedgerStore<MemoryTx> {
  constructor(private readonly world: RetentionWorld) {}

  async open(
    _tx: MemoryTx,
    id: string,
    input: Parameters<LedgerStore<MemoryTx>['open']>[2],
    at: Date,
  ): Promise<{ id: string; created: boolean }> {
    // The `declined_work_ledger_work_item_key` unique index, in miniature —
    // and the same three-way outcome the Postgres store has. A *bare* row is
    // what the phase-3 work-item transition leaves behind, and completing one
    // counts as creating it: see the note on the port.
    const existing = [...this.world.ledger.values()].find(
      (row) => row.workItemId === input.workItemId,
    );
    if (existing !== undefined) {
      const bare = existing.title === null && existing.category === null;
      if (!bare) return { id: existing.id, created: false };

      this.world.ledger.set(existing.id, {
        ...existing,
        declineReason: input.declineReason,
        category: input.category,
        title: input.title,
        technicianNote: input.technicianNote,
        evidenceBundleId: input.evidenceBundleId,
        estimateLineIds: [...input.estimateLineIds],
        amountPaise: input.amountPaise || existing.amountPaise,
        customerId: existing.customerId ?? input.customerId,
        vehicleId: existing.vehicleId ?? input.vehicleId,
        followUpAfter: existing.followUpAfter ?? input.followUpAfter,
        triggerTags: existing.triggerTags.length > 0 ? existing.triggerTags : [...input.triggerTags],
      });
      return { id: existing.id, created: true };
    }

    this.world.ledger.set(id, {
      id,
      shopId: input.shopId,
      jobCardId: input.jobCardId,
      workItemId: input.workItemId,
      customerId: input.customerId,
      vehicleId: input.vehicleId,
      kind: input.kind,
      declineReason: input.declineReason,
      reason: input.reason,
      amountPaise: input.amountPaise,
      category: input.category,
      title: input.title,
      technicianNote: input.technicianNote,
      evidenceBundleId: input.evidenceBundleId,
      estimateLineIds: [...input.estimateLineIds],
      followUpAfter: input.followUpAfter,
      triggerTags: [...input.triggerTags],
      status: 'OPEN',
      repitchCount: 0,
      lastRepitchedAt: null,
      lastResponse: null,
      closedAt: null,
      closedReason: null,
      convertedJobCardId: null,
      recoveredAmountPaise: 0,
      createdAt: at,
    });
    return { id, created: true };
  }

  async lockById(tx: MemoryTx, shopId: string, ledgerItemId: string): Promise<LedgerItem | null> {
    return this.load(tx, shopId, ledgerItemId);
  }

  async load(_tx: MemoryTx, shopId: string, ledgerItemId: string): Promise<LedgerItem | null> {
    const row = this.world.ledger.get(ledgerItemId);
    return row !== undefined && row.shopId === shopId ? row : null;
  }

  async loadMany(
    _tx: MemoryTx,
    shopId: string,
    ledgerItemIds: readonly string[],
  ): Promise<readonly LedgerItem[]> {
    return ledgerItemIds
      .map((id) => this.world.ledger.get(id))
      .filter((row): row is LedgerItem => row !== undefined && row.shopId === shopId);
  }

  async openForCustomer(
    _tx: MemoryTx,
    shopId: string,
    customerId: string,
  ): Promise<readonly LedgerItem[]> {
    return [...this.world.ledger.values()].filter(
      (row) =>
        row.shopId === shopId &&
        row.customerId === customerId &&
        (row.status === 'OPEN' || row.status === 'RE_PITCHED'),
    );
  }

  async openForVehicle(
    _tx: MemoryTx,
    shopId: string,
    vehicleId: string,
  ): Promise<readonly LedgerItem[]> {
    return [...this.world.ledger.values()].filter(
      (row) =>
        row.shopId === shopId &&
        row.vehicleId === vehicleId &&
        (row.status === 'OPEN' || row.status === 'RE_PITCHED'),
    );
  }

  async openForShop(_tx: MemoryTx, shopId: string, limit: number): Promise<readonly LedgerItem[]> {
    return [...this.world.ledger.values()]
      .filter(
        (row) =>
          row.shopId === shopId && (row.status === 'OPEN' || row.status === 'RE_PITCHED'),
      )
      .slice(0, limit);
  }

  async linkedLedgerItems(
    _tx: MemoryTx,
    shopId: string,
    workItemIds: readonly string[],
  ): Promise<readonly { ledgerItemId: string; workItemId: string; amountPaise: number }[]> {
    const out: { ledgerItemId: string; workItemId: string; amountPaise: number }[] = [];
    for (const workItemId of workItemIds) {
      const link = this.world.workItemLinks.get(workItemId);
      if (link === undefined) continue;
      const item = this.world.ledger.get(link.ledgerItemId);
      if (item === undefined || item.shopId !== shopId) continue;
      out.push({
        ledgerItemId: link.ledgerItemId,
        workItemId,
        amountPaise: link.amountPaise,
      });
    }
    return out;
  }

  async recordRepitch(
    _tx: MemoryTx,
    input: Parameters<LedgerStore<MemoryTx>['recordRepitch']>[1],
  ): Promise<void> {
    const row = this.world.ledger.get(input.ledgerItemId);
    if (row === undefined) return;
    // The `declined_work_ledger_repitch_capped` CHECK, in miniature.
    if (input.repitchCount > 2) {
      throw new Error('declined_work_ledger_repitch_capped: repitch_count may not exceed 2');
    }
    this.world.ledger.set(row.id, {
      ...row,
      status: 'RE_PITCHED',
      repitchCount: input.repitchCount,
      lastRepitchedAt: input.at,
      followUpAfter: input.followUpAfter,
    });
  }

  async recordResponse(
    _tx: MemoryTx,
    input: Parameters<LedgerStore<MemoryTx>['recordResponse']>[1],
  ): Promise<void> {
    const row = this.world.ledger.get(input.ledgerItemId);
    if (row === undefined) return;
    this.world.ledger.set(row.id, {
      ...row,
      lastResponse: input.response,
      followUpAfter: input.followUpAfter,
    });
  }

  async close(
    _tx: MemoryTx,
    input: Parameters<LedgerStore<MemoryTx>['close']>[1],
  ): Promise<void> {
    const row = this.world.ledger.get(input.ledgerItemId);
    if (row === undefined) return;
    // The `declined_work_ledger_converted_is_attributable` CHECK, in miniature.
    if (input.status === 'CONVERTED' && input.convertedJobCardId === null) {
      throw new Error(
        'declined_work_ledger_converted_is_attributable: a CONVERTED item must name the visit its money arrived on',
      );
    }
    this.world.ledger.set(row.id, {
      ...row,
      status: input.status,
      closedAt: input.at,
      closedReason: input.reason,
      convertedJobCardId: input.convertedJobCardId,
      recoveredAmountPaise: input.recoveredAmountPaise,
    });
  }
}

export class InMemoryRetentionTouchStore implements RetentionTouchStore<MemoryTx> {
  constructor(private readonly world: RetentionWorld) {}

  async claim(
    _tx: MemoryTx,
    input: Parameters<RetentionTouchStore<MemoryTx>['claim']>[1],
  ): Promise<string | null> {
    // The `retention_touches_dedupe_key` unique index, in miniature. This is
    // the two-re-pitch cap and the once-per-cycle reminder.
    for (const touch of this.world.touches.values()) {
      if (touch.shopId === input.shopId && touch.dedupeKey === input.dedupeKey) return null;
    }

    this.world.touches.set(input.id, {
      id: input.id,
      shopId: input.shopId,
      customerId: input.customerId,
      vehicleId: input.vehicleId,
      jobCardId: input.jobCardId,
      conversationId: input.conversationId,
      trigger: input.trigger,
      purpose: input.purpose,
      status: 'SCHEDULED',
      ledgerItemIds: [...input.ledgerItemIds],
      amountPaise: input.amountPaise,
      language: input.language,
      dedupeKey: input.dedupeKey,
      scheduledFor: input.scheduledFor,
      sentAt: null,
      messageId: null,
      skipCode: null,
      skipReason: null,
    });
    return input.id;
  }

  async settle(
    _tx: MemoryTx,
    input: Parameters<RetentionTouchStore<MemoryTx>['settle']>[1],
  ): Promise<void> {
    const touch = this.world.touches.get(input.touchId);
    if (touch === undefined) return;
    this.world.touches.set(touch.id, {
      ...touch,
      status: input.status,
      messageId: input.messageId,
      sentAt: input.status === 'SENT' ? input.at : null,
      skipCode: input.skipCode,
      skipReason: input.skipReason,
      // The refusal keeps its row and gives up its slot — see the note on the
      // port. `#<id>` cannot collide with a key the composer would generate.
      dedupeKey:
        input.releaseDedupeKey === true ? `${touch.dedupeKey}#${touch.id}` : touch.dedupeKey,
    });
  }

  async load(_tx: MemoryTx, shopId: string, touchId: string): Promise<TouchSnapshot | null> {
    const touch = this.world.touches.get(touchId);
    return touch !== undefined && touch.shopId === shopId ? touch : null;
  }

  async lastSentAt(_tx: MemoryTx, shopId: string, customerId: string): Promise<Date | null> {
    let latest: Date | null = null;
    for (const touch of this.world.touches.values()) {
      if (touch.shopId !== shopId || touch.customerId !== customerId) continue;
      if (touch.sentAt === null) continue;
      if (latest === null || touch.sentAt > latest) latest = touch.sentAt;
    }
    return latest;
  }

  async lastSentAtForTrigger(
    _tx: MemoryTx,
    shopId: string,
    customerId: string,
    trigger: TouchSnapshot['trigger'],
  ): Promise<Date | null> {
    let latest: Date | null = null;
    for (const touch of this.world.touches.values()) {
      if (touch.shopId !== shopId || touch.customerId !== customerId) continue;
      if (touch.trigger !== trigger || touch.sentAt === null) continue;
      if (latest === null || touch.sentAt > latest) latest = touch.sentAt;
    }
    return latest;
  }

  async listForCustomer(
    _tx: MemoryTx,
    shopId: string,
    customerId: string,
    limit: number,
  ): Promise<readonly TouchSnapshot[]> {
    return [...this.world.touches.values()]
      .filter((touch) => touch.shopId === shopId && touch.customerId === customerId)
      .sort((a, b) => b.scheduledFor.getTime() - a.scheduledFor.getTime())
      .slice(0, limit);
  }
}

export class InMemoryRetentionHoldStore implements RetentionHoldStore<MemoryTx> {
  constructor(private readonly world: RetentionWorld) {}

  async open(
    _tx: MemoryTx,
    input: Parameters<RetentionHoldStore<MemoryTx>['open']>[1],
  ): Promise<string> {
    this.world.holds.set(input.id, {
      id: input.id,
      shopId: input.shopId,
      customerId: input.customerId,
      reason: input.reason,
      taskId: input.taskId,
      releasedAt: null,
    });
    return input.id;
  }

  async active(
    _tx: MemoryTx,
    shopId: string,
    customerId: string,
  ): Promise<{ id: string; reason: string } | null> {
    for (const hold of this.world.holds.values()) {
      if (hold.shopId === shopId && hold.customerId === customerId && hold.releasedAt === null) {
        return { id: hold.id, reason: hold.reason };
      }
    }
    return null;
  }

  async release(
    _tx: MemoryTx,
    input: Parameters<RetentionHoldStore<MemoryTx>['release']>[1],
  ): Promise<void> {
    const hold = this.world.holds.get(input.holdId);
    if (hold !== undefined) hold.releasedAt = input.at;
  }

  async releaseForTask(
    _tx: MemoryTx,
    shopId: string,
    taskId: string,
    at: Date,
  ): Promise<number> {
    let released = 0;
    for (const hold of this.world.holds.values()) {
      if (hold.shopId !== shopId || hold.taskId !== taskId || hold.releasedAt !== null) continue;
      hold.releasedAt = at;
      released += 1;
    }
    return released;
  }

  /** Lets a test close a hold the way the console does — by feedback row. */
  releaseBySource(sourceId: string, at: Date): number {
    let released = 0;
    for (const hold of this.world.holds.values()) {
      if (hold.releasedAt !== null) continue;
      if (hold.id !== sourceId && hold.taskId !== sourceId) continue;
      hold.releasedAt = at;
      released += 1;
    }
    return released;
  }
}

/**
 * The gate's retention reader, over the same world.
 *
 * Deliberately implemented from the touch and hold stores rather than given its
 * own state: the whole point of the floor being in the gate is that it measures
 * what actually went out, and a reader with a private counter would drift from
 * the touches the tests assert on.
 */
export class InMemoryRetentionFrequencyReader implements RetentionFrequencyReader<MemoryTx> {
  private readonly touches: InMemoryRetentionTouchStore;
  private readonly holds: InMemoryRetentionHoldStore;

  constructor(world: RetentionWorld) {
    this.touches = new InMemoryRetentionTouchStore(world);
    this.holds = new InMemoryRetentionHoldStore(world);
  }

  async facts(tx: MemoryTx, shopId: string, customerId: string): Promise<RetentionGateFacts> {
    const [lastTouchAt, hold] = await Promise.all([
      this.touches.lastSentAt(tx, shopId, customerId),
      this.holds.active(tx, shopId, customerId),
    ]);
    return { lastTouchAt, frozenReason: hold?.reason ?? null };
  }
}

export class InMemoryOdometerStore implements OdometerStore<MemoryTx> {
  constructor(private readonly world: RetentionWorld) {}

  async record(
    _tx: MemoryTx,
    input: Parameters<OdometerStore<MemoryTx>['record']>[1],
  ): Promise<void> {
    this.world.odometer.push({
      shopId: input.shopId,
      vehicleId: input.vehicleId,
      odometerKm: input.odometerKm,
      source: input.source,
      readAt: input.readAt,
    });
  }

  async latest(_tx: MemoryTx, shopId: string, vehicleId: string): Promise<OdometerReading | null> {
    const rows = this.world.odometer
      .filter((row) => row.shopId === shopId && row.vehicleId === vehicleId)
      .sort((a, b) => b.readAt.getTime() - a.readAt.getTime());
    return rows[0] ?? null;
  }

  async asOf(
    _tx: MemoryTx,
    shopId: string,
    vehicleId: string,
    at: Date,
  ): Promise<OdometerReading | null> {
    const rows = this.world.odometer
      .filter(
        (row) =>
          row.shopId === shopId &&
          row.vehicleId === vehicleId &&
          row.readAt.getTime() <= at.getTime(),
      )
      .sort((a, b) => b.readAt.getTime() - a.readAt.getTime());
    return rows[0] ?? null;
  }
}

export class InMemoryFeedbackStore implements FeedbackStore<MemoryTx> {
  constructor(private readonly world: RetentionWorld) {}

  async schedule(
    _tx: MemoryTx,
    input: Parameters<FeedbackStore<MemoryTx>['schedule']>[1],
  ): Promise<string | null> {
    // The `feedback_requests_job_card_key` unique index: one ask per visit.
    for (const record of this.world.feedback.values()) {
      if (record.shopId === input.shopId && record.jobCardId === input.jobCardId) return null;
    }

    this.world.feedback.set(input.id, {
      id: input.id,
      shopId: input.shopId,
      jobCardId: input.jobCardId,
      customerId: input.customerId,
      conversationId: input.conversationId,
      status: 'SCHEDULED',
      deliveredAt: input.deliveredAt,
      dueAt: input.dueAt,
      askedAt: null,
      remindedAt: null,
      expiresAt: input.expiresAt,
      answeredAt: null,
      sentiment: null,
      comment: null,
      viaVoiceNote: false,
      reviewAskedAt: null,
      recoveryTaskId: null,
      holdId: null,
    });
    return input.id;
  }

  async lockById(
    tx: MemoryTx,
    shopId: string,
    feedbackId: string,
  ): Promise<FeedbackRecord | null> {
    return this.load(tx, shopId, feedbackId);
  }

  async load(
    _tx: MemoryTx,
    shopId: string,
    feedbackId: string,
  ): Promise<FeedbackRecord | null> {
    const record = this.world.feedback.get(feedbackId);
    return record !== undefined && record.shopId === shopId ? record : null;
  }

  async claimDue(
    _tx: MemoryTx,
    input: { shopId: string; dueBefore: Date; limit: number },
  ): Promise<readonly FeedbackRecord[]> {
    return [...this.world.feedback.values()]
      .filter(
        (record) =>
          record.shopId === input.shopId &&
          (record.status === 'SCHEDULED' || record.status === 'ASKED') &&
          record.answeredAt === null &&
          record.dueAt.getTime() <= input.dueBefore.getTime() &&
          record.expiresAt.getTime() > input.dueBefore.getTime() &&
          // One reminder at most, which is the shipped ladder's whole length.
          (record.askedAt === null || record.remindedAt === null),
      )
      .slice(0, input.limit);
  }

  async markAsked(
    _tx: MemoryTx,
    input: Parameters<FeedbackStore<MemoryTx>['markAsked']>[1],
  ): Promise<void> {
    const record = this.world.feedback.get(input.feedbackId);
    if (record === undefined) return;
    this.world.feedback.set(record.id, {
      ...record,
      status: 'ASKED',
      askedAt: input.reminder ? record.askedAt : input.at,
      remindedAt: input.reminder ? input.at : record.remindedAt,
    });
  }

  async recordAnswer(
    _tx: MemoryTx,
    input: Parameters<FeedbackStore<MemoryTx>['recordAnswer']>[1],
  ): Promise<void> {
    const record = this.world.feedback.get(input.feedbackId);
    if (record === undefined) return;
    this.world.feedback.set(record.id, {
      ...record,
      status: 'ANSWERED',
      sentiment: input.sentiment,
      comment: input.comment ?? record.comment,
      viaVoiceNote: input.viaVoiceNote || record.viaVoiceNote,
      answeredAt: record.answeredAt ?? input.at,
    });
  }

  async recordReviewAsk(
    _tx: MemoryTx,
    input: Parameters<FeedbackStore<MemoryTx>['recordReviewAsk']>[1],
  ): Promise<void> {
    const record = this.world.feedback.get(input.feedbackId);
    if (record === undefined) return;
    // The `feedback_requests_review_needs_positive` CHECK, in miniature.
    if (record.sentiment !== 'POSITIVE') {
      throw new Error(
        'feedback_requests_review_needs_positive: a review ask requires a positive answer',
      );
    }
    this.world.feedback.set(record.id, { ...record, reviewAskedAt: input.at });
  }

  async attachRecovery(
    _tx: MemoryTx,
    input: Parameters<FeedbackStore<MemoryTx>['attachRecovery']>[1],
  ): Promise<void> {
    const record = this.world.feedback.get(input.feedbackId);
    if (record === undefined) return;
    this.world.feedback.set(record.id, {
      ...record,
      recoveryTaskId: input.taskId,
      holdId: input.holdId,
    });
    // A hold raised before the task exists gets its task id here, which is what
    // makes `releaseForTask` able to find it when an advisor closes the task.
    if (input.holdId !== null && input.taskId !== null) {
      const hold = this.world.holds.get(input.holdId);
      if (hold !== undefined) hold.taskId = input.taskId;
    }
  }

  async expire(
    _tx: MemoryTx,
    input: { shopId: string; before: Date; limit: number },
  ): Promise<number> {
    let expired = 0;
    for (const record of this.world.feedback.values()) {
      if (expired >= input.limit) break;
      if (record.shopId !== input.shopId) continue;
      if (record.answeredAt !== null || record.status === 'EXPIRED') continue;
      if (record.expiresAt.getTime() > input.before.getTime()) continue;
      this.world.feedback.set(record.id, { ...record, status: 'EXPIRED' });
      expired += 1;
    }
    return expired;
  }

  async findOpenForCustomer(
    _tx: MemoryTx,
    shopId: string,
    customerId: string,
  ): Promise<FeedbackRecord | null> {
    const rows = [...this.world.feedback.values()]
      .filter(
        (record) =>
          record.shopId === shopId &&
          record.customerId === customerId &&
          record.status !== 'EXPIRED',
      )
      .sort((a, b) => b.deliveredAt.getTime() - a.deliveredAt.getTime());
    return rows[0] ?? null;
  }
}

export class InMemoryServiceDueStore implements ServiceDueStore<MemoryTx> {
  constructor(private readonly world: RetentionWorld) {}

  async upsert(
    _tx: MemoryTx,
    input: Parameters<ServiceDueStore<MemoryTx>['upsert']>[1],
  ): Promise<string> {
    for (const row of this.world.forecasts.values()) {
      if (row.shopId === input.shopId && row.vehicleId === input.vehicleId && row.supersededAt === null) {
        this.world.forecasts.set(row.id, { ...row, supersededAt: input.at });
      }
    }
    this.world.forecasts.set(input.id, {
      id: input.id,
      shopId: input.shopId,
      vehicleId: input.vehicleId,
      customerId: input.customerId,
      jobCardId: input.jobCardId,
      dueAt: input.dueAt,
      basis: input.basis,
      remindedLeads: [],
      supersededAt: null,
    });
    return input.id;
  }

  async live(
    _tx: MemoryTx,
    shopId: string,
    vehicleId: string,
  ): Promise<ServiceDueForecast | null> {
    for (const row of this.world.forecasts.values()) {
      if (row.shopId === shopId && row.vehicleId === vehicleId && row.supersededAt === null) {
        return row;
      }
    }
    return null;
  }

  async dueWithin(
    _tx: MemoryTx,
    input: { shopId: string; before: Date; limit: number },
  ): Promise<readonly ServiceDueForecast[]> {
    return [...this.world.forecasts.values()]
      .filter(
        (row) =>
          row.shopId === input.shopId &&
          row.supersededAt === null &&
          row.dueAt.getTime() <= input.before.getTime(),
      )
      .slice(0, input.limit);
  }

  async markLeadSent(
    _tx: MemoryTx,
    input: Parameters<ServiceDueStore<MemoryTx>['markLeadSent']>[1],
  ): Promise<void> {
    const row = this.world.forecasts.get(input.forecastId);
    if (row === undefined) return;
    this.world.forecasts.set(row.id, {
      ...row,
      remindedLeads: [...row.remindedLeads, input.leadDays],
    });
  }
}

export class InMemoryVehicleDocumentStore implements VehicleDocumentStore<MemoryTx> {
  constructor(private readonly world: RetentionWorld) {}

  async upsert(
    _tx: MemoryTx,
    input: Parameters<VehicleDocumentStore<MemoryTx>['upsert']>[1],
  ): Promise<string> {
    for (const row of this.world.documents.values()) {
      if (row.shopId === input.shopId && row.vehicleId === input.vehicleId && row.kind === input.kind) {
        this.world.documents.set(row.id, { ...row, expiresOn: input.expiresOn });
        return row.id;
      }
    }
    this.world.documents.set(input.id, {
      id: input.id,
      shopId: input.shopId,
      vehicleId: input.vehicleId,
      customerId: input.customerId,
      kind: input.kind,
      expiresOn: input.expiresOn,
      enrolledAt: null,
      revokedAt: null,
      lastRemindedAt: null,
      lastRemindedCycle: null,
    });
    return input.id;
  }

  async enrol(
    _tx: MemoryTx,
    input: { shopId: string; vehicleId: string; via: string; at: Date },
  ): Promise<number> {
    let count = 0;
    for (const row of this.world.documents.values()) {
      if (row.shopId !== input.shopId || row.vehicleId !== input.vehicleId) continue;
      this.world.documents.set(row.id, { ...row, enrolledAt: input.at, revokedAt: null });
      count += 1;
    }
    return count;
  }

  async revoke(
    _tx: MemoryTx,
    input: { shopId: string; vehicleId: string; at: Date },
  ): Promise<number> {
    let count = 0;
    for (const row of this.world.documents.values()) {
      if (row.shopId !== input.shopId || row.vehicleId !== input.vehicleId) continue;
      this.world.documents.set(row.id, { ...row, revokedAt: input.at });
      count += 1;
    }
    return count;
  }

  async dueWithin(
    _tx: MemoryTx,
    input: { shopId: string; before: string; limit: number },
  ): Promise<readonly VehicleDocument[]> {
    return [...this.world.documents.values()]
      .filter(
        (row) =>
          row.shopId === input.shopId &&
          // Enrolment, in the store, exactly as the SQL has it: an un-enrolled
          // document is a date the shop holds and may not act on.
          row.enrolledAt !== null &&
          row.revokedAt === null &&
          row.expiresOn <= input.before &&
          row.lastRemindedCycle !== row.expiresOn,
      )
      .slice(0, input.limit);
  }

  async markReminded(
    _tx: MemoryTx,
    input: Parameters<VehicleDocumentStore<MemoryTx>['markReminded']>[1],
  ): Promise<void> {
    const row = this.world.documents.get(input.documentId);
    if (row === undefined) return;
    this.world.documents.set(row.id, {
      ...row,
      lastRemindedAt: input.at,
      lastRemindedCycle: input.cycle,
    });
  }

  async listForVehicle(
    _tx: MemoryTx,
    shopId: string,
    vehicleId: string,
  ): Promise<readonly VehicleDocument[]> {
    return [...this.world.documents.values()].filter(
      (row) => row.shopId === shopId && row.vehicleId === vehicleId,
    );
  }
}

export class InMemoryOwnerDigestStore implements OwnerDigestStore<MemoryTx> {
  constructor(private readonly world: RetentionWorld) {}

  async claim(
    _tx: MemoryTx,
    input: Parameters<OwnerDigestStore<MemoryTx>['claim']>[1],
  ): Promise<string | null> {
    for (const row of this.world.digests.values()) {
      if (
        row.shopId === input.shopId &&
        row.kind === input.kind &&
        row.day === input.day &&
        row.recipientStaffId === input.recipientStaffId
      ) {
        return null;
      }
    }
    this.world.digests.set(input.id, {
      id: input.id,
      shopId: input.shopId,
      kind: input.kind,
      day: input.day,
      recipientStaffId: input.recipientStaffId,
      conversationId: input.conversationId,
      payload: input.payload,
      messageId: null,
      sentAt: null,
      blockedReason: null,
    });
    return input.id;
  }

  async settle(
    _tx: MemoryTx,
    input: Parameters<OwnerDigestStore<MemoryTx>['settle']>[1],
  ): Promise<void> {
    const row = this.world.digests.get(input.digestId);
    if (row === undefined) return;
    this.world.digests.set(row.id, {
      ...row,
      messageId: input.messageId,
      sentAt: input.messageId === null ? null : input.at,
      blockedReason: input.blockedReason,
    });
  }

  async load(
    _tx: MemoryTx,
    shopId: string,
    digestId: string,
  ): Promise<{ payload: unknown; sentAt: Date | null; id: string } | null> {
    const row = this.world.digests.get(digestId);
    return row !== undefined && row.shopId === shopId
      ? { id: row.id, payload: row.payload, sentAt: row.sentAt }
      : null;
  }

  async latest(
    _tx: MemoryTx,
    shopId: string,
    kind: 'DAILY' | 'WEEKLY',
    limit: number,
  ): Promise<readonly { id: string; day: IsoDay; payload: unknown }[]> {
    return [...this.world.digests.values()]
      .filter((row) => row.shopId === shopId && row.kind === kind)
      .sort((a, b) => b.day.localeCompare(a.day))
      .slice(0, limit)
      .map((row) => ({ id: row.id, day: row.day, payload: row.payload }));
  }
}

export class InMemoryAlertStore implements AlertStore<MemoryTx> {
  constructor(private readonly world: RetentionWorld) {}

  async claim(
    _tx: MemoryTx,
    input: Parameters<AlertStore<MemoryTx>['claim']>[1],
  ): Promise<string | null> {
    // The `exception_alerts_incident_key` unique index: one alert per incident.
    for (const row of this.world.alerts.values()) {
      if (row.shopId === input.shopId && row.incidentKey === input.incidentKey) return null;
    }
    this.world.alerts.set(input.id, {
      id: input.id,
      shopId: input.shopId,
      kind: input.kind,
      incidentKey: input.incidentKey,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      detail: input.detail,
      messageId: null,
      taskId: null,
      heldReason: null,
      raisedAt: input.raisedAt,
      resolvedAt: null,
    });
    return input.id;
  }

  async settle(
    _tx: MemoryTx,
    input: Parameters<AlertStore<MemoryTx>['settle']>[1],
  ): Promise<void> {
    const row = this.world.alerts.get(input.alertId);
    if (row === undefined) return;
    this.world.alerts.set(row.id, {
      ...row,
      messageId: input.messageId,
      taskId: input.taskId,
      heldReason: input.heldReason,
    });
  }

  async resolve(_tx: MemoryTx, shopId: string, incidentKey: string, at: Date): Promise<boolean> {
    for (const row of this.world.alerts.values()) {
      if (row.shopId !== shopId || row.incidentKey !== incidentKey) continue;
      this.world.alerts.delete(row.id);
      this.world.alerts.set(row.id, { ...row, resolvedAt: at });
      return true;
    }
    return false;
  }

  async since(
    _tx: MemoryTx,
    shopId: string,
    from: Date,
    limit: number,
  ): Promise<readonly { id: string; kind: never; detail: string; raisedAt: Date }[]> {
    return [...this.world.alerts.values()]
      .filter((row) => row.shopId === shopId && row.raisedAt.getTime() >= from.getTime())
      .slice(0, limit)
      .map((row) => ({
        id: row.id,
        kind: row.kind as never,
        detail: row.detail,
        raisedAt: row.raisedAt,
      }));
  }
}

/**
 * The event log, over the world's own array.
 *
 * `InMemoryOutboxWriter` appends to `InMemoryWorld.outbox`; this reads from
 * whatever array it is handed. In the harness those are the same array, which
 * is the property that matters: the metrics fold reads exactly the events the
 * services under test emitted, not a fixture somebody kept in sync by hand.
 */
export class InMemoryEventLogReader implements EventLogReader<MemoryTx> {
  constructor(private readonly source: () => readonly EventEnvelope[]) {}

  async read(
    _tx: MemoryTx,
    input: { shopId: string; from: Date; to: Date; types?: readonly string[] },
  ): Promise<readonly EventEnvelope[]> {
    const types = input.types === undefined ? null : new Set(input.types);
    return this.source()
      .filter((event) => event.shopId === input.shopId)
      .filter((event) => types === null || types.has(event.type))
      .filter((event) => {
        const at = Date.parse(event.occurredAt);
        return at >= input.from.getTime() && at < input.to.getTime();
      })
      .sort(
        (a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.id.localeCompare(b.id),
      );
  }
}

export class InMemoryRollupStore implements RollupStore<MemoryTx> {
  constructor(private readonly world: RetentionWorld) {}

  async upsert(
    _tx: MemoryTx,
    input: Parameters<RollupStore<MemoryTx>['upsert']>[1],
  ): Promise<{ changed: boolean; previousHash: string | null }> {
    const key = `${input.shopId}:${input.day}`;
    const previous = this.world.rollups.get(key) ?? null;
    this.world.rollups.set(key, { payload: input.payload, payloadHash: input.payloadHash });
    return {
      changed: previous === null || previous.payloadHash !== input.payloadHash,
      previousHash: previous?.payloadHash ?? null,
    };
  }

  async load(
    _tx: MemoryTx,
    shopId: string,
    day: IsoDay,
  ): Promise<{ payload: unknown; payloadHash: string } | null> {
    return this.world.rollups.get(`${shopId}:${day}`) ?? null;
  }

  async range(
    _tx: MemoryTx,
    shopId: string,
    from: IsoDay,
    to: IsoDay,
  ): Promise<readonly { day: IsoDay; payload: unknown }[]> {
    return [...this.world.rollups.entries()]
      .filter(([key]) => key.startsWith(`${shopId}:`))
      .map(([key, value]) => ({ day: key.slice(shopId.length + 1), payload: value.payload }))
      .filter((row) => row.day >= from && row.day <= to)
      .sort((a, b) => a.day.localeCompare(b.day));
  }
}

export class InMemoryRetentionDirectory implements RetentionDirectory<MemoryTx> {
  constructor(private readonly world: RetentionWorld) {}

  async loadCustomer(
    _tx: MemoryTx,
    _shopId: string,
    customerId: string,
  ): Promise<{ id: string; name: string; language: Language; lastVisitAt: Date | null } | null> {
    return this.world.customerRows.get(customerId) ?? null;
  }

  async loadVehicle(
    _tx: MemoryTx,
    _shopId: string,
    vehicleId: string,
  ): Promise<{
    id: string;
    label: string;
    registration: string;
    customerId: string;
    modelYear: number | null;
  } | null> {
    return this.world.vehicleRows.get(vehicleId) ?? null;
  }

  async vehicleForJobCard(
    _tx: MemoryTx,
    _shopId: string,
    jobCardId: string,
  ): Promise<string | null> {
    return this.world.vehicleByJobCard.get(jobCardId) ?? null;
  }

  async lapsedCustomers(
    _tx: MemoryTx,
    input: { shopId: string; before: Date; limit: number },
  ): Promise<readonly { customerId: string; vehicleId: string | null; lastVisitAt: Date }[]> {
    const out: { customerId: string; vehicleId: string | null; lastVisitAt: Date }[] = [];
    for (const customer of this.world.customerRows.values()) {
      if (customer.lastVisitAt === null) continue;
      if (customer.lastVisitAt.getTime() > input.before.getTime()) continue;
      const vehicle = [...this.world.vehicleRows.values()].find(
        (row) => row.customerId === customer.id,
      );
      out.push({
        customerId: customer.id,
        vehicleId: vehicle?.id ?? null,
        lastVisitAt: customer.lastVisitAt,
      });
      if (out.length >= input.limit) break;
    }
    return out;
  }

  async owners(
    _tx: MemoryTx,
    shopId: string,
  ): Promise<readonly { staffId: string; name: string; language: Language }[]> {
    return this.world.ownerRows
      .filter((row) => row.shopId === shopId)
      .map((row) => ({ staffId: row.staffId, name: row.name, language: row.language }));
  }

  async shopsForOwner(
    _tx: MemoryTx,
    staffId: string,
  ): Promise<readonly { shopId: string; name: string }[]> {
    return this.world.ownerShops.get(staffId) ?? [];
  }
}
