import { defaultShopConfig } from '@serviceloop/config';
import { fixedClock, NotFoundError, uuidv7 } from '@serviceloop/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { verifyAuditChain } from '../audit/chain';
import { IllegalTransitionError, TransitionGuardError } from '../errors';
import { createDomainTestHarness, type DomainTestHarness } from '../testing/in-memory';
import type { Actor } from './context';
import { JobCardTransitionService } from './transition-service';

const SHOP_ID = uuidv7();
const ADVISOR: Actor = { type: 'STAFF', id: uuidv7(), displayName: 'Advisor' };
const NOW = new Date('2026-04-01T09:00:00.000Z');

function setup(options: { paymentBeforeDelivery?: boolean } = {}): {
  harness: DomainTestHarness;
  service: JobCardTransitionService<{ id: string }>;
} {
  const harness = createDomainTestHarness(() => NOW);
  harness.world.addShop(SHOP_ID);

  const config = defaultShopConfig();
  harness.world.configs.set(SHOP_ID, {
    ...config,
    payments: { paymentBeforeDelivery: options.paymentBeforeDelivery ?? true },
  });

  const service = new JobCardTransitionService({
    uow: harness.uow,
    cards: harness.cards,
    config: harness.config,
    audit: harness.audit,
    outbox: harness.outbox,
    clock: fixedClock(NOW),
  });

  return { harness, service };
}

