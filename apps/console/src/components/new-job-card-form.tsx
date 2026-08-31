'use client';

import { ConfirmDraftResponseSchema } from '@serviceloop/shared';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Card, CardContent, Input, Label, Select } from '@/components/ui/primitives';

/**
 * The digital job-card form.
 *
 * Every field it produces carries confidence 1 — which is the honest value, not
 * a shortcut around the confirmation flow. A person looked at the vehicle and
 * typed its number; there is no better signal in the system, and marking it
 * lower would put a ⚠ against something nobody needs to check.
 */
interface LineDraft {
  description: string;
  quantity: string;
  price: string;
}

const EMPTY_LINE: LineDraft = { description: '', quantity: '1', price: '' };

export function NewJobCardForm(): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ code: string; jobCardId: string } | null>(null);

  const [customerName, setCustomerName] = useState('');
  const [phone, setPhone] = useState('');
  const [registration, setRegistration] = useState('');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [odometer, setOdometer] = useState('');
  const [promisedAt, setPromisedAt] = useState('');
  const [language, setLanguage] = useState('en');
  const [complaints, setComplaints] = useState<string[]>(['']);
  const [lines, setLines] = useState<LineDraft[]>([{ ...EMPTY_LINE }]);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);

    const body = {
      customerName: customerName.trim(),
      phone: phone.trim(),
      registration: registration.trim(),
      ...(make.trim().length > 0 ? { make: make.trim() } : {}),
      ...(model.trim().length > 0 ? { model: model.trim() } : {}),
      ...(odometer.trim().length > 0 ? { odometerKm: Number(odometer) } : {}),
      complaints: complaints.map((entry) => entry.trim()).filter((entry) => entry.length > 0),
      estimateLines: lines
        .filter((line) => line.description.trim().length > 0)
        .map((line) => ({
          description: line.description.trim(),
          quantity: Number(line.quantity) || 1,
          ...(line.price.trim().length > 0 ? { unitPriceRupees: Number(line.price) } : {}),
        })),
      ...(promisedAt.trim().length > 0 ? { promisedAt: promisedAt.trim() } : {}),
      language,
      confirmImmediately: true,
    };

    try {
      const response = await fetch('/api/intake/job-cards', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const problem = (await response.json()) as { detail?: string };
        setError(problem.detail ?? 'The job card could not be created.');
        return;
      }

      const confirmed = ConfirmDraftResponseSchema.parse(await response.json());
      setCreated({ code: confirmed.code, jobCardId: confirmed.jobCardId });
      router.refresh();
    } catch {
      setError('Could not reach the API.');
    } finally {
      setBusy(false);
    }
  }

  if (created !== null) {
    return (
      <Card className="space-y-3 border-emerald-300 bg-emerald-50 p-4">
        <p className="text-sm font-semibold text-emerald-900" data-testid="new-card-result">
          Job card {created.code} created.
        </p>
        <div className="flex gap-2">
          <Button asChild size="sm">
            <a href={`/board/${created.jobCardId}`}>Open the card</a>
          </Button>
          <Button size="sm" variant="outline" onClick={() => setCreated(null)}>
            Create another
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Card>
        <CardContent className="grid gap-3 pt-4 sm:grid-cols-2">
          <Field label="Customer name" required>
            <Input
              value={customerName}
              onChange={(event) => setCustomerName(event.target.value)}
              data-testid="field-customerName"
              required
            />
          </Field>
          <Field label="Phone" required hint="Any Indian format; +91 is assumed.">
            <Input
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              data-testid="field-phone"
              inputMode="tel"
              required
            />
          </Field>
          <Field label="Registration" required hint="Spaces and hyphens are ignored.">
            <Input
              value={registration}
              onChange={(event) => setRegistration(event.target.value)}
              data-testid="field-registration"
              required
            />
          </Field>
          <Field label="Odometer (km)">
            <Input
              value={odometer}
              onChange={(event) => setOdometer(event.target.value)}
              inputMode="numeric"
            />
          </Field>
          <Field label="Make">
            <Input value={make} onChange={(event) => setMake(event.target.value)} />
          </Field>
          <Field label="Model">
            <Input value={model} onChange={(event) => setModel(event.target.value)} />
          </Field>
          <Field label="Promised by" hint="Free text is fine — “evening”, “tomorrow 5pm”.">
            <Input value={promisedAt} onChange={(event) => setPromisedAt(event.target.value)} />
          </Field>
          <Field label="Language">
            <Select value={language} onChange={(event) => setLanguage(event.target.value)}>
              <option value="en">English</option>
              <option value="ta">தமிழ்</option>
              <option value="hi">हिन्दी</option>
            </Select>
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 pt-4">
          <p className="text-sm font-semibold">What the customer reported</p>
          {complaints.map((complaint, index) => (
            <Input
              key={index}
              value={complaint}
              placeholder="Front brake noise above 60 kmph"
              data-testid={`field-complaint-${index}`}
              onChange={(event) => {
                const next = [...complaints];
                next[index] = event.target.value;
                setComplaints(next);
              }}
            />
          ))}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setComplaints([...complaints, ''])}
          >
            Add another complaint
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 pt-4">
          <p className="text-sm font-semibold">Estimate lines</p>
          {lines.map((line, index) => (
            <div key={index} className="grid gap-2 sm:grid-cols-[1fr_5rem_7rem]">
              <Input
                value={line.description}
                placeholder="Front brake pad set"
                data-testid={`field-line-${index}`}
                onChange={(event) => updateLine(index, { description: event.target.value })}
              />
              <Input
                value={line.quantity}
                inputMode="decimal"
                aria-label="Quantity"
                onChange={(event) => updateLine(index, { quantity: event.target.value })}
              />
              <Input
                value={line.price}
                inputMode="decimal"
                placeholder="₹ each"
                aria-label="Unit price in rupees"
                onChange={(event) => updateLine(index, { price: event.target.value })}
              />
            </div>
          ))}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setLines([...lines, { ...EMPTY_LINE }])}
          >
            Add another line
          </Button>
        </CardContent>
      </Card>

      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <Button type="submit" disabled={busy} data-testid="create-job-card">
        {busy ? 'Creating…' : 'Create the job card'}
      </Button>
    </form>
  );

  function updateLine(index: number, patch: Partial<LineDraft>): void {
    const next = [...lines];
    next[index] = { ...(next[index] as LineDraft), ...patch };
    setLines(next);
  }
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      <Label>
        {label}
        {required === true && <span className="text-destructive"> *</span>}
      </Label>
      {children}
      {hint !== undefined && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
