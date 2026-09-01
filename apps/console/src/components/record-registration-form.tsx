'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button, Input, Select } from '@/components/ui/primitives';

/**
 * Recording what Meta decided about one template variant (phase 7.3).
 *
 * It records; it does not submit. Submission happens in the Business Manager,
 * by a person, against a legal entity — a button here that appeared to do it
 * would either be a lie or would require this service to hold a credential it
 * has no business holding. So the honest shape is a form that says "this is
 * what happened over there", and the screen is a record rather than a remote
 * control.
 *
 * Owner-only for the same reason. An advisor marking a template `APPROVED`
 * because they believe it ought to be turns a compliance record into an
 * opinion, and the next person to read it has no way to tell which it was.
 */
export function RecordRegistrationForm({
  templateKey,
}: {
  readonly templateKey: string;
}): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [language, setLanguage] = useState('en');
  const [status, setStatus] = useState('PENDING');
  const [providerTemplateId, setProviderTemplateId] = useState('');
  const [rejectionReason, setRejectionReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const response = await fetch('/api/ops/templates/registrations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          templateKey,
          language,
          status,
          providerTemplateId: providerTemplateId.trim() === '' ? null : providerTemplateId.trim(),
          // Only ever sent with a rejection. The API clears it on any other
          // status anyway — a stale refusal beside a PENDING badge reads as
          // "rejected again" to everyone who sees it.
          rejectionReason:
            status === 'REJECTED' && rejectionReason.trim() !== '' ? rejectionReason.trim() : null,
        }),
      });

      if (!response.ok) {
        const problem = (await response.json()) as { detail?: string };
        setError(problem.detail ?? 'Could not record that.');
        return;
      }

      setOpen(false);
      setProviderTemplateId('');
      setRejectionReason('');
      router.refresh();
    } catch {
      setError('Could not reach the API.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button
        type="button"
        variant="ghost"
        onClick={() => setOpen(true)}
        data-testid={`template-record-${templateKey}`}
      >
        Record what Meta said
      </Button>
    );
  }

  return (
    <form
      className="space-y-2 rounded-md border border-border p-3"
      onSubmit={(event) => void submit(event)}
    >
      <div className="grid gap-2 sm:grid-cols-3">
        <Select
          aria-label="Language variant"
          value={language}
          onChange={(event) => setLanguage(event.target.value)}
        >
          <option value="en">English</option>
          <option value="ta">Tamil</option>
          <option value="hi">Hindi</option>
        </Select>

        <Select
          aria-label="Status"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="PENDING">Submitted, awaiting review</option>
          <option value="APPROVED">Approved</option>
          <option value="REJECTED">Rejected</option>
          <option value="PAUSED">Paused</option>
          <option value="DISABLED">Disabled</option>
        </Select>

        <Input
          aria-label="Meta template id"
          value={providerTemplateId}
          onChange={(event) => setProviderTemplateId(event.target.value)}
          placeholder="Meta template id"
        />
      </div>

      {status === 'REJECTED' && (
        <Input
          aria-label="Rejection reason"
          value={rejectionReason}
          onChange={(event) => setRejectionReason(event.target.value)}
          // Verbatim, because Meta's categories are coarse and the useful
          // detail is in the prose an operator can search a forum for.
          placeholder="Paste Meta's reason exactly as they gave it"
        />
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? 'Recording…' : 'Record'}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>

      {error !== null && <p className="text-xs text-destructive">{error}</p>}
    </form>
  );
}
