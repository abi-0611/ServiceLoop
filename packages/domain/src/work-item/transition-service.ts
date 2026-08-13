import {
  type Clock,
  type EventEnvelope,
  NotFoundError,
  systemClock,
  uuidv7,
  type WorkItemEvent,
  type WorkItemState,
} from '@serviceloop/shared';
import { IllegalTransitionError, TransitionGuardError } from '../errors';
import type { Actor } from '../job-card/context';
import type { AuditAppender, OutboxWriter, UnitOfWork, WorkItemStore } from '../ports';
import { isLedgerEvent, nextWorkItemState } from './transitions';

/**
 * The WorkItem counterpart of `JobCardTransitionService`, with the same
 * one-transaction contract. DECLINE and DEFER additionally write the
 * DeclinedWorkLedger row that phase 6 re-pitches from — losing that write would
 * silently destroy recoverable revenue, so it shares the transaction.
 */

export interface WorkItemTransitionRequest {
  readonly shopId: string;
  readonly workItemId: string;
  readonly event: WorkItemEvent;
  readonly actor: Actor;
  readonly traceId: string;
  /** Required for DECLINE and DEFER — the ledger is useless without a reason. */
  readonly reason?: string;
  /** When a DEFERRED item should be re-pitched. Defaults to 90 days out. */
  readonly followUpAfter?: Date;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface WorkItemTransitionResult {
  readonly workItemId: string;
  readonly jobCardId: string;
  readonly from: WorkItemState;
  readonly to: WorkItemState;
  readonly auditEventId: string;
  readonly outboxEventId: string;
}

export interface WorkItemTransitionDeps<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly items: WorkItemStore<Tx>;
  readonly audit: AuditAppender<Tx>;
  readonly outbox: OutboxWriter<Tx>;
  readonly clock?: Clock;
}

export const DEFAULT_DEFERRAL_HORIZON_DAYS = 90;

type Outcome =
  | { readonly kind: 'applied'; readonly result: WorkItemTransitionResult }
  | { readonly kind: 'illegal'; readonly from: WorkItemState }
  | {
      readonly kind: 'refused';
      readonly from: WorkItemState;
      readonly code: string;
      readonly reason: string;
    };

export class WorkItemTransitionService<Tx> {
  private readonly clock: Clock;

  constructor(private readonly deps: WorkItemTransitionDeps<Tx>) {
    this.clock = deps.clock ?? systemClock;
  }

  async transition(request: WorkItemTransitionRequest): Promise<WorkItemTransitionResult> {
    const outcome = await this.deps.uow.transaction(async (tx) => this.run(tx, request));

    switch (outcome.kind) {
      case 'applied':
        return outcome.result;
      case 'illegal':
        throw new IllegalTransitionError(
          'WorkItem',
          request.workItemId,
          outcome.from,
          request.event,
        );
      case 'refused':
        throw new TransitionGuardError(
          'WorkItem',
          request.workItemId,
          outcome.from,
          request.event,
          outcome.code,
          outcome.reason,
        );
    }
  }

  private async run(tx: Tx, request: WorkItemTransitionRequest): Promise<Outcome> {
    const { shopId, workItemId, event, actor, traceId } = request;
    const now = this.clock.now();

    const item = await this.deps.items.lockWorkItem(tx, shopId, workItemId);
    if (item === null) throw new NotFoundError('WorkItem', workItemId);

    const target = nextWorkItemState(item.state, event);
    if (target === null) {
      await this.recordRejection(tx, request, item.state, 'ILLEGAL_TRANSITION', {
        reason: `${event} is not a legal transition from ${item.state}`,
      });
      return { kind: 'illegal', from: item.state };
    }

    const reason = request.reason?.trim() ?? '';
    if (isLedgerEvent(event) && reason.length === 0) {
      await this.recordRejection(tx, request, item.state, 'REASON_REQUIRED', {
        reason: `${event} requires a reason so the declined-work ledger can re-pitch it later`,
      });
      return {
        kind: 'refused',
        from: item.state,
        code: 'REASON_REQUIRED',
        reason: `${event} requires a reason so the declined-work ledger can re-pitch it later`,
      };
    }

    await this.deps.items.writeState(tx, {
      shopId,
      workItemId,
      from: item.state,
      to: target,
      at: now,
    });

    if (isLedgerEvent(event)) {
      const followUpAfter =
        event === 'DEFER'
          ? (request.followUpAfter ??
            new Date(now.getTime() + DEFAULT_DEFERRAL_HORIZON_DAYS * 24 * 60 * 60 * 1000))
          : (request.followUpAfter ?? null);

      await this.deps.items.recordDeclineOrDefer(tx, {
        shopId,
        workItemId,
        jobCardId: item.jobCardId,
        kind: event === 'DECLINE' ? 'DECLINED' : 'DEFERRED',
        reason,
        followUpAfter,
      });
    }

    const auditRecord = await this.deps.audit.append(tx, {
      shopId,
      actorType: actor.type,
      actorId: actor.id,
      action: 'work_item.state_changed',
      entityType: 'WorkItem',
      entityId: workItemId,
      payload: {
        jobCardId: item.jobCardId,
        from: item.state,
        to: target,
        event,
        reason: reason === '' ? null : reason,
        meta: request.meta ?? {},
      },
      traceId,
    });

    const envelope: EventEnvelope = {
      id: uuidv7(),
      type: 'work_item.state_changed',
      occurredAt: now.toISOString(),
      shopId,
      traceId,
      payload: {
        workItemId,
        jobCardId: item.jobCardId,
        from: item.state,
        to: target,
        event,
        actor: { type: actor.type, id: actor.id },
        meta: { ...(request.meta ?? {}) },
      },
    };
    await this.deps.outbox.enqueue(tx, envelope);

    return {
      kind: 'applied',
      result: {
        workItemId,
        jobCardId: item.jobCardId,
        from: item.state,
        to: target,
        auditEventId: auditRecord.id,
        outboxEventId: envelope.id,
      },
    };
  }

  private async recordRejection(
    tx: Tx,
    request: WorkItemTransitionRequest,
    from: WorkItemState,
    code: string,
    extra: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.deps.audit.append(tx, {
      shopId: request.shopId,
      actorType: request.actor.type,
      actorId: request.actor.id,
      action: 'work_item.transition_rejected',
      entityType: 'WorkItem',
      entityId: request.workItemId,
      payload: { from, event: request.event, code, ...extra },
      traceId: request.traceId,
    });
  }
}
