import { AnalyticsRangeSchema, formatPaise, SessionSchema } from '@serviceloop/shared';
import Link from 'next/link';
import { KpiTile } from '@/components/kpi-tile';
import { RecomputeButton } from '@/components/recompute-button';
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState } from '@/components/ui/primitives';
import { serverApiFetch } from '@/lib/api';

/**
 * Shop overview (phase 6.9).
 *
 * Every number on this page is a field the metrics service put in a stored
 * rollup. Nothing here is computed in the browser and nothing is queried live,
 * which is what makes the page agree with the WhatsApp digest an owner is
 * holding — and what makes `pnpm metrics:recompute` able to prove it.
 *
 * The two headline figures are chosen rather than defaulted: **approved today**
 * is what the shop earned, and **recovered from previously declined work** is
 * what it would not have earned without this product. The second is the number
 * the business rests on, so it sits beside a link to the ledger it came from
 * rather than alone in a tile somebody has to trust.
 */

export const dynamic = 'force-dynamic';

const DEFAULT_RANGE_LABEL = 'the last 14 days';

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const query = new URLSearchParams();
  const from = single(params['from']);
  const to = single(params['to']);
  if (from !== null) query.set('from', from);
  if (to !== null) query.set('to', to);

  const [range, role] = await Promise.all([
    serverApiFetch(
      `/analytics/summary${query.size === 0 ? '' : `?${query.toString()}`}`,
      AnalyticsRangeSchema,
    ),
    currentRole(),
  ]);

  const { total, kpis, previousKpis } = range;
  const hasData = range.days.length > 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Analytics</h1>
          <p className="text-sm text-muted-foreground">
            {range.from} to {range.to} · every figure folded from the event log.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/api/analytics/export.csv?from=${range.from}&to=${range.to}`}
            className="rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-accent"
            data-testid="analytics-export"
          >
            Export CSV
          </Link>
          {role === 'OWNER' && <RecomputeButton from={range.from} to={range.to} />}
        </div>
      </div>

      {!hasData ? (
        <EmptyState
          title="No days folded yet"
          description="Rollups are written by the nightly fold on the workers process. Run pnpm metrics:recompute --from <date> to build them for a range that has already happened."
        />
      ) : (
        <>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <KpiTile
              label="Approved"
              value={total.approvedValuePaise}
              format="money"
              hint={`of ${formatPaise(total.requestedValuePaise)} asked for`}
              testId="kpi-approved"
            />
            <KpiTile
              label="Recovered from declined work"
              value={total.recoveredPaise}
              format="money"
              hint={`${total.recoveredCount} item(s) came back`}
              testId="kpi-recovered"
            />
            <KpiTile
              label="Vehicles in / out"
              value={total.vehiclesIn}
              format="count"
              hint={`${total.vehiclesOut} delivered`}
              testId="kpi-vehicles"
            />
            <KpiTile
              label="Waiting on approval"
              value={total.pendingApprovals.length}
              format="count"
              hint="past the shop's stuck threshold, right now"
              testId="kpi-pending"
            />
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              The loop
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <KpiTile
                label="Approval turnaround (median)"
                value={kpis.approvalTurnaroundMedianMinutes}
                previous={previousKpis?.approvalTurnaroundMedianMinutes ?? null}
                format="minutes"
                hint={
                  kpis.approvalTurnaroundP90Minutes === null
                    ? undefined
                    : `p90 ${Math.round(kpis.approvalTurnaroundP90Minutes)}m`
                }
                testId="kpi-turnaround"
              />
              <KpiTile
                label="Approval conversion"
                value={kpis.approvalConversionRate}
                previous={previousKpis?.approvalConversionRate ?? null}
                format="percent"
                hint="approved value ÷ value asked for"
                testId="kpi-conversion"
              />
              <KpiTile
                label="Status deflection"
                value={kpis.statusDeflectionRate}
                previous={previousKpis?.statusDeflectionRate ?? null}
                format="percent"
                hint="status questions answered without a person"
                testId="kpi-deflection"
              />
              <KpiTile
                label="On-time delivery"
                value={kpis.onTimeDeliveryRate}
                previous={previousKpis?.onTimeDeliveryRate ?? null}
                format="percent"
                hint={`${total.deliveriesUnpromised} delivered with nothing promised`}
                testId="kpi-ontime"
              />
              <KpiTile
                label="Declined-work recovery"
                value={kpis.declinedWorkRecoveryRate}
                previous={previousKpis?.declinedWorkRecoveryRate ?? null}
                format="percent"
                hint="recovered ÷ ledgered, 90-day cohort"
                testId="kpi-recovery-rate"
              />
              <KpiTile
                label="Repeat visits"
                value={kpis.repeatVisitRate}
                previous={previousKpis?.repeatVisitRate ?? null}
                format="percent"
                hint="visits from a customer seen in the window"
                testId="kpi-repeat"
              />
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              The agent
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <KpiTile
                label="Containment"
                value={kpis.agentContainmentRate}
                previous={previousKpis?.agentContainmentRate ?? null}
                format="percent"
                hint={`${total.agentHandoffs} handed to a person`}
                testId="kpi-containment"
              />
              <KpiTile
                label="Drafts accepted unedited"
                value={kpis.draftAcceptedWithoutEditRate}
                previous={previousKpis?.draftAcceptedWithoutEditRate ?? null}
                format="percent"
                hint={`${total.draftsEdited} edited, ${total.draftsRejected} rejected`}
                testId="kpi-drafts"
              />
              <KpiTile
                label="Calls contained"
                value={kpis.voiceContainmentRate}
                previous={previousKpis?.voiceContainmentRate ?? null}
                format="percent"
                hint={`${total.callsPlaced} placed`}
                testId="kpi-voice"
              />
              <KpiTile
                label="Review velocity"
                value={total.reviewAsks}
                format="count"
                hint={`${total.feedbackPositive} positive, ${total.feedbackNegative} negative`}
                testId="kpi-reviews"
              />
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Guardrails
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <KpiTile
                label="Messages blocked"
                value={total.messagesBlocked}
                format="count"
                hint="the gate refused to send"
                testId="kpi-blocked"
              />
              <KpiTile
                label="Consent revoked"
                value={total.consentRevocations}
                format="count"
                testId="kpi-revocations"
              />
              <KpiTile
                label="Retention withheld"
                value={total.retentionTouchesSkipped}
                format="count"
                hint={`${total.retentionTouchesSent} sent`}
                testId="kpi-withheld"
              />
              <KpiTile
                label="Alerts raised"
                value={total.alertsRaised}
                format="count"
                hint={`${total.silentBays} silent bay(s)`}
                testId="kpi-alerts"
              />
            </div>
          </section>

          <Card>
            <CardHeader>
              <CardTitle>Day by day</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="analytics-days">
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="py-2 pr-4 font-medium">Day</th>
                      <th className="py-2 pr-4 font-medium">In</th>
                      <th className="py-2 pr-4 font-medium">Out</th>
                      <th className="py-2 pr-4 font-medium">Approved</th>
                      <th className="py-2 pr-4 font-medium">Recovered</th>
                      <th className="py-2 pr-4 font-medium">Ledgered</th>
                      <th className="py-2 pr-4 font-medium">Feedback</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...range.days].reverse().map((day) => (
                      <tr key={day.day} className="border-b border-border/60 last:border-0">
                        <td className="py-2 pr-4 font-medium tabular-nums">{day.day}</td>
                        <td className="py-2 pr-4 tabular-nums">{day.vehiclesIn}</td>
                        <td className="py-2 pr-4 tabular-nums">{day.vehiclesOut}</td>
                        <td className="py-2 pr-4 tabular-nums">
                          {formatPaise(day.approvedValuePaise)}
                        </td>
                        <td className="py-2 pr-4 tabular-nums">{formatPaise(day.recoveredPaise)}</td>
                        <td className="py-2 pr-4 tabular-nums">{formatPaise(day.ledgeredPaise)}</td>
                        <td className="py-2 pr-4">
                          {day.feedbackNegative > 0 ? (
                            <Badge tone="warn">{day.feedbackNegative} unhappy</Badge>
                          ) : (
                            <span className="text-muted-foreground tabular-nums">
                              {day.feedbackPositive + day.feedbackNeutral}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      <nav className="flex flex-wrap gap-2 text-sm">
        <Link
          href="/analytics/ledger"
          className="rounded-md border border-border px-3 py-2 font-medium hover:bg-accent"
        >
          Declined-work ledger →
        </Link>
        <Link
          href="/analytics/retention"
          className="rounded-md border border-border px-3 py-2 font-medium hover:bg-accent"
        >
          Retention touches & feedback →
        </Link>
        <Link
          href="/analytics/digests"
          className="rounded-md border border-border px-3 py-2 font-medium hover:bg-accent"
        >
          Owner digests →
        </Link>
      </nav>

      <p className="text-xs text-muted-foreground">
        Showing {DEFAULT_RANGE_LABEL} unless a range is given. Add <code>?from=</code> and{' '}
        <code>?to=</code> for any other window; the CSV export and the digest quote the same
        rollups.
      </p>
    </div>
  );
}

function single(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

async function currentRole(): Promise<string | null> {
  try {
    const me = await serverApiFetch('/auth/me', SessionSchema.shape.staff);
    return me.role;
  } catch {
    return null;
  }
}
