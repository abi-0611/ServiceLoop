'use client';

import { StatusSignalDecisionSchema, type PendingStatusSignalDto } from '@serviceloop/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge, Button, Card } from '@/components/ui/primitives';

/**
 * One technician note the parser would not apply on its own (phase 4.2).
 *
 * The design follows from what an advisor is actually being asked. It is not
 * "review this signal" — it is *"did Suresh mean brake pads DONE on
 * TN09BX4432?"*, and that question has a yes, a no, and occasionally a "he
 * meant the other car". So the transcript is the headline, the reading sits
 * under it as a sentence rather than a field list, and the answer is one tap.
 *
 * When the parser could not choose between two cards the tap *is* the choice:
 * each candidate gets its own button, because "confirm" with a separate car
 * picker is two decisions where the advisor only has one.
 */

const SIGNAL_COPY: Record<PendingStatusSignalDto['signalType'], string> = {
  progress: 'work under way',
  blocked_parts: 'waiting for a part',
  done: 'finished',
  issue_found: 'something new found',
};

export function StatusSignalCard({
  signal,
}: {
  signal: PendingStatusSignalDto;
}): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(action: 'confirm' | 'discard', jobCardId?: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(`/api/status/signals/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          signalId: signal.signalId,
          ...(jobCardId === undefined ? {} : { jobCardId }),
        }),
      });

      if (!response.ok) {
        const problem = (await response.json()) as { detail?: string };
        setError(problem.detail ?? 'The decision could not be recorded.');
        return;
      }

      const outcome = StatusSignalDecisionSchema.parse(await response.json());

      // A confirmed signal whose transition was illegal from the card's current
      // state is not an error — the technician told the shop something true
      // about the world and nothing true about what the card may do next — so
      // the service's own sentence is shown rather than swallowed.
      if (outcome.alreadyActioned === true) {
        setError('Someone else has already answered this one.');
      }

      router.refresh();
    } catch {
      setError('Could not reach the API.');
    } finally {
      setBusy(false);
    }
  }

  const ambiguous = signal.candidates.length > 1;

  return (
    <Card
      className="p-4"
      data-testid="status-signal"
      data-signal-id={signal.signalId}
      data-route={signal.route}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold" data-testid="status-signal-subject">
          {ambiguous
            ? 'Which vehicle?'
            : (signal.card?.registration ?? 'No vehicle identified')}
        </p>
        <div className="flex items-center gap-2">
          <Badge tone={signal.signalType === 'issue_found' ? 'warn' : 'info'}>
            {SIGNAL_COPY[signal.signalType]}
          </Badge>
          <span className="text-xs text-muted-foreground" data-testid="status-confidence">
            {Math.round(signal.confidence * 100)}% sure
          </span>
        </div>
      </div>

      {/* The words being judged. */}
      <p
        className="mt-3 whitespace-pre-wrap rounded-md bg-muted/50 p-3 text-sm"
        data-testid="status-transcript"
      >
        “{signal.transcript}”
      </p>

      <p className="mt-2 text-xs text-muted-foreground">
        {signal.language.toUpperCase()}
        {signal.transcriptConfidence !== null &&
          ` · heard at ${Math.round(signal.transcriptConfidence * 100)}%`}
        {signal.matchBasis !== null && ` · matched by ${signal.matchBasis.toLowerCase()}`}
        {signal.etaHint !== null &&
          ` · says ${new Date(signal.etaHint).toLocaleString('en-IN', {
            hour: '2-digit',
            minute: '2-digit',
            day: 'numeric',
            month: 'short',
          })}`}
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {ambiguous ? (
          signal.candidates.map((candidate) => (
            <Button
              key={candidate.jobCardId}
              onClick={() => void decide('confirm', candidate.jobCardId)}
              disabled={busy}
              data-testid="status-choose-card"
              data-job-card-id={candidate.jobCardId}
            >
              {candidate.registration} · {candidate.vehicle}
            </Button>
          ))
        ) : (
          <Button
            onClick={() => void decide('confirm')}
            disabled={busy || signal.card === null}
            data-testid="status-confirm"
          >
            {busy ? 'Applying…' : 'Yes, apply it'}
          </Button>
        )}

        <Button
          variant="ghost"
          onClick={() => void decide('discard')}
          disabled={busy}
          data-testid="status-discard"
        >
          Discard
        </Button>

        {signal.card !== null && (
          <Link
            href={`/board/${signal.card.jobCardId}`}
            className="ml-auto text-sm text-muted-foreground underline underline-offset-4"
          >
            Open {signal.card.code}
          </Link>
        )}
      </div>

      {signal.card === null && !ambiguous && (
        <p className="mt-3 text-xs text-muted-foreground">
          {/* Recorded even so: "what fraction of technician notes did we
              understand" is a number a shop should be able to see. */}
          Nothing in the workshop matched this note. Discarding it keeps the
          record of what was said.
        </p>
      )}

      {error !== null && (
        <p role="alert" data-testid="status-error" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
    </Card>
  );
}
