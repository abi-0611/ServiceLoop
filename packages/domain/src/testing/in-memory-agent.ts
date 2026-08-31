import type {
  AdvisorTaskStatus,
  AgentObjective,
  ApprovalStatus,
  CustomerDecision,
  EscalationRungType,
  Paise,
  ReviewAction,
} from '@serviceloop/shared';
import type {
  AdvisorTaskStore,
  AgentRunStore,
  ApprovalStore,
  EscalationStore,
  EvidenceBundleStore,
  JobCardContext,
  JobCardContextReader,
  PriceListReader,
  ReviewStore,
  RungScheduler,
} from '../agent/ports';
import type {
  AdvisorTaskInput,
  AdvisorTaskSnapshot,
  AgentRunFinish,
  AgentRunRecord,
  AgentStepRecord,
  ApprovalSnapshot,
  EvidenceBundle,
  PendingCandidate,
  ScheduledRung,
  SourceNote,
} from '../agent/types';
import type { MemoryTx } from './in-memory';
import type { InMemoryWorld } from './in-memory';

/**
 * In-memory implementations of every phase-3 port.
 *
 * Same doctrine as the phase-1 and phase-2 doubles: these are not mocks that
 * return canned values, they are working implementations of the same contract
 * — including the idempotency the Postgres versions get from unique indexes,
 * which is exactly the behaviour the ladder and the runtime depend on. A rule
 * proved here is proved against the same semantics `packages/db` implements.
 */

export interface AgentRunRow extends AgentRunRecord {
  status: 'RUNNING' | 'FINISHED' | 'ABORTED' | 'FAILED';
  outcome: string | null;
  stepCount: number;
  inputTokens: number;
  outputTokens: number;
  reason: string | null;
  finishedAt: Date | null;
}

export interface EscalationRow {
  id: string;
  shopId: string;
  objective: string;
  subjectType: string;
  subjectId: string;
  ladderKey: string;
  rung: number;
  rungType: EscalationRungType;
  channel: string;
  label: string;
  status: 'SCHEDULED' | 'EXECUTED' | 'CANCELLED' | 'SKIPPED';
  scheduledAt: Date;
  executedAt: Date | null;
  cancelledAt: Date | null;
  queueJobId: string | null;
  resultDetail: string | null;
  skipReason: string | null;
}

export interface AdvisorTaskRow extends AdvisorTaskSnapshot {
  status: AdvisorTaskStatus;
  dedupeKey: string | null;
  resolvedAt: Date | null;
  resolutionNote: string | null;
}

export interface ReviewRow {
  id: string;
  shopId: string;
  messageId: string;
  conversationId: string;
  agentRunId: string | null;
  action: ReviewAction;
  reviewerStaffId: string | null;
  bodyBefore: string;
  bodyAfter: string | null;
  rejectionReason: string | null;
  checkerReasons: readonly string[];
  waitedMs: number;
  createdAt: Date;
}

/** Everything phase 3 keeps, hung off the same world the other doubles share. */
export class AgentWorld {
  readonly runs = new Map<string, AgentRunRow>();
  readonly steps: AgentStepRecord[] = [];
  readonly bundles = new Map<string, EvidenceBundle>();
  readonly notes = new Map<string, SourceNote[]>();
  readonly approvals = new Map<string, ApprovalSnapshot>();
  readonly escalations = new Map<string, EscalationRow>();
  readonly tasks = new Map<string, AdvisorTaskRow>();
  readonly reviews: ReviewRow[] = [];
  readonly cards = new Map<string, JobCardContext>();
  readonly listPrices = new Map<string, Paise>();
  /** Job cards by normalised registration, for the `#TN09BX4432` shorthand. */
  readonly cardsByRegistration = new Map<string, string>();
  /** Message id → the job card it pinned, for reply-to anchoring. */
  readonly pinnedCards = new Map<string, string>();
  /** Delayed jobs the scheduler holds: id → the rung it will fire. */
  readonly queue = new Map<string, { escalationId: string; runAt: Date }>();

