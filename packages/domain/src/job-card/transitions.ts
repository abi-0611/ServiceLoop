import { JOB_CARD_EVENTS, type JobCardEvent, type JobCardState } from '@serviceloop/shared';
import { assertNever } from '../assert-never';

/**
 * JobCard state machine — the single source of truth (master §4).
 *
 *   DRAFT → OPEN → IN_DIAGNOSIS → AWAITING_APPROVAL ⇄ IN_PROGRESS → AWAITING_PARTS
 *      → IN_PROGRESS → QUALITY_CHECK → READY_FOR_DELIVERY → AWAITING_PAYMENT
 *      → DELIVERED → CLOSED            (CANCELLED reachable from any pre-DELIVERED state)
 *
 * The AWAITING_PAYMENT position is shop-configurable, so both orderings are
 * edges here and `guards.ts` decides which one a given shop may take:
 *   payment-first : READY_FOR_DELIVERY → AWAITING_PAYMENT → DELIVERED → CLOSED
 *   delivery-first: READY_FOR_DELIVERY → DELIVERED → AWAITING_PAYMENT → DELIVERED → CLOSED
 *
 * This module is pure: no clock, no IO, no configuration. Everything that needs
 * context lives in `guards.ts`, and persistence lives in `transition-service.ts`.
 */

export type JobCardTransitionTable = Readonly<{
  [S in JobCardState]: Readonly<Partial<Record<JobCardEvent, JobCardState>>>;
}>;

export const JOB_CARD_TRANSITIONS: JobCardTransitionTable = {
  DRAFT: { OPEN_CARD: 'OPEN', CANCEL: 'CANCELLED' },
  OPEN: { BEGIN_DIAGNOSIS: 'IN_DIAGNOSIS', CANCEL: 'CANCELLED' },
  IN_DIAGNOSIS: { REQUEST_APPROVAL: 'AWAITING_APPROVAL', CANCEL: 'CANCELLED' },
  AWAITING_APPROVAL: { APPROVAL_GRANTED: 'IN_PROGRESS', CANCEL: 'CANCELLED' },
  IN_PROGRESS: {
    REQUEST_APPROVAL: 'AWAITING_APPROVAL',
    PARTS_AWAITED: 'AWAITING_PARTS',
    WORK_COMPLETED: 'QUALITY_CHECK',
    CANCEL: 'CANCELLED',
  },
  AWAITING_PARTS: { PARTS_RECEIVED: 'IN_PROGRESS', CANCEL: 'CANCELLED' },
  QUALITY_CHECK: { QUALITY_PASSED: 'READY_FOR_DELIVERY', CANCEL: 'CANCELLED' },
  READY_FOR_DELIVERY: {
    PAYMENT_REQUESTED: 'AWAITING_PAYMENT',
    VEHICLE_DELIVERED: 'DELIVERED',
    CANCEL: 'CANCELLED',
  },
  AWAITING_PAYMENT: { PAYMENT_SETTLED: 'DELIVERED', CANCEL: 'CANCELLED' },
  DELIVERED: { PAYMENT_REQUESTED: 'AWAITING_PAYMENT', CLOSE: 'CLOSED' },
  CLOSED: {},
  CANCELLED: {},
};

export const TERMINAL_JOB_CARD_STATES: readonly JobCardState[] = ['CLOSED', 'CANCELLED'];

export function isTerminalJobCardState(state: JobCardState): boolean {
  return TERMINAL_JOB_CARD_STATES.includes(state);
}

/**
 * Pure edge lookup. Returns `null` when the pair is not an edge at all — the
 * caller decides whether that is an error (it always is, in the service).
 */
export function nextJobCardState(state: JobCardState, event: JobCardEvent): JobCardState | null {
  switch (state) {
    case 'DRAFT':
    case 'OPEN':
    case 'IN_DIAGNOSIS':
    case 'AWAITING_APPROVAL':
    case 'IN_PROGRESS':
    case 'AWAITING_PARTS':
    case 'QUALITY_CHECK':
    case 'READY_FOR_DELIVERY':
    case 'AWAITING_PAYMENT':
    case 'DELIVERED':
    case 'CLOSED':
    case 'CANCELLED':
      return JOB_CARD_TRANSITIONS[state][event] ?? null;
    default:
      return assertNever(state, 'JobCardState');
  }
}

export function allowedJobCardEvents(state: JobCardState): JobCardEvent[] {
  return JOB_CARD_EVENTS.filter((event) => nextJobCardState(state, event) !== null);
}

/** True when `event` is an edge from `state`, ignoring guards. */
export function isJobCardEdge(state: JobCardState, event: JobCardEvent): boolean {
  return nextJobCardState(state, event) !== null;
}
