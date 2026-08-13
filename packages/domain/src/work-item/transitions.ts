import { WORK_ITEM_EVENTS, type WorkItemEvent, type WorkItemState } from '@serviceloop/shared';
import { assertNever } from '../assert-never';

/**
 * WorkItem state machine (master §4):
 *   PROPOSED → PENDING_APPROVAL → { APPROVED | DECLINED | DEFERRED } → IN_PROGRESS → DONE
 *
 * DECLINED and DEFERRED are terminal for the item itself; recovery happens in
 * the DeclinedWorkLedger and produces a *new* item on a later visit, so the
 * original decision stays immutable evidence of what the customer said.
 */

export type WorkItemTransitionTable = Readonly<{
  [S in WorkItemState]: Readonly<Partial<Record<WorkItemEvent, WorkItemState>>>;
}>;

export const WORK_ITEM_TRANSITIONS: WorkItemTransitionTable = {
  PROPOSED: { SUBMIT_FOR_APPROVAL: 'PENDING_APPROVAL' },
  PENDING_APPROVAL: { APPROVE: 'APPROVED', DECLINE: 'DECLINED', DEFER: 'DEFERRED' },
  APPROVED: { START: 'IN_PROGRESS' },
  IN_PROGRESS: { COMPLETE: 'DONE' },
  DECLINED: {},
  DEFERRED: {},
  DONE: {},
};

export const TERMINAL_WORK_ITEM_STATES: readonly WorkItemState[] = ['DECLINED', 'DEFERRED', 'DONE'];

export function nextWorkItemState(
  state: WorkItemState,
  event: WorkItemEvent,
): WorkItemState | null {
  switch (state) {
    case 'PROPOSED':
    case 'PENDING_APPROVAL':
    case 'APPROVED':
    case 'DECLINED':
    case 'DEFERRED':
    case 'IN_PROGRESS':
    case 'DONE':
      return WORK_ITEM_TRANSITIONS[state][event] ?? null;
    default:
      return assertNever(state, 'WorkItemState');
  }
}

export function allowedWorkItemEvents(state: WorkItemState): WorkItemEvent[] {
  return WORK_ITEM_EVENTS.filter((event) => nextWorkItemState(state, event) !== null);
}

/** Events whose outcome must also be written to the DeclinedWorkLedger. */
export function isLedgerEvent(event: WorkItemEvent): event is 'DECLINE' | 'DEFER' {
  return event === 'DECLINE' || event === 'DEFER';
}
