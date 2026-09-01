'use client';

import { RecomputeResultSchema, type RecomputeResult } from '@serviceloop/shared';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/primitives';

/**
 * "Check these numbers" (phase 6.9).
 *
 * Owner-only, and the point of it is the *result*, not the action. A rollup is
 * a derived value with exactly one right answer, so re-folding a fortnight from
 * the event log should change nothing — and when it changes something, that is
 * the alarm. So the button reports the changed-day count in plain words rather
 * than flashing a success toast, and a change is drawn as a warning even though
 * the operation succeeded.
 *
 * This is the console half of the audit story the "₹ recovered" claim rests on:
 * an owner who does not believe a number can make the system derive it again in
 * front of them.
 */
export function RecomputeButton({
  from,
  to,
}: {
  readonly from: string;
  readonly to: string;
}): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RecomputeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(): Promise<void> {
    setBusy(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch('/api/analytics/recompute', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from, to }),
      });

      if (!response.ok) {
        const problem = (await response.json()) as { detail?: string };
        setError(problem.detail ?? 'The recompute could not be run.');
        return;
      }

      const parsed = RecomputeResultSchema.parse(await response.json());
      setResult(parsed);
      // A changed day means the page above is now showing stale numbers.
      if (parsed.changedDays > 0) router.refresh();
    } catch {
      setError('Could not reach the API.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        disabled={busy}
        onClick={() => void run()}
        data-testid="analytics-recompute"
      >
        {busy ? 'Re-folding…' : 'Check these numbers'}
      </Button>

      {result !== null && (
        <span
          data-testid="analytics-recompute-result"
          className={
            result.changedDays === 0
              ? 'text-xs text-muted-foreground'
              : 'text-xs font-medium text-amber-700 dark:text-amber-400'
          }
        >
          {result.changedDays === 0
            ? `${result.days} day(s) re-folded from the event log — every number reproduced exactly${
                result.filledDays === 0 ? '' : ` (${result.filledDays} folded for the first time)`
              }.`
            : `${result.changedDays} of ${result.days} day(s) produced different numbers and have been corrected.`}
        </span>
      )}

      {error !== null && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
