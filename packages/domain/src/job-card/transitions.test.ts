import {
  JOB_CARD_EVENTS,
  JOB_CARD_STATES,
  type JobCardEvent,
  type JobCardState,
} from '@serviceloop/shared';
import { describe, expect, it } from 'vitest';
import { dominantBlockingState, isJobCardStateStale } from './dominant-state';
import type { WorkItemSnapshot } from './context';
import { allowedJobCardEvents, isTerminalJobCardState, nextJobCardState } from './transitions';

/**
 * The edge list transcribed directly from `00_MASTER_PROMPT.md` §4. This is the
 * specification; the implementation table must equal it exactly, and every one
 * of the 12 × 13 = 156 (state, event) pairs is checked against it.
 */
const SPEC_EDGES: ReadonlyArray<readonly [JobCardState, JobCardEvent, JobCardState]> = [
  ['DRAFT', 'OPEN_CARD', 'OPEN'],
  ['OPEN', 'BEGIN_DIAGNOSIS', 'IN_DIAGNOSIS'],
  ['IN_DIAGNOSIS', 'REQUEST_APPROVAL', 'AWAITING_APPROVAL'],
  ['AWAITING_APPROVAL', 'APPROVAL_GRANTED', 'IN_PROGRESS'],
  ['IN_PROGRESS', 'REQUEST_APPROVAL', 'AWAITING_APPROVAL'],
  ['IN_PROGRESS', 'PARTS_AWAITED', 'AWAITING_PARTS'],
  ['AWAITING_PARTS', 'PARTS_RECEIVED', 'IN_PROGRESS'],
  ['IN_PROGRESS', 'WORK_COMPLETED', 'QUALITY_CHECK'],
  ['QUALITY_CHECK', 'QUALITY_PASSED', 'READY_FOR_DELIVERY'],
  // Payment ordering is shop-configurable, so both edges exist and guards decide.
  ['READY_FOR_DELIVERY', 'PAYMENT_REQUESTED', 'AWAITING_PAYMENT'],
  ['READY_FOR_DELIVERY', 'VEHICLE_DELIVERED', 'DELIVERED'],
  ['AWAITING_PAYMENT', 'PAYMENT_SETTLED', 'DELIVERED'],
  ['DELIVERED', 'PAYMENT_REQUESTED', 'AWAITING_PAYMENT'],
  ['DELIVERED', 'CLOSE', 'CLOSED'],
  // CANCELLED is reachable from any pre-DELIVERED state.
  ['DRAFT', 'CANCEL', 'CANCELLED'],
  ['OPEN', 'CANCEL', 'CANCELLED'],
  ['IN_DIAGNOSIS', 'CANCEL', 'CANCELLED'],
  ['AWAITING_APPROVAL', 'CANCEL', 'CANCELLED'],
  ['IN_PROGRESS', 'CANCEL', 'CANCELLED'],
  ['AWAITING_PARTS', 'CANCEL', 'CANCELLED'],
  ['QUALITY_CHECK', 'CANCEL', 'CANCELLED'],
  ['READY_FOR_DELIVERY', 'CANCEL', 'CANCELLED'],
  ['AWAITING_PAYMENT', 'CANCEL', 'CANCELLED'],
];

function specTarget(state: JobCardState, event: JobCardEvent): JobCardState | null {
  return SPEC_EDGES.find(([from, on]) => from === state && on === event)?.[2] ?? null;
}

