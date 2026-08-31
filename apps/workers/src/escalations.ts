import type { EscalationLadderEngine, RungScheduler } from '@serviceloop/domain';
import type { Tx } from '@serviceloop/db';
import { ESCALATION_QUEUE } from '@serviceloop/shared';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { Logger } from 'pino';
import { z } from 'zod';

/**
 * The escalation ladder's delayed-job side (phase 3.7).
 *
 * A rung is two things: a row and a timer. The **row is the authority** — this
 * worker's whole contribution is to say "it is time" and let
 * `EscalationLadderEngine.fireRung` decide whether anything should happen. A job
 * that fires for a rung the customer has already answered finds it `CANCELLED`
 * and does nothing, which is what makes the cancellation safe even when
 * removing the timer fails.
 *
 * The job id is the escalation id. BullMQ de-duplicates on it, so a rung
 * scheduled twice by a redelivered event has one timer, not two.
 */

const RungJobSchema = z.object({
  escalationId: z.string().uuid(),
  shopId: z.string().uuid(),
  subjectId: z.string().uuid(),
});

export type RungJob = z.infer<typeof RungJobSchema>;

/**
 * A `RungScheduler` over BullMQ.
 *
 * `cancel` is best effort by contract, not by accident: the row has already been
 * marked cancelled by the time this is called, so a removal that fails leaves a
 * job that will fire and immediately find nothing to do.
 */
export class BullMqRungScheduler implements RungScheduler {
  constructor(
    private readonly queue: Queue,
    private readonly logger?: Logger,
  ) {}

  async enqueue(input: {
    readonly escalationId: string;
    readonly shopId: string;
    readonly subjectId: string;
    readonly runAt: Date;
  }): Promise<string | null> {
    const delay = Math.max(0, input.runAt.getTime() - Date.now());

    const job = await this.queue.add(
      'rung',
      {
        escalationId: input.escalationId,
        shopId: input.shopId,
        subjectId: input.subjectId,
      } satisfies RungJob,
      {
        // The escalation id *is* the job id, so a duplicate schedule is a
        // duplicate insert Redis refuses rather than a second timer.
        jobId: input.escalationId,
        delay,
        removeOnComplete: { age: 86_400, count: 10_000 },
        removeOnFail: false,
      },
    );

    return job.id ?? null;
  }

  async cancel(jobId: string): Promise<void> {
    try {
      const job = await this.queue.getJob(jobId);
      await job?.remove();
    } catch (error) {
      // Deliberately swallowed: the row is already CANCELLED, so the worst case
      // is a job that fires and finds nothing to do.
      this.logger?.debug({ err: error, jobId }, 'could not remove escalation job');
    }
  }
}

export function createEscalationQueue(connection: ConnectionOptions): Queue {
  return new Queue(ESCALATION_QUEUE, {
    connection,
    defaultJobOptions: {
      // One attempt: a rung that failed should not be retried blindly, because
      // "retry" here means "message the customer again". The ladder's next rung
      // is the retry, and an operator sees the failure in the row.
      attempts: 1,
      removeOnComplete: { age: 86_400, count: 10_000 },
      removeOnFail: false,
    },
  });
}

export interface EscalationWorkerOptions {
  readonly connection: ConnectionOptions;
  readonly ladder: EscalationLadderEngine<Tx>;
  readonly logger: Logger;
  readonly concurrency: number;
}

export function createEscalationWorker(options: EscalationWorkerOptions): Worker {
  const worker = new Worker(
    ESCALATION_QUEUE,
    async (job) => {
      const parsed = RungJobSchema.safeParse(job.data);
      if (!parsed.success) {
        // A malformed job cannot be retried into correctness, and throwing would
        // put a customer-facing rung into the retry loop this queue exists
        // without. Logged and dropped.
        options.logger.error({ jobId: job.id, issues: parsed.error.issues }, 'malformed rung job');
        return { outcome: 'SKIPPED', detail: 'malformed job payload' };
      }

      const result = await options.ladder.fireRung({
        shopId: parsed.data.shopId,
        escalationId: parsed.data.escalationId,
        traceId: `escalation:${parsed.data.escalationId}`,
      });

      options.logger.info(
        {
          escalationId: parsed.data.escalationId,
          subjectId: parsed.data.subjectId,
          outcome: result.outcome,
          detail: result.detail,
        },
        'escalation rung fired',
      );

      return result;
    },
    { connection: options.connection, concurrency: options.concurrency },
  );

  worker.on('failed', (job, error) => {
    options.logger.error({ jobId: job?.id, err: error }, 'escalation rung failed');
  });

  return worker;
}
