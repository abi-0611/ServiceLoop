import { formatPaise, JobCardDetailSchema } from '@serviceloop/shared';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { TransitionActions } from '@/components/transition-actions';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/primitives';
import { ApiError, serverApiFetch } from '@/lib/api';

/**
 * Card drawer: work items, estimate lines and the audit trail — the three
 * things an advisor needs to answer "what did we tell the customer, and when".
 */

export const dynamic = 'force-dynamic';

export default async function JobCardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;

  let card;
  try {
    card = await serverApiFetch(`/jobcards/${id}`, JobCardDetailSchema);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  return (
    <div className="space-y-6">
      <div>
        <Link href="/board" className="text-sm text-muted-foreground hover:underline">
          ← Back to board
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{card.code}</h1>
          <span
            data-testid="card-state"
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset state-${card.state}`}
          >
            {card.state}
          </span>
          <Badge tone="neutral">{card.source.replace('_', ' ').toLowerCase()}</Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {card.vehicle.registrationDisplay} ·{' '}
          {[card.vehicle.make, card.vehicle.model].filter(Boolean).join(' ')} ·{' '}
          {card.customer.fullName} ({card.customer.phoneMasked})
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Customer complaint</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm">{card.complaintText ?? 'None recorded.'}</p>
        </CardContent>
      </Card>

      <TransitionActions jobCardId={card.id} allowedEvents={card.allowedEvents} />

      <Card>
        <CardHeader>
          <CardTitle>Work items</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {card.workItems.length === 0 && (
            <p className="text-sm text-muted-foreground">None yet.</p>
          )}
          {card.workItems.map((item) => (
            <div key={item.id} className="rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium">{item.title}</p>
                <Badge tone={item.state === 'PENDING_APPROVAL' ? 'warn' : 'neutral'}>
                  {item.state}
                </Badge>
              </div>
              {item.description !== null && (
                <p className="mt-1 text-sm text-muted-foreground">{item.description}</p>
              )}
              {item.technicianNote !== null && (
                <p className="mt-2 rounded bg-muted p-2 text-xs">
                  <span className="font-medium">Technician note (evidence): </span>
                  {item.technicianNote}
                </p>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      {card.estimates.map((estimate) => (
        <Card key={estimate.id}>
          <CardHeader>
            <CardTitle>
              Estimate v{estimate.version} · {estimate.status}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                    <th className="py-2">Description</th>
                    <th className="py-2">Kind</th>
                    <th className="py-2 text-right">Qty</th>
                    <th className="py-2 text-right">Line total</th>
                  </tr>
                </thead>
                <tbody>
                  {estimate.lines.map((line) => (
                    <tr key={line.id} className="border-b border-border/60">
                      <td className="py-2">{line.description}</td>
                      <td className="py-2 text-muted-foreground">{line.kind}</td>
                      <td className="py-2 text-right">{(line.quantityMilli / 1000).toFixed(1)}</td>
                      <td className="py-2 text-right">{formatPaise(line.lineTotalPaise)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3} className="py-2 text-right text-muted-foreground">
                      Subtotal
                    </td>
                    <td className="py-2 text-right">{formatPaise(estimate.subtotalPaise)}</td>
                  </tr>
                  <tr>
                    <td colSpan={3} className="py-1 text-right text-muted-foreground">
                      Tax
                    </td>
                    <td className="py-1 text-right">{formatPaise(estimate.taxPaise)}</td>
                  </tr>
                  <tr>
                    <td colSpan={3} className="py-1 text-right font-semibold">
                      Total
                    </td>
                    <td className="py-1 text-right font-semibold">
                      {formatPaise(estimate.totalPaise)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </CardContent>
        </Card>
      ))}

      <Card>
        <CardHeader>
          <CardTitle>Audit trail</CardTitle>
        </CardHeader>
        <CardContent>
          <ol data-testid="audit-trail" className="space-y-2">
            {card.auditTrail.map((entry) => (
              <li key={entry.id} className="rounded-md border border-border p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{entry.action}</span>
                  <span className="text-xs text-muted-foreground">
                    #{entry.seq} · {new Date(entry.createdAt).toLocaleString('en-IN')}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {entry.actorType}
                  {entry.actorId === null ? '' : ` · ${entry.actorId.slice(0, 8)}`}
                </p>
                <pre className="mt-2 overflow-x-auto rounded bg-muted p-2 text-xs">
                  {JSON.stringify(entry.payload, null, 2)}
                </pre>
                <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                  hash {entry.hash.slice(0, 16)}…
                </p>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