describe('JobCardTransitionService', () => {
  let harness: DomainTestHarness;
  let service: JobCardTransitionService<{ id: string }>;

  beforeEach(() => {
    ({ harness, service } = setup());
  });

  it('applies a legal transition, audits it, and emits exactly one outbox event', async () => {
    const card = harness.world.addCard({ shopId: SHOP_ID, state: 'OPEN' });

    const result = await service.transition({
      shopId: SHOP_ID,
      jobCardId: card.id,
      event: 'BEGIN_DIAGNOSIS',
      actor: ADVISOR,
      traceId: 'trace-1',
    });

    expect(result.from).toBe('OPEN');
    expect(result.to).toBe('IN_DIAGNOSIS');
    expect(harness.world.cards.get(card.id)?.state).toBe('IN_DIAGNOSIS');
    expect(harness.world.cards.get(card.id)?.version).toBe(2);

    const audit = harness.world.auditFor(SHOP_ID);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.action).toBe('job_card.state_changed');
    expect(audit[0]?.actorId).toBe(ADVISOR.id);

    expect(harness.world.outbox).toHaveLength(1);
    const [envelope] = harness.world.outbox;
    expect(envelope?.type).toBe('job_card.state_changed');
    expect(envelope?.shopId).toBe(SHOP_ID);
    expect(envelope?.traceId).toBe('trace-1');
  });

  it('rejects an illegal transition, still audits the attempt, and changes nothing', async () => {
    const card = harness.world.addCard({ shopId: SHOP_ID, state: 'OPEN' });

    await expect(
      service.transition({
        shopId: SHOP_ID,
        jobCardId: card.id,
        event: 'PAYMENT_SETTLED',
        actor: ADVISOR,
        traceId: 'trace-2',
      }),
    ).rejects.toBeInstanceOf(IllegalTransitionError);

    expect(harness.world.cards.get(card.id)?.state).toBe('OPEN');
    expect(harness.world.cards.get(card.id)?.version).toBe(1);

    const audit = harness.world.auditFor(SHOP_ID);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.action).toBe('job_card.transition_rejected');
    expect(audit[0]?.payload).toMatchObject({ from: 'OPEN', event: 'PAYMENT_SETTLED' });

    expect(harness.world.outbox.map((envelope) => envelope.type)).toEqual([
      'job_card.transition_rejected',
    ]);
  });

  it('refuses to request approval when there is nothing to approve', async () => {
    const card = harness.world.addCard({ shopId: SHOP_ID, state: 'IN_DIAGNOSIS' });

    const attempt = service.transition({
      shopId: SHOP_ID,
      jobCardId: card.id,
      event: 'REQUEST_APPROVAL',
      actor: ADVISOR,
      traceId: 'trace-3',
    });

    await expect(attempt).rejects.toBeInstanceOf(TransitionGuardError);
    await expect(attempt).rejects.toMatchObject({ details: { guardCode: 'NO_WORK_TO_APPROVE' } });
    expect(harness.world.cards.get(card.id)?.state).toBe('IN_DIAGNOSIS');
    expect(harness.world.auditFor(SHOP_ID)[0]?.action).toBe('job_card.transition_rejected');
  });

  it('allows the approval request once a work item is proposed', async () => {
    const card = harness.world.addCard({ shopId: SHOP_ID, state: 'IN_DIAGNOSIS' });
    harness.world.addWorkItem({ shopId: SHOP_ID, jobCardId: card.id, state: 'PROPOSED' });

    const result = await service.transition({
      shopId: SHOP_ID,
      jobCardId: card.id,
      event: 'REQUEST_APPROVAL',
      actor: ADVISOR,
      traceId: 'trace-4',
    });

    expect(result.to).toBe('AWAITING_APPROVAL');
  });

  it('refuses to complete work while an approved item is unfinished', async () => {
    const card = harness.world.addCard({ shopId: SHOP_ID, state: 'IN_PROGRESS' });
    harness.world.addWorkItem({ shopId: SHOP_ID, jobCardId: card.id, state: 'APPROVED' });

    await expect(
      service.transition({
        shopId: SHOP_ID,
        jobCardId: card.id,
        event: 'WORK_COMPLETED',
        actor: ADVISOR,
        traceId: 'trace-5',
      }),
    ).rejects.toMatchObject({ details: { guardCode: 'APPROVED_WORK_UNFINISHED' } });
  });

  it('refuses to bill a card that still holds unapproved required work', async () => {
    const card = harness.world.addCard({ shopId: SHOP_ID, state: 'READY_FOR_DELIVERY' });
    harness.world.addWorkItem({
      shopId: SHOP_ID,
      jobCardId: card.id,
      state: 'PENDING_APPROVAL',
      requiresApproval: true,
    });

    await expect(
      service.transition({
        shopId: SHOP_ID,
        jobCardId: card.id,
        event: 'PAYMENT_REQUESTED',
        actor: ADVISOR,
        traceId: 'trace-6',
      }),
    ).rejects.toMatchObject({ details: { guardCode: 'UNAPPROVED_REQUIRED_WORK' } });
  });

  it('enforces the shop payment ordering in both directions', async () => {
    const paymentFirst = setup({ paymentBeforeDelivery: true });
    const card = paymentFirst.harness.world.addCard({
      shopId: SHOP_ID,
      state: 'READY_FOR_DELIVERY',
    });
    paymentFirst.harness.world.balances.set(card.id, 250_000);

    await expect(
      paymentFirst.service.transition({
        shopId: SHOP_ID,
        jobCardId: card.id,
        event: 'VEHICLE_DELIVERED',
        actor: ADVISOR,
        traceId: 'trace-7',
      }),
    ).rejects.toMatchObject({ details: { guardCode: 'PAYMENT_REQUIRED_BEFORE_DELIVERY' } });

    const deliveryFirst = setup({ paymentBeforeDelivery: false });
    const other = deliveryFirst.harness.world.addCard({
      shopId: SHOP_ID,
      state: 'READY_FOR_DELIVERY',
    });
    deliveryFirst.harness.world.balances.set(other.id, 250_000);

    const delivered = await deliveryFirst.service.transition({
      shopId: SHOP_ID,
      jobCardId: other.id,
      event: 'VEHICLE_DELIVERED',
      actor: ADVISOR,
      traceId: 'trace-8',
    });
    expect(delivered.to).toBe('DELIVERED');
  });

  it('refuses to close a card with an outstanding balance', async () => {
    const card = harness.world.addCard({ shopId: SHOP_ID, state: 'DELIVERED' });
    harness.world.balances.set(card.id, 5_000);

    await expect(
      service.transition({
        shopId: SHOP_ID,
        jobCardId: card.id,
        event: 'CLOSE',
        actor: ADVISOR,
        traceId: 'trace-9',
      }),
    ).rejects.toMatchObject({ details: { guardCode: 'OUTSTANDING_BALANCE' } });

    harness.world.balances.set(card.id, 0);
    const closed = await service.transition({
      shopId: SHOP_ID,
      jobCardId: card.id,
      event: 'CLOSE',
      actor: ADVISOR,
      traceId: 'trace-10',
    });
    expect(closed.to).toBe('CLOSED');
  });

  it('does not leak the existence of another shop’s card', async () => {
    const otherShop = uuidv7();
    harness.world.addShop(otherShop);
    const card = harness.world.addCard({ shopId: otherShop, state: 'OPEN' });

    await expect(
      service.transition({
        shopId: SHOP_ID,
        jobCardId: card.id,
        event: 'BEGIN_DIAGNOSIS',
        actor: ADVISOR,
        traceId: 'trace-11',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rolls the whole transaction back when a write fails', async () => {
    const card = harness.world.addCard({ shopId: SHOP_ID, state: 'OPEN' });
    // Simulate a lost update: another writer bumped the version mid-transition.
    const failing = new JobCardTransitionService({
      uow: harness.uow,
      cards: {
        ...harness.cards,
        lockCard: harness.cards.lockCard.bind(harness.cards),
        loadWorkItems: harness.cards.loadWorkItems.bind(harness.cards),
        loadOutstandingBalancePaise: harness.cards.loadOutstandingBalancePaise.bind(harness.cards),
        writeState: async () => {
          throw new Error('optimistic lock failure');
        },
      },
      config: harness.config,
      audit: harness.audit,
      outbox: harness.outbox,
      clock: fixedClock(NOW),
    });

    await expect(
      failing.transition({
        shopId: SHOP_ID,
        jobCardId: card.id,
        event: 'BEGIN_DIAGNOSIS',
        actor: ADVISOR,
        traceId: 'trace-12',
      }),
    ).rejects.toThrow(/optimistic lock failure/);

    expect(harness.world.cards.get(card.id)?.state).toBe('OPEN');
    expect(harness.world.auditFor(SHOP_ID)).toHaveLength(0);
    expect(harness.world.outbox).toHaveLength(0);
  });

  it('keeps the audit chain verifiable across a full lifecycle', async () => {
    const card = harness.world.addCard({ shopId: SHOP_ID, state: 'DRAFT' });
    const item = harness.world.addWorkItem({
      shopId: SHOP_ID,
      jobCardId: card.id,
      state: 'PROPOSED',
    });

    const run = async (event: Parameters<typeof service.transition>[0]['event']) =>
      service.transition({
        shopId: SHOP_ID,
        jobCardId: card.id,
        event,
        actor: ADVISOR,
        traceId: 'lifecycle',
      });

    await run('OPEN_CARD');
    await run('BEGIN_DIAGNOSIS');
    await run('REQUEST_APPROVAL');
    harness.world.items.set(item.id, { ...item, state: 'DONE' });
    await run('APPROVAL_GRANTED');
    await run('WORK_COMPLETED');
    await run('QUALITY_PASSED');

    expect(harness.world.cards.get(card.id)?.state).toBe('READY_FOR_DELIVERY');
    expect(verifyAuditChain(harness.world.auditFor(SHOP_ID))).toMatchObject({
      valid: true,
      entriesChecked: 6,
      brokenAtIndex: null,
    });
    expect(harness.world.outbox).toHaveLength(6);
  });

  it('reports whether a transition is available without writing anything', async () => {
    const card = harness.world.addCard({ shopId: SHOP_ID, state: 'IN_DIAGNOSIS' });

    expect(await service.canTransition(SHOP_ID, card.id, 'REQUEST_APPROVAL')).toEqual({
      allowed: false,
      reason: expect.stringContaining('no proposed or pending work items'),
    });
    expect(await service.canTransition(SHOP_ID, card.id, 'CANCEL')).toEqual({
      allowed: true,
      reason: null,
    });
    expect(await service.canTransition(SHOP_ID, card.id, 'CLOSE')).toEqual({
      allowed: false,
      reason: expect.stringContaining('not a legal transition'),
    });

    expect(harness.world.auditFor(SHOP_ID)).toHaveLength(0);
    expect(harness.world.outbox).toHaveLength(0);
  });
});
