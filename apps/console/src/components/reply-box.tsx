'use client';

import { SendOutcomeSchema } from '@serviceloop/shared';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Input } from '@/components/ui/primitives';

/**
 * The advisor's reply box.
 *
 * It posts through `OutboundGate` like everything else. A human typing here
 * skips the *autonomy* check — a person has taken responsibility for the words —
 * but not consent, not the 24-hour window, not quiet hours and not the
 * frequency cap. When the gate refuses, the reason is shown here rather than
 * swallowed, because "opted out" and "window closed, send a template" call for
 * completely different next actions.
 */
export function ReplyBox({
  conversationId,
  windowOpen,
}: {
  conversationId: string;
  windowOpen: boolean;
}): React.JSX.Element {
  const router = useRouter();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);

  async function send(): Promise<void> {
    const trimmed = body.trim();
    if (trimmed.length === 0 || busy) return;

    setBusy(true);
    setNotice(null);

    try {
      const response = await fetch(`/api/conversations/${conversationId}/reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: trimmed }),
      });

      if (!response.ok) {
        const problem = (await response.json()) as { detail?: string };
        setNotice({ tone: 'error', text: problem.detail ?? 'The reply could not be sent.' });
        return;
      }

      const outcome = SendOutcomeSchema.parse(await response.json());
      if (outcome.status === 'SENT') {
        setBody('');
        router.refresh();
        return;
      }

      // Every other verdict is shown verbatim: the message exists in the thread
      // with its state, and the advisor is told what happened to it.
      setNotice({
        tone: outcome.status === 'DEFERRED' ? 'info' : 'error',
        text: outcome.reason ?? `The gate returned ${outcome.status}.`,
      });
      setBody('');
      router.refresh();
    } catch {
      setNotice({ tone: 'error', text: 'Could not reach the API.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      {!windowOpen && (
        <p className="rounded-md bg-amber-100 px-3 py-2 text-xs text-amber-900">
          The 24-hour customer-service window is closed on this thread. A free-form reply will be
          refused — send an approved template, or call.
        </p>
      )}

      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <Input
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Reply as an advisor…"
          aria-label="Reply as an advisor"
          data-testid="reply-input"
          disabled={busy}
        />
        <Button type="submit" disabled={busy || body.trim().length === 0} data-testid="reply-send">
          {busy ? 'Sending…' : 'Send'}
        </Button>
      </form>

      {notice !== null && (
        <p
          role="alert"
          data-testid="reply-notice"
          className={
            notice.tone === 'error'
              ? 'text-sm text-destructive'
              : 'text-sm text-muted-foreground'
          }
        >
          {notice.text}
        </p>
      )}
    </div>
  );
}
