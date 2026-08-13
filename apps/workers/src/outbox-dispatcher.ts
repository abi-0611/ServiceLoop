import { type Database, OutboxService, PgUnitOfWork } from '@serviceloop/db';
import { queueForEventType, type EventEnvelope, type QueueName } from '@serviceloop/shared';
import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import { outboxBacklog, outboxDispatched, outboxFailed, outboxParked } from './metrics';

/**
 * Outbox dispatcher (phase 1.5).
 *
 * Loop: claim up to `batchSize` pending events with `FOR UPDATE SKIP LOCKED`,
 * publish each to its queue, mark the batch dispatched — all inside one
 * transaction, so a crash anywhere rolls the claim back and the events stay
 * pending. Delivery is at-least-once; consumers are idempotent.
 *
 * When a batch comes back empty the loop idles for `idleBackoffMs` rather than
 * hot-spinning on an empty table.
 */

export interface OutboxDispatcherOptions {
  readonly db: Database;
  readonly queues: ReadonlyMap<QueueName, Queue>;
  readonly logger: Logger;
  readonly batchSize: number;
  readonly idleBackoffMs: number;
  readonly maxAttempts: number;
}

export interface DispatchBatchResult {
  readonly claimed: number;
  readonly dispatched: number;
  readonly failed: number;
}

export class OutboxDispatcher {
  private readonly outbox: OutboxService;
  private readonly uow: PgUnitOfWork;
  private running = false;
  private stopped: Promise<void> = Promise.resolve();

  constructor(private readonly options: OutboxDispatcherOptions) {
    this.outbox = new OutboxService(options.db);
    this.uow = new PgUnitOfWork(options.db);
  }

  /** Drains one batch. Exposed so tests and the demo can step the loop. */
  async dispatchOnce(): Promise<DispatchBatchResult> {
    const failures: Array<{ id: string; type: string; error: string }> = [];

    const result = await this.uow.transaction(async (tx) => {
      const claimed = await this.outbox.claimPendingBatch(tx, this.options.batchSize);
      if (claimed.length === 0) return { claimed: 0, dispatched: 0, failed: 0 };

      const dispatchedIds: string[] = [];

      for (const event of claimed) {
        try {
          await this.publish(event.envelope);
          dispatchedIds.push(event.id);
        } catch (error) {
          failures.push({
            id: event.id,
            type: event.envelope.type,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      await this.outbox.markDispatched(tx, dispatchedIds);
      return { claimed: claimed.length, dispatched: dispatchedIds.length, failed: failures.length };
    });

    // Failures are recorded outside the claim transaction: that transaction
    // committed the successful half of the batch, and the attempt counter must
    // survive independently of it.
    for (const failure of failures) {
      const outcome = await this.uow.transaction(async (tx) =>
        this.outbox.markFailed(tx, failure.id, failure.error, this.options.maxAttempts),
      );
      outboxFailed.inc({ type: failure.type });
      if (outcome.parked) {
        outboxParked.inc({ type: failure.type });
        this.options.logger.error(
          { eventId: failure.id, type: failure.type, attempts: outcome.attempts },
          'outbox event parked after exhausting attempts',
        );
      }
    }

    if (result.dispatched > 0) {
      this.options.logger.debug(
        { claimed: result.claimed, dispatched: result.dispatched },
        'outbox batch dispatched',
      );
    }

    return result;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.stopped;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const result = await this.dispatchOnce();
        await this.refreshBacklogGauge();
        if (result.claimed === 0) await sleep(this.options.idleBackoffMs);
      } catch (error) {
        this.options.logger.error({ err: error }, 'outbox dispatch loop error');
        await sleep(Math.max(this.options.idleBackoffMs, 1_000));
      }
    }
  }

  private async publish(envelope: EventEnvelope): Promise<void> {
    const queueName = queueForEventType(envelope.type);
    const queue = this.options.queues.get(queueName);
    if (queue === undefined) throw new Error(`No queue registered for ${queueName}`);

    // The event id doubles as the BullMQ job id, so a redelivered event is
    // de-duplicated by Redis before it ever reaches a consumer.
    await queue.add(envelope.type, envelope, { jobId: envelope.id });
    outboxDispatched.inc({ queue: queueName, type: envelope.type });
  }

  private async refreshBacklogGauge(): Promise<void> {
    const counts = await this.outbox.countByStatus();
    for (const [status, count] of Object.entries(counts)) {
      outboxBacklog.set({ status }, count);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
