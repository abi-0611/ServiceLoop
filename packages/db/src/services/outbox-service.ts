import type { OutboxWriter } from '@serviceloop/domain';
import {
  type EventEnvelope,
  EventEnvelopeSchema,
  type OutboxStatus,
  parseEventEnvelope,
} from '@serviceloop/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database, Executor, Tx } from '../client';
import { eventsOutbox, idempotencyKeys } from '../schema';

/**
 * Transactional outbox (phase 1.5).
 *
 * Writers insert the envelope in the same transaction as the state change.
 * The dispatcher claims a batch with `FOR UPDATE SKIP LOCKED` so several
 * dispatcher instances can drain the same table without stepping on each other,
 * publishes, and marks the batch dispatched inside the claim transaction.
 *
 * Delivery is therefore at-least-once; `IdempotencyGuard` on the consumer side
 * turns that into exactly-once *effects*.
 */

export interface ClaimedEvent {
  readonly id: string;
  readonly envelope: EventEnvelope;
  readonly attempts: number;
}

export class OutboxService implements OutboxWriter<Tx> {
  constructor(private readonly db: Database) {}

  async enqueue(tx: Tx, envelope: EventEnvelope): Promise<void> {
    // Validate on the way in as well as on the way out: a malformed event must
    // never reach the queue.
    const validated = EventEnvelopeSchema.parse(envelope);

    await tx.insert(eventsOutbox).values({
      id: validated.id,
      shopId: validated.shopId,
      type: validated.type,
      payload: validated.payload as Record<string, unknown>,
      occurredAt: new Date(validated.occurredAt),
      traceId: validated.traceId,
      status: 'PENDING',
    });
  }

  /**
   * Claims up to `limit` pending events for this dispatcher. Must be called
   * inside a transaction: the row locks are held until it commits.
   */
  async claimPendingBatch(tx: Tx, limit: number): Promise<ClaimedEvent[]> {
    const result = await tx.execute<{
      id: string;
      shop_id: string;
      type: string;
      payload: unknown;
      occurred_at: Date;
      trace_id: string;
      attempts: number;
    }>(sql`
      select id, shop_id, type, payload, occurred_at, trace_id, attempts
      from events_outbox
      where status = 'PENDING'
      order by occurred_at asc, id asc
      limit ${limit}
      for update skip locked
    `);

    return result.rows.map((row) => ({
      id: row.id,
      attempts: Number(row.attempts),
      envelope: parseEventEnvelope({
        id: row.id,
        type: row.type,
        occurredAt: new Date(row.occurred_at).toISOString(),
        shopId: row.shop_id,
        traceId: row.trace_id,
        payload: row.payload,
      }),
    }));
  }

  async markDispatched(tx: Tx, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await tx
      .update(eventsOutbox)
      .set({ status: 'DISPATCHED', dispatchedAt: new Date(), lastError: null })
      .where(inArray(eventsOutbox.id, [...ids]));
  }

  /**
   * Records a failed publish. The row stays PENDING (and is retried) until
   * `maxAttempts`, after which it is parked as FAILED for the dead-letter list.
   */
  async markFailed(
    tx: Tx,
    id: string,
    error: string,
    maxAttempts: number,
  ): Promise<{ attempts: number; parked: boolean }> {
    const result = await tx.execute<{ attempts: number; status: OutboxStatus }>(sql`
      update events_outbox
      set attempts = attempts + 1,
          last_error = ${error.slice(0, 2000)},
          status = case when attempts + 1 >= ${maxAttempts} then 'FAILED'::outbox_status else 'PENDING'::outbox_status end
      where id = ${id}
      returning attempts, status
    `);

    const row = result.rows[0];
    return {
      attempts: row === undefined ? 0 : Number(row.attempts),
      parked: row?.status === 'FAILED',
    };
  }

  async countByStatus(executor: Executor = this.db): Promise<Record<OutboxStatus, number>> {
    const rows = await executor
      .select({ status: eventsOutbox.status, count: sql<number>`count(*)::int` })
      .from(eventsOutbox)
      .groupBy(eventsOutbox.status);

    const counts: Record<OutboxStatus, number> = { PENDING: 0, DISPATCHED: 0, FAILED: 0 };
    for (const row of rows) counts[row.status] = Number(row.count);
    return counts;
  }

  async listDeadLettered(
    shopId: string | null,
    limit: number,
    executor: Executor = this.db,
  ): Promise<Array<typeof eventsOutbox.$inferSelect>> {
    const condition =
      shopId === null
        ? eq(eventsOutbox.status, 'FAILED')
        : and(eq(eventsOutbox.status, 'FAILED'), eq(eventsOutbox.shopId, shopId));

    return executor
      .select()
      .from(eventsOutbox)
      .where(condition)
      .orderBy(sql`${eventsOutbox.createdAt} desc`)
      .limit(limit);
  }

  /** Returns a parked event to the pending backlog (admin action). */
  async requeue(id: string, executor: Executor = this.db): Promise<boolean> {
    const result = await executor.execute(sql`
      update events_outbox
      set status = 'PENDING'::outbox_status, attempts = 0, last_error = null
      where id = ${id} and status = 'FAILED'
    `);
    return (result.rowCount ?? 0) > 0;
  }
}

/**
 * Consumer-side idempotency (phase 1.5): claim `(consumer, event_id)` inside
 * the handler's own transaction. A redelivered event fails to claim and the
 * handler skips its side effects.
 */
export class IdempotencyGuard {
  async claim(tx: Tx, consumer: string, eventId: string): Promise<boolean> {
    const result = await tx.execute(sql`
      insert into idempotency_keys (consumer, event_id)
      values (${consumer}, ${eventId})
      on conflict (consumer, event_id) do nothing
    `);
    return (result.rowCount ?? 0) > 0;
  }

  async recordResult(
    tx: Tx,
    consumer: string,
    eventId: string,
    result: Record<string, unknown>,
  ): Promise<void> {
    await tx
      .update(idempotencyKeys)
      .set({ result })
      .where(and(eq(idempotencyKeys.consumer, consumer), eq(idempotencyKeys.eventId, eventId)));
  }

  async seen(executor: Executor, consumer: string, eventId: string): Promise<boolean> {
    const rows = await executor
      .select({ eventId: idempotencyKeys.eventId })
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.consumer, consumer), eq(idempotencyKeys.eventId, eventId)))
      .limit(1);
    return rows.length > 0;
  }
}
