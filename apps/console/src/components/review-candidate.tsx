'use client';

import { ReviewDecisionResponseSchema, type ReviewCandidate } from '@serviceloop/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge, Button, Card } from '@/components/ui/primitives';

/**
 * One candidate, and the three things an advisor can do with it.
 *
 * The design decision that matters is that **editing is a first-class action,
 * not a correction of a mistake**. Approve-and-send is one tap; editing opens
 * the same words in a textarea and sends what the advisor actually wants. Both
 * are recorded — before and after, with a diff — because "how often does it get
 * this right without me?" is the only question that decides whether a shop ever
 * leaves shadow mode, and it cannot be answered from a queue that only records
 * approvals.
 *
 * Rejection demands a reason for the same purpose: without one the graduation
 * report cannot tell "the agent was wrong" from "the advisor was busy".
 */
export function ReviewCandidateCard({
  candidate,
}: {
  candidate: ReviewCandidate;
}): React.JSX.Element {
  const router = useRouter();
  const [mode, setMode] = useState<'idle' | 'editing' | 'rejecting'>('idle');
  const [body, setBody] = useState(candidate.body);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(
    action: 'APPROVE_SEND' | 'EDIT_AND_SEND' | 'REJECT',
  ): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(`/api/review/${candidate.messageId}/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action,
          ...(action === 'EDIT_AND_SEND' ? { body: body.trim() } : {}),
          ...(action === 'REJECT' ? { reason: reason.trim() } : {}),
        }),
      });

      if (!response.ok) {
        const problem = (await response.json()) as { detail?: string };
        setError(problem.detail ?? 'The decision could not be recorded.');
        return;
      }

      const outcome = ReviewDecisionResponseSchema.parse(await response.json());

      // A send that the gate then held or blocked is *not* a failure of the
      // review — consent may have been revoked while the candidate waited — so
      // the verdict is shown rather than swallowed, and the queue refreshes
      // either way.
      if (outcome.action === 'SENT' && outcome.status !== 'SENT') {
        setError(`The gate returned ${outcome.status} — see the thread for the reason.`);
      }

      router.refresh();
    } catch {
      setError('Could not reach the API.');
    } finally {
      setBusy(false);
    }
  }

  const edited = body.trim() !== candidate.body.trim();

  return (
    <Card className="p-4" data-testid="review-candidate" data-message-id={candidate.messageId}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold">{candidate.customerLabel}</p>
        <div className="flex items-center gap-2">
          <Badge tone="neutral">{candidate.language}</Badge>
          <span className="text-xs text-muted-foreground" data-testid="review-waited">
            waiting {formatWaited(candidate.waitedMs)}
          </span>
        </div>
      </div>

      {/* The words being judged, given the weight they deserve. */}
      {mode === 'editing' ? (
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={6}
          aria-label="Edit the message before sending"
          data-testid="review-edit-body"
          className="mt-3 w-full rounded-md border border-input bg-background p-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      ) : (
        <p
          className="mt-3 whitespace-pre-wrap rounded-md bg-muted/50 p-3 text-sm"
          data-testid="review-body"
        >
          {candidate.body}
        </p>
      )}

      {candidate.checkerReasons.length > 0 && (
        <ul className="mt-3 space-y-1" data-testid="review-checker-reasons">
          {candidate.checkerReasons.map((detail) => (
            <li key={detail} className="text-xs text-amber-900">
              ⚠ {detail}
            </li>
          ))}
        </ul>
      )}

      {candidate.evidenceRefs.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          cites {candidate.evidenceRefs.join(', ')}
        </p>
      )}

      {mode === 'rejecting' && (
        <div className="mt-3">
          <label htmlFor={`reason-${candidate.messageId}`} className="text-sm font-medium">
            Why are you rejecting this?
          </label>
          <input
            id={`reason-${candidate.messageId}`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="It named a part the technician never mentioned"
            data-testid="review-reject-reason"
            className="mt-1 flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            The reason is what lets the graduation report tell a bad draft from a busy afternoon.
          </p>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {mode === 'idle' && (
          <>
            <Button
              onClick={() => void decide('APPROVE_SEND')}
              disabled={busy}
              data-testid="review-approve"
            >
              {busy ? 'Sending…' : 'Approve & send'}
            </Button>
            <Button variant="outline" onClick={() => setMode('editing')} data-testid="review-edit">
              Edit
            </Button>
            <Button
              variant="ghost"
              onClick={() => setMode('rejecting')}
              data-testid="review-reject"
            >
              Reject
            </Button>
          </>
        )}

        {mode === 'editing' && (
          <>
            <Button
              onClick={() => void decide('EDIT_AND_SEND')}
              disabled={busy || body.trim().length === 0}
              data-testid="review-send-edited"
            >
              {busy ? 'Sending…' : edited ? 'Send edited' : 'Send unchanged'}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setBody(candidate.body);
                setMode('idle');
              }}
              disabled={busy}
            >
              Cancel
            </Button>
          </>
        )}

        {mode === 'rejecting' && (
          <>
            <Button
              variant="destructive"
              onClick={() => void decide('REJECT')}
              disabled={busy || reason.trim().length === 0}
              data-testid="review-confirm-reject"
            >
              {busy ? 'Rejecting…' : 'Reject'}
            </Button>
            <Button variant="ghost" onClick={() => setMode('idle')} disabled={busy}>
              Cancel
            </Button>
          </>
        )}

        <Link
          href={`/conversations/${candidate.conversationId}`}
          className="ml-auto text-sm text-muted-foreground underline underline-offset-4"
        >
          Open thread
        </Link>
      </div>

      {error !== null && (
        <p role="alert" data-testid="review-error" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
    </Card>
  );
}

/** Waiting time, in the units a person actually thinks in. */
function formatWaited(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
}
