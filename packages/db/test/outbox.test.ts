import { type EventEnvelope, uuidv7 } from '@serviceloop/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgUnitOfWork, type Database, type Tx } from '../src/client';
import { eventsOutbox, shops } from '../src/schema';
import { IdempotencyGuard, OutboxService } from '../src/services/outbox-service';
import { startTestDatabase, truncateAll, type TestDatabase } from './harness';

/**
 * Outbox behaviour under the failure modes phase 1.5 names: duplicate delivery
 * and a dispatcher that dies mid-batch.
 */

let harness: TestDatabase;
let db: Database;
let outbox: OutboxService;
let uow: PgUnitOfWork;

const SHOP_ID = '01930000-0000-7000-8000-00000000cc01';

beforeAll(async () => {
  harness = await startTestDatabase();
  db = harness.db;
  outbox = new OutboxService(db);
  uow = new PgUnitOfWork(db);
});

afterAll(async () => {
  await harness.stop();
});

beforeEach(async () => {
  await truncateAll(db);
  await db.insert(shops).values({ id: SHOP_ID, name: 'Outbox Motors', city: 'Chennai' });
});

function envelope(index: number): EventEnvelope {
  return {
    id: uuidv7(),
    type: 'job_card.state_changed',
    occurredAt: new Date(Date.now() + index).toISOString(),
    shopId: SHOP_ID,
    traceId: `trace-${index}`,
    payload: {
      jobCardId: uuidv7(),
      from: 'OPEN',
      to: 'IN_DIAGNOSIS',
      event: 'BEGIN_DIAGNOSIS',
      actor: { type: 'SYSTEM', id: null },
      meta: {},
    },
  };
}

async function enqueue(count: number): Promise<EventEnvelope[]> {
  const envelopes = Array.from({ length: count }, (_unused, index) => envelope(index));
  await uow.transaction(async (tx) => {
    for (const item of envelopes) await outbox.enqueue(tx, item);
  });
  return envelopes;
}

describe('outbox dispatch', () => {
  it('rejects a malformed envelope before it can reach a queue', async () => {
    await expect(
      uow.transaction(async (tx: Tx) =>
        outbox.enqueue(tx, {
          id: uuidv7(),
          type: 'job_card.state_changed',
          occurredAt: new Date().toISOString(),
          shopId: SHOP_ID,
          traceId: 'bad',
          // Missing `to`, `event` and `actor`.
          payload: { jobCardId: uuidv7(), from: 'OPEN' },
        } as unknown as EventEnvelope),
      ),
    ).rejects.toThrow();

    expect(await db.select().from(eventsOutbox)).toHaveLength(0);
  });

  it('claims, publishes and marks a batch dispatched exactly once', async () => {
    await enqueue(5);
    const published: string[] = [];

    await uow.transaction(async (tx) => {
      const claimed = await outbox.claimPendingBatch(tx, 100);
      expect(claimed).toHaveLength(5);
      for (const event of claimed) published.push(event.id);
      await outbox.markDispatched(
        tx,
        claimed.map((event) => event.id),
      );
    });

    expect(published).toHaveLength(5);
    expect(await outbox.countByStatus()).toEqual({ PENDING: 0, DISPATCHED: 5, FAILED: 0 });

    // A second pass finds nothing left to do.
    await uow.transaction(async (tx) => {
      expect(await outbox.claimPendingBatch(tx, 100)).toHaveLength(0);
    });
  });

  it('does not hand the same event to two concurrent dispatchers', async () => {
    await enqueue(20);

    const claimAndHold = async (): Promise<string[]> =>
      uow.transaction(async (tx) => {
        const claimed = await outbox.claimPendingBatch(tx, 10);
        // Hold the locks briefly so the two claims genuinely overlap.
        await new Promise((resolve) => setTimeout(resolve, 120));
        await outbox.markDispatched(
          tx,
          claimed.map((event) => event.id),
        );
        return claimed.map((event) => event.id);
      });

    const [first, second] = await Promise.all([claimAndHold(), claimAndHold()]);
    const overlap = first.filter((id) => second.includes(id));

    expect(overlap).toHaveLength(0);
    expect(new Set([...first, ...second]).size).toBe(20);
    expect(await outbox.countByStatus()).toEqual({ PENDING: 0, DISPATCHED: 20, FAILED: 0 });
  });

  it('loses nothing when the dispatcher dies mid-batch', async () => {
    const envelopes = await enqueue(6);

    await expect(
      uow.transaction(async (tx) => {
        const claimed = await outbox.claimPendingBatch(tx, 6);
        await outbox.markDispatched(
          tx,
          claimed.slice(0, 3).map((event) => event.id),
        );
        throw new Error('dispatcher crashed mid-batch');
      }),
    ).rejects.toThrow(/crashed/);

    // The transaction rolled back, so every event is still pending.
    expect(await outbox.countByStatus()).toEqual({ PENDING: 6, DISPATCHED: 0, FAILED: 0 });

    const redelivered: string[] = [];
    await uow.transaction(async (tx) => {
      const claimed = await outbox.claimPendingBatch(tx, 100);
      for (const event of claimed) redelivered.push(event.id);
      await outbox.markDispatched(
        tx,
        claimed.map((event) => event.id),
      );
    });

    expect(redelivered.sort()).toEqual(envelopes.map((item) => item.id).sort());
  });

  it('parks an event as FAILED after the configured attempts and can requeue it', async () => {
    const [only] = await enqueue(1);
    const eventId = (only as EventEnvelope).id;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const outcome = await uow.transaction(async (tx) =>
        outbox.markFailed(tx, eventId, `publish failed (attempt ${attempt})`, 3),
      );
      expect(outcome.attempts).toBe(attempt);
      expect(outcome.parked).toBe(attempt === 3);
    }

    expect(await outbox.countByStatus()).toEqual({ PENDING: 0, DISPATCHED: 0, FAILED: 1 });
    const dead = await outbox.listDeadLettered(SHOP_ID, 10);
    expect(dead).toHaveLength(1);
    expect(dead[0]?.lastError).toContain('attempt 3');

    expect(await outbox.requeue(eventId)).toBe(true);
    expect(await outbox.countByStatus()).toEqual({ PENDING: 1, DISPATCHED: 0, FAILED: 0 });
    expect(await outbox.requeue(eventId)).toBe(false);
  });

  it('drains in occurred-at order', async () => {
    const envelopes = await enqueue(8);
    await uow.transaction(async (tx) => {
      const claimed = await outbox.claimPendingBatch(tx, 8);
      expect(claimed.map((event) => event.id)).toEqual(envelopes.map((item) => item.id));
      await outbox.markDispatched(
        tx,
        claimed.map((event) => event.id),
      );
    });
  });
});

