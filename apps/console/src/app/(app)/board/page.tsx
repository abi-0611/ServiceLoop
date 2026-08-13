import { BoardResponseSchema, formatPaise, JOB_CARD_STATES } from '@serviceloop/shared';
import Link from 'next/link';
import { Badge, Card, EmptyState } from '@/components/ui/primitives';
import { serverApiFetch } from '@/lib/api';

/**
 * Job Card Board — kanban by state.
 *
 * Cards are deliberately **not** draggable. State changes happen only through
 * domain events (`JobCardTransitionService`), so the board reflects state; it
 * never sets it. The drawer offers the transitions the guards actually allow.
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

export default async function BoardPage(): Promise<React.JSX.Element> {
  const board = await serverApiFetch('/jobcards/board', BoardResponseSchema);
  const columns = board.columns.filter((column) => column.cards.length > 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Job card board</h1>
          <p className="text-sm text-muted-foreground">
            {board.totalCards} open visit{board.totalCards === 1 ? '' : 's'} · states change through
            domain events, not by dragging
          </p>
        </div>
      </div>

      {board.totalCards === 0 ? (
        <EmptyState
          title="No job cards yet"
          description="Run `pnpm db:seed` to load the demo workshop, or create a card from a photographed paper job card once channel intake lands."
        />
      ) : (
        <div
          data-testid="board"
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        >
          {columns.map((column) => (
            <section
              key={column.state}
              data-testid={`column-${column.state}`}
              aria-label={HUMAN_STATE[column.state] ?? column.state}
              className="space-y-3"
            >
              <header className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">
                  {HUMAN_STATE[column.state] ?? column.state}
                </h2>
                <span className="text-xs text-muted-foreground">{column.cards.length}</span>
              </header>

              <ul className="space-y-3">
                {column.cards.map((card) => (
                  <li key={card.id}>
                    <Link href={`/board/${card.id}`} className="block focus:outline-none">
                      <Card
                        data-testid="job-card"
                        draggable={false}
                        className="p-4 transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="text-sm font-semibold">
                              {card.vehicle.registrationDisplay}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {[card.vehicle.make, card.vehicle.model].filter(Boolean).join(' ')}
                            </p>
                          </div>
                          <span
                            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset state-${card.state}`}
                          >
                            {card.code}
                          </span>
                        </div>

                        <p className="mt-3 line-clamp-2 text-sm">{card.complaintText ?? '—'}</p>

                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <Badge tone="neutral">{card.customer.fullName}</Badge>
                          {card.workItemCounts.pendingApproval > 0 && (
                            <Badge tone="warn">
                              {card.workItemCounts.pendingApproval} awaiting approval
                            </Badge>
                          )}
                          {card.estimateTotalPaise !== null && (
                            <Badge tone="info">{formatPaise(card.estimateTotalPaise)}</Badge>
                          )}
                        </div>
                      </Card>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Columns shown: {columns.length} of {JOB_CARD_STATES.length} states.
      </p>
    </div>
  );
}
