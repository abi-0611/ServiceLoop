import { Controller, Get, Header, Inject, Post } from '@nestjs/common';
import type { RetentionRuntime } from '@serviceloop/agent-core';
import type { Database, Tx } from '@serviceloop/db';
import {
  addLocalDays,
  localDaysBetween,
  ValidationError,
  type AnalyticsRange,
  type DailyRollupDto,
  type IsoDay,
  type OwnerDigestDto,
  type OwnerDigestList,
  type RecomputeResult,
  type RollupKpisDto,
} from '@serviceloop/shared';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { CurrentStaff, Roles, type AuthenticatedStaff } from '../auth/auth.types';
import { ZodBody, ZodQuery } from '../common/zod';
import { DATABASE, RETENTION_RUNTIME } from '../infra/tokens';
import { currentTraceId } from '../common/request-context';

/**
 * The Analytics surface (phase 6.9).
 *
 * Every endpoint here reads a *stored rollup*. None of them folds an event log
 * on the request path, and that is not a performance decision: the phase's
 * central promise is that a number in the console, a number in last night's
 * WhatsApp digest and a number a `recompute --from` produces are the same
 * number. The only way to keep that promise is for all three to read the same
 * row, so this controller has no access to anything else.
 *
 * The one endpoint that *writes* is the backfill, and it is OWNER-only and
 * loud: it reports which days changed, because a rollup is a derived value with
 * exactly one right answer and a changed day means something was wrong.
 */

