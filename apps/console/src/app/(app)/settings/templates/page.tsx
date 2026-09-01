import { SessionSchema } from '@serviceloop/shared';
import { z } from 'zod';
import { RecordRegistrationForm } from '@/components/record-registration-form';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/primitives';
import { serverApiFetch } from '@/lib/api';

/**
 * Template operations (phase 7.3).
 *
 * The screen that answers one question during onboarding, and one question
 * during an outage: **can this shop actually reach its customers?**
 *
 * A template is the only way to open a conversation with somebody whose 24-hour
 * window has closed, and Meta takes between an hour and a fortnight to approve
 * one. So the set of approvals a shop holds is an operational fact with a lead
 * time, not a configuration detail — which is why it gets a screen rather than
 * a line in a settings form.
 *
 * **Ready means every language, not any.** A customer-facing template approved
 * in English with Tamil still pending is drawn as blocked, because a shop that
 * believed it was finished would discover the gap when a Tamil-speaking
 * customer got silence. The `blockedOn` list names the variants standing in the
 * way, which is the actual to-do list.
 *
 * The lint block is the same `lintTemplates()` CI runs. It is shown because a
 * green build only proves the catalogue was consistent *at build time*, and an
 * operator staring at a template that will not render deserves to be told when
 * the fault is ours rather than in their Business Manager.
 */

export const dynamic = 'force-dynamic';

const LanguageStateSchema = z.object({
  language: z.enum(['en', 'ta', 'hi']),
  status: z.string(),
  providerTemplateId: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  submittedAt: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  submissionBody: z.string(),
  driftedFromSubmission: z.boolean().nullable(),
});

const CatalogSchema = z.object({
  rows: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      category: z.string(),
      purpose: z.string(),
      customerFacing: z.boolean(),
      variables: z.array(z.string()),
      languages: z.array(LanguageStateSchema),
      ready: z.boolean(),
      blockedOn: z.array(z.string()),
    }),
  ),
  orphaned: z.array(
    z.object({
      templateKey: z.string(),
      language: z.string(),
      status: z.string(),
      providerTemplateId: z.string().nullable(),
    }),
  ),
  summary: z.object({
    total: z.number(),
    customerFacing: z.number(),
    ready: z.number(),
    pending: z.number(),
    rejected: z.number(),
    notSubmitted: z.number(),
  }),
  lint: z.object({
    clean: z.boolean(),
    findings: z.array(
      z.object({
        templateKey: z.string(),
        language: z.string().nullable(),
        rule: z.string(),
        detail: z.string(),
      }),
    ),
    formatted: z.string(),
  }),
  sms: z.object({
    enabled: z.boolean(),
    senderId: z.string().nullable(),
    dltEntityId: z.string().nullable(),
    covered: z.array(z.string()),
    missing: z.array(z.string()),
  }),
});

const STATUS_TONE: Readonly<Record<string, 'neutral' | 'info' | 'warn' | 'success' | 'danger'>> = {
  NOT_SUBMITTED: 'neutral',
  PENDING: 'info',
  APPROVED: 'success',
  REJECTED: 'danger',
  PAUSED: 'warn',
  DISABLED: 'warn',
};