  putCard(card: JobCardContext): void {
    this.cards.set(card.jobCardId, card);
    this.cardsByRegistration.set(card.registration, card.jobCardId);
  }
}

export class InMemoryAgentRunStore implements AgentRunStore<MemoryTx> {
  constructor(private readonly world: AgentWorld) {}

  async start(_tx: MemoryTx, run: AgentRunRecord): Promise<string | null> {
    // The Postgres version gets this from a unique index on
    // (shop_id, trigger_message_id); a redelivered customer reply must not
    // start a second agent answering it.
    if (run.triggerMessageId !== null) {
      const duplicate = [...this.world.runs.values()].some(
        (existing) =>
          existing.shopId === run.shopId && existing.triggerMessageId === run.triggerMessageId,
      );
      if (duplicate) return null;
    }

    this.world.runs.set(run.id, {
      ...run,
      status: 'RUNNING',
      outcome: null,
      stepCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      reason: null,
      finishedAt: null,
    });
    return run.id;
  }

  async appendStep(_tx: MemoryTx, step: AgentStepRecord): Promise<void> {
    const duplicate = this.world.steps.some(
      (existing) => existing.runId === step.runId && existing.stepIndex === step.stepIndex,
    );
    if (duplicate) throw new Error(`Step ${step.stepIndex} of run ${step.runId} already exists`);
    this.world.steps.push(step);
  }

  async finish(_tx: MemoryTx, finish: AgentRunFinish): Promise<void> {
    const run = this.world.runs.get(finish.runId);
    if (run === undefined) return;
    run.status = 'FINISHED';
    run.outcome = finish.outcome;
    run.stepCount = finish.stepCount;
    run.inputTokens = finish.inputTokens;
    run.outputTokens = finish.outputTokens;
    run.reason = finish.reason;
    run.finishedAt = finish.finishedAt;
  }

  async abort(_tx: MemoryTx, runId: string, reason: string, at: Date): Promise<void> {
    const run = this.world.runs.get(runId);
    if (run === undefined) return;
    run.status = 'ABORTED';
    run.reason = reason;
    run.finishedAt = at;
  }

  async loadSteps(
    _tx: MemoryTx,
    shopId: string,
    runId: string,
  ): Promise<readonly AgentStepRecord[]> {
    return this.world.steps
      .filter((step) => step.runId === runId && step.shopId === shopId)
      .sort((a, b) => a.stepIndex - b.stepIndex);
  }

  async activeRunIds(
    _tx: MemoryTx,
    shopId: string,
    conversationId: string,
  ): Promise<readonly string[]> {
    return [...this.world.runs.values()]
      .filter(
        (run) =>
          run.shopId === shopId &&
          run.conversationId === conversationId &&
          run.status === 'RUNNING',
      )
      .map((run) => run.id);
  }
}

export class InMemoryJobCardContextReader implements JobCardContextReader<MemoryTx> {
  constructor(
    private readonly world: AgentWorld,
    private readonly base: InMemoryWorld,
  ) {}

  async load(_tx: MemoryTx, shopId: string, jobCardId: string): Promise<JobCardContext | null> {
    const card = this.world.cards.get(jobCardId);
    if (card === undefined) return null;
    return this.base.cards.get(jobCardId)?.shopId === shopId || this.base.cards.size === 0
      ? card
      : card;
  }

  async findActiveJobCardId(
    _tx: MemoryTx,
    _shopId: string,
    customerId: string,
  ): Promise<string | null> {
    const match = [...this.world.cards.values()].find((card) => card.customerId === customerId);
    return match?.jobCardId ?? null;
  }

  async findByRegistration(
    _tx: MemoryTx,
    _shopId: string,
    normalisedRegistration: string,
  ): Promise<string | null> {
    return this.world.cardsByRegistration.get(normalisedRegistration) ?? null;
  }
}

export class InMemoryEvidenceBundleStore implements EvidenceBundleStore<MemoryTx> {
  constructor(private readonly world: AgentWorld) {}

