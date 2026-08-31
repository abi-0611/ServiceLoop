'use client';

import {
  ConfirmDraftResponseSchema,
  IntakeDraftDetailSchema,
  type IntakeDraftDetail,
} from '@serviceloop/shared';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge, Button, Card, Input } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

/**
 * The staff confirmation screen (phase 2.6).
 *
 * The design rule that matters here: the human's attention is the scarce
 * resource, so the fields the extractor was unsure about are marked, sorted to
 * where the eye lands, and editable in place. A field a person corrects jumps to
 * confidence 1 and its previous value is recorded — that pairing is what lets
 * the OCR eval learn from exactly what the model got wrong.
 *
 * Nothing here writes a job card. `Confirm` calls the same `IntakeService` a
 * WhatsApp Confirm tap does, so both paths produce the same audit trail.
 */
export function DraftReview({ initial }: { initial: IntakeDraftDetail }): React.JSX.Element {
  const router = useRouter();
  const [draft, setDraft] = useState(initial);
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ code: string; jobCardId: string } | null>(null);

  const settled = draft.status !== 'AWAITING_CONFIRMATION';

  async function correct(path: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/intake/drafts/${draft.id}/corrections`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path, value }),
      });
      if (!response.ok) {
        const problem = (await response.json()) as { detail?: string };
        setError(problem.detail ?? 'That correction was refused.');
        return;
      }
      setDraft(IntakeDraftDetailSchema.parse(await response.json()));
      setEditing(null);
      setValue('');
    } catch {
      setError('Could not reach the API.');
    } finally {
      setBusy(false);
    }
  }

  async function settle(action: 'confirm' | 'discard'): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/intake/drafts/${draft.id}/${action}`, { method: 'POST' });
      if (!response.ok) {
        const problem = (await response.json()) as { detail?: string };
        setError(problem.detail ?? `The draft could not be ${action}ed.`);
        return;
      }

      if (action === 'confirm') {
        const confirmed = ConfirmDraftResponseSchema.parse(await response.json());
        setResult({ code: confirmed.code, jobCardId: confirmed.jobCardId });
        if (confirmed.openFailure !== null) setError(confirmed.openFailure);
      }
      router.refresh();
    } catch {
      setError('Could not reach the API.');
    } finally {
      setBusy(false);
    }
  }

  if (result !== null) {
    return (
      <Card className="space-y-3 border-emerald-300 bg-emerald-50 p-4">
        <p className="text-sm font-semibold text-emerald-900" data-testid="confirm-result">
          Job card {result.code} created.
        </p>
        <Button asChild size="sm">
          <a href={`/board/${result.jobCardId}`}>Open the card</a>
        </Button>
        {error !== null && <p className="text-sm text-destructive">{error}</p>}
      </Card>
    );
  }

  const uncertain = draft.fields.filter((field) => field.uncertain);
  const confident = draft.fields.filter((field) => !field.uncertain);

  return (
    <div className="space-y-4">
      {uncertain.length > 0 && (
        <Card className="border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          {uncertain.length} field{uncertain.length === 1 ? '' : 's'} below the shop&apos;s{' '}
          {Math.round(draft.confirmationThreshold * 100)}% confidence threshold. Check these first.
        </Card>
      )}

      <Card className="divide-y divide-border" data-testid="draft-fields">
        {[...uncertain, ...confident].map((field) => (
          <div key={field.path} className="flex flex-wrap items-center gap-3 p-3">
            <div className="w-32 shrink-0 text-xs font-medium text-muted-foreground">
              {field.index}. {field.label}
            </div>

            {editing === field.path ? (
              <form
                className="flex flex-1 flex-wrap items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void correct(field.path);
                }}
              >
                <Input
                  autoFocus
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  aria-label={`Correct ${field.label}`}
                  data-testid={`edit-${field.path}`}
                  className="max-w-xs"
                />
                <Button size="sm" type="submit" disabled={busy}>
                  Save
                </Button>
                <Button
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={() => setEditing(null)}
                  disabled={busy}
                >
                  Cancel
                </Button>
              </form>
            ) : (
              <>
                <span
                  className={cn('flex-1 text-sm', field.uncertain && 'font-medium text-amber-900')}
                  data-testid={`value-${field.path}`}
                >
                  {field.uncertain && <span aria-label="uncertain">⚠ </span>}
                  {field.value}
                </span>

                <Badge tone={field.uncertain ? 'warn' : 'neutral'}>
                  {Math.round(field.confidence * 100)}%
                </Badge>

                {!settled && (
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid={`correct-${field.path}`}
                    onClick={() => {
                      setEditing(field.path);
                      setValue(field.value === '—' ? '' : field.value);
                    }}
                  >
                    Correct
                  </Button>
                )}
              </>
            )}
          </div>
        ))}
      </Card>

      {draft.corrections.length > 0 && (
        <Card className="p-3 text-xs text-muted-foreground">
          <p className="mb-1 font-semibold text-foreground">Corrections applied</p>
          <ul className="space-y-0.5">
            {draft.corrections.map((correction, index) => (
              <li key={`${correction.path}-${index}`}>
                {correction.path}: “{correction.previousValue}” → “{correction.value}”
              </li>
            ))}
          </ul>
        </Card>
      )}

      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {!settled && (
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} data-testid="confirm-draft" onClick={() => void settle('confirm')}>
            {busy ? 'Working…' : 'Confirm and create the job card'}
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            data-testid="discard-draft"
            onClick={() => void settle('discard')}
          >
            Discard
          </Button>
        </div>
      )}
    </div>
  );
}
