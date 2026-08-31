import { PendingStatusSignalListSchema } from '@serviceloop/shared';
import { Badge, EmptyState } from '@/components/ui/primitives';
import { StatusSignalCard } from '@/components/status-signal-card';
import { serverApiFetch } from '@/lib/api';

/**
 * The status confirm queue (phase 4.2).
 *
 * Everything the parser *was* sure about has already happened — the card moved,
 * the customer heard about it, and nobody opened this page. What lands here is
 * the remainder: a note whose words were clear but whose vehicle was not, a
 * fragment, a recogniser that struggled with a compressor running next to the
 * phone.
 *
 * That is why the page is deliberately quiet-by-default rather than a dashboard.
 * A shop whose queue is long has an audio problem or a parser problem, and the
 * honest thing for this screen to do is show exactly how long it is.
 */
export const dynamic = 'force-dynamic';

export default async function StatusPage(): Promise<React.JSX.Element> {
  const queue = await serverApiFetch('/status/signals/pending', PendingStatusSignalListSchema);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Status signals</h1>
          <p className="text-sm text-muted-foreground">
            Technician notes that need one tap before they move a job card.
          </p>
        </div>
        {queue.signals.length > 0 && (
          <Badge tone="warn" data-testid="status-pending-count">
            {queue.signals.length} waiting
          </Badge>
        )}
      </div>

      {queue.signals.length === 0 ? (
        <EmptyState
          title="Nothing waiting"
          description="Notes the parser is sure about apply themselves. Anything it is unsure of — a fragment, a plate it did not hear, two cars in the running — waits here instead of guessing."
        />
      ) : (
        <ul data-testid="status-queue" className="space-y-4">
          {queue.signals.map((signal) => (
            <li key={signal.signalId}>
              <StatusSignalCard signal={signal} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