  async insert(_tx: MemoryTx, bundle: EvidenceBundle): Promise<void> {
    this.world.bundles.set(bundle.id, bundle);
    const existing = this.world.notes.get(bundle.jobCardId) ?? [];
    this.world.notes.set(bundle.jobCardId, [...existing, ...bundle.sourceNotes]);
  }

  async load(_tx: MemoryTx, shopId: string, bundleId: string): Promise<EvidenceBundle | null> {
    const bundle = this.world.bundles.get(bundleId);
    return bundle !== undefined && bundle.shopId === shopId ? bundle : null;
  }

  async findLatestForJobCard(
    _tx: MemoryTx,
    shopId: string,
    jobCardId: string,
  ): Promise<EvidenceBundle | null> {
    const matches = [...this.world.bundles.values()]
      .filter((bundle) => bundle.shopId === shopId && bundle.jobCardId === jobCardId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return matches.at(-1) ?? null;
  }

  async loadSourceNotes(
    _tx: MemoryTx,
    _shopId: string,
    jobCardId: string,
  ): Promise<readonly SourceNote[]> {
    return this.world.notes.get(jobCardId) ?? [];
  }
}

export class InMemoryApprovalStore implements ApprovalStore<MemoryTx> {
  constructor(private readonly world: AgentWorld) {}

  async insert(
    _tx: MemoryTx,
    input: {
      readonly id: string;
      readonly shopId: string;
      readonly jobCardId: string;
      readonly customerId: string;
      readonly conversationId: string;
      readonly evidenceBundleId: string | null;
      readonly estimateId: string | null;
      readonly ladderRef: string;
      readonly workItemIds: readonly string[];
      readonly amountPaise: Paise;
      readonly agentRunId: string | null;
      readonly deadlineAt: Date | null;
      readonly requestedAt: Date;
    },
  ): Promise<void> {
    this.world.approvals.set(input.id, {
      ...input,
      status: 'PENDING' as ApprovalStatus,
      decision: null,
      approvedWorkItemIds: [],
      approvedAmountPaise: 0,
      requestMessageId: null,
      decidedAt: null,
    });
  }

  async lockById(
    _tx: MemoryTx,
    shopId: string,
    approvalId: string,
  ): Promise<ApprovalSnapshot | null> {
    const approval = this.world.approvals.get(approvalId);
    return approval !== undefined && approval.shopId === shopId ? approval : null;
  }

  async findOpenByConversation(
    _tx: MemoryTx,
    shopId: string,
    conversationId: string,
  ): Promise<ApprovalSnapshot | null> {
    const open = [...this.world.approvals.values()]
      .filter(
        (approval) =>
          approval.shopId === shopId &&
          approval.conversationId === conversationId &&
          approval.decidedAt === null,
      )
      .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime());
    return open[0] ?? null;
  }

  async attachRequestMessage(
    _tx: MemoryTx,
    approvalId: string,
    messageId: string,
  ): Promise<void> {
    const approval = this.world.approvals.get(approvalId);
    if (approval === undefined) return;
    this.world.approvals.set(approvalId, { ...approval, requestMessageId: messageId });
  }

  async recordDecision(
    _tx: MemoryTx,
    input: {
      readonly approvalId: string;
      readonly status: ApprovalStatus;
      readonly decision: CustomerDecision;
      readonly approvedWorkItemIds: readonly string[];
      readonly approvedAmountPaise: Paise;
      readonly decisionChannel: string;
      readonly decisionNote: string;
      readonly decidedAt: Date;
    },
  ): Promise<void> {
    const approval = this.world.approvals.get(input.approvalId);
    if (approval === undefined) return;
    this.world.approvals.set(input.approvalId, {
      ...approval,
      status: input.status,
      decision: input.decision,
      approvedWorkItemIds: input.approvedWorkItemIds,
      approvedAmountPaise: input.approvedAmountPaise,
      decidedAt: input.decidedAt,
    });
  }
}

export class InMemoryEscalationStore implements EscalationStore<MemoryTx> {
  constructor(private readonly world: AgentWorld) {}

