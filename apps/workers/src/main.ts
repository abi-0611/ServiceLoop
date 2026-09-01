import {
  createChannelPorts,
  createMediaPipeline,
  createStoragePort,
  createStreamingSpeechPort,
  createTelephonyPort,
} from '@serviceloop/adapters';
import { formatAdapterSelection, getEnv } from '@serviceloop/config';
import {
  AuditService,
  createAgentStores,
  createDatabase,
  createVoiceStores,
  OutboxService,
  PgCallRecordingWriter,
  PgConsentStore,
  PgConversationStore,
  PgGeneratedMediaWriter,
  PgJobCardContextReader,
  PgJobCardStore,
  PgMessageStore,
  PgShopConfigStore,
  PgShopDirectory,
  PgUnitOfWork,
  PgWorkItemStore,
  type Tx,
} from '@serviceloop/db';
import {
  createAgentRuntime,
  createLoopRuntime,
  createRetentionRuntime,
  createVoiceRuntime,
  voiceSettingsFrom,
} from '@serviceloop/agent-core';
import {
  DeferredSendService,
  JobCardTransitionService,
  OutboundGate,
  VoiceCallService,
  WorkItemTransitionService,
} from '@serviceloop/domain';
import { defaultShopConfig } from '@serviceloop/config';
import { QUEUE_NAMES } from '@serviceloop/shared';
import type { Worker } from 'bullmq';
import { startTracing, stopTracing } from '@serviceloop/observability';
import { createConsumer } from './consumer';
import { DeferredSender, StorageMediaBytesLoader } from './deferred-sender';
import {
  BullMqRungScheduler,
  createEscalationQueue,
  createEscalationWorker,
} from './escalations';
import { createApprovalLadderHandler } from './handlers/approval-ladder';
import {
  createConversionHandler,
  createDeliveredHandler,
  createExceptionAlertHandler,
  createLedgerHandler,
} from './handlers/retention';
import {
  createEtaCommsHandler,
  createEtaRequestHandler,
  createStateCommsHandler,
} from './handlers/status-comms';
import { ReminderSentinel, SilentBayScanner } from './sentinels';
import {
  DigestScheduler,
  FeedbackSentinel,
  RetentionScanner,
  StuckApprovalSentinel,
} from './retention-sentinels';
import { createLoopStores, listActiveShopIds } from './loop-wiring';
import { DataRequestSentinel } from './privacy-sentinel';
import { createDataPrincipalService } from './privacy-wiring';
import { createRetentionWiring } from './retention-wiring';
import { createAudioTranscodeHandler } from './handlers/audio-transcode';
import { createChainIntegrityHandler } from './handlers/chain-integrity';
import { createCostMeterHandler } from './handlers/cost-meter';
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
  // Before anything that touches http, pg or ioredis: the auto-instrumentations
  // patch those modules as they load, and a provider registered afterwards
  // instruments nothing while looking exactly like a sampling problem.
  startTracing({ component: 'workers' });

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

  /* Phase 5: the telephone.
   *
   * Wired *here* and not only in the API, because this is the process where a
   * `VOICE_OR_ADVISOR` rung actually fires: the API can place a call somebody
   * clicked for, but the ladder's own rungs run on the escalation worker. A
   * deployment that wired voice into the API alone would have a softphone that
   * worked and a ladder that never rang anybody — which is the shape of bug
   * that looks like a config problem for a week.
   *
   * `createVoiceRuntime` attaches the placer to `agent.ladder`. Nothing about a
   * shop's settings changes: the call gate still refuses on `voice.enabled`,
   * quiet hours, consent and the caps, and every refusal that says so falls
   * back to the advisor task the rung raised in phase 3. */
  const voiceStores = createVoiceStores();
  const voiceCalls = new VoiceCallService<Tx>({
    uow,
    calls: voiceStores.calls,
    turns: voiceStores.turns,
    consentEvents: voiceStores.consentEvents,
    usage: voiceStores.usage,
    consents: new PgConsentStore(),
    config: new PgShopConfigStore(),
    audit,
    outbox,
    recordings: new PgCallRecordingWriter(
      new PgGeneratedMediaWriter(storage, (work) => uow.transaction(work)),
    ),
    rates: {
      telcoPaisePerMinute: env.VOICE_TELCO_PAISE_PER_MINUTE,
      sttPaisePerMinute: env.VOICE_STT_PAISE_PER_MINUTE,
      ttsPaisePerMinute: env.VOICE_TTS_PAISE_PER_MINUTE,
      usdMicrosToPaise: 9_000,
    },
    platformCapPaise: env.VOICE_PLATFORM_DAILY_CAP_PAISE,
    alertRatio: env.VOICE_COST_ALERT_RATIO,
    // Read per call, not captured at boot: the whole value of a kill switch is
    // that it takes effect without a deploy.
    platformKillSwitch: () => getEnv().VOICE_KILL_SWITCH,
    retentionDays: env.VOICE_RECORDING_RETENTION_DAYS,
  });

  const telephony = createTelephonyPort(env);
  createVoiceRuntime<Tx>({
    runtime: agent,
    telephony,
    speech: createStreamingSpeechPort(env),
    calls: voiceCalls,
    destinations: voiceStores.destinations,
    gate,
    llm: channels.llm,
    stores: {
      uow,
      runs: agentStores.runs,
      cards: new PgJobCardContextReader(),
      conversations: new PgConversationStore(),
      directory: new PgShopDirectory(),
      config: new PgShopConfigStore(),
      audit,
      outbox,
    },
    settings: voiceSettingsFrom(defaultShopConfig(env.DEFAULT_TIMEZONE), {
      endpointSilenceMs: env.VOICE_ENDPOINT_SILENCE_MS,
      frameMs: env.VOICE_FRAME_MS,
      latencyBudgetMs: env.VOICE_LATENCY_BUDGET_MS,
      maxDeadAirMs: env.VOICE_MAX_DEAD_AIR_MS,
    }),
    onTrace: (line) =>
      logger.debug({ callId: line.callId, stage: line.stage }, line.detail),
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

  /* Phase 6: the loop that starts after the vehicle has left.
   *
   * Wired here rather than in the API because every one of its call sites is a
   * timer or a consumed event — the API only ever *reads* what this process
   * writes. The runtime is still assembled from the shared factory so the two
   * processes cannot end up with, say, a feedback service that has no alerter.
   *
   * `agent.tasks` is passed rather than a second task creator: a recovery task
   * and an approval task are the same queue in front of the same advisor, and
   * two writers for it would be two audit-chain writers for one shop. */
  const retention = createRetentionRuntime<Tx>(
    createRetentionWiring({ uow, audit, outbox, gate, tasks: agent.tasks }),
  );

  const registry = new HandlerRegistry()
    .register(createChainIntegrityHandler(audit))
    .register(createAudioTranscodeHandler(mediaPipeline, storage))
    .register(createApprovalLadderHandler(agent.ladder))
    // Phase 4.3: the `eta.requested` hook phase 3 emitted with no consumer.
    .register(createEtaRequestHandler(loop))
    .register(createEtaCommsHandler(loop))
    .register(createStateCommsHandler(loop))
    // Phase 6. Every one of them consumes a fact an earlier phase committed:
    // retention adds handlers, not call sites.
    .register(createLedgerHandler(retention))
    .register(createDeliveredHandler(retention))
    .register(createConversionHandler(retention))
    .register(createExceptionAlertHandler(retention))
    // Phase 7.3. A consumer, not a call inside the gate: a metering failure
    // must never fail a customer send.
    .register(createCostMeterHandler());
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

  /* The phase-6 sentinels. Four passes rather than one because they answer to
   * four different clocks: the trigger engine to a horizon in weeks, the
   * feedback ask to a delivery a day or two ago, the alert stream to an owner
   * waiting right now, and the digest to the shop's own wall clock. */
  const retentionDeps = { ...sentinelDeps, retention, uow };
  const retentionScanner = new RetentionScanner(
    retentionDeps,
    env.RETENTION_SCAN_MS,
    env.RETENTION_BATCH_SIZE,
  );
  const feedbackSentinel = new FeedbackSentinel(
    retentionDeps,
    env.FEEDBACK_SCAN_MS,
    env.RETENTION_BATCH_SIZE,
  );
  const stuckApprovals = new StuckApprovalSentinel(retentionDeps, env.ALERT_SCAN_MS);
  const digestScheduler = new DigestScheduler(retentionDeps, env.DIGEST_SCAN_MS);

  /* The phase-7.2 sentinel. An approval schedules the cascade; this runs it
   * once the shop's grace window has elapsed. Without it an approved deletion
   * would sit `SCHEDULED` for ever unless somebody pressed "run now", and a
   * statutory obligation that depends on a person remembering to press a button
   * is not a workflow. */
  const dataRequests = new DataRequestSentinel(
    sentinelDeps,
    createDataPrincipalService({ uow, audit, outbox, storage }),
    env.DPDP_SCAN_MS,
    env.DPDP_BATCH_SIZE,
  );

  let healthy = true;
  // A worker that exited with calls in flight would leave customers listening
  // to a line nothing is on the other end of.
  process.once('beforeExit', () => {
    void telephony.shutdown('the worker is shutting down');
  });
  const metricsServer = startMetricsServer(env.WORKERS_METRICS_PORT, () => healthy);
  dispatcher.start();
  deferredSender.start();
  silentBay.start();
  reminders.start();
  retentionScanner.start();
  feedbackSentinel.start();
  stuckApprovals.start();
  digestScheduler.start();
  dataRequests.start();

  logger.info({ queues: QUEUE_NAMES, metricsPort: env.WORKERS_METRICS_PORT }, 'workers ready');

  const shutdown = async (signal: string): Promise<void> => {
    healthy = false;
    logger.info({ signal }, 'shutting down workers');
    await dispatcher.stop();
    await deferredSender.stop();
    await silentBay.stop();
    await reminders.stop();
    await retentionScanner.stop();
    await feedbackSentinel.stop();
    await stuckApprovals.stop();
    await digestScheduler.stop();
    await dataRequests.stop();
    await Promise.all(consumers.map((consumer) => consumer.close()));
    await escalationWorker.close();
    await escalationQueue.close();
    await queueSet.close();
    await redis.quit();
    await database.close();
    metricsServer.close();
    await stopTracing();
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
