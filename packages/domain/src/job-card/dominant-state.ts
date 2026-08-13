import type { JobCardState, WorkItemState } from '@serviceloop/shared';
import { assertNever } from '../assert-never';
import type { WorkItemSnapshot } from './context';

/**
 * Dominant blocking state (master §4).
 *
 * Work items advance independently; the job card shows the one thing that is
 * actually holding the visit up. Priority runs from "waiting on the customer"
 * down to "waiting on us", because an advisor scanning the board needs the
 * customer-blocked cards to surface first.
 *
 * Returns `null` when no work item imposes a blocking state — a card whose
 * items are all DONE, DECLINED or DEFERRED is blocked by nothing, and its state
 * is then driven purely by explicit transitions.
 */

const PRIORITY: readonly WorkItemState[] = [
  'PENDING_APPROVAL', // customer decision outstanding
  'IN_PROGRESS', // technician actively working
  'APPROVED', // approved, not started
  'PROPOSED', // still being written up
];

function blockingStateFor(state: WorkItemState): JobCardState | null {
  switch (state) {
    case 'PENDING_APPROVAL':
      return 'AWAITING_APPROVAL';
    case 'IN_PROGRESS':
    case 'APPROVED':
      return 'IN_PROGRESS';
    case 'PROPOSED':
      return 'IN_DIAGNOSIS';
    case 'DECLINED':
    case 'DEFERRED':
    case 'DONE':
      return null;
    default:
      return assertNever(state, 'WorkItemState');
  }
}

export function dominantBlockingState(workItems: readonly WorkItemSnapshot[]): JobCardState | null {
  for (const candidate of PRIORITY) {
    if (workItems.some((item) => item.state === candidate)) {
      return blockingStateFor(candidate);
    }
  }
  return null;
}

/**
 * True when the card's recorded state disagrees with what its work items imply.
 * The console surfaces this as a nudge; it never auto-corrects, because state
 * changes happen only through `JobCardTransitionService`.
 */
export function isJobCardStateStale(
  cardState: JobCardState,
  workItems: readonly WorkItemSnapshot[],
): boolean {
  const dominant = dominantBlockingState(workItems);
  if (dominant === null) return false;
  if (cardState === 'CLOSED' || cardState === 'CANCELLED' || cardState === 'DELIVERED')
    return false;
  return dominant !== cardState;
}
