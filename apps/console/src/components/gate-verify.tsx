'use client';

import { GatePassVerdictSchema, type GatePassVerdict } from '@serviceloop/shared';
import { Ban, Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import { OrbitalLoader } from '@/components/ui/orbital-loader';
import { Button } from '@/components/ui/primitives';

/**
 * The gate person's screen (phase 4.10).
 *
 * Its whole job is to be readable in three seconds on a phone in the rain: one
 * colour for the barrier, one sentence for why, and the vehicle so they can
 * check the car in front of them is the one on the screen.
 *
 * Two ways in, because there are two people at the gate. A **scan** arrives as
 * `?t=<token>` — the customer's QR encodes the token, the gate person's camera
 * app opens this page, and the check runs on load with nothing to type. A
 * **typed code** is the fallback for a dead phone, a cracked screen, or a
 * customer who screenshotted the message and lost the picture.
 *
 * The API answers 200 for a rejected pass, which is why this component has no
 * error state for a red light: a refusal is the answer to the question, not a
 * failure to ask it.
 */
export function GateVerify({ initialToken }: { initialToken: string | null }): React.JSX.Element {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [verdict, setVerdict] = useState<GatePassVerdict | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function verify(body: { token?: string; code?: string }): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const response = await fetch('/api/gate-pass/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const problem = (await response.json()) as { detail?: string };
        setError(problem.detail ?? 'The pass could not be checked.');
        setVerdict(null);
        return;
      }

      setVerdict(GatePassVerdictSchema.parse(await response.json()));
    } catch {
      setError('Could not reach the API.');
      setVerdict(null);
    } finally {
      setBusy(false);
    }
  }

  // A scanned pass checks itself: the gate person is holding a phone in one
  // hand and a barrier remote in the other. Keyed on the token alone, so the
  // check runs once for the token the URL arrived with.
  useEffect(() => {
    if (initialToken === null) return;
    void verify({ token: initialToken });
  }, [initialToken]);

  return (
    <div className="space-y-6">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (code.trim().length > 0) void verify({ code: code.trim().toUpperCase() });
        }}
      >
        <div className="min-w-0 flex-1">
          <label htmlFor="gate-code" className="text-sm font-medium">
            Gate pass code
          </label>
          <input
            id="gate-code"
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            placeholder="7KQ4MP"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            data-testid="gate-code"
            className="mt-1.5 flex h-14 w-full rounded-lg border border-input bg-background px-4 py-2 font-mono text-2xl tracking-[0.3em] shadow-xs transition-[border-color,box-shadow] duration-200 ease-swift placeholder:text-muted-foreground/40 hover:border-muted-foreground/40 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25"
          />
        </div>
        <Button
          type="submit"
          size="lg"
          disabled={busy || code.trim().length === 0}
          data-testid="gate-verify"
        >
          {busy ? (
            <>
              <OrbitalLoader />
              Checking…
            </>
          ) : (
            'Check'
          )}
        </Button>
      </form>

      {error !== null && (
        <p role="alert" data-testid="gate-error" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {verdict !== null && <Verdict verdict={verdict} />}
    </div>
  );
}

function Verdict({ verdict }: { verdict: GatePassVerdict }): React.JSX.Element {
  const allow = verdict.allow;

  return (
    <div
      role="status"
      data-testid="gate-verdict"
      data-allow={allow ? 'true' : 'false'}
      data-result={verdict.result}
      className={`animate-scale-in relative overflow-hidden rounded-md border-2 p-6 shadow-lg ${
        allow
          ? 'border-emerald-500 bg-emerald-50 text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-200'
          : 'border-rose-500 bg-rose-50 text-rose-900 dark:bg-rose-500/10 dark:text-rose-200'
      }`}
    >
      {/* A wash of the verdict's own colour, so the answer registers as a block
          of red or green before a single word has been read. */}
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute -right-20 -top-20 size-56 rounded-full blur-3xl ${
          allow ? 'bg-emerald-500/25' : 'bg-rose-500/25'
        }`}
      />

      <div className="relative flex items-center gap-3">
        <span
          aria-hidden="true"
          className={`flex size-12 shrink-0 items-center justify-center rounded-full ${
            allow ? 'bg-emerald-500/20' : 'bg-rose-500/20'
          }`}
        >
          {allow ? <Check className="size-7" strokeWidth={3} /> : <Ban className="size-7" strokeWidth={2.5} />}
        </span>
        {/* One word, large enough to read from arm's length. */}
        <p
          className="text-3xl font-bold tracking-tight sm:text-4xl"
          data-testid="gate-headline"
        >
          {allow ? 'LET IT OUT' : 'STOP'}
        </p>
      </div>

      <p className="relative mt-2 text-sm leading-relaxed">{verdict.detail}</p>

      {verdict.summary !== null && (
        <dl className="relative mt-5 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <Field label="Vehicle" value={verdict.summary.registration} mono />
          <Field label="Model" value={verdict.summary.vehicle} />
          <Field label="Customer" value={verdict.summary.customerName} />
          <Field label="Balance" value={verdict.summary.balance} mono />
        </dl>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): React.JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-[0.08em] opacity-70">{label}</dt>
      <dd className={`mt-0.5 truncate font-semibold ${mono ? 'font-mono tracking-wide' : ''}`}>
        {value}
      </dd>
    </div>
  );
}
