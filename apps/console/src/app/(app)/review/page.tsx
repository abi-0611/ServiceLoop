import {
  AdvisorTaskListSchema,
  GraduationReportSchema,
  ReviewQueueSchema,
  type AdvisorTaskDto,
  type GraduationReportDto,
} from '@serviceloop/shared';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { Badge, Card, EmptyState, PageHeader, SectionHeading } from '@/components/ui/primitives';
import { SpotlightArea } from '@/components/ui/spotlight';
import { spotlightProps } from '@/lib/spotlight';
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
    <div className="space-y-8">
      <PageHeader
        eyebrow="Workshop"
        title="Review queue"
        description="Messages the agent drafted. Nothing here has reached the customer."
        actions={
          queue.candidates.length > 0 ? (
            <span
              data-testid="review-pending-count"
              className="inline-flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900 shadow-xs dark:border-amber-400/35 dark:bg-amber-500/10 dark:text-amber-300"
            >
              <span className="relative flex size-2">
                <span className="ping-dot absolute inset-0 rounded-full opacity-70" />
                <span className="relative size-2 rounded-full bg-current" />
              </span>
              {queue.candidates.length} waiting
            </span>
          ) : undefined
        }
      />

      {queue.candidates.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck />}
          title="Nothing waiting"
          description="When the agent drafts a message at shadow autonomy it lands here, with the checker's reasons attached, and goes nowhere until you approve it."
        />
      ) : (
        <ul data-testid="review-queue" className="space-y-4">
          {queue.candidates.map((candidate, index) => (
            <li
              key={candidate.messageId}
              className="animate-enter"
              style={{ '--i': index } as React.CSSProperties}
            >
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
    <Card
      className="animate-enter relative overflow-hidden p-5"
      data-testid="graduation-report"
    >
      {/* A shop that has earned a promotion should be able to tell from across
          the room; one that has not should see nothing shouting at it. */}
      {ready && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -right-16 -top-16 size-48 rounded-full bg-emerald-500/10 blur-3xl"
        />
      )}

      <div className="relative flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2.5 text-base font-semibold">
          <span
            aria-hidden="true"
            className="flex size-8 items-center justify-center rounded-lg bg-primary-soft text-primary ring-1 ring-inset ring-primary/15"
          >
            <ShieldCheck className="size-4" />
          </span>
          Approval flow autonomy
        </h2>
        <Badge tone={ready ? 'success' : 'neutral'} data-testid="graduation-verdict">
          {ready ? `Ready for ${report.recommendedLevel}` : `Staying at ${report.currentLevel}`}
        </Badge>
      </div>

      <dl className="relative mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4">
        <Stat label="Sent without edit" value={percent(report.approvedWithoutEditRate)} />
        <Stat label="Edited before sending" value={String(report.approvedWithEdit)} />
        <Stat label="Rejected" value={String(report.rejected)} />
        <Stat label="Checker blocked" value={percent(report.checkerBlockRate)} />
      </dl>

      <p
        className="relative mt-4 text-sm leading-relaxed text-muted-foreground"
        data-testid="graduation-rationale"
      >
        {report.rationale}
      </p>

      {ready && (
        <p className="relative mt-4 text-sm">
          {/* The system recommends; the owner decides (master §6). The link goes
              to the setting rather than a one-click promotion, because raising
              autonomy is a deliberate act with a customer on the other end. */}
          <Link
            href="/settings/guardrails"
            className="group inline-flex items-center gap-1.5 font-medium text-primary underline-offset-4 hover:underline"
          >
            Change it in Guardrails
            <ArrowRight
              className="size-4 transition-transform duration-200 ease-swift group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </Link>
        </p>
      )}
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="bg-card p-3">
      <dt className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-lg font-semibold tabular-nums">{value}</dd>
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
    <section className="space-y-3" data-testid="advisor-tasks">
      <SectionHeading>Waiting for you</SectionHeading>

      {tasks.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          No calls or handoffs are outstanding.
        </p>
      ) : (
        <SpotlightArea>
          <ul className="space-y-2.5">
            {tasks.map((task, index) => (
              <li
                key={task.id}
                className="animate-enter-fast"
                style={{ '--i': index } as React.CSSProperties}
              >
                <Card
                  {...spotlightProps}
                  className="spotlight flex flex-wrap items-start justify-between gap-x-3 gap-y-2 overflow-hidden p-4"
                >
                  <div className="min-w-0">
                    <p className="text-sm leading-relaxed">{task.brief}</p>
                    <p className="mt-1 text-xs capitalize text-muted-foreground">
                      {task.kind.replace(/_/g, ' ').toLowerCase()}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={URGENCY_TONE[task.urgency]}>{task.urgency}</Badge>
                    {task.conversationId !== null && (
                      <Link
                        href={`/conversations/${task.conversationId}`}
                        className="group inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline"
                      >
                        Open thread
                        <ArrowRight
                          className="size-3.5 transition-transform duration-200 ease-swift group-hover:translate-x-0.5"
                          aria-hidden="true"
                        />
                      </Link>
                    )}
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </SpotlightArea>
      )}
    </section>
  );
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
