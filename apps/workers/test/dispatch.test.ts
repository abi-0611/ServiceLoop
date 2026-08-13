import { defaultShopConfig } from '@serviceloop/config';
import {
  AuditService,
  OutboxService,
  PgJobCardStore,
  PgShopConfigStore,
  PgUnitOfWork,
  schema,
  type Database,
} from '@serviceloop/db';
import { JobCardTransitionService, type Actor } from '@serviceloop/domain';
import { QUEUE_NAMES, uuidv7, type EventEnvelope } from '@serviceloop/shared';
import { type Queue } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { processEnvelope } from '../src/consumer';
import { createChainIntegrityHandler } from '../src/handlers/chain-integrity';
import { HandlerRegistry } from '../src/handlers/registry';
import { OutboxDispatcher } from '../src/outbox-dispatcher';
import { createQueues, createRedis } from '../src/queues';
import { startWorkerStack, type WorkerTestStack } from './harness';

/**
 * End-to-end reliability spine: state transition → outbox row → queue →
 * consumer side-effect, exactly once under duplicate delivery and under a
 * dispatcher that dies mid-batch (phase 1.5 acceptance).
 */

let stack: WorkerTestStack;
let db: Database;
let redis: Redis;
let queueSet: ReturnType<typeof createQueues>;
let dispatcher: OutboxDispatcher;
let registry: HandlerRegistry;
let cardService: JobCardTransitionService<never>;

const SHOP_ID = '01940000-0000-7000-8000-00000000dd01';
const ACTOR: Actor = { type: 'STAFF', id: null, displayName: 'worker test' };
const logger = pino({ level: 'silent' });

beforeAll(async () => {
  stack = await startWorkerStack();
  db = stack.db;
  redis = createRedis(stack.redisUrl);
  queueSet = createQueues(redis);

  const audit = new AuditService(db);
  registry = new HandlerRegistry().register(createChainIntegrityHandler(audit));

  dispatcher = new OutboxDispatcher({
    db,
    queues: queueSet.queues,
    logger,
    batchSize: 100,
    idleBackoffMs: 50,
    maxAttempts: 3,
  });

  cardService = new JobCardTransitionService({
    uow: new PgUnitOfWork(db),
    cards: new PgJobCardStore(),
    config: new PgShopConfigStore(),
    audit,
    outbox: new OutboxService(db),
  }) as unknown as JobCardTransitionService<never>;
}, 240_000);

afterAll(async () => {
  await queueSet.close();
  await redis.quit();
  await stack.stop();
});

beforeEach(async () => {
  await db.execute(sql`
    alter table audit_events disable trigger audit_events_append_only;
    truncate table idempotency_keys, events_outbox, audit_events, shop_config,
      work_items, job_cards, vehicles, customers, staff, shops restart identity cascade;
    alter table audit_events enable trigger audit_events_append_only;
  `);

  for (const queueName of QUEUE_NAMES) {
    await queueSet.queues.get(queueName)?.obliterate({ force: true });
  }
  await queueSet.deadLetter.obliterate({ force: true });

  await db.insert(schema.shops).values({ id: SHOP_ID, name: 'Worker Motors', city: 'Chennai' });
  await db.insert(schema.shopConfig).values({
    shopId: SHOP_ID,
    configVersion: 1,
    config: defaultShopConfig() as unknown as Record<string, unknown>,
  });
});

async function makeCard(): Promise<string> {
  const customerId = uuidv7();
  const vehicleId = uuidv7();
  const jobCardId = uuidv7();
  const phone = `+9198410${Math.floor(10000 + Math.random() * 89999)}`;

  await db.insert(schema.customers).values({
    id: customerId,
    shopId: SHOP_ID,
    fullNameEncrypted: 'Worker Customer',
    phoneEncrypted: phone,
    phoneHash: `hash-${customerId}`,
  });
  await db.insert(schema.vehicles).values({
    id: vehicleId,
    shopId: SHOP_ID,
    customerId,
    registrationRaw: 'TN 09 WK 0001',
    registrationNormalised: `TN09WK${vehicleId.replace(/-/g, '').slice(-10)}`,
  });
  await db.insert(schema.jobCards).values({
    id: jobCardId,
    shopId: SHOP_ID,
    customerId,
    vehicleId,
    code: `JC-W-${jobCardId}`,
    state: 'OPEN',
  });
  return jobCardId;
}