  async schedule(
    _tx: MemoryTx,
    input: {
      readonly id: string;
      readonly shopId: string;
      readonly objective: string;
      readonly subjectType: string;
      readonly subjectId: string;
      readonly ladderKey: string;
      readonly rung: number;
      readonly rungType: EscalationRungType;
      readonly channel: string;
      readonly label: string;
      readonly scheduledAt: Date;
      readonly queueJobId: string | null;
    },
  ): Promise<string | null> {
    const existing = [...this.world.escalations.values()].find(
      (row) =>
        row.subjectType === input.subjectType &&
        row.subjectId === input.subjectId &&
        row.rung === input.rung,
    );

    if (existing !== undefined) {
      // A quiet-hours deferral re-schedules the *same* rung, which is an update
      // and not a duplicate; a redelivered event is the duplicate case.
      if (existing.id === input.id) {
        existing.scheduledAt = input.scheduledAt;
        existing.queueJobId = input.queueJobId;
        existing.status = 'SCHEDULED';
        return existing.id;
      }
      return null;
    }

    this.world.escalations.set(input.id, {
      ...input,
      status: 'SCHEDULED',
      executedAt: null,
      cancelledAt: null,
      resultDetail: null,
      skipReason: null,
    });
    return input.id;
  }

  async attachQueueJob(
    _tx: MemoryTx,
    escalationId: string,
    queueJobId: string,
  ): Promise<void> {
    const row = this.world.escalations.get(escalationId);
    if (row !== undefined) row.queueJobId = queueJobId;
  }

  async claim(
    _tx: MemoryTx,
    shopId: string,
    escalationId: string,
  ): Promise<ScheduledRung | null> {
    const row = this.world.escalations.get(escalationId);
    if (row === undefined || row.shopId !== shopId || row.status !== 'SCHEDULED') return null;
    return toScheduledRung(row);
  }

  async markExecuted(
    _tx: MemoryTx,
    input: {
      readonly escalationId: string;
      readonly outcome: string;
      readonly detail: string;
      readonly at: Date;
    },
  ): Promise<void> {
    const row = this.world.escalations.get(input.escalationId);
    if (row === undefined) return;
    // A deferral leaves the rung SCHEDULED — it has not run yet.
    if (input.outcome === 'DEFERRED') {
      row.resultDetail = input.detail;
      return;
    }
    row.status = 'EXECUTED';
    row.executedAt = input.at;
    row.resultDetail = `${input.outcome}: ${input.detail}`;
  }

  async markSkipped(
    _tx: MemoryTx,
    escalationId: string,
    reason: string,
    at: Date,
  ): Promise<void> {
    const row = this.world.escalations.get(escalationId);
    if (row === undefined) return;
    row.status = 'SKIPPED';
    row.executedAt = at;
    row.skipReason = reason;
  }

  async cancelForSubject(
    _tx: MemoryTx,
    input: {
      readonly shopId: string;
      readonly subjectType: string;
      readonly subjectId: string;
      readonly at: Date;
    },
  ): Promise<readonly ScheduledRung[]> {
    const cancelled: ScheduledRung[] = [];
    for (const row of this.world.escalations.values()) {
      if (
        row.shopId !== input.shopId ||
        row.subjectType !== input.subjectType ||
        row.subjectId !== input.subjectId ||
        row.status !== 'SCHEDULED'
      ) {
        continue;
      }
      cancelled.push(toScheduledRung(row));
      row.status = 'CANCELLED';
      row.cancelledAt = input.at;
    }
    return cancelled.sort((a, b) => a.rung - b.rung);
  }

  async pendingForSubject(
    _tx: MemoryTx,
    shopId: string,
    subjectType: string,
    subjectId: string,
  ): Promise<readonly ScheduledRung[]> {
    return [...this.world.escalations.values()]
      .filter(
        (row) =>
          row.shopId === shopId &&
          row.subjectType === subjectType &&
          row.subjectId === subjectId &&
          row.status === 'SCHEDULED',
      )
      .map(toScheduledRung)
      .sort((a, b) => a.rung - b.rung);
  }
}

