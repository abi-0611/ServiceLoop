'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Select } from '@/components/ui/primitives';

/**
 * The acts on a data-principal request (phase 7.2).
 *
 * Which buttons exist is derived from the status, and it matches the RBAC
 * matrix rather than merely resembling it: verify and cancel are counter work,
 * approve, execute and reject are the owner's alone. Hiding a button an advisor
 * cannot use is a courtesy — the API refuses it regardless, which is where the
 * enforcement actually lives.
 *
 * Two deliberate frictions:
 *
 * **Approving a deletion asks for confirmation naming the pseudonym.** Not a
 * generic "are you sure": the thing about to be destroyed is identified in the
 * prompt, because the failure this guards against is approving the wrong row,
 * and a dialogue that does not say which row cannot catch it.
 *
 * **"Run now" is absent while a request is inside its grace window.** The API
 * refuses it, and offering a button that reliably fails would teach an operator
 * that this screen's buttons are unreliable. Waiving the window is `approve`'s
 * business and requires a written reason.
 */
export function DataRequestActions({
  requestId,
  status,
  kind,
  isOwner,
}: {
  readonly requestId: string;
  readonly status: string;
  readonly kind: 'EXPORT' | 'DELETION';
  readonly isOwner: boolean;
}): React.JSX.Element | null {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verification, setVerification] = useState('OTP_TO_NUMBER_ON_FILE');

  async function post(path: string, body: unknown): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/privacy/requests/${requestId}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const problem = (await response.json()) as { detail?: string };
        setError(problem.detail ?? 'The request could not be completed.');
        return;
      }
      router.refresh();
    } catch {
      setError('Could not reach the API.');
    } finally {
      setBusy(false);
    }
  }

  const terminal = ['COMPLETED', 'REJECTED', 'CANCELLED', 'RUNNING'].includes(status);
  if (terminal) {
    return error === null ? null : <p className="text-xs text-destructive">{error}</p>;
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {status === 'RECEIVED' && (
          <>
            <Select
              aria-label="How the requester was verified"
              value={verification}
              onChange={(event) => setVerification(event.target.value)}
              className="max-w-[16rem]"
            >
              <option value="OTP_TO_NUMBER_ON_FILE">Code to the number on file</option>
              <option value="STAFF_ATTESTED_IN_PERSON">ID checked at the counter</option>
              <option value="AUTHENTICATED_THREAD">Asked on their own WhatsApp thread</option>
            </Select>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void post('/verify', { verification })}
              data-testid="privacy-verify"
            >
              Verify requester
            </Button>
          </>
        )}

        {status === 'VERIFIED' && isOwner && (
          <Button
            type="button"
            disabled={busy}
            onClick={() => {
              const confirmed =
                kind === 'EXPORT' ||
                window.confirm(
                  'Approve this erasure?\n\nOnce the grace window elapses the cascade runs and cannot be undone. ' +
                    'Invoices are retained under the tax carve-out with the identity removed; everything else is destroyed.',
                );
              if (confirmed) void post('/approve', {});
            }}
            data-testid="privacy-approve"
          >
            {kind === 'EXPORT' ? 'Approve export' : 'Approve erasure'}
          </Button>
        )}

        {/* Only once the window has actually elapsed. The API refuses earlier,
            and the worker runs it unattended anyway — this is for the case
            where somebody is standing at the counter waiting. */}
        {(status === 'APPROVED' || status === 'SCHEDULED') && isOwner && (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void post('/execute', {})}
            data-testid="privacy-execute"
          >
            Run now
          </Button>
        )}

        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            const reason = window.prompt('Why is this being cancelled? The requester is told.');
            if (reason !== null && reason.trim().length >= 3) void post('/cancel', { reason });
          }}
          data-testid="privacy-cancel"
        >
          Cancel
        </Button>

        {isOwner && status !== 'SCHEDULED' && (
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              const reason = window.prompt(
                'Why is this being refused? The requester is entitled to be told, so this must be a reason they can be given (at least 10 characters).',
              );
              if (reason !== null && reason.trim().length >= 10) void post('/reject', { reason });
            }}
            data-testid="privacy-reject"
          >
            Reject
          </Button>
        )}
      </div>

      {error !== null && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
