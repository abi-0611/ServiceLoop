'use client';

import type { JobCardEvent } from '@serviceloop/shared';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/primitives';

/**
 * The only state-changing control in the console.
 *
 * `allowedEvents` comes from the server, which has already run the transition
 * table *and* the guards — so a button is shown only when the domain would
 * actually accept it. The API re-checks regardless; this is affordance, not
 * enforcement.
 */

const LABELS: Readonly<Record<JobCardEvent, string>> = {
  OPEN_CARD: 'Open the card',
  BEGIN_DIAGNOSIS: 'Begin diagnosis',
  REQUEST_APPROVAL: 'Request customer approval',
  APPROVAL_GRANTED: 'Record approval granted',
  PARTS_AWAITED: 'Waiting on parts',
  PARTS_RECEIVED: 'Parts received',
  WORK_COMPLETED: 'Work completed',
  QUALITY_PASSED: 'Quality check passed',
  PAYMENT_REQUESTED: 'Request payment',
  PAYMENT_SETTLED: 'Payment settled',
  VEHICLE_DELIVERED: 'Vehicle delivered',
  CLOSE: 'Close the job card',
  CANCEL: 'Cancel the job card',
};

export function TransitionActions({
  jobCardId,
  allowedEvents,
}: {
  jobCardId: string;
  allowedEvents: readonly JobCardEvent[];
}): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState<JobCardEvent | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(event: JobCardEvent): Promise<void> {
    setBusy(event);
    setError(null);

    try {
      const response = await fetch(`/api/jobcards/${jobCardId}/transitions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event }),
      });

      if (!response.ok) {
        const problem = (await response.json()) as { detail?: string };
        setError(problem.detail ?? 'That transition was refused.');
        return;
      }
      router.refresh();
    } catch {
      setError('Could not reach the API.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Available transitions</CardTitle>
      </CardHeader>
      <CardContent>
        {allowedEvents.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No transition is available from this state.
          </p>
        ) : (
          <div data-testid="transitions" className="flex flex-wrap gap-2">
            {allowedEvents.map((event) => (
              <Button
                key={event}
                size="sm"
                variant={event === 'CANCEL' ? 'destructive' : 'default'}
                disabled={busy !== null}
                onClick={() => void run(event)}
              >
                {busy === event ? 'Working…' : LABELS[event]}
              </Button>
            ))}
          </div>
        )}

        {error !== null && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
