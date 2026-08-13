'use client';

import { OtpRequestResponseSchema, SessionSchema } from '@serviceloop/shared';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@/components/ui/primitives';

/**
 * Phone-OTP sign in.
 *
 * In DEMO_MODE the API returns the code so it can be shown here — there is no
 * SMS provider in a sandbox, and hunting through server logs is not a workflow.
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

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-10">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">ServiceLoop</CardTitle>
          <CardDescription>Sign in with the phone number your workshop registered.</CardDescription>
        </CardHeader>
        <CardContent>
          {stage === 'phone' ? (
            <form className="space-y-4" onSubmit={requestCode}>
              <div className="space-y-2">
                <Label htmlFor="phone">Mobile number</Label>
                <Input
                  id="phone"
                  name="phone"
                  inputMode="tel"
                  autoComplete="tel"
                  placeholder="98400 12002"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  required
                />
              </div>
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? 'Sending…' : 'Send code'}
              </Button>
            </form>
          ) : (
            <form className="space-y-4" onSubmit={verifyCode}>
              <div className="space-y-2">
                <Label htmlFor="code">6-digit code</Label>
                <Input
                  id="code"
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="000000"
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                  required
                />
              </div>

              {demoCode !== null && (
                <p
                  data-testid="demo-code"
                  className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-inset ring-amber-300"
                >
                  Demo mode — your code is <strong>{demoCode}</strong>
                </p>
              )}

              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? 'Checking…' : 'Sign in'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => {
                  setStage('phone');
                  setCode('');
                  setDemoCode(null);
                }}
              >
                Use a different number
              </Button>
            </form>
          )}

          {error !== null && (
            <p role="alert" className="mt-4 text-sm text-destructive">
              {error}
            </p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
