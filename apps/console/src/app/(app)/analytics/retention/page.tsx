import {
  AlertListSchema,
  FeedbackListSchema,
  formatPaise,
  RetentionTouchListSchema,
} from '@serviceloop/shared';
import Link from 'next/link';
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState } from '@/components/ui/primitives';
import { serverApiFetch } from '@/lib/api';

/**
 * Retention touches, feedback and the exception stream (phases 6.3–6.8).
 *
 * The most useful column on this page is the one showing what was **not** sent.
 * A retention engine's failure mode is not silence, it is enthusiasm — and the
 * question anybody asks about one is "why did my customer get that?", or more
 * often "why did they not?". Every withheld touch carries the gate's own code
 * for the refusal, so both questions are answered by looking rather than by
 * searching a log.
 */

export const dynamic = 'force-dynamic';

const SENTIMENT: Readonly<Record<string, { label: string; tone: 'success' | 'neutral' | 'danger' }>> = {
  POSITIVE: { label: '😊 good', tone: 'success' },
  NEUTRAL: { label: '😐 okay', tone: 'neutral' },
  NEGATIVE: { label: '😞 not good', tone: 'danger' },
};

export default async function RetentionPage(): Promise<React.JSX.Element> {
  const [touches, feedback, alerts] = await Promise.all([
    serverApiFetch('/retention/touches?limit=50', RetentionTouchListSchema),
    serverApiFetch('/retention/feedback?limit=25', FeedbackListSchema),
    serverApiFetch('/retention/alerts?limit=25', AlertListSchema),
  ]);

  const withheld = touches.touches.filter((touch) => touch.status !== 'SENT');

  return (
    <div className="space-y-6">
      <div>
        <Link href="/analytics" className="text-sm text-muted-foreground hover:underline">
          ← Back to analytics
        </Link>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">Retention & feedback</h1>
        <p className="text-sm text-muted-foreground">
          What went out, what the gate held back, and what customers said afterwards.
        </p>
      </div>

      {alerts.alerts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Exceptions, last 48 hours</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2" data-testid="retention-alerts">
              {alerts.alerts.map((alert) => (
                <li key={alert.id} className="flex flex-wrap items-baseline gap-2 text-sm">
                  <Badge tone="warn">{alert.kind.replace(/_/g, ' ').toLowerCase()}</Badge>
                  <span>{alert.detail}</span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(alert.raisedAt).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>
            Post-service feedback · {feedback.positive} good, {feedback.neutral} okay,{' '}
            {feedback.negative} not good
          </CardTitle>
        </CardHeader>
        <CardContent>
          {feedback.feedback.length === 0 ? (
            <EmptyState
              title="Nothing asked yet"
              description="A feedback ask is scheduled the moment a vehicle is delivered, and goes out a day or two later."
            />
          ) : (
            <ul className="space-y-3" data-testid="retention-feedback">
              {feedback.feedback.map((row) => {
                const sentiment = row.sentiment === null ? null : (SENTIMENT[row.sentiment] ?? null);
                return (
                  <li key={row.id} className="border-b border-border/60 pb-3 last:border-0 last:pb-0">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      {sentiment === null ? (
                        <Badge tone="neutral">{row.status.toLowerCase()}</Badge>
                      ) : (
                        <Badge tone={sentiment.tone}>{sentiment.label}</Badge>
                      )}
                      <span className="font-medium">
                        {[row.vehicleLabel, row.customerName].filter(Boolean).join(' · ') ||
                          'Unknown customer'}
                      </span>
                      {row.reviewAskedAt !== null && <Badge tone="info">review asked</Badge>}
                      {row.recoveryTaskId !== null && <Badge tone="warn">recovery task open</Badge>}
                      {row.viaVoiceNote && <Badge tone="neutral">voice note</Badge>}
                    </div>
                    {row.comment !== null && row.comment.trim().length > 0 && (
                      <blockquote className="mt-1 border-l-2 border-border pl-3 text-sm italic">
                        “{row.comment}”
                      </blockquote>
                    )}
                    <p className="mt-1 text-xs text-muted-foreground">
                      delivered {new Date(row.deliveredAt).toLocaleDateString()}
                      {row.answeredAt !== null &&
                        ` · answered ${new Date(row.answeredAt).toLocaleDateString()}`}
                      {' · '}
                      <Link href={`/board/${row.jobCardId}`} className="hover:underline">
                        the card
                      </Link>
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            Touches · {touches.touches.length - withheld.length} sent, {withheld.length} withheld
          </CardTitle>
        </CardHeader>
        <CardContent>
          {touches.touches.length === 0 ? (
            <EmptyState
              title="No retention traffic"
              description="Retention is off until a shop turns it on in Guardrails. The ledger fills up regardless, so switching it on later finds the deferred work waiting."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="retention-touches">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">When</th>
                    <th className="py-2 pr-4 font-medium">Customer</th>
                    <th className="py-2 pr-4 font-medium">Trigger</th>
                    <th className="py-2 pr-4 font-medium">Purpose</th>
                    <th className="py-2 pr-4 font-medium">Value</th>
                    <th className="py-2 pr-4 font-medium">Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {touches.touches.map((touch) => (
                    <tr key={touch.id} className="border-b border-border/60 last:border-0">
                      <td className="py-2 pr-4 whitespace-nowrap tabular-nums">
                        {new Date(touch.sentAt ?? touch.scheduledFor).toLocaleDateString()}
                      </td>
                      <td className="py-2 pr-4">
                        {[touch.vehicleLabel, touch.customerName].filter(Boolean).join(' · ') || '—'}
                      </td>
                      <td className="py-2 pr-4 whitespace-nowrap">
                        {touch.trigger.replace(/_/g, ' ').toLowerCase()}
                      </td>
                      <td className="py-2 pr-4">
                        <Badge tone={touch.purpose === 'MARKETING' ? 'warn' : 'neutral'}>
                          {touch.purpose.toLowerCase()}
                        </Badge>
                      </td>
                      <td className="py-2 pr-4 tabular-nums">
                        {touch.amountPaise === 0 ? '—' : formatPaise(touch.amountPaise)}
                      </td>
                      <td className="py-2 pr-4">
                        {touch.status === 'SENT' ? (
                          <Badge tone="success">sent</Badge>
                        ) : (
                          <span className="flex flex-wrap items-center gap-2">
                            <Badge tone="neutral">{touch.status.toLowerCase()}</Badge>
                            <span className="text-xs text-muted-foreground">
                              {touch.skipCode ?? ''}
                              {touch.skipReason === null ? '' : ` — ${touch.skipReason}`}
                            </span>
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
