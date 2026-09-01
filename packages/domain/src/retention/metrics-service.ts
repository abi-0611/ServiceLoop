import type { ShopConfig } from '@serviceloop/config';
import {
  addLocalDays,
  localDay,
  localDayBounds,
  localDaysBetween,
  systemClock,
  uuidv7,
  type Clock,
  type EventEnvelope,
  type IsoDay,
  type RollupSource,
} from '@serviceloop/shared';
import { SYSTEM_ACTOR } from '../job-card/context';
import type { AuditAppender, OutboxWriter, UnitOfWork } from '../ports';
import {
  computeRollup,
  emptyRollup,
  hashRollup,
  mergeRollups,
  rollupKpis,
  type DailyRollup,
  type PendingApproval,
  type RollupKpis,
  type RollupWindows,
} from './metrics';
import type { EventLogReader, RollupStore } from './ports';

/**
 * The metrics service (phase 6.9).
 *
 * Thin on purpose: the arithmetic is a pure function in `metrics.ts`, and this
 * class only decides *which events to read* and *where to put the answer*. That
 * split is what makes the phase's central promise testable — "a
 * `recompute --from` command must reproduce identical numbers" is a property of
 * the fold, and this service's job is to not get in its way.
 *
 * Two decisions here are worth stating because they look like details and are
 * the reason the promise holds:
 *
 *   - **The read window is wider than the day.** A rollup for the 14th needs
 *     the approval requested on the 12th (to compute a turnaround), the ledger
 *     item opened in June (to attribute a conversion to its cohort) and the
 *     customer's previous visit in March (to know today's is a repeat). The
 *     window is derived from the shop's configured windows, so a shop that
 *     widens its cohort widens its reads and its numbers stay correct.
 *   - **A recompute overwrites in place and says whether anything changed.**
 *     A rollup is a derived value with exactly one right answer, not a record of
 *     an opinion held on a Tuesday. `changed: true` on a backfill is the alarm.
 */

export interface MetricsServiceDeps<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly events: EventLogReader<Tx>;
  readonly rollups: RollupStore<Tx>;
  readonly audit: AuditAppender<Tx>;
  readonly outbox: OutboxWriter<Tx>;
  readonly loadConfig: (tx: Tx, shopId: string) => Promise<ShopConfig>;
  readonly clock?: Clock;
}

export interface RollupResult {
  readonly day: IsoDay;
  readonly rollup: DailyRollup;
  readonly kpis: RollupKpis;
  readonly payloadHash: string;
  readonly eventsRead: number;
  /** True when this run produced different numbers from what was stored. */
  readonly changed: boolean;
  readonly previousHash: string | null;
}

export class MetricsService<Tx> {
  private readonly clock: Clock;

  constructor(private readonly deps: MetricsServiceDeps<Tx>) {
    this.clock = deps.clock ?? systemClock;
  }

  /** The shop-local day an instant falls on, in the shop's own timezone. */
  async dayFor(shopId: string, at: Date): Promise<IsoDay> {
    return this.deps.uow.transaction(async (tx) => {
      const config = await this.deps.loadConfig(tx, shopId);
      return localDay(at, config.quietHours.timezone);
    });
  }

  /**
   * Folds one shop-day and stores it.
   *
   * `source` distinguishes the nightly fold from a backfill. Both run the same
   * code over the same events and must agree; recording which one wrote a row
   * is how a disagreement gets attributed rather than argued about.
   */
  async computeDay(input: {
    readonly shopId: string;
    readonly day: IsoDay;
    readonly source?: RollupSource;
    readonly traceId: string;
  }): Promise<RollupResult> {
    const source = input.source ?? 'LIVE';
    const computedAt = this.clock.now();

    const { rollup, eventsRead, timezone } = await this.deps.uow.transaction(async (tx) => {
      const config = await this.deps.loadConfig(tx, input.shopId);
      const zone = config.quietHours.timezone;
      const windows = windowsFrom(config);

      const { start, end } = localDayBounds(input.day, zone);
      // The lookback: the wider of the two windows, plus a day of slack for an
      // approval opened just before it. Reading too much costs a scan; reading
      // too little produces a number that is quietly wrong.
      const lookbackDays =
        Math.max(windows.recoveryCohortDays, windows.repeatVisitWindowDays) + 1;
      const from = localDayBounds(addLocalDays(input.day, -lookbackDays), zone).start;

      const events = await this.deps.events.read(tx, {
        shopId: input.shopId,
        from,
        to: end,
      });

      return {
        rollup: computeRollup({
          shopId: input.shopId,
          day: input.day,
          timezone: zone,
          windows,
          events,
        }),
        eventsRead: events.length,
        timezone: zone,
        start,
      };
    });

    const payloadHash = hashRollup(rollup);

    const stored = await this.deps.uow.transaction(async (tx) => {
      const result = await this.deps.rollups.upsert(tx, {
        id: uuidv7(),
        shopId: input.shopId,
        day: input.day,
        timezone,
        payload: rollup as unknown,
        payloadHash,
        source,
        eventsRead,
        computedAt,
      });

      // Only a *change* is worth an audit row and an event. A nightly fold that
      // reproduces yesterday's numbers is the system working, and recording it
      // every night would bury the one night it did not.
      if (result.changed) {
        await this.deps.audit.append(tx, {
          shopId: input.shopId,
          actorType: 'SYSTEM',
          actorId: null,
          action: 'metrics.rollup_computed',
          entityType: 'MetricRollup',
          entityId: null,
          payload: {
            day: input.day,
            source,
            eventsRead,
            payloadHash,
            previousHash: result.previousHash,
          },
          traceId: input.traceId,
        });

        const envelope: EventEnvelope = {
          id: uuidv7(),
          type: 'metrics.rollup_computed',
          occurredAt: computedAt.toISOString(),
          shopId: input.shopId,
          traceId: input.traceId,
          payload: {
            day: input.day,
            source,
            eventsRead,
            payloadHash,
            changed: true,
            actor: { type: SYSTEM_ACTOR.type, id: SYSTEM_ACTOR.id },
          },
        };
        await this.deps.outbox.enqueue(tx, envelope);
      }

      return result;
    });

    return {
      day: input.day,
      rollup,
      kpis: rollupKpis(rollup),
      payloadHash,
      eventsRead,
      changed: stored.changed,
      previousHash: stored.previousHash,
    };
  }

