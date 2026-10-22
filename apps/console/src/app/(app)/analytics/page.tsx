import { AnalyticsRangeSchema, formatPaise, SessionSchema } from '@serviceloop/shared';
import { ArrowUpRight, Download } from 'lucide-react';
import Link from 'next/link';
import { KpiTile } from '@/components/kpi-tile';
import { RecomputeButton } from '@/components/recompute-button';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  SectionHeading,
} from '@/components/ui/primitives';
import { SpotlightArea } from '@/components/ui/spotlight';
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
    <div className="space-y-8">
      <PageHeader
        eyebrow="Insight"
        title="Analytics"
        description={
          <>
            {range.from} to {range.to} · every figure folded from the event log.
          </>
        }
        actions={
          <>
            <Link
              href={`/api/analytics/export.csv?from=${range.from}&to=${range.to}`}
              className="inline-flex h-11 items-center gap-2 rounded-md border border-input bg-background/60 px-4 text-sm font-medium shadow-xs transition-[background-color,border-color,transform] duration-200 ease-swift hover:border-primary/40 hover:bg-accent active:scale-[0.98]"
              data-testid="analytics-export"
            >
              <Download className="size-4" aria-hidden="true" />
              Export CSV
            </Link>
            {role === 'OWNER' && <RecomputeButton from={range.from} to={range.to} />}
          </>
        }
      />

      {!hasData ? (
        <EmptyState
          title="No days folded yet"
          description="Rollups are written by the nightly fold on the workers process. Run pnpm metrics:recompute --from <date> to build them for a range that has already happened."
        />
      ) : (
        <>
          <SpotlightArea className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <KpiTile
              index={0}
              label="Approved"
              value={total.approvedValuePaise}
              format="money"
              hint={`of ${formatPaise(total.requestedValuePaise)} asked for`}
              testId="kpi-approved"
            />
            <KpiTile
              index={1}
              label="Recovered from declined work"
              value={total.recoveredPaise}
              format="money"
              hint={`${total.recoveredCount} item(s) came back`}
              testId="kpi-recovered"
            />
            <KpiTile
              index={2}
              label="Vehicles in / out"
              value={total.vehiclesIn}
              format="count"
              hint={`${total.vehiclesOut} delivered`}
              testId="kpi-vehicles"
            />
            <KpiTile
              index={3}
              label="Waiting on approval"
              value={total.pendingApprovals.length}
              format="count"
              hint="past the shop's stuck threshold, right now"
              testId="kpi-pending"
            />
          </SpotlightArea>

          <section>
            <SectionHeading className="mb-3">
              The loop
            </SectionHeading>
            <SpotlightArea className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <KpiTile
                index={0}
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
                index={1}
                label="Approval conversion"
                value={kpis.approvalConversionRate}
                previous={previousKpis?.approvalConversionRate ?? null}
                format="percent"
                hint="approved value ÷ value asked for"
                testId="kpi-conversion"
              />
              <KpiTile
                index={2}
                label="Status deflection"
                value={kpis.statusDeflectionRate}
                previous={previousKpis?.statusDeflectionRate ?? null}
                format="percent"
                hint="status questions answered without a person"
                testId="kpi-deflection"
              />
              <KpiTile
                index={3}
                label="On-time delivery"
                value={kpis.onTimeDeliveryRate}
                previous={previousKpis?.onTimeDeliveryRate ?? null}
                format="percent"
                hint={`${total.deliveriesUnpromised} delivered with nothing promised`}
                testId="kpi-ontime"
              />
              <KpiTile
                index={4}
                label="Declined-work recovery"
                value={kpis.declinedWorkRecoveryRate}
                previous={previousKpis?.declinedWorkRecoveryRate ?? null}
                format="percent"
                hint="recovered ÷ ledgered, 90-day cohort"
                testId="kpi-recovery-rate"
              />
              <KpiTile
                index={5}
                label="Repeat visits"
                value={kpis.repeatVisitRate}
                previous={previousKpis?.repeatVisitRate ?? null}
                format="percent"
                hint="visits from a customer seen in the window"
                testId="kpi-repeat"
              />
            </SpotlightArea>
          </section>

          <section>
            <SectionHeading className="mb-3">
              The agent
            </SectionHeading>
            <SpotlightArea className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <KpiTile
                index={0}
                label="Containment"
                value={kpis.agentContainmentRate}
                previous={previousKpis?.agentContainmentRate ?? null}
                format="percent"
                hint={`${total.agentHandoffs} handed to a person`}
                testId="kpi-containment"
              />
              <KpiTile
                index={1}
                label="Drafts accepted unedited"
                value={kpis.draftAcceptedWithoutEditRate}
                previous={previousKpis?.draftAcceptedWithoutEditRate ?? null}
                format="percent"
                hint={`${total.draftsEdited} edited, ${total.draftsRejected} rejected`}
                testId="kpi-drafts"
              />
              <KpiTile
                index={2}
                label="Calls contained"
                value={kpis.voiceContainmentRate}
                previous={previousKpis?.voiceContainmentRate ?? null}
                format="percent"
                hint={`${total.callsPlaced} placed`}
                testId="kpi-voice"
              />
              <KpiTile
                index={3}
                label="Review velocity"
                value={total.reviewAsks}
                format="count"
                hint={`${total.feedbackPositive} positive, ${total.feedbackNegative} negative`}
                testId="kpi-reviews"
              />
            </SpotlightArea>
          </section>

          <section>
            <SectionHeading className="mb-3">
              Guardrails
            </SectionHeading>
            <SpotlightArea className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <KpiTile
                index={0}
                label="Messages blocked"
                value={total.messagesBlocked}
                format="count"
                hint="the gate refused to send"
                testId="kpi-blocked"
              />
              <KpiTile
                index={1}
                label="Consent revoked"
                value={total.consentRevocations}
                format="count"
                testId="kpi-revocations"
              />
              <KpiTile
                index={2}
                label="Retention withheld"
                value={total.retentionTouchesSkipped}
                format="count"
                hint={`${total.retentionTouchesSent} sent`}
                testId="kpi-withheld"
              />
              <KpiTile
                index={3}
                label="Alerts raised"
                value={total.alertsRaised}
                format="count"
                hint={`${total.silentBays} silent bay(s)`}
                testId="kpi-alerts"
              />
            </SpotlightArea>
          </section>

          <Card className="animate-enter overflow-hidden">
            <CardHeader>
              <CardTitle>Day by day</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="-mx-4 overflow-x-auto px-4">
                <table className="w-full min-w-[46rem] text-sm" data-testid="analytics-days">
                  <thead>
                    {/* Sticky so the column a figure belongs to is still on
                        screen when a fortnight of rows is scrolled. */}
                    <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
                      <th className="sticky left-0 bg-card py-2.5 pr-4 font-semibold">Day</th>
                      <th className="py-2.5 pr-4 font-semibold">In</th>
                      <th className="py-2.5 pr-4 font-semibold">Out</th>
                      <th className="py-2.5 pr-4 text-right font-semibold">Approved</th>
                      <th className="py-2.5 pr-4 text-right font-semibold">Recovered</th>
                      <th className="py-2.5 pr-4 text-right font-semibold">Ledgered</th>
                      <th className="py-2.5 pr-4 font-semibold">Feedback</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...range.days].reverse().map((day) => (
                      <tr
                        key={day.day}
                        className="border-b border-border/60 transition-colors duration-150 last:border-0 hover:bg-accent/50"
                      >
                        <td className="sticky left-0 bg-card py-2.5 pr-4 font-mono text-xs font-medium tabular-nums">
                          {day.day}
                        </td>
                        <td className="py-2.5 pr-4 tabular-nums">{day.vehiclesIn}</td>
                        <td className="py-2.5 pr-4 tabular-nums">{day.vehiclesOut}</td>
                        <td className="py-2.5 pr-4 text-right tabular-nums">
                          {formatPaise(day.approvedValuePaise)}
                        </td>
                        <td className="py-2.5 pr-4 text-right tabular-nums">
                          {formatPaise(day.recoveredPaise)}
                        </td>
                        <td className="py-2.5 pr-4 text-right tabular-nums">
                          {formatPaise(day.ledgeredPaise)}
                        </td>
                        <td className="py-2.5 pr-4">
                          {day.feedbackNegative > 0 ? (
                            <Badge tone="warn">{day.feedbackNegative} unhappy</Badge>
                          ) : (
                            <span className="tabular-nums text-muted-foreground">
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

      {/* The three reports this page summarises. Cards rather than a row of
          pills, because each one is a destination an owner spends minutes in,
          not a filter they flick between. */}
      <SpotlightArea>
        <nav className="grid gap-3 sm:grid-cols-3" aria-label="Detailed reports">
          {[
            {
              href: '/analytics/ledger',
              label: 'Declined-work ledger',
              blurb: 'Everything a customer said no to, and what came back.',
            },
            {
              href: '/analytics/retention',
              label: 'Retention touches & feedback',
              blurb: 'Who was contacted, who was withheld, and what they said.',
            },
            {
              href: '/analytics/digests',
              label: 'Owner digests',
              blurb: 'The message sent to the owner, and the rollup behind it.',
            },
          ].map((report, index) => (
            <Link
              key={report.href}
              href={report.href}
              data-spotlight
              className="spotlight sheen lift animate-enter group flex flex-col rounded-md border border-border bg-card p-4 shadow-sm transition-colors hover:border-foreground/25 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              style={{ '--i': index } as React.CSSProperties}
            >
              <span className="flex items-center justify-between gap-2 text-sm font-semibold">
                {report.label}
                <ArrowUpRight
                  className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-swift group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-primary"
                  aria-hidden="true"
                />
              </span>
              <span className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                {report.blurb}
              </span>
            </Link>
          ))}
        </nav>
      </SpotlightArea>

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