describe('JobCard transition matrix', () => {
  const pairs: Array<[JobCardState, JobCardEvent]> = [];
  for (const state of JOB_CARD_STATES) {
    for (const event of JOB_CARD_EVENTS) {
      pairs.push([state, event]);
    }
  }

  it('covers every state and event exactly once', () => {
    expect(pairs).toHaveLength(JOB_CARD_STATES.length * JOB_CARD_EVENTS.length);
    expect(pairs).toHaveLength(156);
  });

  it.each(pairs)('(%s, %s) matches the specification', (state, event) => {
    expect(nextJobCardState(state, event)).toBe(specTarget(state, event));
  });

  it('implements every specified edge and no others', () => {
    const implemented = pairs
      .map(([state, event]) => [state, event, nextJobCardState(state, event)] as const)
      .filter(([, , target]) => target !== null);
    expect(implemented).toHaveLength(SPEC_EDGES.length);
  });

  it('makes CANCELLED reachable from every pre-DELIVERED state and no later one', () => {
    const preDelivered: JobCardState[] = [
      'DRAFT',
      'OPEN',
      'IN_DIAGNOSIS',
      'AWAITING_APPROVAL',
      'IN_PROGRESS',
      'AWAITING_PARTS',
      'QUALITY_CHECK',
      'READY_FOR_DELIVERY',
      'AWAITING_PAYMENT',
    ];
    for (const state of preDelivered) {
      expect(nextJobCardState(state, 'CANCEL'), state).toBe('CANCELLED');
    }
    for (const state of ['DELIVERED', 'CLOSED', 'CANCELLED'] as JobCardState[]) {
      expect(nextJobCardState(state, 'CANCEL'), state).toBeNull();
    }
  });

  it('leaves terminal states with no outgoing edges', () => {
    for (const state of JOB_CARD_STATES) {
      if (isTerminalJobCardState(state)) {
        expect(allowedJobCardEvents(state), state).toEqual([]);
      } else {
        expect(allowedJobCardEvents(state).length, state).toBeGreaterThan(0);
      }
    }
  });

  it('reaches READY_FOR_DELIVERY from DRAFT along the happy path', () => {
    const path: JobCardEvent[] = [
      'OPEN_CARD',
      'BEGIN_DIAGNOSIS',
      'REQUEST_APPROVAL',
      'APPROVAL_GRANTED',
      'WORK_COMPLETED',
      'QUALITY_PASSED',
    ];
    let state: JobCardState = 'DRAFT';
    for (const event of path) {
      const next = nextJobCardState(state, event);
      expect(next, `${state} --${event}-->`).not.toBeNull();
      state = next as JobCardState;
    }
    expect(state).toBe('READY_FOR_DELIVERY');
  });

  it('supports both payment orderings end to end', () => {
    // Payment before delivery
    expect(nextJobCardState('READY_FOR_DELIVERY', 'PAYMENT_REQUESTED')).toBe('AWAITING_PAYMENT');
    expect(nextJobCardState('AWAITING_PAYMENT', 'PAYMENT_SETTLED')).toBe('DELIVERED');
    expect(nextJobCardState('DELIVERED', 'CLOSE')).toBe('CLOSED');
    // Payment after delivery
    expect(nextJobCardState('READY_FOR_DELIVERY', 'VEHICLE_DELIVERED')).toBe('DELIVERED');
    expect(nextJobCardState('DELIVERED', 'PAYMENT_REQUESTED')).toBe('AWAITING_PAYMENT');
    expect(nextJobCardState('AWAITING_PAYMENT', 'PAYMENT_SETTLED')).toBe('DELIVERED');
  });
});

describe('dominant blocking state', () => {
  const item = (state: WorkItemSnapshot['state']): WorkItemSnapshot => ({
    id: `item-${state}`,
    shopId: 'shop',
    jobCardId: 'card',
    state,
    requiresApproval: true,
  });

  const cases: ReadonlyArray<readonly [string, WorkItemSnapshot['state'][], JobCardState | null]> =
    [
      ['no work items', [], null],
      ['a single proposed item', ['PROPOSED'], 'IN_DIAGNOSIS'],
      [
        'pending approval outranks work in progress',
        ['IN_PROGRESS', 'PENDING_APPROVAL'],
        'AWAITING_APPROVAL',
      ],
      ['pending approval outranks proposed', ['PROPOSED', 'PENDING_APPROVAL'], 'AWAITING_APPROVAL'],
      ['in progress outranks approved-not-started', ['APPROVED', 'IN_PROGRESS'], 'IN_PROGRESS'],
      ['approved but unstarted still blocks', ['APPROVED', 'DONE'], 'IN_PROGRESS'],
      ['in progress outranks proposed', ['PROPOSED', 'IN_PROGRESS'], 'IN_PROGRESS'],
      ['everything done blocks nothing', ['DONE', 'DONE'], null],
      ['declined and deferred block nothing', ['DECLINED', 'DEFERRED'], null],
      ['done alongside declined blocks nothing', ['DONE', 'DECLINED'], null],
    ];

  it.each(cases)('%s', (_label, states, expected) => {
    expect(dominantBlockingState(states.map(item))).toBe(expected);
  });

  it('flags a card whose recorded state disagrees with its work items', () => {
    expect(isJobCardStateStale('IN_PROGRESS', [item('PENDING_APPROVAL')])).toBe(true);
    expect(isJobCardStateStale('AWAITING_APPROVAL', [item('PENDING_APPROVAL')])).toBe(false);
  });

  it('never flags terminal or delivered cards', () => {
    for (const state of ['DELIVERED', 'CLOSED', 'CANCELLED'] as JobCardState[]) {
      expect(isJobCardStateStale(state, [item('PENDING_APPROVAL')]), state).toBe(false);
    }
  });
});