  /**
   * `recompute --from` (phase 6.9).
   *
   * Idempotent over the event log by construction: it is `computeDay` in a
   * loop. The return value is the audit — which days changed, and what they
   * changed from — because a backfill that silently corrected a month of
   * numbers is indistinguishable from one that silently corrupted them.
   */
  async recompute(input: {
    readonly shopId: string;
    readonly from: IsoDay;
    readonly to?: IsoDay;
    readonly traceId: string;
  }): Promise<readonly RollupResult[]> {
    const config = await this.deps.uow.transaction((tx) =>
      this.deps.loadConfig(tx, input.shopId),
    );
    const today = localDay(this.clock.now(), config.quietHours.timezone);
    const to = input.to ?? today;

    const span = localDaysBetween(input.from, to);
    if (span < 0) return [];
    if (span + 1 > config.analytics.maxBackfillDays) {
      throw new RangeError(
        `Refusing to backfill ${span + 1} days: this shop's configured maximum is ${config.analytics.maxBackfillDays}. Widen analytics.maxBackfillDays deliberately, or narrow the range.`,
      );
    }

    const results: RollupResult[] = [];
    for (let offset = 0; offset <= span; offset += 1) {
      results.push(
        await this.computeDay({
          shopId: input.shopId,
          day: addLocalDays(input.from, offset),
          source: 'BACKFILL',
          traceId: input.traceId,
        }),
      );
    }
    return results;
  }

  /**
   * Approvals nobody has answered, right now (phase 6.8).
   *
   * Folded from the same event stream the digest reads, over a narrow window
   * and only the two approval types — so the alert stream and the evening brief
   * cannot disagree about which requests are stuck, and the scan that runs every
   * couple of minutes costs two indexed reads rather than a full day's fold.
   */
  async stuckApprovals(input: {
    readonly shopId: string;
    readonly now: Date;
    readonly lookbackDays?: number;
  }): Promise<readonly PendingApproval[]> {
    return this.deps.uow.transaction(async (tx) => {
      const config = await this.deps.loadConfig(tx, input.shopId);
      const windows = windowsFrom(config);
      const zone = config.quietHours.timezone;

      const events = await this.deps.events.read(tx, {
        shopId: input.shopId,
        from: new Date(input.now.getTime() - (input.lookbackDays ?? 14) * 86_400_000),
        to: input.now,
        types: ['approval.requested', 'approval.decided'],
      });

      // Folded against a day that *ends now* rather than at local midnight:
      // "waiting more than two hours" is a question about this moment, and a
      // day-boundary fold would answer it about 23:59.
      const day = localDay(input.now, zone);
      const bounds = localDayBounds(day, zone);
      const elapsed = Math.max(0, input.now.getTime() - bounds.start.getTime());
      const rollup = computeRollup({
        shopId: input.shopId,
        day,
        timezone: zone,
        windows: {
          ...windows,
          // Re-express the threshold relative to the day's end, which is what
          // `computeRollup` measures from.
          approvalStuckHours:
            windows.approvalStuckHours +
            (bounds.end.getTime() - bounds.start.getTime() - elapsed) / 3_600_000,
        },
        events,
      });
      return rollup.pendingApprovals;
    });
  }

  /** The stored rollup for a day, or an empty one — never a null the UI must handle. */
  async load(shopId: string, day: IsoDay): Promise<{ rollup: DailyRollup; kpis: RollupKpis }> {
    return this.deps.uow.transaction(async (tx) => {
      const config = await this.deps.loadConfig(tx, shopId);
      const stored = await this.deps.rollups.load(tx, shopId, day);
      const rollup =
        stored === null
          ? emptyRollup(day, config.quietHours.timezone, windowsFrom(config))
          : (stored.payload as DailyRollup);
      return { rollup, kpis: rollupKpis(rollup) };
    });
  }

  /**
   * A range, merged.
   *
   * The console's week and month views and the weekly digest all come through
   * here, which means they are sums of the same daily rollups the daily digest
   * quotes. One source of numeric truth is only true if there is one source.
   */
  async range(
    shopId: string,
    from: IsoDay,
    to: IsoDay,
  ): Promise<{
    readonly days: readonly DailyRollup[];
    readonly total: DailyRollup;
    readonly kpis: RollupKpis;
  }> {
    return this.deps.uow.transaction(async (tx) => {
      const config = await this.deps.loadConfig(tx, shopId);
      const windows = windowsFrom(config);
      const rows = await this.deps.rollups.range(tx, shopId, from, to);
      const days = rows.map((row) => row.payload as DailyRollup);
      const total =
        mergeRollups(days, windows) ?? emptyRollup(to, config.quietHours.timezone, windows);
      return { days, total, kpis: rollupKpis(total) };
    });
  }
}

export function windowsFrom(config: ShopConfig): RollupWindows {
  return {
    recoveryCohortDays: config.analytics.recoveryCohortDays,
    repeatVisitWindowDays: config.analytics.repeatVisitWindowDays,
    approvalStuckHours: config.alerts.approvalStuckHours,
  };
}
