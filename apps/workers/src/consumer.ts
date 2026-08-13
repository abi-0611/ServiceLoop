import { IdempotencyGuard, PgUnitOfWork, type Database } from '@serviceloop/db';
import {
  DEAD_LETTER_QUEUE,
  parseEventEnvelope,
  redactDeep,
  type EventEnvelope,
  type QueueName,
} from '@serviceloop/shared';
import { type Job, type Queue, Worker } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import type { Logger } from 'pino';
import { deadLettered, jobDuration, jobsProcessed } from './metrics';
import type { HandlerRegistry } from './handlers/registry';

/**
 * Consumer harness (phase 1.5).
 *
 * Each job: validate the envelope → open a transaction → claim
 * `(consumer, event_id)` in `idempotency_keys` → run every handler registered
 * for that event type → record the combined result. A redelivered event fails
 * the claim and returns without repeating side effects.
 *
 * Retries use the queue's exponential policy; a job that exhausts its attempts
 * is copied to the dead-letter queue with its error, where the admin endpoint
 * can list and requeue it.
 */

export interface ConsumerOptions {
  readonly queueName: QueueName;
  readonly connection: ConnectionOptions;
  readonly db: Database;
  readonly registry: HandlerRegistry;
  readonly deadLetterQueue: Queue;
  readonly logger: Logger;
  readonly concurrency: number;
  readonly maxAttempts: number;
}

export interface ProcessOutcome {
  readonly status: 'processed' | 'duplicate';
  readonly handlers: number;
  readonly results: Record<string, unknown>;
}

/**
 * Processes one envelope. Extracted from the Worker so tests can drive it
 * directly, including the forced-duplicate case.
 */
export async function processEnvelope(
  options: Pick<ConsumerOptions, 'queueName' | 'db' | 'registry' | 'logger'>,
  envelope: EventEnvelope,
): Promise<ProcessOutcome> {
  const guard = new IdempotencyGuard();
  const uow = new PgUnitOfWork(options.db);
  const consumer = `${options.queueName}:handlers`;

  return uow.transaction(async (tx) => {
    const claimed = await guard.claim(tx, consumer, envelope.id);
    if (!claimed) {
      options.logger.debug(
        { eventId: envelope.id, type: envelope.type },
        'duplicate delivery ignored',
      );
      return { status: 'duplicate', handlers: 0, results: {} };
    }

    const handlers = options.registry.for(envelope.type);
    const results: Record<string, unknown> = {};

    for (const handler of handlers) {
      results[handler.name] = await handler.handle({
        tx,
        db: options.db,
        envelope,
        logger: options.logger.child({ handler: handler.name }),
      });
    }

    await guard.recordResult(tx, consumer, envelope.id, {
      type: envelope.type,
      processedAt: new Date().toISOString(),
      handlers: handlers.map((handler) => handler.name),
      results,
    });

    return { status: 'processed', handlers: handlers.length, results };
  });
}

export function createConsumer(options: ConsumerOptions): Worker {
  const worker = new Worker(
    options.queueName,
    async (job: Job) => {
      const envelope = parseEventEnvelope(job.data);
      const stopTimer = jobDuration.startTimer({
        queue: options.queueName,
        type: envelope.type,
      });

      try {
        const outcome = await processEnvelope(options, envelope);
        jobsProcessed.inc({
          queue: options.queueName,
          type: envelope.type,
          outcome: outcome.status,
        });
        return outcome;
      } finally {
        stopTimer();
      }
    },
    {
      connection: options.connection,
      concurrency: options.concurrency,
      autorun: true,
    },
  );

  worker.on('failed', (job, error) => {
    const attemptsMade = job?.attemptsMade ?? 0;
    const type = typeof job?.name === 'string' ? job.name : 'unknown';

    options.logger.warn(
      { jobId: job?.id, type, attemptsMade, err: error.message },
      'queue job failed',
    );
    jobsProcessed.inc({ queue: options.queueName, type, outcome: 'failed' });

    if (attemptsMade >= options.maxAttempts && job !== undefined) {
      void options.deadLetterQueue
        .add(
          `${options.queueName}:${type}`,
          {
            queue: options.queueName,
            originalJobId: job.id,
            type,
            attemptsMade,
            failedReason: error.message,
            data: redactDeep(job.data),
            failedAt: new Date().toISOString(),
          },
          { jobId: `${DEAD_LETTER_QUEUE}:${String(job.id)}` },
        )
        .then(() => {
          deadLettered.inc({ queue: options.queueName, type });
          options.logger.error({ jobId: job.id, type }, 'job moved to the dead-letter queue');
        })
        .catch((deadLetterError: unknown) => {
          options.logger.error({ err: deadLetterError }, 'failed to dead-letter a job');
        });
    }
  });

  return worker;
}
