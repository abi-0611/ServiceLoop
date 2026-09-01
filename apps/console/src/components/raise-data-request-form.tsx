'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button, Input, Label, Select } from '@/components/ui/primitives';

/**
 * Lodging a data-principal request (phase 7.2).
 *
 * Takes a customer id rather than a phone number, and that is not laziness
 * about search: a phone number typed at a counter is the *unverified* claim
 * this whole workflow exists to check, and accepting one here would put the
 * identification and the verification in the same act. An advisor reaches this
 * screen from the customer's own record, where the id came from the database.
 *
 * The free-text detail is the customer's own words. It is carried into the
 * audit trail and the completion report unaltered, because "delete everything
 * except my invoices" and "delete everything" are different requests and a
 * paraphrase loses the difference.
 */
export function RaiseDataRequestForm(): React.JSX.Element {
  const router = useRouter();
  const [customerId, setCustomerId] = useState('');
  const [kind, setKind] = useState<'EXPORT' | 'DELETION'>('EXPORT');
  const [detail, setDetail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const response = await fetch('/api/privacy/requests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          customerId: customerId.trim(),
          kind,
          ...(detail.trim() === '' ? {} : { detail: detail.trim() }),
        }),
      });

      if (!response.ok) {
        const problem = (await response.json()) as { detail?: string };
        setError(problem.detail ?? 'The request could not be lodged.');
        return;
      }

      setCustomerId('');
      setDetail('');
      router.refresh();
    } catch {
      setError('Could not reach the API.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="space-y-3" onSubmit={(event) => void submit(event)}>
      <div className="grid gap-3 sm:grid-cols-[1fr,12rem]">
        <div className="space-y-1.5">
          <Label htmlFor="dp-customer">Customer</Label>
          <Input
            id="dp-customer"
            required
            value={customerId}
            onChange={(event) => setCustomerId(event.target.value)}
            placeholder="Customer id from their record"
            data-testid="privacy-customer-id"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="dp-kind">Request</Label>
          <Select
            id="dp-kind"
            value={kind}
            onChange={(event) => setKind(event.target.value as 'EXPORT' | 'DELETION')}
            data-testid="privacy-kind"
          >
            <option value="EXPORT">Copy of their data</option>
            <option value="DELETION">Erasure</option>
          </Select>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="dp-detail">What they asked for, in their words</Label>
        <Input
          id="dp-detail"
          value={detail}
          onChange={(event) => setDetail(event.target.value)}
          placeholder="Optional, but it goes into the audit trail and the report"
        />
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={busy} data-testid="privacy-raise">
          {busy ? 'Lodging…' : 'Lodge request'}
        </Button>
        <p className="text-xs text-muted-foreground">
          Nothing happens yet. The requester is verified next, and an erasure needs the
          owner&rsquo;s approval after that.
        </p>
      </div>

      {error !== null && <p className="text-xs text-destructive">{error}</p>}
    </form>
  );
}