export default async function TemplatesPage(): Promise<React.JSX.Element> {
  const [catalog, role] = await Promise.all([
    serverApiFetch('/ops/templates', CatalogSchema),
    currentRole(),
  ]);
  const isOwner = role === 'OWNER';
  const { summary } = catalog;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">WhatsApp templates</h1>
        <p className="text-sm text-muted-foreground">
          {summary.ready} of {summary.total} approved in every language they need. Meta approves
          per language variant, so a template is only usable when all of its are through.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-4" data-testid="templates-summary">
        <Tile label="Ready" value={summary.ready} tone="success" />
        <Tile label="Awaiting Meta" value={summary.pending} tone="info" />
        <Tile label="Rejected" value={summary.rejected} tone="danger" />
        <Tile label="Not submitted" value={summary.notSubmitted} tone="neutral" />
      </div>

      {!catalog.lint.clean && (
        <Card className="border-destructive" data-testid="templates-lint">
          <CardHeader>
            <CardTitle className="text-destructive">
              The catalogue itself is inconsistent ({catalog.lint.findings.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="text-muted-foreground">
              This is a fault in the build, not in your Business Manager. Nothing you do on Meta&rsquo;s
              side will fix it — report it with the block below.
            </p>
            <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
              {catalog.lint.formatted}
            </pre>
          </CardContent>
        </Card>
      )}

      {catalog.orphaned.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Registered but no longer sent ({catalog.orphaned.length})</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="text-muted-foreground">
              Meta still holds an approval for these; this build never sends them. Not an error —
              but worth knowing before you go looking for them in the list above.
            </p>
            <ul className="space-y-1 font-mono text-xs">
              {catalog.orphaned.map((row) => (
                <li key={`${row.templateKey}-${row.language}`}>
                  {row.templateKey} [{row.language}] · {row.status}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Catalog
        </h2>
        <ul className="space-y-3">
          {catalog.rows.map((row) => (
            <li key={row.key}>
              <Card data-testid={`template-${row.key}`}>
                <CardHeader className="flex-row flex-wrap items-center gap-2 space-y-0">
                  <Badge tone={row.ready ? 'success' : 'warn'} data-testid="template-readiness">
                    {row.ready ? 'Ready' : `Blocked on ${row.blockedOn.join(', ')}`}
                  </Badge>
                  <CardTitle className="font-mono text-sm">{row.name}</CardTitle>
                  <Badge tone="neutral">{row.category}</Badge>
                  {!row.customerFacing && <Badge tone="neutral">staff only</Badge>}
                </CardHeader>

                <CardContent className="space-y-3 text-sm">
                  <p className="text-muted-foreground">{row.purpose}</p>

                  <div className="space-y-2">
                    {row.languages.map((state) => (
                      <div
                        key={state.language}
                        className="rounded-md border border-border p-3 text-xs"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium uppercase">{state.language}</span>
                          <Badge tone={STATUS_TONE[state.status] ?? 'neutral'}>
                            {state.status}
                          </Badge>
                          {state.providerTemplateId !== null && (
                            <span className="font-mono text-muted-foreground">
                              {state.providerTemplateId}
                            </span>
                          )}
                          {state.driftedFromSubmission === true && (
                            <Badge tone="warn" data-testid="template-drift">
                              wording has changed since submission
                            </Badge>
                          )}
                        </div>

                        {state.rejectionReason !== null && (
                          <p className="mt-2 text-destructive">
                            Meta said: {state.rejectionReason}
                          </p>
                        )}

                        {/* The exact text to paste into the Business Manager,
                            with the manifest's variable order already applied.
                            Rendering it here rather than letting an operator
                            retype the catalogue is what stops {{1}} meaning a
                            different thing in Tamil than it does in English. */}
                        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded bg-muted p-2">
                          {state.submissionBody}
                        </pre>
                      </div>
                    ))}
                  </div>

                  <p className="text-xs text-muted-foreground">
                    Variables, in order:{' '}
                    {row.variables.length === 0 ? (
                      'none'
                    ) : (
                      <span className="font-mono">
                        {row.variables.map((name, index) => `{{${index + 1}}} ${name}`).join(' · ')}
                      </span>
                    )}
                  </p>

                  {isOwner && <RecordRegistrationForm templateKey={row.key} />}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      </section>

      <Card data-testid="templates-sms">
        <CardHeader>
          <CardTitle>SMS fallback coverage</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {!catalog.sms.enabled ? (
            <p className="text-muted-foreground">
              SMS fallback is off for this shop. When WhatsApp is unreachable an escalation rung
              raises an advisor task instead of sending — which is safe, and silent.
            </p>
          ) : catalog.sms.missing.length === 0 ? (
            <p>
              Every customer-facing template has a registered DLT id. Sender{' '}
              <span className="font-mono">{catalog.sms.senderId ?? 'platform default'}</span>.
            </p>
          ) : (
            <>
              <p className="text-amber-700 dark:text-amber-400">
                {catalog.sms.missing.length} customer-facing template(s) have no DLT id, so they
                cannot fall back to SMS. This is invisible until the day WhatsApp is down.
              </p>
              <ul className="font-mono text-xs">
                {catalog.sms.missing.map((key) => (
                  <li key={key}>{key}</li>
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Tile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'neutral' | 'info' | 'success' | 'danger';
}): React.JSX.Element {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
        <Badge tone={tone} className="mt-2">
          {label}
        </Badge>
      </CardContent>
    </Card>
  );
}

async function currentRole(): Promise<string | null> {
  try {
    const me = await serverApiFetch('/auth/me', SessionSchema.shape.staff);
    return me.role;
  } catch {
    return null;
  }
}
