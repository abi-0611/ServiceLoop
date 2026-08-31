import {
  systemClock,
  uuidv7,
  type AdvisorTaskStatus,
  type Clock,
  type EventEnvelope,
} from '@serviceloop/shared';
import type { Actor } from '../job-card/context';
import type { AuditAppender, OutboxWriter, UnitOfWork } from '../ports';
import type { AdvisorTaskStore } from './ports';
import type { AdvisorTaskInput, AdvisorTaskSnapshot } from './types';

/**
 * Advisor tasks — the reachable, context-rich path to a person (L6).
 *
 * Every automated flow can end here, and the thing that makes it work is not
 * the queue but the *brief*: one line an advisor can act on from a phone screen
 * without opening the thread, plus the structured context the console turns
 * into a deep link. A handoff that arrives as "customer needs help" is a
 * handoff that sits unread.
 */

export interface AdvisorTaskDeps<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly tasks: AdvisorTaskStore<Tx>;
  readonly audit: AuditAppender<Tx>;
  readonly outbox: OutboxWriter<Tx>;
  readonly clock?: Clock;
}

export class AdvisorTaskService<Tx> {
  private readonly clock: Clock;

  constructor(private readonly deps: AdvisorTaskDeps<Tx>) {
    this.clock = deps.clock ?? systemClock;
  }

  async create(
    input: AdvisorTaskInput & { readonly actor: Actor; readonly traceId: string },
  ): Promise<string> {
    const now = this.clock.now();

    return this.deps.uow.transaction(async (tx) => {
      const taskId = await this.deps.tasks.create(tx, uuidv7(), input, now);

      await this.deps.audit.append(tx, {
        shopId: input.shopId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'advisor_task.created',
        entityType: 'AdvisorTask',
        entityId: taskId,
        payload: {
          kind: input.kind,
          urgency: input.urgency,
          brief: input.brief,
          jobCardId: input.jobCardId ?? null,
          conversationId: input.conversationId ?? null,
          approvalRequestId: input.approvalRequestId ?? null,
          dedupeKey: input.dedupeKey ?? null,
        },
        traceId: input.traceId,
      });

      const envelope: EventEnvelope = {
        id: uuidv7(),
        type: 'advisor_task.created',
        occurredAt: now.toISOString(),
        shopId: input.shopId,
        traceId: input.traceId,
        payload: {
          taskId,
          kind: input.kind,
          urgency: input.urgency,
          jobCardId: input.jobCardId ?? null,
          conversationId: input.conversationId ?? null,
          brief: input.brief,
          actor: { type: input.actor.type, id: input.actor.id },
        },
      };
      await this.deps.outbox.enqueue(tx, envelope);

      return taskId;
    });
  }

  async list(
    shopId: string,
    status: AdvisorTaskStatus = 'OPEN',
    limit = 50,
  ): Promise<readonly AdvisorTaskSnapshot[]> {
    return this.deps.uow.transaction(async (tx) =>
      this.deps.tasks.list(tx, shopId, status, limit),
    );
  }

  async resolve(input: {
    readonly shopId: string;
    readonly taskId: string;
    readonly status: Extract<AdvisorTaskStatus, 'DONE' | 'CANCELLED' | 'IN_PROGRESS'>;
    readonly staffId: string | null;
    readonly note: string;
    readonly traceId: string;
  }): Promise<void> {
    const now = this.clock.now();

    await this.deps.uow.transaction(async (tx) => {
      await this.deps.tasks.resolve(tx, {
        shopId: input.shopId,
        taskId: input.taskId,
        status: input.status,
        staffId: input.staffId,
        note: input.note,
        at: now,
      });

      await this.deps.audit.append(tx, {
        shopId: input.shopId,
        actorType: 'STAFF',
        actorId: input.staffId,
        action: 'advisor_task.resolved',
        entityType: 'AdvisorTask',
        entityId: input.taskId,
        payload: { status: input.status, note: input.note },
        traceId: input.traceId,
      });
    });
  }

  /**
   * Clears the open tasks a decided approval no longer needs.
   *
   * A customer who approves at 14:05 must not leave a "call now" task in an
   * advisor's list at 14:30 — the call would be actively unhelpful, and the
   * advisor's trust in the queue is the thing being spent.
   */
  async cancelForApproval(input: {
    readonly shopId: string;
    readonly approvalId: string;
    readonly traceId: string;
  }): Promise<number> {
    const now = this.clock.now();
    return this.deps.uow.transaction(async (tx) =>
      this.deps.tasks.cancelForApproval(tx, input.shopId, input.approvalId, now),
    );
  }
}
