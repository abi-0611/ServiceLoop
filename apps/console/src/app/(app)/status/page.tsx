import { PendingStatusSignalListSchema } from '@serviceloop/shared';
import { Activity } from 'lucide-react';
import { EmptyState, PageHeader } from '@/components/ui/primitives';
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
      <PageHeader
        eyebrow="Workshop"
        title="Status signals"
        description="Technician notes that need one tap before they move a job card."
        actions={
          queue.signals.length > 0 ? (
            <span
              data-testid="status-pending-count"
              className="inline-flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900 shadow-xs dark:border-amber-400/35 dark:bg-amber-500/10 dark:text-amber-300"
            >
              <span className="relative flex size-2">
                <span className="ping-dot absolute inset-0 rounded-full opacity-70" />
                <span className="relative size-2 rounded-full bg-current" />
              </span>
              {queue.signals.length} waiting
            </span>
          ) : undefined
        }
      />

      {queue.signals.length === 0 ? (
        <EmptyState
          icon={<Activity />}
          title="Nothing waiting"
          description="Notes the parser is sure about apply themselves. Anything it is unsure of — a fragment, a plate it did not hear, two cars in the running — waits here instead of guessing."
        />
      ) : (
        <ul data-testid="status-queue" className="space-y-4">
          {queue.signals.map((signal, index) => (
            <li
              key={signal.signalId}
              className="animate-enter"
              style={{ '--i': index } as React.CSSProperties}
            >
              <StatusSignalCard signal={signal} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
