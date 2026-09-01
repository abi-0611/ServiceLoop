import { SessionSchema } from '@serviceloop/shared';
import Link from 'next/link';
import { z } from 'zod';
import { DataRequestActions } from '@/components/data-request-actions';
import { RaiseDataRequestForm } from '@/components/raise-data-request-form';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
} from '@/components/ui/primitives';
import { serverApiFetch } from '@/lib/api';

/**
 * Data-principal requests (phase 7.2).
 *
 * The console half of the DPDP workflow. Deliberately a *workflow* screen and
 * not a "delete customer" button: a request is lodged, verified, approved, and
 * only then does the cascade run — and each of those is a separate act by a
 * person, recorded separately, because verifying that somebody is who they say
 * they are and deciding to destroy a shop's records about them are different
 * judgements.
 *
 * The grace window is why `SCHEDULED` is a state you can see and cancel from
 * here. A deletion aimed at the wrong customer has no undo, and the interval
 * between approving one and it running is the only place that mistake can be
 * caught.
 *
 * A completed deletion names nobody. `customerId` is null by then and the row
 * identifies itself by its pseudonym, which is correct — the erasure is meant
 * to have happened, and a console that still displayed the name would mean it
 * had not.
 */

export const dynamic = 'force-dynamic';

const RequestSchema = z.object({
  id: z.string(),
  kind: z.enum(['EXPORT', 'DELETION']),
  status: z.string(),
  customerId: z.string().nullable(),
  subjectPseudonym: z.string(),
  detail: z.string().nullable(),
  verification: z.string().nullable(),
  verifiedAt: z.string().nullable(),
  approvedAt: z.string().nullable(),
  scheduledFor: z.string().nullable(),
  completedAt: z.string().nullable(),
  outcomeReason: z.string().nullable(),
  archiveBytes: z.number().nullable(),
  downloadExpiresAt: z.string().nullable(),
  downloadedAt: z.string().nullable(),
  createdAt: z.string(),
});

const ListSchema = z.object({ requests: z.array(RequestSchema) });

type Request = z.infer<typeof RequestSchema>;

const TONE: Readonly<Record<string, 'neutral' | 'info' | 'warn' | 'success' | 'danger'>> = {
  RECEIVED: 'neutral',
  VERIFIED: 'info',
  APPROVED: 'warn',
  SCHEDULED: 'warn',
  RUNNING: 'warn',
  COMPLETED: 'success',
  REJECTED: 'neutral',
  CANCELLED: 'neutral',
  FAILED: 'danger',
};

export default async function PrivacyRequestsPage(): Promise<React.JSX.Element> {
  const [list, role] = await Promise.all([
    serverApiFetch('/privacy/requests?limit=100', ListSchema),
    currentRole(),
  ]);

  const open = list.requests.filter(
    (request) => !['COMPLETED', 'REJECTED', 'CANCELLED'].includes(request.status),
  );
  const closed = list.requests.filter((request) =>
    ['COMPLETED', 'REJECTED', 'CANCELLED'].includes(request.status),
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Data-principal requests</h1>
        <p className="text-sm text-muted-foreground">
          Export and erasure under the DPDP Act. Every step is audited; a deletion is a workflow
          with an approval and a completion report, not a button.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Lodge a request</CardTitle>
        </CardHeader>
        <CardContent>
          <RaiseDataRequestForm />
        </CardContent>
      </Card>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Open ({open.length})
        </h2>
        {open.length === 0 ? (
          <EmptyState
            title="Nothing outstanding"
            description="No export or erasure request is waiting on anyone."
          />
        ) : (
          <ul className="space-y-3" data-testid="privacy-open-requests">
            {open.map((request) => (
              <RequestCard key={request.id} request={request} isOwner={role === 'OWNER'} />
            ))}
          </ul>
        )}
      </section>

      {closed.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Closed ({closed.length})
          </h2>
          <ul className="space-y-3">
            {closed.map((request) => (
              <RequestCard key={request.id} request={request} isOwner={role === 'OWNER'} />
            ))}
          </ul>
        </section>
      )}

      <p className="text-xs text-muted-foreground">
        Retention carve-outs — which records survive an erasure, and for how long — are documented
        in <code>docs/privacy/retention.md</code> and summarised on the{' '}
        <Link href="/privacy" className="underline">
          public privacy notice
        </Link>
        .
      </p>
    </div>
  );
}

function RequestCard({
  request,
  isOwner,
}: {
  request: Request;
  isOwner: boolean;
}): React.JSX.Element {
  return (
    <li>
      <Card data-testid={`privacy-request-${request.id}`}>
        <CardHeader className="flex-row flex-wrap items-center gap-2 space-y-0">
          <Badge tone={request.kind === 'DELETION' ? 'danger' : 'info'}>{request.kind}</Badge>
          <Badge tone={TONE[request.status] ?? 'neutral'} data-testid="privacy-request-status">
            {request.status}
          </Badge>
          <CardTitle className="font-mono text-xs text-muted-foreground">
            {/* The pseudonym, not the name. A completed erasure has no customer
                to name, and showing one for an open request and nothing for a
                closed one would read as data loss rather than as the erasure
                working. */}
            {request.subjectPseudonym}
          </CardTitle>
        </CardHeader>

        <CardContent className="space-y-3 text-sm">
          {request.detail !== null && <p className="italic text-muted-foreground">“{request.detail}”</p>}

          <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-xs">
            <Row label="Lodged" value={formatWhen(request.createdAt)} />
            {request.verifiedAt !== null && (
              <Row
                label="Verified"
                value={`${formatWhen(request.verifiedAt)} · ${request.verification ?? ''}`}
              />
            )}
            {request.approvedAt !== null && (
              <Row label="Approved" value={formatWhen(request.approvedAt)} />
            )}
            {request.scheduledFor !== null && request.completedAt === null && (
              <Row
                label="Runs at"
                value={`${formatWhen(request.scheduledFor)} — cancellable until then`}
              />
            )}
            {request.completedAt !== null && (
              <Row label="Completed" value={formatWhen(request.completedAt)} />
            )}
            {request.downloadExpiresAt !== null && (
              <Row
                label="Archive"
                value={
                  request.downloadedAt === null
                    ? `link expires ${formatWhen(request.downloadExpiresAt)}, not yet downloaded`
                    : `downloaded ${formatWhen(request.downloadedAt)}`
                }
              />
            )}
            {request.outcomeReason !== null && (
              <Row label="Reason" value={request.outcomeReason} />
            )}
          </dl>

          <DataRequestActions
            requestId={request.id}
            status={request.status}
            kind={request.kind}
            isOwner={isOwner}
          />
        </CardContent>
      </Card>
    </li>
  );
}

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
}

async function currentRole(): Promise<string | null> {
  try {
    const me = await serverApiFetch('/auth/me', SessionSchema.shape.staff);
    return me.role;
  } catch {
    return null;
  }
}