const RangeQuery = z.object({
  /** Inclusive, shop-local. Defaults to a fortnight ending today. */
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const RecomputeBody = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const DigestQuery = z.object({
  limit: z.coerce.number().int().min(1).max(60).default(14),
});

/** The default window: two weeks, which is what fits on a phone without paging. */
const DEFAULT_WINDOW_DAYS = 13;

@Controller('analytics')
export class AnalyticsController {
  constructor(
    @Inject(RETENTION_RUNTIME) private readonly retention: RetentionRuntime<Tx>,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  /**
   * The shop overview and every drill-down behind it.
   *
   * `previousKpis` is the comparison window, computed the same way over the
   * immediately preceding span of equal length. Shipping it from the server
   * rather than letting the page fetch twice is what stops two views of the
   * same page disagreeing about what "last period" meant.
   */
  /**
   * Phase 7.1 - RBAC tightening.
   *
   * These routes carried no `@Roles()` and were therefore open to every
   * authenticated role, technicians included. That was never intended: a
   * technician's job is the vehicle, and this controller reads the shop's revenue, margin and approval-rate figures.
   * `rbac-matrix.test.ts` now asserts the whole surface, so the omission
   * cannot come back silently.
   */
  @Get('summary')
  @Roles('OWNER', 'ADVISOR')
  async summary(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodQuery(RangeQuery) query: z.infer<typeof RangeQuery>,
  ): Promise<AnalyticsRange> {
    const { from, to } = await this.resolveRange(staff.shopId, query);
    const current = await this.retention.metrics.range(staff.shopId, from, to);

    const span = localDaysBetween(from, to);
    const previous = await this.retention.metrics.range(
      staff.shopId,
      addLocalDays(from, -(span + 1)),
      addLocalDays(from, -1),
    );

    return {
      from,
      to,
      days: current.days.map(toRollupDto),
      total: toRollupDto(current.total),
      kpis: current.kpis as RollupKpisDto,
      // Null rather than a row of nulls when there is nothing behind it: a
      // comparison against a period the shop was not using the product for is
      // not a comparison, and an arrow pointing down would be a lie.
      previousKpis: previous.days.length === 0 ? null : (previous.kpis as RollupKpisDto),
    };
  }

  /**
   * The same rollups as CSV, one row per day.
   *
   * A projection of `summary`, not a second query. The columns are the rollup's
   * own fields in a fixed order, so a spreadsheet somebody built last quarter
   * still opens — new fields are appended, never inserted.
   */
  @Get('export.csv')
  @Roles('OWNER', 'ADVISOR')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="serviceloop-analytics.csv"')
  async exportCsv(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodQuery(RangeQuery) query: z.infer<typeof RangeQuery>,
  ): Promise<string> {
    const { from, to } = await this.resolveRange(staff.shopId, query);
    const range = await this.retention.metrics.range(staff.shopId, from, to);

    const rows = range.days.map(toRollupDto);
    const header = [...CSV_COLUMNS, ...CSV_KPI_COLUMNS].join(',');
    const body = rows.map((row) => {
      const kpis = kpisForDay(row);
      return [
        ...CSV_COLUMNS.map((column) => csvCell(row[column])),
        ...CSV_KPI_COLUMNS.map((column) => csvCell(kpis[column])),
      ].join(',');
    });
    return [header, ...body, ''].join('\n');
  }

  /**
   * Re-fold a span of days from the event log (phase 6.9).
   *
   * The audit story for the "revenue recovered" claim: an owner, or an operator
   * answering a question about a number, can make the system prove its own
   * arithmetic. The shop's `analytics.maxBackfillDays` bounds it, and exceeding
   * that is a 400 rather than a slow query nobody cancelled.
   */
  @Roles('OWNER')
  @Post('recompute')
  async recompute(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodBody(RecomputeBody) body: z.infer<typeof RecomputeBody>,
  ): Promise<RecomputeResult> {
    let results;
    try {
      results = await this.retention.metrics.recompute({
        shopId: staff.shopId,
        from: body.from,
        ...(body.to === undefined ? {} : { to: body.to }),
        traceId: currentTraceId(),
      });
    } catch (error) {
      if (error instanceof RangeError) {
        throw new ValidationError(error.message, {
          fieldErrors: [{ path: 'from', message: error.message }],
        });
      }
      throw error;
    }

    // A day that had no rollup is *filled in*; only a day that had one and
    // produced different numbers is a change. Conflating the two would make an
    // owner's first press of "check these numbers" an alarm every time, which
    // is how an alarm stops being read.
    const filled = results.filter((result) => result.previousHash === null);
    const changed = results.filter((result) => result.previousHash !== null && result.changed);

    return {
      from: body.from,
      to: results.at(-1)?.day ?? body.from,
      days: results.length,
      filledDays: filled.length,
      changedDays: changed.length,
      changed: changed.map((result) => ({
        day: result.day,
        previousHash: result.previousHash,
        hash: result.payloadHash,
      })),
      source: 'BACKFILL',
    };
  }

  /**
   * The briefs that actually went out, newest first (phase 6.7).
   *
   * The stored payload replayed, never re-composed: an owner comparing this
   * page with the message on their phone must not find two different evenings.
   */
  @Get('digests')
  @Roles('OWNER', 'ADVISOR')
  async digests(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodQuery(DigestQuery) query: z.infer<typeof DigestQuery>,
  ): Promise<OwnerDigestList> {
    const result = await this.db.execute<{
      id: string;
      kind: string;
      day: string;
      payload: unknown;
      sent_at: Date | null;
    }>(sql`
      select id, kind, day::text as day, payload, sent_at
      from owner_digests
      where shop_id = ${staff.shopId}
      order by day desc, created_at desc
      limit ${query.limit}
    `);

    return {
      digests: result.rows.map((row): OwnerDigestDto => {
        const payload = (row.payload ?? {}) as Partial<OwnerDigestDto>;
        return {
          id: row.id,
          kind: row.kind === 'WEEKLY' ? 'WEEKLY' : 'DAILY',
          day: row.day,
          shopName: payload.shopName ?? '',
          lines: payload.lines ?? [],
          numbers: payload.numbers ?? {
            vehiclesIn: 0,
            vehiclesOut: 0,
            approvedPaise: 0,
            recoveredPaise: 0,
            approvalsPending: 0,
            feedbackFlags: 0,
            silentBays: 0,
          },
          actions: payload.actions ?? [],
          sentAt: row.sent_at?.toISOString() ?? null,
        };
      }),
    };
  }

  /**
   * Resolves the window in the shop's own timezone.
   *
   * "Today" is a different day in Chennai and in London, and an owner reading
   * their evening numbers at 00:30 IST is asking about the day that just ended.
   * `metrics.dayFor` answers that in the shop's zone; the API's own clock never
   * decides it.
   */
  private async resolveRange(
    shopId: string,
    query: z.infer<typeof RangeQuery>,
  ): Promise<{ from: IsoDay; to: IsoDay }> {
    const today = await this.retention.metrics.dayFor(shopId, new Date());
    const to = query.to ?? today;
    const from = query.from ?? addLocalDays(to, -DEFAULT_WINDOW_DAYS);

    if (localDaysBetween(from, to) < 0) {
      throw new ValidationError('`from` is after `to`', {
        fieldErrors: [{ path: 'from', message: 'The range starts after it ends' }],
      });
    }
    return { from, to };
  }
}

/* -------------------------------------------------------------------------- *
 * Projection
 * -------------------------------------------------------------------------- */

/**
 * The rollup, minus `windows`.
 *
 * The window settings are shop configuration, not measurement, and putting them
 * on every day of a fortnight's response would be fourteen copies of a fact the
 * Guardrails page already owns.
 */
function toRollupDto(rollup: object): DailyRollupDto {
  const { windows: _windows, ...rest } = rollup as Record<string, unknown> & {
    windows?: unknown;
  };
  return rest as unknown as DailyRollupDto;
}

const CSV_COLUMNS = [
  'day',
  'vehiclesIn',
  'vehiclesOut',
  'approvalsRequested',
  'approvalsDecided',
  'requestedValuePaise',
  'approvedValuePaise',
  'statusQueriesAnswered',
  'statusQueriesHandedOff',
  'deliveriesOnTime',
  'deliveriesLate',
  'deliveriesUnpromised',
  'ledgeredPaise',
  'ledgeredCount',
  'recoveredPaise',
  'recoveredCount',
  'cohortLedgeredPaise',
  'cohortRecoveredPaise',
  'optedOutCount',
  'repitchesSent',
  'retentionTouchesSent',
  'retentionTouchesSkipped',
  'visits',
  'repeatVisits',
  'feedbackPositive',
  'feedbackNeutral',
  'feedbackNegative',
  'reviewAsks',
  'agentRuns',
  'agentObjectiveMet',
  'agentHandoffs',
  'agentBlocked',
  'draftsApprovedWithoutEdit',
  'draftsEdited',
  'draftsRejected',
  'callsPlaced',
  'callsContained',
  'callsHandedOff',
  'messagesBlocked',
  'consentRevocations',
  'silentBays',
  'alertsRaised',
] as const satisfies readonly (keyof DailyRollupDto)[];

const CSV_KPI_COLUMNS = [
  'approvalTurnaroundMedianMinutes',
  'approvalTurnaroundP90Minutes',
  'approvalConversionRate',
  'statusDeflectionRate',
  'onTimeDeliveryRate',
  'declinedWorkRecoveryRate',
  'repeatVisitRate',
  'agentContainmentRate',
  'draftAcceptedWithoutEditRate',
  'voiceContainmentRate',
] as const satisfies readonly (keyof RollupKpisDto)[];

/**
 * The per-day KPIs for a CSV row.
 *
 * Computed from the same pure function the service uses, so a spreadsheet's
 * recovery rate and the page's recovery rate cannot differ. A null stays an
 * empty cell rather than becoming a zero — `=AVERAGE()` over an empty cell is
 * right, and over a fabricated zero is wrong.
 */
function kpisForDay(row: DailyRollupDto): RollupKpisDto {
  const ratio = (numerator: number, denominator: number): number | null =>
    denominator === 0 ? null : numerator / denominator;
  const percentile = (samples: readonly number[], fraction: number): number | null => {
    if (samples.length === 0) return null;
    const sorted = [...samples].sort((a, b) => a - b);
    const rank = Math.max(1, Math.ceil(fraction * sorted.length));
    return sorted[rank - 1] ?? null;
  };

  return {
    approvalTurnaroundMedianMinutes: percentile(row.turnaroundMinutes, 0.5),
    approvalTurnaroundP90Minutes: percentile(row.turnaroundMinutes, 0.9),
    approvalConversionRate: ratio(row.approvedValuePaise, row.requestedValuePaise),
    statusDeflectionRate: ratio(
      row.statusQueriesAnswered,
      row.statusQueriesAnswered + row.statusQueriesHandedOff,
    ),
    onTimeDeliveryRate: ratio(row.deliveriesOnTime, row.deliveriesOnTime + row.deliveriesLate),
    declinedWorkRecoveryRate: ratio(row.cohortRecoveredPaise, row.cohortLedgeredPaise),
    repeatVisitRate: ratio(row.repeatVisits, row.visits),
    agentContainmentRate: ratio(row.agentObjectiveMet, row.agentRuns),
    draftAcceptedWithoutEditRate: ratio(
      row.draftsApprovedWithoutEdit,
      row.draftsApprovedWithoutEdit + row.draftsEdited + row.draftsRejected,
    ),
    voiceContainmentRate: ratio(row.callsContained, row.callsContained + row.callsHandedOff),
  };
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
