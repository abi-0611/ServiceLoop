import { AppError } from '@serviceloop/shared';
import type { JobCardEvent, JobCardState, WorkItemEvent, WorkItemState } from '@serviceloop/shared';

export class DomainError extends AppError {}

/** The (state, event) pair is not an edge in the state machine at all. */
export class IllegalTransitionError extends DomainError {
  constructor(
    readonly entity: 'JobCard' | 'WorkItem',
    readonly entityId: string,
    readonly from: JobCardState | WorkItemState,
    readonly event: JobCardEvent | WorkItemEvent,
  ) {
    super(
      'ILLEGAL_TRANSITION',
      `${entity} ${entityId}: ${event} is not a legal transition from ${from}`,
      409,
      { entity, entityId, from, event },
    );
  }
}

/** The edge exists but a business guard refused it. */
export class TransitionGuardError extends DomainError {
  constructor(
    readonly entity: 'JobCard' | 'WorkItem',
    readonly entityId: string,
    readonly from: JobCardState | WorkItemState,
    readonly event: JobCardEvent | WorkItemEvent,
    readonly guardCode: string,
    reason: string,
  ) {
    super('TRANSITION_GUARD_FAILED', reason, 409, { entity, entityId, from, event, guardCode });
  }
}

export class GuardrailViolationError extends DomainError {
  constructor(guardCode: string, reason: string, details: Record<string, unknown> = {}) {
    super('GUARDRAIL_VIOLATION', reason, 422, { guardCode, ...details });
  }
}

export class AuditChainError extends DomainError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('AUDIT_CHAIN_BROKEN', message, 500, details);
  }
}
