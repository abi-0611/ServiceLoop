'use client';

import {
  formatPaise,
  IssuedGatePassSchema,
  IssuedInvoiceSchema,
  PaymentLinkSchema,
  ReadyAnnouncementSchema,
  type DeliverySummaryDto,
} from '@serviceloop/shared';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/primitives';
import { qrPathData } from '@/lib/qr';

/**
 * The end of the loop, at the counter (phase 4.7–4.10).
 *
 * Four buttons in the order the afternoon actually happens: tell the customer
 * it is ready and offer them times, bill them, take the money, let the car out.
 * Each one is idempotent on the server — `announceReady` refuses a second
 * offer, `issue` returns the existing invoice, `createLink` re-uses a live link
 * — because these are the buttons an advisor double-taps when the counter is
 * busy, and each duplicate costs a customer a duplicate message or a duplicate
 * payment.
 *
 * The gate-pass token is shown exactly once, here, at issue. It is not stored
 * and cannot be read back: what the shop keeps is a hash, so that a *used* pass
 * can be recognised.
 */

const BOOKING_TONE = {
  OFFERED: 'info',
  CHOSEN: 'success',
  REMINDED: 'success',
  COMPLETED: 'neutral',
  MISSED: 'warn',
  CANCELLED: 'neutral',
} as const;

const PAYMENT_TONE = {
  PENDING: 'warn',
  PARTIALLY_PAID: 'warn',
  PAID: 'success',
  FAILED: 'danger',
  EXPIRED: 'neutral',
  CANCELLED: 'neutral',
} as const;

