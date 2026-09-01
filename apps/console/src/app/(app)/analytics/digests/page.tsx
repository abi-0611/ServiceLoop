import { formatPaise, OwnerDigestListSchema } from '@serviceloop/shared';
import Link from 'next/link';
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState } from '@/components/ui/primitives';
import { serverApiFetch } from '@/lib/api';

/**
 * The briefs that went out (phase 6.7).
 *
 * This page replays the **stored payload** — the exact object the WhatsApp
 * message was rendered from — rather than composing the brief again. That is
 * not laziness: an owner opening this page is usually holding the message on
 * their phone, and a page that recomposed from today's rollups would show them
 * a different evening and destroy their trust in both.
 *
 * A digest with no `sentAt` is not a bug and is shown as such. It means the
 * brief was composed and stored but the gate did not deliver it — no owner
 * thread, quiet hours, a shop with nobody configured to receive it — and that
 * is exactly what somebody wondering why they get no digest needs to see.
 */

export const dynamic = 'force-dynamic';

export default async function DigestsPage(): Promise<React.JSX.Element> {
  const list = await serverApiFetch('/analytics/digests?limit=21', OwnerDigestListSchema);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/analytics" className="text-sm text-muted-foreground hover:underline">
          ← Back to analytics
        </Link>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">Owner digests</h1>
        <p className="text-sm text-muted-foreground">
          The evening brief, exactly as it was sent — same numbers, same buttons.
        </p>
      </div>

      {list.digests.length === 0 ? (
        <EmptyState
          title="No digests yet"
          description="The brief goes out at the shop's configured time (20:30 by default) once the workers process has folded the day. It needs an owner with a WhatsApp thread to land on."
        />
      ) : (
        <ul className="space-y-3" data-testid="digest-list">
          {list.digests.map((digest) => (
            <li key={digest.id}>
              <Card>
                <CardHeader>
                  <CardTitle className="flex flex-wrap items-center gap-2">
                    <span>{digest.day}</span>
                    <Badge tone={digest.kind === 'WEEKLY' ? 'info' : 'neutral'}>
                      {digest.kind.toLowerCase()}
                    </Badge>
                    {digest.sentAt === null ? (
                      <Badge tone="warn">composed, not delivered</Badge>
                    ) : (
                      <Badge tone="success">
                        sent {new Date(digest.sentAt).toLocaleTimeString()}
                      </Badge>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <pre className="whitespace-pre-wrap rounded-md bg-muted p-3 text-sm font-sans">
                    {digest.lines.join('\n')}
                  </pre>

                  {digest.actions.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {digest.actions.map((action) => (
                        <span
                          key={action.id}
                          className="rounded-full border border-border px-3 py-1 text-xs font-medium text-muted-foreground"
                        >
                          {action.title}
                        </span>
                      ))}
                    </div>
                  )}

                  <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                    <Figure label="Approved" value={formatPaise(digest.numbers.approvedPaise)} />
                    <Figure label="Recovered" value={formatPaise(digest.numbers.recoveredPaise)} />
                    <Figure
                      label="Vehicles"
                      value={`${digest.numbers.vehiclesIn} in / ${digest.numbers.vehiclesOut} out`}
                    />
                    <Figure
                      label="Waiting"
                      value={`${digest.numbers.approvalsPending} approval(s)`}
                    />
                  </dl>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Figure({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): React.JSX.Element {
  return (
    <div>
      <dt className="uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium tabular-nums">{value}</dd>
    </div>
  );
}
