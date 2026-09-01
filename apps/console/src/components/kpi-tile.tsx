import { formatPaise } from '@serviceloop/shared';

/**
 * One KPI, with its comparison (phase 6.9).
 *
 * The rule this component exists to enforce: **a null is rendered as "no data",
 * never as a zero.** Every rate on an analytics page comes back nullable from
 * the metrics service because "we asked for approval nine times and got four"
 * and "we never asked" are different facts, and a dashboard that draws both as
 * 0% tells a shop it is failing at something it has not started.
 *
 * The delta is rendered without a judgement colour for the same reason a rate
 * is not rounded to an integer: whether "approvals took longer this fortnight"
 * is good or bad depends on why, and a red arrow is an opinion this page has
 * not earned.
 */

export type KpiFormat = 'percent' | 'minutes' | 'money' | 'count';

export function KpiTile({
  label,
  value,
  previous,
  format,
  hint,
  testId,
}: {
  readonly label: string;
  readonly value: number | null;
  readonly previous?: number | null;
  readonly format: KpiFormat;
  readonly hint?: string;
  readonly testId?: string;
}): React.JSX.Element {
  const delta =
    value === null || previous === null || previous === undefined ? null : value - previous;

  return (
    <div
      data-testid={testId}
      className="rounded-lg border border-border bg-card p-4 shadow-sm"
    >
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums" data-testid={testId && `${testId}-value`}>
        {value === null ? (
          <span className="text-base font-normal text-muted-foreground">No data</span>
        ) : (
          formatKpi(value, format)
        )}
      </p>
      {delta !== null && Math.abs(delta) > EPSILON[format] && (
        <p className="mt-1 text-xs text-muted-foreground tabular-nums">
          {delta > 0 ? '+' : '−'}
          {formatKpi(Math.abs(delta), format)} vs previous period
        </p>
      )}
      {hint !== undefined && <p className="mt-2 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * A number below which a change is noise rather than news.
 *
 * Half a percentage point, half a minute, a rupee, one of anything. Without
 * this, a tile whose rate moved by 0.0001 renders "+0% vs previous period",
 * which is worse than saying nothing.
 */
const EPSILON: Readonly<Record<KpiFormat, number>> = {
  percent: 0.005,
  minutes: 0.5,
  money: 100,
  count: 0.5,
};

export function formatKpi(value: number, format: KpiFormat): string {
  switch (format) {
    case 'percent':
      return `${Math.round(value * 100)}%`;
    case 'minutes':
      return value >= 90
        ? `${Math.floor(value / 60)}h ${Math.round(value % 60)}m`
        : `${Math.round(value)}m`;
    case 'money':
      return formatPaise(value);
    case 'count':
      return String(Math.round(value));
  }
}
