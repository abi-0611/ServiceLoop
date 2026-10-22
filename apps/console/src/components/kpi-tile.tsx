import { formatPaise } from '@serviceloop/shared';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { spotlightProps } from '@/lib/spotlight';
import { cn } from '@/lib/utils';

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
 * not earned. The arrow states the *direction* — which is a fact — in the
 * muted palette every other secondary figure uses.
 */

export type KpiFormat = 'percent' | 'minutes' | 'money' | 'count';

export function KpiTile({
  label,
  value,
  previous,
  format,
  hint,
  testId,
  index = 0,
}: {
  readonly label: string;
  readonly value: number | null;
  readonly previous?: number | null;
  readonly format: KpiFormat;
  readonly hint?: string;
  readonly testId?: string;
  /** Position in its grid, so a row of tiles arrives in order rather than at once. */
  readonly index?: number;
}): React.JSX.Element {
  const delta =
    value === null || previous === null || previous === undefined ? null : value - previous;
  const notable = delta !== null && Math.abs(delta) > EPSILON[format];

  return (
    <div
      data-testid={testId}
      {...spotlightProps}
      className={cn(
        'animate-enter spotlight sheen lift group relative overflow-hidden rounded-md',
        'border border-border bg-card p-4 shadow-sm hover:border-foreground/25 hover:shadow-md',
      )}
      style={{ '--i': index } as React.CSSProperties}
    >
      {/* A hairline of brand colour along the top edge, revealed on hover. It
          is the only decoration on the tile, and it costs one transform. */}
      <span
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-px origin-left scale-x-0 bg-foreground/40 transition-transform duration-500 ease-swift group-hover:scale-x-100"
      />

      <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </p>

      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <p
          className="text-[26px] font-semibold leading-none tracking-tight tabular-nums"
          data-testid={testId && `${testId}-value`}
        >
          {value === null ? (
            <span className="text-base font-normal text-muted-foreground">No data</span>
          ) : (
            formatKpi(value, format)
          )}
        </p>

        {notable && delta !== null && (
          <span
            title={`${delta > 0 ? '+' : '−'}${formatKpi(Math.abs(delta), format)} vs previous period`}
            aria-label={`${delta > 0 ? 'up' : 'down'} ${formatKpi(Math.abs(delta), format)} versus the previous period`}
            className="inline-flex items-center gap-0.5 rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground"
          >
            {delta > 0 ? (
              <ArrowUpRight className="size-3" aria-hidden="true" />
            ) : (
              <ArrowDownRight className="size-3" aria-hidden="true" />
            )}
            {formatKpi(Math.abs(delta), format)}
          </span>
        )}
      </div>

      {hint !== undefined && (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{hint}</p>
      )}
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
