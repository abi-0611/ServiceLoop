import {
  DeliverySummarySchema,
  EtaHistorySchema,
  formatPaise,
  JobCardDetailSchema,
  NextVisitPromptListSchema,
  SessionSchema,
} from '@serviceloop/shared';
import { ArrowLeft, Car, Phone, User } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DeliveryPanel } from '@/components/delivery-panel';
import { EtaHistory } from '@/components/eta-history';
import { TransitionActions } from '@/components/transition-actions';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/primitives';
import { ApiError, serverApiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Card drawer: work items, estimate lines, the ETA history and the audit trail
 * — what an advisor needs to answer "what did we tell the customer, and when".
 *
 * Phase 4 added the two panels at the end of the loop. They are on this page
 * rather than a screen of their own because the question "is it ready and has
 * he paid?" is asked about *a car*, and an advisor who had to leave the card to
 * answer it would be holding two screens with a customer in front of them.
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

  // Phase-4 reads, and a card that predates them is not an error: a shop that
  // upgraded mid-repair has cards with no ETA history and no invoice, and the
  // drawer should render them rather than 500.
  const [eta, delivery, nextVisit, role] = await Promise.all([
    optional(() => serverApiFetch(`/status/eta?jobCardId=${id}`, EtaHistorySchema)),
    optional(() => serverApiFetch(`/delivery/summary?jobCardId=${id}`, DeliverySummarySchema)),
    // Phase 6.2: work this customer deferred on an earlier visit. Read here
    // rather than folded into the card DTO because it is a different question
    // about a different aggregate, and a shop with retention switched off
    // should not pay for the join on every card open.
    optional(() =>
      serverApiFetch(`/retention/next-visit/${id}`, NextVisitPromptListSchema),
    ),
    currentRole(),
  ]);

  return (
    <div className="space-y-6">
      <div className="animate-enter">
        <Link
          href="/board"
          className="group inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft
            className="size-4 transition-transform duration-200 ease-swift group-hover:-translate-x-0.5"
            aria-hidden="true"
          />
          Back to board
        </Link>

        {/* The identifying block. The plate is the largest thing on it because
            it is what somebody standing at the bay is reading off the car. */}
        <div className="relative mt-3 overflow-hidden rounded-md border border-border bg-card p-5 shadow-sm">
          <span
            aria-hidden="true"
            className={cn(
              'absolute inset-x-0 top-0 h-1 bg-gradient-to-r',
              `rail-${card.state}`,
            )}
          />

          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="font-mono text-xl font-semibold tracking-tight">{card.code}</h1>
            <span
              data-testid="card-state"
              className={cn(
                'rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset',
                `state-${card.state}`,
              )}
            >
              {card.state}
            </span>
            <Badge tone="neutral">{card.source.replace('_', ' ').toLowerCase()}</Badge>
          </div>

          <dl className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-3">
            <Fact icon={<Car />} label="Vehicle">
              <span className="font-mono tracking-wide">{card.vehicle.registrationDisplay}</span>
              <span className="block text-xs text-muted-foreground">
                {[card.vehicle.make, card.vehicle.model].filter(Boolean).join(' ') || '—'}
              </span>
            </Fact>
            <Fact icon={<User />} label="Customer">
              {card.customer.fullName}
            </Fact>
            <Fact icon={<Phone />} label="Phone">
              <span className="font-mono">{card.customer.phoneMasked}</span>
            </Fact>
          </dl>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Customer complaint</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm">{card.complaintText ?? 'None recorded.'}</p>
        </CardContent>
      </Card>

      {nextVisit !== null && nextVisit.prompts.length > 0 && (
        <Card data-testid="next-visit-prompt" className="animate-enter border-amber-400/60 bg-amber-50/40 dark:border-amber-400/30 dark:bg-amber-500/5">
          <CardHeader>
            <CardTitle>While it&rsquo;s here</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {card.customer.fullName} deferred this work on an earlier visit. The car is on the
              floor now — the cheapest moment there will ever be to do it.
            </p>
            {nextVisit.prompts.map((prompt) => (
              <div key={prompt.ledgerItemId} className="rounded-md border border-border bg-background p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">{prompt.title}</p>
                  <span className="text-sm tabular-nums">{formatPaise(prompt.amountPaise)}</span>
                </div>
                {prompt.technicianNote !== null && (
                  <p className="mt-1 text-xs italic text-muted-foreground">
                    &ldquo;{prompt.technicianNote}&rdquo;
                  </p>
                )}
                <p className="mt-1 text-xs text-muted-foreground">
                  declined {new Date(prompt.declinedAt).toLocaleDateString()} ·{' '}
                  {prompt.declineReason.replace(/_/g, ' ')}
                  {prompt.repitchCount > 0 && ` · raised again ${prompt.repitchCount}×`}
                </p>
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              Add it as a work item on this card if the customer agrees. Approving it here is what
              records the recovery against the original decline.
            </p>
          </CardContent>
        </Card>
      )}

      <TransitionActions jobCardId={card.id} allowedEvents={card.allowedEvents} />

      {eta !== null && <EtaHistory history={eta} />}

      {delivery !== null && (
        <DeliveryPanel
          jobCardId={card.id}
          summary={delivery}
          canOverride={role === 'OWNER'}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle>Work items</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {card.workItems.length === 0 && (
            <p className="text-sm text-muted-foreground">None yet.</p>
          )}
          {card.workItems.map((item, index) => (
            <div
              key={item.id}
              className="animate-enter-fast rounded-lg border border-border p-3 transition-colors duration-200 hover:border-primary/25 hover:bg-accent/30"
              style={{ '--i': index } as React.CSSProperties}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium">{item.title}</p>
                <Badge tone={item.state === 'PENDING_APPROVAL' ? 'warn' : 'neutral'}>
                  {item.state}
                </Badge>
              </div>
              {item.description !== null && (
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                  {item.description}
                </p>
              )}
              {item.technicianNote !== null && (
                // Quoted rather than boxed: this is the evidence a claim to the
                // customer has to be anchored to, and it is somebody's words.
                <p className="mt-2 border-l-2 border-primary/40 bg-muted/60 py-1.5 pl-3 pr-2 text-xs leading-relaxed">
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
            <div className="-mx-4 overflow-x-auto px-4">
              <table className="w-full min-w-[32rem] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                    <th className="py-2.5 pr-3 font-semibold">Description</th>
                    <th className="py-2.5 pr-3 font-semibold">Kind</th>
                    <th className="py-2.5 pr-3 text-right font-semibold">Qty</th>
                    <th className="py-2.5 text-right font-semibold">Line total</th>
                  </tr>
                </thead>
                <tbody>
                  {estimate.lines.map((line) => (
                    <tr
                      key={line.id}
                      className="border-b border-border/60 transition-colors duration-150 hover:bg-accent/50"
                    >
                      <td className="py-2.5 pr-3">{line.description}</td>
                      <td className="py-2.5 pr-3 text-xs uppercase tracking-wide text-muted-foreground">
                        {line.kind}
                      </td>
                      <td className="py-2.5 pr-3 text-right tabular-nums">
                        {(line.quantityMilli / 1000).toFixed(1)}
                      </td>
                      <td className="py-2.5 text-right tabular-nums">
                        {formatPaise(line.lineTotalPaise)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="text-sm">
                  <tr>
                    <td colSpan={3} className="pt-3 text-right text-muted-foreground">
                      Subtotal
                    </td>
                    <td className="pt-3 text-right tabular-nums">
                      {formatPaise(estimate.subtotalPaise)}
                    </td>
                  </tr>
                  <tr>
                    <td colSpan={3} className="py-1 text-right text-muted-foreground">
                      Tax
                    </td>
                    <td className="py-1 text-right tabular-nums">
                      {formatPaise(estimate.taxPaise)}
                    </td>
                  </tr>
                  <tr className="border-t border-border">
                    <td colSpan={3} className="pt-2 text-right font-semibold">
                      Total
                    </td>
                    <td className="pt-2 text-right text-base font-semibold tabular-nums">
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
          {/* A hash-chained log is a sequence, so it is drawn as one. The rail
              and the nodes are the shape of the chain; the payload stays folded
              away in a <details> because nobody reads JSON until the moment
              they need to, and unfolded it buries the sequence it belongs to. */}
          <ol data-testid="audit-trail" className="relative space-y-0">
            <span
              aria-hidden="true"
              className="absolute bottom-2 left-[7px] top-2 w-px bg-border"
            />
            {card.auditTrail.map((entry, index) => (
              <li
                key={entry.id}
                className="animate-enter-fast relative pb-5 pl-7 last:pb-0"
                style={{ '--i': index } as React.CSSProperties}
              >
                <span
                  aria-hidden="true"
                  className="absolute left-0 top-1 size-[15px] rounded-full border-2 border-card bg-primary/70 ring-1 ring-border"
                />

                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="text-sm font-medium">{entry.action}</span>
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">
                    #{entry.seq} · {new Date(entry.createdAt).toLocaleString('en-IN')}
                  </span>
                </div>

                <p className="mt-0.5 text-xs text-muted-foreground">
                  {entry.actorType}
                  {entry.actorId === null ? '' : ` · ${entry.actorId.slice(0, 8)}`}
                  <span className="ml-2 font-mono text-[10px] opacity-70">
                    hash {entry.hash.slice(0, 16)}…
                  </span>
                </p>

                <details className="group mt-2">
                  <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
                    <span className="transition-transform duration-200 ease-swift group-open:rotate-90">
                      ›
                    </span>
                    Payload
                  </summary>
                  <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-2.5 font-mono text-xs leading-relaxed">
                    {JSON.stringify(entry.payload, null, 2)}
                  </pre>
                </details>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}

/** One labelled fact in the card's identifying block. */
function Fact({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-2.5">
      <span
        aria-hidden="true"
        className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-3.5"
      >
        {icon}
      </span>
      <div className="min-w-0">
        <dt className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">{label}</dt>
        <dd className="mt-0.5 truncate text-sm font-medium">{children}</dd>
      </div>
    </div>
  );
}

/**
 * A read the drawer can live without.
 *
 * Swallows 404 and 403 only. Anything else is a real failure and is allowed to
 * surface, because a drawer that quietly hid a broken API would have an advisor
 * telling a customer there is no invoice when there is one.
 */
async function optional<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) return null;
    throw error;
  }
}

/** Only an owner may release a vehicle with a balance outstanding. */
async function currentRole(): Promise<string | null> {
  try {
    const me = await serverApiFetch('/auth/me', SessionSchema.shape.staff);
    return me.role;
  } catch {
    return null;
  }
}