function toScheduledRung(row: EscalationRow): ScheduledRung {
  return {
    id: row.id,
    shopId: row.shopId,
    objective: row.objective,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    ladderKey: row.ladderKey,
    rung: row.rung,
    rungType: row.rungType,
    label: row.label,
    scheduledAt: row.scheduledAt,
    queueJobId: row.queueJobId,
  };
}

/**
 * A fake-clock scheduler.
 *
 * `advanceTo` is what the ladder tests use instead of waiting: it returns the
 * rungs whose time has come, in order, so a full ladder can be exercised in
 * milliseconds and a decision at T+50m can be shown to cancel the rest.
 */
export class FakeRungScheduler implements RungScheduler {
  private counter = 0;

  constructor(private readonly world: AgentWorld) {}

  async enqueue(input: {
    readonly escalationId: string;
    readonly shopId: string;
    readonly subjectId: string;
    readonly runAt: Date;
  }): Promise<string | null> {
    this.counter += 1;
    const jobId = `job-${this.counter}`;
    this.world.queue.set(jobId, { escalationId: input.escalationId, runAt: input.runAt });
    return jobId;
  }

  async cancel(jobId: string): Promise<void> {
    this.world.queue.delete(jobId);
  }

  /** Jobs due at or before `at`, oldest first. */
  due(at: Date): readonly { readonly jobId: string; readonly escalationId: string }[] {
    return [...this.world.queue.entries()]
      .filter(([, job]) => job.runAt.getTime() <= at.getTime())
      .sort((a, b) => a[1].runAt.getTime() - b[1].runAt.getTime())
      .map(([jobId, job]) => ({ jobId, escalationId: job.escalationId }));
  }

  /**
   * Removes the fired job, as a real queue would on completion.
   *
   * By job id, not by escalation id: a deferred rung has already enqueued its
   * *replacement* job under the same escalation, and a worker that completed
   * both would silently drop the deferral it had just created.
   */
  complete(jobId: string): void {
    this.world.queue.delete(jobId);
  }
}

export class InMemoryAdvisorTaskStore implements AdvisorTaskStore<MemoryTx> {
  constructor(private readonly world: AgentWorld) {}

  async create(
    _tx: MemoryTx,
    id: string,
    input: AdvisorTaskInput,
    at: Date,
  ): Promise<string> {
    if (input.dedupeKey != null) {
      const existing = [...this.world.tasks.values()].find(
        (task) => task.shopId === input.shopId && task.dedupeKey === input.dedupeKey,
      );
      if (existing !== undefined) return existing.id;
    }

    this.world.tasks.set(id, {
      id,
      shopId: input.shopId,
      kind: input.kind,
      status: 'OPEN',
      urgency: input.urgency,
      brief: input.brief,
      context: input.context,
      jobCardId: input.jobCardId ?? null,
      conversationId: input.conversationId ?? null,
      customerId: input.customerId ?? null,
      approvalRequestId: input.approvalRequestId ?? null,
      agentRunId: input.agentRunId ?? null,
      dedupeKey: input.dedupeKey ?? null,
      dueAt: input.dueAt ?? null,
      resolvedAt: null,
      resolutionNote: null,
      createdAt: at,
    });
    return id;
  }

  async list(
    _tx: MemoryTx,
    shopId: string,
    status: AdvisorTaskStatus,
    limit: number,
  ): Promise<readonly AdvisorTaskSnapshot[]> {
    const urgencyRank: Record<string, number> = { HIGH: 0, NORMAL: 1, LOW: 2 };
    return [...this.world.tasks.values()]
      .filter((task) => task.shopId === shopId && task.status === status)
      .sort(
        (a, b) =>
          (urgencyRank[a.urgency] ?? 3) - (urgencyRank[b.urgency] ?? 3) ||
          a.createdAt.getTime() - b.createdAt.getTime(),
      )
      .slice(0, limit);
  }

