import { BoardResponseSchema, formatPaise, JOB_CARD_STATES } from '@serviceloop/shared';
import { AlertTriangle, LayoutGrid, User } from 'lucide-react';
import Link from 'next/link';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui/primitives';
import { SpotlightArea } from '@/components/ui/spotlight';
import { Timeline, type TimelineEntry } from '@/components/ui/timeline';
import { spotlightProps } from '@/lib/spotlight';
import { serverApiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Job Card Board — the workshop's states, in the order a car passes through
 * them.
 *
 * Cards are deliberately **not** draggable. State changes happen only through
 * domain events (`JobCardTransitionService`), so the board reflects state; it
 * never sets it. The drawer offers the transitions the guards actually allow.
 *
 * That constraint is the argument for a timeline over a kanban. Columns are the
 * right shape for a board you *rearrange* — they set every lane beside every
 * other as a peer and invite you to move things between them. Nothing here
 * moves by hand, and the states are not peers: they are a sequence a vehicle
 * travels, intake at the top and the gate at the bottom. So the board is drawn
 * as that sequence, with a beam that fills as an advisor scrolls it and each
 * stage carrying its own colour on the node.
 *
 * The practical gain is the width the columns were spending: a card is no
 * longer 19rem wide because eleven other lanes needed room beside it. A stage
 * takes the full page and lays its cards in a grid, so a shop with six cars
 * awaiting approval sees six cards instead of a column to scroll.
 */

export const dynamic = 'force-dynamic';

const HUMAN_STATE: Readonly<Record<string, string>> = {
  DRAFT: 'Draft',
  OPEN: 'Open',
  IN_DIAGNOSIS: 'In diagnosis',
  AWAITING_APPROVAL: 'Awaiting approval',
  IN_PROGRESS: 'In progress',
  AWAITING_PARTS: 'Awaiting parts',
  QUALITY_CHECK: 'Quality check',
  READY_FOR_DELIVERY: 'Ready for delivery',
  AWAITING_PAYMENT: 'Awaiting payment',
  DELIVERED: 'Delivered',
  CLOSED: 'Closed',
  CANCELLED: 'Cancelled',
};

/** Position in the loop, so the timeline reads in the order work happens. */
const ORDER: ReadonlyMap<string, number> = new Map(
  JOB_CARD_STATES.map((state, index) => [state, index]),
);

export default async function BoardPage(): Promise<React.JSX.Element> {
  const board = await serverApiFetch('/jobcards/board', BoardResponseSchema);

  const columns = board.columns
    .filter((column) => column.cards.length > 0)
    // Sorted here rather than trusted from the API: a beam down the side is
    // only honest if the stages are in the order a vehicle passes through them.
    .slice()
    .sort((a, b) => (ORDER.get(a.state) ?? 99) - (ORDER.get(b.state) ?? 99));

  // Counted here rather than in a tile component, so the number and the badges
  // it summarises come from one pass over one payload.
  const awaitingApproval = columns
    .flatMap((column) => column.cards)
    .reduce((sum, card) => sum + card.workItemCounts.pendingApproval, 0);

  const entries: TimelineEntry[] = columns.map((column) => ({
    id: column.state,
    title: HUMAN_STATE[column.state] ?? column.state,
    meta: `${column.cards.length} vehicle${column.cards.length === 1 ? '' : 's'}`,
    markerClassName: `rail-${column.state}`,
    content: (
      // Keyed even though it is one element per entry rather than a list: these
      // are built inside a `.map`, and React validates every element it finds
      // in an array — including the array of entries handed across the server /
      // client boundary — so without it the console warns on every board load.
      <div
        key={column.state}
        data-testid={`column-${column.state}`}
        aria-label={HUMAN_STATE[column.state] ?? column.state}
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
      >
        {column.cards.map((card, index) => (
          <Link
            key={card.id}
            href={`/board/${card.id}`}
            className="block rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <Card
              data-testid="job-card"
              draggable={false}
              {...spotlightProps}
              className="animate-enter-fast spotlight sheen lift h-full overflow-hidden p-4 hover:border-foreground/25 hover:shadow-lg"
              style={{ '--i': Math.min(index, 6) } as React.CSSProperties}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-mono text-sm font-semibold tracking-wide">
                    {card.vehicle.registrationDisplay}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {[card.vehicle.make, card.vehicle.model].filter(Boolean).join(' ') || '—'}
                  </p>
                </div>
                <span
                  className={cn(
                    'shrink-0 rounded-full px-2 py-0.5 font-mono text-[11px] font-medium ring-1 ring-inset',
                    `state-${card.state}`,
                  )}
                >
                  {card.code}
                </span>
              </div>

              <p className="mt-3 line-clamp-2 text-sm leading-relaxed text-foreground/90">
                {card.complaintText ?? '—'}
              </p>

              <div className="mt-3.5 flex flex-wrap items-center gap-1.5 border-t border-border/70 pt-3">
                <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <User className="size-3.5 shrink-0" aria-hidden="true" />
                  <span className="truncate">{card.customer.fullName}</span>
                </span>
                <span className="ml-auto flex flex-wrap items-center gap-1.5">
                  {card.workItemCounts.pendingApproval > 0 && (
                    <Badge tone="warn">
                      {card.workItemCounts.pendingApproval} awaiting approval
                    </Badge>
                  )}
                  {card.estimateTotalPaise !== null && (
                    <Badge tone="brand" className="font-mono">
                      {formatPaise(card.estimateTotalPaise)}
                    </Badge>
                  )}
                </span>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    ),
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Workshop"
        title="Job card board"
        description={
          <>
            {board.totalCards} open visit{board.totalCards === 1 ? '' : 's'}, in the order they move
            through the shop · states change through domain events, not by dragging.
          </>
        }
        actions={
          <>
            <span className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm shadow-xs">
              <LayoutGrid className="size-4 text-muted-foreground" aria-hidden="true" />
              <span className="font-semibold tabular-nums">{columns.length}</span>
              <span className="text-muted-foreground">
                of {JOB_CARD_STATES.length} states in play
              </span>
            </span>
            {awaitingApproval > 0 && (
              <span className="inline-flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 shadow-xs dark:border-amber-400/35 dark:bg-amber-500/10 dark:text-amber-300">
                <AlertTriangle className="size-4" aria-hidden="true" />
                <span className="font-semibold tabular-nums">{awaitingApproval}</span>
                <span>awaiting approval</span>
              </span>
            )}
          </>
        }
      />

      {board.totalCards === 0 ? (
        <EmptyState
          title="No job cards yet"
          description="Run `pnpm db:seed` to load the demo workshop, or create a card from a photographed paper job card once channel intake lands."
        />
      ) : (
        <SpotlightArea data-testid="board">
          <Timeline data={entries} />
        </SpotlightArea>
      )}
    </div>
  );
}