export function DeliveryPanel({
  jobCardId,
  summary,
  canOverride,
}: {
  jobCardId: string;
  summary: DeliverySummaryDto;
  /** Owners alone may release a vehicle with a balance outstanding. */
  canOverride: boolean;
}): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [overrideReason, setOverrideReason] = useState('');

  async function call(
    action: string,
    path: string,
    body: Record<string, unknown>,
    describe: (payload: unknown) => string,
  ): Promise<void> {
    if (busy !== null) return;
    setBusy(action);
    setError(null);
    setNote(null);

    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload: unknown = await response.json();

      if (!response.ok) {
        const problem = payload as { detail?: string };
        setError(problem.detail ?? 'That did not work.');
        return;
      }

      setNote(describe(payload));
      router.refresh();
    } catch {
      setError('Could not reach the API.');
    } finally {
      setBusy(null);
    }
  }

  const balancePaise =
    summary.payment === null
      ? summary.amountDuePaise
      : summary.payment.amountPaise - summary.payment.amountPaidPaise;

  return (
    <Card data-testid="delivery-panel">
      <CardHeader>
        <CardTitle>Delivery &amp; payment</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Amount due" value={formatPaise(summary.amountDuePaise)} />
          <Stat
            label="Pickup"
            value={
              summary.booking?.slotStart === undefined || summary.booking?.slotStart === null
                ? 'not chosen'
                : formatSlot(summary.booking.slotStart)
            }
          />
          <Stat
            label="Invoice"
            value={summary.invoice?.number ?? 'not issued'}
            {...(summary.invoice?.mediaId == null
              ? {}
              : { href: `/api/media/${summary.invoice.mediaId}` })}
          />
          <Stat
            label="Paid"
            value={
              summary.payment === null
                ? '—'
                : formatPaise(summary.payment.amountPaidPaise)
            }
          />
        </dl>

        <div className="flex flex-wrap items-center gap-2">
          {summary.booking !== null && (
            <Badge tone={BOOKING_TONE[summary.booking.status]} data-testid="booking-status">
              booking {summary.booking.status.toLowerCase()}
            </Badge>
          )}
          {summary.payment !== null && (
            <Badge tone={PAYMENT_TONE[summary.payment.status]} data-testid="payment-status">
              payment {summary.payment.status.toLowerCase().replace('_', ' ')}
            </Badge>
          )}
          {summary.gatePass !== null && (
            <Badge tone={summary.gatePass.status === 'ISSUED' ? 'success' : 'neutral'}>
              gate pass {summary.gatePass.code}
            </Badge>
          )}
        </div>

        {summary.booking !== null && summary.booking.slotStart === null && (
          <p className="text-sm text-muted-foreground" data-testid="offered-slots">
            Offered {summary.booking.offeredSlots.map(formatSlot).join(' · ')} — waiting for the
            customer to choose.
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy !== null}
            data-testid="delivery-ready"
            onClick={() =>
              void call('ready', '/api/delivery/ready', { jobCardId }, (payload) => {
                const result = ReadyAnnouncementSchema.parse(payload);
                return `Offered ${result.offeredSlots.length} slots · ${result.gateStatus.toLowerCase()}`;
              })
            }
          >
            {busy === 'ready' ? 'Sending…' : 'Ready — offer slots'}
          </Button>

          <Button
            variant="outline"
            disabled={busy !== null}
            data-testid="delivery-invoice"
            onClick={() =>
              void call('invoice', '/api/delivery/invoice', { jobCardId }, (payload) => {
                const result = IssuedInvoiceSchema.parse(payload);
                return result.alreadyIssued
                  ? `Invoice ${result.number} was already issued`
                  : `Invoice ${result.number} · ${formatPaise(result.totalPaise)} · ${result.evidenceBlocks} evidence block(s)`;
              })
            }
          >
            {busy === 'invoice' ? 'Issuing…' : 'Issue invoice'}
          </Button>

          <Button
            variant="outline"
            disabled={busy !== null}
            data-testid="delivery-payment-link"
            onClick={() =>
              void call('payment', '/api/delivery/payment-link', { jobCardId }, (payload) => {
                const result = PaymentLinkSchema.parse(payload);
                return `${result.reused ? 'Existing' : 'New'} link for ${formatPaise(result.amountPaise)}: ${result.shortUrl}`;
              })
            }
          >
            {busy === 'payment' ? 'Creating…' : 'Send payment link'}
          </Button>

          <Button
            disabled={busy !== null}
            data-testid="delivery-gate-pass"
            onClick={() =>
              void call(
                'gate',
                '/api/gate-pass/issue',
                {
                  jobCardId,
                  ...(canOverride && overrideReason.trim().length >= 5
                    ? { overrideReason: overrideReason.trim() }
                    : {}),
                },
                (payload) => {
                  const result = IssuedGatePassSchema.parse(payload);
                  if (result.token.length > 0) setToken(result.token);
                  return result.reused
                    ? `Pass ${result.code} is already live`
                    : `Pass ${result.code}, valid until ${formatSlot(result.expiresAt)}`;
                },
              )
            }
          >
            {busy === 'gate' ? 'Issuing…' : 'Issue gate pass'}
          </Button>
        </div>

        {/* The override is only offered where it can be used, and only when it
            would actually be needed: an owner looking at a settled card should
            not be shown a box asking why they are waiving a balance of zero. */}
        {canOverride && balancePaise > 0 && summary.gatePass === null && (
          <div>
            <label htmlFor="gate-override" className="text-sm font-medium">
              Releasing with {formatPaise(balancePaise)} outstanding? Say why.
            </label>
            <input
              id="gate-override"
              value={overrideReason}
              onChange={(event) => setOverrideReason(event.target.value)}
              placeholder="Regular customer, settling on Monday"
              data-testid="gate-override-reason"
              className="mt-1 flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
        )}

        {token !== null && <GatePassQr token={token} />}

        {note !== null && (
          <p className="text-sm text-muted-foreground" data-testid="delivery-note">
            {note}
          </p>
        )}
        {error !== null && (
          <p role="alert" data-testid="delivery-error" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The token, once.
 *
 * Rendered client-side from the value the issue call returned rather than
 * fetched: there is no endpoint that could serve it, because only its hash was
 * stored. Close the drawer and it is gone — which is the correct lifetime for a
 * bearer capability that opens a barrier.
 */
function GatePassQr({ token }: { token: string }): React.JSX.Element {
  const { path, size } = qrPathData(token);

  return (
    <div className="flex flex-wrap items-center gap-4 rounded-md border border-border p-4">
      <svg
        viewBox={`0 0 ${size} ${size}`}
        width={180}
        height={180}
        shapeRendering="crispEdges"
        role="img"
        aria-label="Gate pass QR code"
        data-testid="gate-pass-qr"
      >
        <rect width={size} height={size} fill="#ffffff" />
        <path d={path} fill="#000000" />
      </svg>
      <p className="max-w-xs text-xs text-muted-foreground">
        The customer has this on WhatsApp. Shown here for the case it matters —
        a flat battery at the counter. It is not stored and will not be shown
        again.
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  href,
}: {
  label: string;
  value: string;
  /** Set for the invoice, whose value is a document worth opening. */
  href?: string;
}): React.JSX.Element {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-semibold tabular-nums">
        {href === undefined ? (
          value
        ) : (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            data-testid="invoice-pdf"
            className="underline underline-offset-4"
          >
            {value}
          </a>
        )}
      </dd>
    </div>
  );
}

function formatSlot(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