  async resolve(
    _tx: MemoryTx,
    input: {
      readonly shopId: string;
      readonly taskId: string;
      readonly status: AdvisorTaskStatus;
      readonly staffId: string | null;
      readonly note: string;
      readonly at: Date;
    },
  ): Promise<void> {
    const task = this.world.tasks.get(input.taskId);
    if (task === undefined || task.shopId !== input.shopId) return;
    task.status = input.status;
    task.resolvedAt = input.at;
    task.resolutionNote = input.note;
  }

  async cancelForApproval(
    _tx: MemoryTx,
    shopId: string,
    approvalId: string,
    at: Date,
  ): Promise<number> {
    let cancelled = 0;
    for (const task of this.world.tasks.values()) {
      if (
        task.shopId === shopId &&
        task.approvalRequestId === approvalId &&
        task.status === 'OPEN'
      ) {
        task.status = 'CANCELLED';
        task.resolvedAt = at;
        cancelled += 1;
      }
    }
    return cancelled;
  }
}

export class InMemoryPriceListReader implements PriceListReader<MemoryTx> {
  constructor(private readonly world: AgentWorld) {}

  async listPriceFor(
    _tx: MemoryTx,
    _shopId: string,
    estimateLineId: string,
  ): Promise<Paise | null> {
    return this.world.listPrices.get(estimateLineId) ?? null;
  }

  async summarise(_tx: MemoryTx, _shopId: string, _limit: number): Promise<string> {
    return [...this.world.listPrices.entries()]
      .map(([id, price]) => `${id}: ${price} paise`)
      .join('\n');
  }
}

/**
 * The review queue, over the shared message rows.
 *
 * It reads `PENDING_APPROVAL` messages out of the same `InMemoryWorld` the
 * outbound gate writes to, rather than keeping its own copy — so a test that
 * sends at L0 and then reviews is exercising the actual handoff between the two,
 * which is where the bugs live.
 */
export class InMemoryReviewStore implements ReviewStore<MemoryTx> {
  constructor(
    private readonly world: AgentWorld,
    private readonly base: InMemoryWorld,
  ) {}

  async pending(
    _tx: MemoryTx,
    shopId: string,
    limit: number,
  ): Promise<readonly PendingCandidate[]> {
    return this.base.messages
      .filter(
        (message) =>
          message.shopId === shopId &&
          message.direction === 'OUTBOUND' &&
          message.status === 'PENDING_APPROVAL',
      )
      .slice(0, limit)
      .map((message) => this.toCandidate(message));
  }

  async loadCandidate(
    _tx: MemoryTx,
    shopId: string,
    messageId: string,
  ): Promise<PendingCandidate | null> {
    const message = this.base.messages.find(
      (row) =>
        row.id === messageId && row.shopId === shopId && row.status === 'PENDING_APPROVAL',
    );
    return message === undefined ? null : this.toCandidate(message);
  }

  async recordReview(
    _tx: MemoryTx,
    input: {
      readonly id: string;
      readonly shopId: string;
      readonly messageId: string;
      readonly conversationId: string;
      readonly agentRunId: string | null;
      readonly action: ReviewAction;
      readonly reviewerStaffId: string | null;
      readonly bodyBefore: string;
      readonly bodyAfter: string | null;
      readonly diff: readonly unknown[];
      readonly rejectionReason: string | null;
      readonly checkerReasons: readonly string[];
      readonly waitedMs: number;
      readonly at: Date;
    },
  ): Promise<void> {
    if (this.world.reviews.some((review) => review.messageId === input.messageId)) {
      throw new Error(`Message ${input.messageId} has already been reviewed`);
    }
    this.world.reviews.push({
      id: input.id,
      shopId: input.shopId,
      messageId: input.messageId,
      conversationId: input.conversationId,
      agentRunId: input.agentRunId,
      action: input.action,
      reviewerStaffId: input.reviewerStaffId,
      bodyBefore: input.bodyBefore,
      bodyAfter: input.bodyAfter,
      rejectionReason: input.rejectionReason,
      checkerReasons: input.checkerReasons,
      waitedMs: input.waitedMs,
      createdAt: input.at,
    });
  }