describe('consumer idempotency', () => {
  it('gives the side effect to the first delivery only', async () => {
    const guard = new IdempotencyGuard();
    const eventId = uuidv7();
    let sideEffects = 0;

    const handle = async (): Promise<boolean> =>
      uow.transaction(async (tx) => {
        const claimed = await guard.claim(tx, 'test-consumer', eventId);
        if (!claimed) return false;
        sideEffects += 1;
        await guard.recordResult(tx, 'test-consumer', eventId, { sideEffects });
        return true;
      });

    expect(await handle()).toBe(true);
    expect(await handle()).toBe(false);
    expect(await handle()).toBe(false);
    expect(sideEffects).toBe(1);
    expect(await guard.seen(db, 'test-consumer', eventId)).toBe(true);
  });

  it('scopes the claim per consumer, so two consumers both see the event', async () => {
    const guard = new IdempotencyGuard();
    const eventId = uuidv7();

    expect(await uow.transaction((tx) => guard.claim(tx, 'consumer-a', eventId))).toBe(true);
    expect(await uow.transaction((tx) => guard.claim(tx, 'consumer-b', eventId))).toBe(true);
    expect(await uow.transaction((tx) => guard.claim(tx, 'consumer-a', eventId))).toBe(false);
  });

  it('rolls the claim back when the handler throws, so a retry can succeed', async () => {
    const guard = new IdempotencyGuard();
    const eventId = uuidv7();

    await expect(
      uow.transaction(async (tx) => {
        await guard.claim(tx, 'flaky-consumer', eventId);
        throw new Error('handler blew up');
      }),
    ).rejects.toThrow(/blew up/);

    expect(await guard.seen(db, 'flaky-consumer', eventId)).toBe(false);
    expect(await uow.transaction((tx) => guard.claim(tx, 'flaky-consumer', eventId))).toBe(true);
  });

  it('keeps outbox rows scoped to their shop for the admin dead-letter view', async () => {
    const otherShop = uuidv7();
    await db.insert(shops).values({ id: otherShop, name: 'Other', city: 'Erode' });
    const [mine] = await enqueue(1);

    await db
      .update(eventsOutbox)
      .set({ status: 'FAILED' })
      .where(eq(eventsOutbox.id, (mine as EventEnvelope).id));

    expect(await outbox.listDeadLettered(SHOP_ID, 10)).toHaveLength(1);
    expect(await outbox.listDeadLettered(otherShop, 10)).toHaveLength(0);
    expect(await outbox.listDeadLettered(null, 10)).toHaveLength(1);
  });
});
