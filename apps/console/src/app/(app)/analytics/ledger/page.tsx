import { formatPaise, LedgerListSchema } from '@serviceloop/shared';
import Link from 'next/link';
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState } from '@/components/ui/primitives';
import { serverApiFetch } from '@/lib/api';

/**
 * The declined-work ledger (phase 6.1).
 *
 * Every piece of work a customer said no to, with the reason they said it and
 * the technician's own words about why it mattered. Shops have always had this
 * information and always lost it — it lived in an advisor's memory of a
 * conversation in March.
 *
 * The two totals at the top are the argument for the product. What is still on
 * the table is money the shop has already done the diagnostic work to find; what
 * has come back is money it would not have earned. Neither is computed here:
 * both arrive from the API so that a filtered view cannot quietly change them.
 */

export const dynamic = 'force-dynamic';

const STATUS_TONE: Readonly<Record<string, 'info' | 'warn' | 'neutral' | 'danger' | 'success'>> = {
  OPEN: 'info',
  RE_PITCHED: 'warn',
  CONVERTED: 'success',
  EXPIRED: 'neutral',
  OPTED_OUT: 'danger',
};

const REASON_LABEL: Readonly<Record<string, string>> = {
  customer_deferred: 'deferred',
  customer_partial: 'partial',
  price: 'price',
  distrust: 'unsure',
  other: 'other',
};

export default async function LedgerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const status = single(params['status']) ?? 'all';
  const list = await serverApiFetch(
    `/retention/ledger?status=${encodeURIComponent(status)}`,
    LedgerListSchema,
  );

  return (
    <div className="space-y-6">
      <div>
        <Link href="/analytics" className="text-sm text-muted-foreground hover:underline">
          ← Back to analytics
        </Link>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">Declined-work ledger</h1>
        <p className="text-sm text-muted-foreground">
          Work a customer said no to, why they said it, and what came back.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Still on the table</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums" data-testid="ledger-open-value">
              {formatPaise(list.openValuePaise)}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Open and re-pitched items across every customer.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Recovered</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums" data-testid="ledger-recovered-value">
              {formatPaise(list.recoveredValuePaise)}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Previously declined work that came back and was approved.
            </p>
          </CardContent>
        </Card>
      </div>

      <nav className="flex flex-wrap gap-2 text-sm">
        {['all', 'OPEN', 'RE_PITCHED', 'CONVERTED', 'OPTED_OUT', 'EXPIRED'].map((option) => (
          <Link
            key={option}
            href={`/analytics/ledger?status=${option}`}
            aria-current={status === option ? 'page' : undefined}
            className={`rounded-md border px-3 py-1.5 font-medium ${
              status === option
                ? 'border-primary bg-primary/10'
                : 'border-border hover:bg-accent'
            }`}
          >
            {option === 'all' ? 'All' : option.replace('_', ' ').toLowerCase()}
          </Link>
        ))}
      </nav>

      {list.items.length === 0 ? (
        <EmptyState
          title="Nothing in the ledger"
          description="An item lands here the moment a work item is declined or deferred on a job card. Nothing is sent until the shop turns retention on in Guardrails."
        />
      ) : (
        <ul className="space-y-3" data-testid="ledger-items">
          {list.items.map((item) => (
            <li key={item.id}>
              <Card>
                <CardContent className="space-y-2 pt-6">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{item.title ?? 'Deferred work'}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {formatPaise(item.amountPaise)}
                    </span>
                    <Badge tone={STATUS_TONE[item.status] ?? 'neutral'}>
                      {item.status.replace('_', ' ').toLowerCase()}
                    </Badge>
                    <Badge tone="neutral">{REASON_LABEL[item.declineReason] ?? item.declineReason}</Badge>
                    {item.repitchCount > 0 && (
                      <Badge tone="neutral">
                        re-pitched {item.repitchCount}×
                      </Badge>
                    )}
                    {item.recoveredAmountPaise > 0 && (
                      <Badge tone="success">recovered {formatPaise(item.recoveredAmountPaise)}</Badge>
                    )}
                  </div>

                  <p className="text-sm text-muted-foreground">
                    {[item.vehicleLabel, item.customerName].filter(Boolean).join(' · ') ||
                      'Unknown vehicle'}
                    {' · declined '}
                    {new Date(item.createdAt).toLocaleDateString()}
                    {item.followUpAfter !== null &&
                      ` · next look ${new Date(item.followUpAfter).toLocaleDateString()}`}
                  </p>

                  {item.technicianNote !== null && item.technicianNote.trim().length > 0 && (
                    <blockquote className="border-l-2 border-border pl-3 text-sm italic">
                      “{item.technicianNote}”
                    </blockquote>
                  )}

                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {item.triggerTags.map((tag) => (
                      <span key={tag} className="rounded bg-muted px-1.5 py-0.5">
                        {tag}
                      </span>
                    ))}
                    <Link href={`/board/${item.jobCardId}`} className="hover:underline">
                      open the card →
                    </Link>
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function single(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}
