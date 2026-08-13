import { migrateShopConfig, type ShopConfig } from '@serviceloop/config';
import {
  type Clock,
  type EventEnvelope,
  type JobCardEvent,
  type JobCardState,
  NotFoundError,
  systemClock,
  uuidv7,
} from '@serviceloop/shared';
import { IllegalTransitionError, TransitionGuardError } from '../errors';
import type {
  AuditAppender,
  JobCardStore,
  OutboxWriter,
  ShopConfigStore,
  UnitOfWork,
} from '../ports';
import type { Actor, JobCardGuardContext } from './context';
import { evaluateJobCardGuard } from './guards';
import { nextJobCardState } from './transitions';

/**
 * The only way a JobCard changes state (master §4).
 *
 * One transaction does all four things: guard check → state write → audit
 * append → outbox insert. A rejected attempt is *also* recorded — the audit
 * trail must show that someone tried to skip the approval step — so rejections
 * commit their audit row and then throw to the caller.
 */

export interface JobCardTransitionRequest {
  readonly shopId: string;
  readonly jobCardId: string;
  readonly event: JobCardEvent;
  readonly actor: Actor;
  readonly traceId: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface JobCardTransitionResult {
  readonly jobCardId: string;
  readonly from: JobCardState;
  readonly to: JobCardState;
  readonly auditEventId: string;
  readonly outboxEventId: string;
}

export interface JobCardTransitionDeps<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly cards: JobCardStore<Tx>;
  readonly config: ShopConfigStore<Tx>;
  readonly audit: AuditAppender<Tx>;
  readonly outbox: OutboxWriter<Tx>;
  readonly clock?: Clock;
}

type Outcome =
  | { readonly kind: 'applied'; readonly result: JobCardTransitionResult }
  | {
      readonly kind: 'illegal';
      readonly from: JobCardState;
      readonly event: JobCardEvent;
    }
  | {
      readonly kind: 'refused';
      readonly from: JobCardState;
      readonly event: JobCardEvent;
      readonly code: string;
      readonly reason: string;
    };

export class JobCardTransitionService<Tx> {
  private readonly clock: Clock;

  constructor(private readonly deps: JobCardTransitionDeps<Tx>) {
    this.clock = deps.clock ?? systemClock;
  }

  async transition(request: JobCardTransitionRequest): Promise<JobCardTransitionResult> {
    const outcome = await this.deps.uow.transaction(async (tx) => this.run(tx, request));

    switch (outcome.kind) {
      case 'applied':
        return outcome.result;
      case 'illegal':
        throw new IllegalTransitionError('JobCard', request.jobCardId, outcome.from, outcome.event);
      case 'refused':
        throw new TransitionGuardError(
          'JobCard',
          request.jobCardId,
          outcome.from,
          outcome.event,
          outcome.code,
          outcome.reason,
        );
    }
  }

  /** Legal-and-permitted check with no writes; drives the console's action list. */
  async canTransition(
    shopId: string,
    jobCardId: string,
    event: JobCardEvent,
  ): Promise<{ allowed: boolean; reason: string | null }> {
    return this.deps.uow.transaction(async (tx) => {
      const card = await this.deps.cards.lockCard(tx, shopId, jobCardId);
      if (card === null) throw new NotFoundError('JobCard', jobCardId);
      if (nextJobCardState(card.state, event) === null) {
        return { allowed: false, reason: `${event} is not a legal transition from ${card.state}` };
      }
      const context = await this.buildContext(tx, shopId, jobCardId, card.state, card.version);
      const guard = evaluateJobCardGuard(card.state, event, context);
      return guard.allowed
        ? { allowed: true, reason: null }
        : { allowed: false, reason: guard.reason };
    });
  }