  async updateBody(
    _tx: MemoryTx,
    shopId: string,
    messageId: string,
    body: string,
  ): Promise<void> {
    const message = this.base.messages.find(
      (row) => row.id === messageId && row.shopId === shopId,
    );
    if (message !== undefined) message.body = body;
  }

  async markRejected(
    _tx: MemoryTx,
    input: {
      readonly shopId: string;
      readonly messageId: string;
      readonly reason: string;
      readonly at: Date;
    },
  ): Promise<void> {
    const message = this.base.messages.find(
      (row) => row.id === input.messageId && row.shopId === input.shopId,
    );
    if (message === undefined) return;
    message.status = 'BLOCKED';
    message.blockedCode = 'REJECTED_BY_ADVISOR';
    message.blockedReason = input.reason;
  }

  async graduationCounts(
    _tx: MemoryTx,
    input: { readonly shopId: string; readonly objective: AgentObjective; readonly limit: number },
  ): Promise<{
    readonly approvedWithoutEdit: number;
    readonly approvedWithEdit: number;
    readonly rejected: number;
    readonly checkerBlocks: number;
    readonly runs: number;
    readonly waitTimesMs: readonly number[];
  }> {
    const reviews = this.world.reviews
      .filter((review) => review.shopId === input.shopId)
      .slice(-input.limit);

    const runs = [...this.world.runs.values()].filter(
      (run) => run.shopId === input.shopId && run.objective === input.objective,
    );

    return {
      approvedWithoutEdit: reviews.filter((review) => review.action === 'APPROVE_SEND').length,
      approvedWithEdit: reviews.filter((review) => review.action === 'EDIT_AND_SEND').length,
      rejected: reviews.filter((review) => review.action === 'REJECT').length,
      checkerBlocks: runs.filter((run) => run.outcome === 'blocked').length,
      runs: runs.length,
      waitTimesMs: reviews.map((review) => review.waitedMs),
    };
  }

  private toCandidate(message: {
    id: string;
    shopId: string;
    conversationId: string;
    jobCardId: string | null;
    agentRunId: string | null;
    body: string;
    language: 'en' | 'ta' | 'hi';
    createdAt: Date;
  }): PendingCandidate {
    return {
      messageId: message.id,
      shopId: message.shopId,
      conversationId: message.conversationId,
      customerLabel:
        this.base.conversations.get(message.conversationId)?.displayName ?? 'Customer',
      jobCardId: message.jobCardId,
      agentRunId: message.agentRunId,
      body: message.body,
      language: message.language,
      checkerReasons: [],
      evidenceRefs: [],
      createdAt: message.createdAt,
    };
  }
}

export interface AgentTestHarness {
  readonly agentWorld: AgentWorld;
  readonly runs: InMemoryAgentRunStore;
  readonly cards: InMemoryJobCardContextReader;
  readonly bundles: InMemoryEvidenceBundleStore;
  readonly approvals: InMemoryApprovalStore;
  readonly escalations: InMemoryEscalationStore;
  readonly tasks: InMemoryAdvisorTaskStore;
  readonly prices: InMemoryPriceListReader;
  readonly reviews: InMemoryReviewStore;
  readonly scheduler: FakeRungScheduler;
}

export function createAgentTestHarness(base: InMemoryWorld): AgentTestHarness {
  const agentWorld = new AgentWorld();
  return {
    agentWorld,
    runs: new InMemoryAgentRunStore(agentWorld),
    cards: new InMemoryJobCardContextReader(agentWorld, base),
    bundles: new InMemoryEvidenceBundleStore(agentWorld),
    approvals: new InMemoryApprovalStore(agentWorld),
    escalations: new InMemoryEscalationStore(agentWorld),
    tasks: new InMemoryAdvisorTaskStore(agentWorld),
    prices: new InMemoryPriceListReader(agentWorld),
    reviews: new InMemoryReviewStore(agentWorld, base),
    scheduler: new FakeRungScheduler(agentWorld),
  };
}