describe('transition → outbox → queue → consumer', () => {
  it('delivers a transition to its queue and applies the side effect once', async () => {
    const jobCardId = await makeCard();

    await cardService.transition({
      shopId: SHOP_ID,
      jobCardId,
      event: 'BEGIN_DIAGNOSIS',
      actor: ACTOR,
      traceId: 'e2e-1',
    });

    const result = await dispatcher.dispatchOnce();
    expect(result).toEqual({ claimed: 1, dispatched: 1, failed: 0 });

    const queue = queueSet.queues.get('jobcard-events') as Queue;
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active', 'prioritized']);
    expect(jobs).toHaveLength(1);

    const envelope = jobs[0]?.data as EventEnvelope;
    expect(envelope.type).toBe('job_card.state_changed');

    const first = await processEnvelope(
      { queueName: 'jobcard-events', db, registry, logger },
      envelope,
    );
    expect(first.status).toBe('processed');
    expect(first.handlers).toBe(1);

    // Forced duplicate delivery — the side effect must not repeat.
    const second = await processEnvelope(
      { queueName: 'jobcard-events', db, registry, logger },
      envelope,
    );
    expect(second.status).toBe('duplicate');
    expect(second.handlers).toBe(0);

    const claims = await db
      .select()
      .from(schema.idempotencyKeys)
      .where(eq(schema.idempotencyKeys.eventId, envelope.id));
    expect(claims).toHaveLength(1);
    expect(claims[0]?.result).toMatchObject({ type: 'job_card.state_changed' });
  });

  it('marks the outbox row dispatched and does not redeliver it', async () => {
    const jobCardId = await makeCard();
    await cardService.transition({
      shopId: SHOP_ID,
      jobCardId,
      event: 'BEGIN_DIAGNOSIS',
      actor: ACTOR,
      traceId: 'e2e-2',
    });

    await dispatcher.dispatchOnce();
    expect(await new OutboxService(db).countByStatus()).toEqual({
      PENDING: 0,
      DISPATCHED: 1,
      FAILED: 0,
    });

    const second = await dispatcher.dispatchOnce();
    expect(second).toEqual({ claimed: 0, dispatched: 0, failed: 0 });
  });

  it('de-duplicates at the queue too, because the event id is the job id', async () => {
    const jobCardId = await makeCard();
    await cardService.transition({
      shopId: SHOP_ID,
      jobCardId,
      event: 'BEGIN_DIAGNOSIS',
      actor: ACTOR,
      traceId: 'e2e-3',
    });

    await dispatcher.dispatchOnce();
    const queue = queueSet.queues.get('jobcard-events') as Queue;
    const [job] = await queue.getJobs(['waiting', 'delayed', 'active', 'prioritized']);
    expect(job).toBeDefined();

    // Re-adding the same event id is a no-op for BullMQ.
    await queue.add('job_card.state_changed', job?.data, { jobId: job?.id });
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active', 'prioritized']);
    expect(jobs).toHaveLength(1);
  });

  it('loses nothing when the dispatcher dies mid-batch', async () => {
    const cards = await Promise.all([makeCard(), makeCard(), makeCard()]);
    for (const jobCardId of cards) {
      await cardService.transition({
        shopId: SHOP_ID,
        jobCardId,
        event: 'BEGIN_DIAGNOSIS',
        actor: ACTOR,
        traceId: 'e2e-crash',
      });
    }

    // A dispatcher whose publish throws for the middle event.
    let published = 0;
    const flaky = new OutboxDispatcher({
      db,
      queues: new Map([
        [
          'jobcard-events',
          {
            add: async () => {
              published += 1;
              if (published === 2) throw new Error('redis unavailable');
              return {};
            },
          } as unknown as Queue,
        ],
      ]),
      logger,
      batchSize: 100,
      idleBackoffMs: 10,
      maxAttempts: 3,
    });

    const outcome = await flaky.dispatchOnce();
    expect(outcome).toEqual({ claimed: 3, dispatched: 2, failed: 1 });

    const outbox = new OutboxService(db);
    expect(await outbox.countByStatus()).toEqual({ PENDING: 1, DISPATCHED: 2, FAILED: 0 });

    // The survivor is redelivered on the next pass, exactly once.
    const recovery = await dispatcher.dispatchOnce();
    expect(recovery).toEqual({ claimed: 1, dispatched: 1, failed: 0 });
    expect(await outbox.countByStatus()).toEqual({ PENDING: 0, DISPATCHED: 3, FAILED: 0 });

    const queue = queueSet.queues.get('jobcard-events') as Queue;
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active', 'prioritized']);
    expect(jobs).toHaveLength(1);
  });

  it('routes every event type to exactly one queue', async () => {
    const jobCardId = await makeCard();
    await cardService.transition({
      shopId: SHOP_ID,
      jobCardId,
      event: 'BEGIN_DIAGNOSIS',
      actor: ACTOR,
      traceId: 'routing',
    });
    await cardService
      .transition({ shopId: SHOP_ID, jobCardId, event: 'CLOSE', actor: ACTOR, traceId: 'routing' })
      .catch(() => undefined); // Illegal on purpose: emits a rejection event.

    await dispatcher.dispatchOnce();

    const jobcardQueue = queueSet.queues.get('jobcard-events') as Queue;
    const workitemQueue = queueSet.queues.get('workitem-events') as Queue;
    expect(
      await jobcardQueue.getJobs(['waiting', 'delayed', 'active', 'prioritized']),
    ).toHaveLength(2);
    expect(
      await workitemQueue.getJobs(['waiting', 'delayed', 'active', 'prioritized']),
    ).toHaveLength(0);
  });
});

describe('chain integrity handler', () => {
  it('fails the job when the audit chain has been tampered with', async () => {
    const jobCardId = await makeCard();
    await cardService.transition({
      shopId: SHOP_ID,
      jobCardId,
      event: 'BEGIN_DIAGNOSIS',
      actor: ACTOR,
      traceId: 'integrity',
    });
    await dispatcher.dispatchOnce();

    const queue = queueSet.queues.get('jobcard-events') as Queue;
    const [job] = await queue.getJobs(['waiting', 'delayed', 'active', 'prioritized']);
    const envelope = job?.data as EventEnvelope;

    await db.execute(sql`alter table audit_events disable trigger audit_events_append_only`);
    await db.execute(
      sql`update audit_events set payload = jsonb_set(payload, '{to}', '"CLOSED"') where shop_id = ${SHOP_ID}`,
    );
    await db.execute(sql`alter table audit_events enable trigger audit_events_append_only`);

    await expect(
      processEnvelope({ queueName: 'jobcard-events', db, registry, logger }, envelope),
    ).rejects.toThrow(/Audit chain broken/);

    // The failed transaction rolled the idempotency claim back, so a retry
    // after the chain is restored can still process the event.
    const claims = await db.select().from(schema.idempotencyKeys);
    expect(claims).toHaveLength(0);
  });
});
