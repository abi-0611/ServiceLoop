import type { EtaHistoryDto } from '@serviceloop/shared';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/primitives';

/**
 * "When will it be ready?" — and every time that answer changed (phase 4.3).
 *
 * The history rather than the current value, because the question an advisor is
 * actually answering on the phone is *"you said four o'clock"*, and only the
 * history contains the four o'clock. The promise made at the counter sits at
 * the top and never moves: it is what the customer was told, and the entries
 * below are what happened to it.
 *
 * Each row says whether the customer was told. That is the column that matters
 * most: an ETA that slipped and was announced is a shop doing its job, and one
 * that slipped in silence is a complaint that has not arrived yet.
 */

const REASON_COPY: Record<EtaHistoryDto['entries'][number]['reason'], string> = {
  INTAKE_PROMISE: 'promised at intake',
  WORK_APPROVED: 'work approved',
  WORK_DECLINED: 'work declined',
  BLOCKED_PARTS: 'waiting for a part',
  PARTS_RECEIVED: 'part arrived',
  TECHNICIAN_HINT: 'technician said so',
  WORK_DONE: 'work finished',
  QUALITY_PASSED: 'passed quality check',
  ADVISOR_OVERRIDE: 'changed by an advisor',
};

const MATERIALITY_TONE = {
  MATERIAL_SLIP: 'danger',
  MATERIAL_GAIN: 'success',
  IMMATERIAL: 'neutral',
} as const;

export function EtaHistory({ history }: { history: EtaHistoryDto }): React.JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Promise &amp; ETA</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-2 gap-4">
          <div>
            <dt className="text-xs text-muted-foreground">Promised at intake</dt>
            <dd className="text-sm font-semibold" data-testid="eta-promised">
              {history.promisedAt === null ? 'no promise recorded' : formatWhen(history.promisedAt)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Current ETA</dt>
            <dd className="text-sm font-semibold" data-testid="eta-current">
              {history.currentEta === null ? 'not estimated' : formatWhen(history.currentEta)}
            </dd>
          </div>
        </dl>

        {history.entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing has changed the estimate yet.
          </p>
        ) : (
          <ol data-testid="eta-history" className="space-y-2">
            {history.entries.map((entry) => (
              <li
                key={entry.version}
                className="rounded-md border border-border p-3 text-sm"
                data-testid="eta-entry"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{formatWhen(entry.eta)}</span>
                  <div className="flex items-center gap-2">
                    <Badge tone={MATERIALITY_TONE[entry.materiality]}>
                      {entry.deltaMinutes === 0
                        ? 'set'
                        : `${entry.deltaMinutes > 0 ? '+' : ''}${entry.deltaMinutes} min`}
                    </Badge>
                    <span className="text-xs text-muted-foreground">v{entry.version}</span>
                  </div>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {REASON_COPY[entry.reason]} · {formatWhen(entry.changedAt)}
                </p>
                <p className="mt-1 text-sm">{entry.detail}</p>
                <p className="mt-1 text-xs" data-testid="eta-told">
                  {entry.customerWasTold ? (
                    <span className="text-emerald-700">customer was told</span>
                  ) : (
                    <span className="text-muted-foreground">not announced</span>
                  )}
                </p>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
