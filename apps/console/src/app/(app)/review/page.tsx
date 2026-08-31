import {
  AdvisorTaskListSchema,
  GraduationReportSchema,
  ReviewQueueSchema,
  type AdvisorTaskDto,
  type GraduationReportDto,
} from '@serviceloop/shared';
import Link from 'next/link';
import { Badge, Card, EmptyState } from '@/components/ui/primitives';
import { ReviewCandidateCard } from '@/components/review-candidate';
import { ApiError, serverApiFetch } from '@/lib/api';

/**
 * The HITL review queue (phase 3.9).
 *
 * Every shop starts at L0 SHADOW and stays there until its owner decides
 * otherwise, so for the first weeks of a shop's life *this page is the product*:
 * the agent drafts, and nothing reaches a customer until someone here says so.
 *
 * The layout follows from that. The candidate's words come first and largest,
 * because they are what the advisor is actually judging. The checker's reasons
 * sit directly under them — an advisor needs to know *why* it was held before
 * deciding whether the agent was wrong or merely cautious. The waiting time is
 * shown on every card, because the cost of shadow mode is a customer waiting,
 * and hiding that cost is how a shop ends up leaving the agent at L0 for ever.
 */
export const dynamic = 'force-dynamic';

const URGENCY_TONE = {
  HIGH: 'danger',
  NORMAL: 'info',
  LOW: 'neutral',
} as const;

export default async function ReviewPage(): Promise<React.JSX.Element> {
  const queue = await serverApiFetch('/review/queue', ReviewQueueSchema);
  const tasks = await serverApiFetch('/review/tasks', AdvisorTaskListSchema);

  // OWNER-only. An advisor seeing a recommendation they cannot act on would
  // only be invited to ask for it, so the panel is absent rather than disabled.
  const graduation = await loadGraduation();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Review queue</h1>
          <p className="text-sm text-muted-foreground">
            Messages the agent drafted. Nothing here has reached the customer.
          </p>
        </div>
        {queue.candidates.length > 0 && (
          <Badge tone="warn" data-testid="review-pending-count">
            {queue.candidates.length} waiting
          </Badge>
        )}
      </div>

      {queue.candidates.length === 0 ? (
        <EmptyState
          title="Nothing waiting"
          description="When the agent drafts a message at shadow autonomy it lands here, with the checker's reasons attached, and goes nowhere until you approve it."
        />
      ) : (
        <ul data-testid="review-queue" className="space-y-4">
          {queue.candidates.map((candidate) => (
            <li key={candidate.messageId}>
              <ReviewCandidateCard candidate={candidate} />
            </li>
          ))}
        </ul>
      )}

      {graduation !== null && <GraduationPanel report={graduation} />}

      <AdvisorTasks tasks={tasks.tasks} />
    </div>
  );
}

/**
 * The graduation report, for an owner.
 *
 * A 403 means the signed-in staff member is an advisor, which is not an error —
 * it is the role boundary working — so the panel is simply omitted.
 */
async function loadGraduation(): Promise<GraduationReportDto | null> {
  try {
    return await serverApiFetch(
      '/review/graduation?objective=request_approval&flow=approval',
      GraduationReportSchema,
    );
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 401)) return null;
    throw error;
  }
}

function GraduationPanel({ report }: { report: GraduationReportDto }): React.JSX.Element {
  const ready = report.recommendedLevel !== null;

  return (
    <Card className="p-4" data-testid="graduation-report">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">Approval flow autonomy</h2>
        <Badge tone={ready ? 'success' : 'neutral'} data-testid="graduation-verdict">
          {ready ? `Ready for ${report.recommendedLevel}` : `Staying at ${report.currentLevel}`}
        </Badge>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Sent without edit" value={percent(report.approvedWithoutEditRate)} />
        <Stat label="Edited before sending" value={String(report.approvedWithEdit)} />
        <Stat label="Rejected" value={String(report.rejected)} />
        <Stat label="Checker blocked" value={percent(report.checkerBlockRate)} />
      </dl>

      <p className="mt-4 text-sm text-muted-foreground" data-testid="graduation-rationale">
        {report.rationale}
      </p>

      {ready && (
        <p className="mt-3 text-sm">
          {/* The system recommends; the owner decides (master §6). The link goes
              to the setting rather than a one-click promotion, because raising
              autonomy is a deliberate act with a customer on the other end. */}
          <Link href="/settings/guardrails" className="font-medium underline underline-offset-4">
            Change it in Guardrails →
          </Link>
        </p>
      )}
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

/**
 * Work waiting for a person (L6).
 *
 * On the same page as the queue on purpose: an advisor opening this screen is
 * asking "what needs me?", and a call the ladder raised is exactly that.
 */
function AdvisorTasks({ tasks }: { tasks: readonly AdvisorTaskDto[] }): React.JSX.Element {
  return (
    <section className="space-y-2" data-testid="advisor-tasks">
      <h2 className="text-base font-semibold">Waiting for you</h2>

      {tasks.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No calls or handoffs are outstanding.
        </p>
      ) : (
        <ul className="space-y-2">
          {tasks.map((task) => (
            <li key={task.id}>
              <Card className="flex flex-wrap items-start justify-between gap-2 p-4">
                <div className="min-w-0">
                  <p className="text-sm">{task.brief}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {task.kind.replace(/_/g, ' ').toLowerCase()}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={URGENCY_TONE[task.urgency]}>{task.urgency}</Badge>
                  {task.conversationId !== null && (
                    <Link
                      href={`/conversations/${task.conversationId}`}
                      className="text-sm font-medium underline underline-offset-4"
                    >
                      Open thread
                    </Link>
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
