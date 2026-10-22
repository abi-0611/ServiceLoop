'use client';

import { OtpRequestResponseSchema, SessionSchema } from '@serviceloop/shared';
import { ArrowLeft, ArrowRight, KeyRound, Smartphone } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { OrbitalLoader } from '@/components/ui/orbital-loader';
import { AnimatedField, ParticleField } from '@/components/ui/sign-in-flow';

/**
 * Phone-OTP sign in.
 *
 * In DEMO_MODE the API returns the code so it can be shown here — there is no
 * SMS provider in a sandbox, and hunting through server logs is not a workflow.
 *
 * The screen is the sign-in-flo layout — particles behind a blurred card, an
 * icon roundel over the heading, floating-label fields, a light sweeping across
 * the submit button — carrying the two-stage OTP this API actually implements.
 * The source's email, password, sign-up toggle, "remember me", "forgot
 * password?" and three OAuth buttons are all absent, because none of them
 * exists in this product: a workshop registers its staff, the only credential
 * is a phone number, and the only second factor is a code sent to it. Controls
 * that cannot work are worse on an auth screen than anywhere else — it is the
 * one screen where somebody who is already unsure needs to trust what they are
 * looking at.
 */
export default function LoginPage(): React.JSX.Element {
  const router = useRouter();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'phone' | 'code'>('phone');
  const [demoCode, setDemoCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function requestCode(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const response = await fetch('/api/session/otp-request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone }),
      });

      if (!response.ok) {
        const problem = (await response.json()) as { detail?: string };
        setError(problem.detail ?? 'That number was not accepted.');
        return;
      }

      const parsed = OtpRequestResponseSchema.parse(await response.json());
      setDemoCode(parsed.demoCode ?? null);
      setStage('code');
    } catch {
      setError('Could not reach the API. Is it running?');
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const response = await fetch('/api/session/otp-verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone, code }),
      });

      if (!response.ok) {
        const problem = (await response.json()) as { detail?: string };
        setError(problem.detail ?? 'That code was not accepted.');
        return;
      }

      SessionSchema.parse(await response.json());
      router.push('/board');
      router.refresh();
    } catch {
      setError('Sign in failed. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const onCode = stage === 'code';

  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-background p-4">
      <ParticleField className="text-primary" />

      <main className="animate-enter relative z-10 w-full max-w-md">
        <div className="rounded-lg border border-border bg-card/80 p-7 shadow-xl backdrop-blur-xl sm:p-8">
          <div className="mb-8 text-center">
            <span className="mb-4 inline-flex size-14 items-center justify-center rounded-full bg-primary-soft text-primary ring-1 ring-inset ring-primary/15">
              {onCode ? (
                <KeyRound className="size-7" aria-hidden="true" />
              ) : (
                <Smartphone className="size-7" aria-hidden="true" />
              )}
            </span>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              {onCode ? 'Check your messages' : 'Welcome back'}
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {onCode
                ? `We sent a six-digit code to ${phone}. It expires in ten minutes.`
                : 'Sign in with the phone number your workshop registered.'}
            </p>
          </div>

          {onCode ? (
            <form className="space-y-6" onSubmit={verifyCode}>
              <AnimatedField
                id="code"
                name="code"
                label="6-digit code"
                icon={<KeyRound />}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                maxLength={6}
                required
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                inputClassName="font-mono text-xl tracking-[0.4em]"
              />

              {demoCode !== null && (
                <p
                  data-testid="demo-code"
                  className="animate-fade-in flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border-l-2 border-brand bg-muted/60 py-2.5 pl-3 pr-2 text-sm"
                >
                  <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                    Demo
                  </span>
                  your code is
                  <strong className="font-mono text-base tracking-[0.25em]">{demoCode}</strong>
                </p>
              )}

              <SubmitButton busy={busy} label="Sign in" working="Checking" />

              <button
                type="button"
                onClick={() => {
                  setStage('phone');
                  setCode('');
                  setDemoCode(null);
                  setError(null);
                }}
                className="mx-auto flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                <ArrowLeft className="size-4" aria-hidden="true" />
                Use a different number
              </button>
            </form>
          ) : (
            <form className="space-y-6" onSubmit={requestCode}>
              <AnimatedField
                id="phone"
                name="phone"
                label="Mobile number"
                icon={<Smartphone />}
                inputMode="tel"
                autoComplete="tel"
                autoFocus
                required
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                inputClassName="font-mono tracking-wide"
              />

              <SubmitButton busy={busy} label="Send code" working="Sending" showArrow />
            </form>
          )}

          {error !== null && (
            <p
              role="alert"
              className="animate-fade-in mt-5 rounded-md border-l-2 border-destructive bg-destructive/5 py-2 pl-3 pr-2 text-sm text-destructive"
            >
              {error}
            </p>
          )}

          <div className="mt-8">
            <div className="relative">
              <div aria-hidden="true" className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-border" />
              </div>
              <p className="relative flex justify-center">
                <span className="bg-card px-3 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                  Registered numbers only
                </span>
              </p>
            </div>

            <p className="mt-5 text-center text-xs leading-relaxed text-muted-foreground">
              Signing in records who you are on every message this console sends.{' '}
              <Link href="/privacy" className="text-primary underline-offset-4 hover:underline">
                Privacy notice
              </Link>
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}

/**
 * The submit button, with the source's light sweep and its in-place spinner.
 *
 * The label keeps its space while the spinner covers it — the source fades the
 * text to `opacity-0` and absolutely positions the spinner for the same reason,
 * and it is the right call: a button that changes width mid-submit moves out
 * from under the finger still resting on it.
 */
function SubmitButton({
  busy,
  label,
  working,
  showArrow = false,
}: {
  busy: boolean;
  label: string;
  working: string;
  showArrow?: boolean;
}): React.JSX.Element {
  return (
    <button
      type="submit"
      disabled={busy}
      className="group relative w-full overflow-hidden rounded-md bg-primary px-4 py-3.5 font-medium text-primary-foreground shadow-sm transition-[background-color,box-shadow,transform] duration-300 ease-swift hover:shadow-md hover:brightness-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span
        className={`inline-flex items-center justify-center gap-2 transition-opacity duration-200 ${
          busy ? 'opacity-0' : 'opacity-100'
        }`}
      >
        {label}
        {showArrow && (
          <ArrowRight
            className="size-4 transition-transform duration-200 ease-swift group-hover:translate-x-0.5"
            aria-hidden="true"
          />
        )}
      </span>

      {busy && (
        <span className="absolute inset-0 flex items-center justify-center gap-2 text-sm">
          <OrbitalLoader />
          {working}…
        </span>
      )}

      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/20 to-transparent transition-transform duration-1000 ease-in-out group-hover:translate-x-full"
      />
    </button>
  );
}
