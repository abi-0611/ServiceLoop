import {
  createChannelPorts,
  createMediaPipeline,
  createStoragePort,
} from '@serviceloop/adapters';
import { formatAdapterSelection, getEnv } from '@serviceloop/config';
import {
  AuditService,
  createAgentStores,
  createDatabase,
  OutboxService,
  PgConsentStore,
  PgConversationStore,
  PgJobCardStore,
  PgMessageStore,
  PgShopConfigStore,
  PgShopDirectory,
  PgUnitOfWork,
  PgWorkItemStore,
  type Tx,
} from '@serviceloop/db';
import { createAgentRuntime, createLoopRuntime } from '@serviceloop/agent-core';
import {
  DeferredSendService,
  JobCardTransitionService,
  OutboundGate,
  WorkItemTransitionService,
} from '@serviceloop/domain';
import { defaultShopConfig } from '@serviceloop/config';
import { QUEUE_NAMES } from '@serviceloop/shared';
import type { Worker } from 'bullmq';
import { createConsumer } from './consumer';
import { DeferredSender, StorageMediaBytesLoader } from './deferred-sender';
import {
  BullMqRungScheduler,
  createEscalationQueue,
  createEscalationWorker,
} from './escalations';
import { createApprovalLadderHandler } from './handlers/approval-ladder';
import {
  createEtaCommsHandler,
  createEtaRequestHandler,
  createStateCommsHandler,
} from './handlers/status-comms';
import { ReminderSentinel, SilentBayScanner } from './sentinels';
import { createLoopStores, listActiveShopIds } from './loop-wiring';
import { createAudioTranscodeHandler } from './handlers/audio-transcode';
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

  const storage = createStoragePort(env);
  const mediaPipeline = createMediaPipeline(env, storage);
  const channels = createChannelPorts(env, { redis });

  // The quiet-hours release path. It shares the *single* OutboundGate contract
  // with the API: a held message is re-checked against consent, window, caps
  // and quiet hours before it leaves, exactly as a fresh send would be.
  const uow = new PgUnitOfWork(database.db);
  const outbox = new OutboxService(database.db);
  const gate = new OutboundGate<Tx>({
    uow,
    conversations: new PgConversationStore(),
    messages: new PgMessageStore(),
    consents: new PgConsentStore(),
    config: new PgShopConfigStore(),
    audit,
    outbox,
    sender: channels.sender,
  });

  const deferredSender = new DeferredSender({
    service: new DeferredSendService<Tx>({
      uow,
      messages: new PgMessageStore(),
      gate,
      media: new StorageMediaBytesLoader(database.db, storage),
    }),
    logger: logger.child({ component: 'deferred-sender' }),
    intervalMs: env.DEFERRED_SEND_POLL_MS,
    batchSize: env.DEFERRED_SEND_BATCH_SIZE,
  });

  /* Phase 3 — the escalation ladder.
   *
   * The worker owns the timers; the ladder owns the decisions. A rung whose
   * customer has already answered finds its row CANCELLED and does nothing,
   * which is why the queue can be best-effort and the row cannot. */
  const escalationQueue = createEscalationQueue(connectionFor(redis));
  const agentStores = createAgentStores();

  // One instance of each transition service, shared by the agent and the loop:
  // two would be two audit-chain writers for the same card.
  const jobCards = new JobCardTransitionService<Tx>({
    uow,
    cards: new PgJobCardStore(),
    config: new PgShopConfigStore(),
    audit,
    outbox,
  });
  const workItems = new WorkItemTransitionService<Tx>({
    uow,
    items: new PgWorkItemStore(),
    audit,
    outbox,
  });

  const agent = createAgentRuntime<Tx>({
    stores: {
      uow,
      ...agentStores,
      conversations: new PgConversationStore(),
      messages: new PgMessageStore(),
      config: new PgShopConfigStore(),
      directory: new PgShopDirectory(),
      audit,
      outbox,
    },
    gate,
    jobCards,
    workItems,
    scheduler: new BullMqRungScheduler(
      escalationQueue,
      logger.child({ component: 'escalations' }),
    ),
    llm: channels.llm,
    // The ladder reads each shop's own document per rung; this is only the
    // fallback for a tool call made outside a shop context.
    config: defaultShopConfig(env.DEFAULT_TIMEZONE),
    conversationTail: async () => [],
    loadHeld: async () => null,
    resolvePinnedCard: async () => null,
    scheduleFollowup: async () => 'not-scheduled',
    openObjectionObjective: async () => undefined,
  });

  /* Phase 4: the middle and the end of the loop. Assembled from the same
   * factory the API uses, so a bug cannot reproduce in only one process. */
  const loop = createLoopRuntime<Tx>(
    createLoopStores({
      uow,
      audit,
      outbox,
      gate,
      jobCards,
      workItems,
      storage,
      llm: channels.llm,
      speech: channels.speech,
      tasks: agent.tasks,
      env,
    }),
  );

  const registry = new HandlerRegistry()
    .register(createChainIntegrityHandler(audit))
    .register(createAudioTranscodeHandler(mediaPipeline, storage))
    .register(createApprovalLadderHandler(agent.ladder))
    // Phase 4.3: the `eta.requested` hook phase 3 emitted with no consumer.
    .register(createEtaRequestHandler(loop))
    .register(createEtaCommsHandler(loop))
    .register(createStateCommsHandler(loop));
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

  const escalationWorker = createEscalationWorker({
    connection: connectionFor(redis),
    ladder: agent.ladder,
    logger: logger.child({ component: 'escalation-worker' }),
    concurrency: env.WORKER_CONCURRENCY,
  });

  /* The phase-4 sentinels. Polling, for the reason the quiet-hours drain is:
   * each depends on state that can change between scheduling and firing. */
  const sentinelDeps = {
    loop,
    uow,
    logger: logger.child({ component: 'sentinels' }),
    shopIds: () => listActiveShopIds(database.db),
  };
  const silentBay = new SilentBayScanner(sentinelDeps, env.SILENT_BAY_SCAN_MS);
  const reminders = new ReminderSentinel(
    sentinelDeps,
    env.REMINDER_SCAN_MS,
    env.DEFERRED_SEND_BATCH_SIZE,
  );

  let healthy = true;
  const metricsServer = startMetricsServer(env.WORKERS_METRICS_PORT, () => healthy);
  dispatcher.start();
  deferredSender.start();
  silentBay.start();
  reminders.start();

  logger.info({ queues: QUEUE_NAMES, metricsPort: env.WORKERS_METRICS_PORT }, 'workers ready');

  const shutdown = async (signal: string): Promise<void> => {
    healthy = false;
    logger.info({ signal }, 'shutting down workers');
    await dispatcher.stop();
    await deferredSender.stop();
    await silentBay.stop();
    await reminders.stop();
    await Promise.all(consumers.map((consumer) => consumer.close()));
    await escalationWorker.close();
    await escalationQueue.close();
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
