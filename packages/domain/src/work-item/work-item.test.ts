import { fixedClock, uuidv7, WORK_ITEM_EVENTS, WORK_ITEM_STATES } from '@serviceloop/shared';
import type { WorkItemEvent, WorkItemState } from '@serviceloop/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { IllegalTransitionError, TransitionGuardError } from '../errors';
import { createDomainTestHarness, type DomainTestHarness } from '../testing/in-memory';
import { WorkItemTransitionService } from './transition-service';
import { allowedWorkItemEvents, nextWorkItemState } from './transitions';

const SHOP_ID = uuidv7();
const NOW = new Date('2026-04-01T09:00:00.000Z');
const TECHNICIAN = { type: 'STAFF', id: uuidv7() } as const;

const SPEC_EDGES: ReadonlyArray<readonly [WorkItemState, WorkItemEvent, WorkItemState]> = [
  ['PROPOSED', 'SUBMIT_FOR_APPROVAL', 'PENDING_APPROVAL'],
  ['PENDING_APPROVAL', 'APPROVE', 'APPROVED'],
  ['PENDING_APPROVAL', 'DECLINE', 'DECLINED'],
  ['PENDING_APPROVAL', 'DEFER', 'DEFERRED'],
  ['APPROVED', 'START', 'IN_PROGRESS'],
  ['IN_PROGRESS', 'COMPLETE', 'DONE'],
];

describe('WorkItem transition matrix', () => {
  const pairs: Array<[WorkItemState, WorkItemEvent]> = [];
  for (const state of WORK_ITEM_STATES) {
    for (const event of WORK_ITEM_EVENTS) {
      pairs.push([state, event]);
    }
  }

  it.each(pairs)('(%s, %s) matches the specification', (state, event) => {
    const expected = SPEC_EDGES.find(([from, on]) => from === state && on === event)?.[2] ?? null;
    expect(nextWorkItemState(state, event)).toBe(expected);
  });

  it('treats DECLINED, DEFERRED and DONE as terminal', () => {
    for (const state of ['DECLINED', 'DEFERRED', 'DONE'] as WorkItemState[]) {
      expect(allowedWorkItemEvents(state), state).toEqual([]);
    }
  });
});

describe('WorkItemTransitionService', () => {
  let harness: DomainTestHarness;
  let service: WorkItemTransitionService<{ id: string }>;

  beforeEach(() => {
    harness = createDomainTestHarness(() => NOW);
    harness.world.addShop(SHOP_ID);
    service = new WorkItemTransitionService({
      uow: harness.uow,
      items: harness.items,
      audit: harness.audit,
      outbox: harness.outbox,
      clock: fixedClock(NOW),
    });
  });

  it('advances an item and records the audit and outbox entries', async () => {
    const item = harness.world.addWorkItem({
      shopId: SHOP_ID,
      jobCardId: 'card-1',
      state: 'PROPOSED',
    });

    const result = await service.transition({
      shopId: SHOP_ID,
      workItemId: item.id,
      event: 'SUBMIT_FOR_APPROVAL',
      actor: TECHNICIAN,
      traceId: 'trace-wi-1',
    });

    expect(result.to).toBe('PENDING_APPROVAL');
    expect(harness.world.items.get(item.id)?.state).toBe('PENDING_APPROVAL');
    expect(harness.world.auditFor(SHOP_ID)[0]?.action).toBe('work_item.state_changed');
    expect(harness.world.outbox[0]?.type).toBe('work_item.state_changed');
  });

  it('rejects an illegal transition and audits the attempt', async () => {
    const item = harness.world.addWorkItem({
      shopId: SHOP_ID,
      jobCardId: 'card-1',
      state: 'DONE',
    });

    await expect(
      service.transition({
        shopId: SHOP_ID,
        workItemId: item.id,
        event: 'START',
        actor: TECHNICIAN,
        traceId: 'trace-wi-2',
      }),
    ).rejects.toBeInstanceOf(IllegalTransitionError);

    expect(harness.world.auditFor(SHOP_ID)[0]?.action).toBe('work_item.transition_rejected');
  });

  it('writes a declined item to the ledger with its reason', async () => {
    const item = harness.world.addWorkItem({
      shopId: SHOP_ID,
      jobCardId: 'card-1',
      state: 'PENDING_APPROVAL',
    });

    await service.transition({
      shopId: SHOP_ID,
      workItemId: item.id,
      event: 'DECLINE',
      actor: { type: 'CUSTOMER', id: 'customer-1' },
      traceId: 'trace-wi-3',
      reason: 'Too expensive right now',
    });

    expect(harness.world.ledger).toHaveLength(1);
    expect(harness.world.ledger[0]).toMatchObject({
      kind: 'DECLINED',
      reason: 'Too expensive right now',
      followUpAfter: null,
    });
  });

  it('gives a deferred item a follow-up horizon', async () => {
    const item = harness.world.addWorkItem({
      shopId: SHOP_ID,
      jobCardId: 'card-1',
      state: 'PENDING_APPROVAL',
    });

    await service.transition({
      shopId: SHOP_ID,
      workItemId: item.id,
      event: 'DEFER',
      actor: { type: 'CUSTOMER', id: 'customer-1' },
      traceId: 'trace-wi-4',
      reason: 'Will do it next service',
    });

    const [row] = harness.world.ledger;
    expect(row?.kind).toBe('DEFERRED');
    expect(row?.followUpAfter).toBeInstanceOf(Date);
    expect(row?.followUpAfter?.getTime()).toBe(NOW.getTime() + 90 * 24 * 60 * 60 * 1000);
  });

  it('refuses to decline without a reason and leaves the item untouched', async () => {
    const item = harness.world.addWorkItem({
      shopId: SHOP_ID,
      jobCardId: 'card-1',
      state: 'PENDING_APPROVAL',
    });

    await expect(
      service.transition({
        shopId: SHOP_ID,
        workItemId: item.id,
        event: 'DECLINE',
        actor: { type: 'CUSTOMER', id: 'customer-1' },
        traceId: 'trace-wi-5',
        reason: '   ',
      }),
    ).rejects.toBeInstanceOf(TransitionGuardError);

    expect(harness.world.items.get(item.id)?.state).toBe('PENDING_APPROVAL');
    expect(harness.world.ledger).toHaveLength(0);
    expect(harness.world.auditFor(SHOP_ID)[0]?.payload).toMatchObject({ code: 'REASON_REQUIRED' });
  });
});
