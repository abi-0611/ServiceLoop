import { formatAdapterSelection, getEnv } from '@serviceloop/config';
import { AuditService, createDatabase } from '@serviceloop/db';
import { QUEUE_NAMES } from '@serviceloop/shared';
import type { Worker } from 'bullmq';
import { createConsumer } from './consumer';
import { createChainIntegrityHandler } from './handlers/chain-integrity';
import { HandlerRegistry } from './handlers/registry';
import { createLogger } from './logger';
import { startMetricsServer } from './metrics';
import { OutboxDispatcher } from './outbox-dispatcher';
import { connectionFor, createQueues, createRedis } from './queues';

/**
 * Worker process: the outbox dispatcher plus one consumer per queue.
 *
 * Shutdown is ordered so nothing is lost: stop claiming new work, let in-flight
 * jobs finish, then close connections.
 */
async function main(): Promise<void> {
  const env = getEnv();
  const logger = createLogger('workers');

  logger.info({ demoMode: env.DEMO_MODE, nodeEnv: env.NODE_ENV }, 'starting workers');
  for (const line of formatAdapterSelection(env)) logger.info(line);

  const database = createDatabase(env);
  const redis = createRedis(env.REDIS_URL);
  const queueSet = createQueues(redis);
  const audit = new AuditService(database.db, redis);

  const registry = new HandlerRegistry().register(createChainIntegrityHandler(audit));
  logger.info(
    { handlers: registry.all().map((handler) => handler.name) },
    'event handlers registered',
  );

  const dispatcher = new OutboxDispatcher({
    db: database.db,
    queues: queueSet.queues,
    logger: logger.child({ component: 'outbox-dispatcher' }),
    batchSize: env.OUTBOX_BATCH_SIZE,
    idleBackoffMs: env.OUTBOX_IDLE_BACKOFF_MS,
    maxAttempts: env.OUTBOX_MAX_ATTEMPTS,
  });

  const consumers: Worker[] = QUEUE_NAMES.map((queueName) =>
    createConsumer({
      queueName,
      connection: connectionFor(redis),
      db: database.db,
      registry,
      deadLetterQueue: queueSet.deadLetter,
      logger: logger.child({ queue: queueName }),
      concurrency: env.WORKER_CONCURRENCY,
      maxAttempts: env.QUEUE_MAX_ATTEMPTS,
    }),
  );

  let healthy = true;
  const metricsServer = startMetricsServer(env.WORKERS_METRICS_PORT, () => healthy);
  dispatcher.start();

  logger.info({ queues: QUEUE_NAMES, metricsPort: env.WORKERS_METRICS_PORT }, 'workers ready');

  const shutdown = async (signal: string): Promise<void> => {
    healthy = false;
    logger.info({ signal }, 'shutting down workers');
    await dispatcher.stop();
    await Promise.all(consumers.map((consumer) => consumer.close()));
    await queueSet.close();
    await redis.quit();
    await database.close();
    metricsServer.close();
    logger.info('workers stopped');
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void shutdown(signal).then(
        () => process.exit(0),
        (error: unknown) => {
          logger.error({ err: error }, 'unclean shutdown');
          process.exit(1);
        },
      );
    });
  }
}

main().catch((error: unknown) => {
  console.error('[workers] failed to start');
  console.error(error);
  process.exit(1);
});
