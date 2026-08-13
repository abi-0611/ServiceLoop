import { getEnv } from '@serviceloop/config';
import { DEAD_LETTER_QUEUE, QUEUE_NAMES, type QueueName } from '@serviceloop/shared';
import { Queue, type ConnectionOptions } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';

/**
 * BullMQ wiring.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ's blocking commands, and
 * the Redis instance is configured `noeviction` in compose — a delayed
 * escalation job must never be evicted under memory pressure.
 */

export function createRedis(url: string = getEnv().REDIS_URL): Redis {
  return new IORedis(url, { maxRetriesPerRequest: null, enableReadyCheck: true });
}

export function connectionFor(redis: Redis): ConnectionOptions {
  return redis as unknown as ConnectionOptions;
}

export interface QueueSet {
  readonly queues: ReadonlyMap<QueueName, Queue>;
  readonly deadLetter: Queue;
  close(): Promise<void>;
}

export function createQueues(redis: Redis): QueueSet {
  const connection = connectionFor(redis);
  const env = getEnv();

  const queues = new Map<QueueName, Queue>(
    QUEUE_NAMES.map((name) => [
      name,
      new Queue(name, {
        connection,
        defaultJobOptions: {
          attempts: env.QUEUE_MAX_ATTEMPTS,
          backoff: { type: 'exponential', delay: 1_000 },
          removeOnComplete: { age: 3_600, count: 5_000 },
          removeOnFail: false,
        },
      }),
    ]),
  );

  const deadLetter = new Queue(DEAD_LETTER_QUEUE, {
    connection,
    defaultJobOptions: { attempts: 1, removeOnComplete: false, removeOnFail: false },
  });

  return {
    queues,
    deadLetter,
    async close() {
      await Promise.all([...queues.values()].map((queue) => queue.close()));
      await deadLetter.close();
    },
  };
}