  private async run(tx: Tx, request: JobCardTransitionRequest): Promise<Outcome> {
    const { shopId, jobCardId, event, actor, traceId } = request;
    const now = this.clock.now();

    const card = await this.deps.cards.lockCard(tx, shopId, jobCardId);
    if (card === null) throw new NotFoundError('JobCard', jobCardId);

    const target = nextJobCardState(card.state, event);
    if (target === null) {
      await this.recordRejection(tx, request, card.state, 'ILLEGAL_TRANSITION', now, {
        reason: `${event} is not a legal transition from ${card.state}`,
      });
      return { kind: 'illegal', from: card.state, event };
    }

    const context = await this.buildContext(tx, shopId, jobCardId, card.state, card.version, now);
    const guard = evaluateJobCardGuard(card.state, event, context);
    if (!guard.allowed) {
      await this.recordRejection(tx, request, card.state, guard.code, now, {
        reason: guard.reason,
      });
      return { kind: 'refused', from: card.state, event, code: guard.code, reason: guard.reason };
    }

    await this.deps.cards.writeState(tx, {
      shopId,
      jobCardId,
      from: card.state,
      to: target,
      at: now,
      expectedVersion: card.version,
    });

    const auditRecord = await this.deps.audit.append(tx, {
      shopId,
      actorType: actor.type,
      actorId: actor.id,
      action: 'job_card.state_changed',
      entityType: 'JobCard',
      entityId: jobCardId,
      payload: {
        from: card.state,
        to: target,
        event,
        meta: request.meta ?? {},
      },
      traceId,
    });

    const envelope: EventEnvelope = {
      id: uuidv7(),
      type: 'job_card.state_changed',
      occurredAt: now.toISOString(),
      shopId,
      traceId,
      payload: {
        jobCardId,
        from: card.state,
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
        jobCardId,
        from: card.state,
        to: target,
        auditEventId: auditRecord.id,
        outboxEventId: envelope.id,
      },
    };
  }

  private async recordRejection(
    tx: Tx,
    request: JobCardTransitionRequest,
    from: JobCardState,
    code: string,
    now: Date,
    extra: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.deps.audit.append(tx, {
      shopId: request.shopId,
      actorType: request.actor.type,
      actorId: request.actor.id,
      action: 'job_card.transition_rejected',
      entityType: 'JobCard',
      entityId: request.jobCardId,
      payload: { from, event: request.event, code, ...extra },
      traceId: request.traceId,
    });

    const reason = typeof extra['reason'] === 'string' ? extra['reason'] : code;
    await this.deps.outbox.enqueue(tx, {
      id: uuidv7(),
      type: 'job_card.transition_rejected',
      occurredAt: now.toISOString(),
      shopId: request.shopId,
      traceId: request.traceId,
      payload: {
        jobCardId: request.jobCardId,
        from,
        event: request.event,
        reason,
        actor: { type: request.actor.type, id: request.actor.id },
      },
    });
  }

  private async buildContext(
    tx: Tx,
    shopId: string,
    jobCardId: string,
    state: JobCardState,
    version: number,
    now: Date = this.clock.now(),
  ): Promise<JobCardGuardContext> {
    // Sequential on purpose: `tx` is a single database connection, and issuing
    // concurrent queries on one connection is a deprecated pattern in node-pg.
    const workItems = await this.deps.cards.loadWorkItems(tx, shopId, jobCardId);
    const outstandingBalancePaise = await this.deps.cards.loadOutstandingBalancePaise(
      tx,
      shopId,
      jobCardId,
    );
    const config = await this.loadConfig(tx, shopId);

    return {
      card: { id: jobCardId, shopId, state, version },
      workItems,
      config,
      outstandingBalancePaise,
      now,
    };
  }

  private async loadConfig(tx: Tx, shopId: string): Promise<ShopConfig> {
    const stored = await this.deps.config.load(tx, shopId);
    const timezone = (await this.deps.config.loadShopTimezone(tx, shopId)) ?? 'Asia/Kolkata';
    return migrateShopConfig(stored?.raw ?? {}, timezone).config;
  }
}
