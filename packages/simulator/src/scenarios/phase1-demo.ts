import { createStoragePort, mediaKey } from '@serviceloop/adapters';
import { formatAdapterSelection, getEnv } from '@serviceloop/config';
import {
  AuditService,
  createDatabase,
  DEMO_ADVISOR,
  DEMO_SHOP_ID,
  isAlreadySeeded,
  JobCardRepository,
  IdempotencyGuard,
  OutboxService,
  PgJobCardStore,
  PgShopConfigStore,
  PgUnitOfWork,
  PgWorkItemStore,
  runMigrations,
  schema,
  seedDemoShop,
  StaffRepository,
  type Database,
  type Tx,
} from '@serviceloop/db';
import {
  GuardrailService,
  JobCardTransitionService,
  verifyAuditChain,
  WorkItemTransitionService,
  type Actor,
  type AuditChainEntry,
} from '@serviceloop/domain';
import {
  EVENT_TYPES,
  formatPaise,
  queueForEventType,
  QUEUE_NAMES,
  uuidv7,
  type JobCardEvent,
} from '@serviceloop/shared';
import { Queue } from 'bullmq';
import { asc, eq } from 'drizzle-orm';
import IORedis from 'ioredis';
import { assert, assertEqual, ScenarioRunner } from '../runner';

/**
 * `pnpm demo:phase1`
 *
 * Executes the phase 1 acceptance scenario against the sandbox adapters:
 * a scripted job-card lifecycle, the audit chain, the transactional outbox,
 * consumer idempotency, the guardrail engine and tenant isolation. Exits
 * non-zero on any failure so CI gates on it.
 */

const ACTOR: Actor = { type: 'STAFF', id: DEMO_ADVISOR.id, displayName: DEMO_ADVISOR.fullName };
const TRACE = `demo-phase1-${uuidv7().slice(0, 8)}`;

async function main(): Promise<void> {
  const env = getEnv();
  const database = createDatabase(env);
  const db = database.db;
  const redis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const storage = createStoragePort(env);

  const uow = new PgUnitOfWork(db);
  const audit = new AuditService(db, redis);
  const outbox = new OutboxService(db);
  const configStore = new PgShopConfigStore();

  const cards = new JobCardTransitionService({
    uow,
    cards: new PgJobCardStore(),
    config: configStore,
    audit,
    outbox,
  });
  const items = new WorkItemTransitionService({
    uow,
    items: new PgWorkItemStore(),
    audit,
    outbox,
  });
  const guardrails = new GuardrailService({ uow, store: configStore, audit, outbox });
  const repository = new JobCardRepository(db);

  // Scenario state, populated as the steps run.
  let jobCardId = '';
  let workItemId = '';
  let auditEntriesBefore = 0;
  let dispatchedEventIds: string[] = [];

  const runner = new ScenarioRunner(
    'ServiceLoop — Phase 1 acceptance demo',
    'Foundation & domain core: schema, state machine, outbox, guardrails, audit chain.',
  );

  runner
    .step('Environment validated and sandbox adapters selected', () => {
      assert(env.DEMO_MODE, 'DEMO_MODE must be true for the demo');
      const lines = formatAdapterSelection(env);
      assert(
        lines.some((line) => line.startsWith('adapter[storage] SANDBOX')),
        'storage must resolve to a sandbox adapter in DEMO_MODE',
      );
      return lines.join('\n       ');
    })

    .step('Schema migrated and demo shop seeded', async () => {
      await runMigrations(db);
      if (!(await isAlreadySeeded(db))) {
        await seedDemoShop(db, { env, storage, log: () => undefined });
      }
      const [shop] = await db.select().from(schema.shops).where(eq(schema.shops.id, DEMO_SHOP_ID));
      assert(shop !== undefined, 'the demo shop must exist after seeding');
      const board = await repository.board(DEMO_SHOP_ID);
      assertEqual(
        board.totalCards >= 10,
        true,
        'the board should hold at least the 10 seeded cards',
      );
      return `${shop?.name ?? ''} — ${board.totalCards} job cards on the board`;
    })

    .step('Guardrail defaults are conservative', async () => {
      const { config } = await guardrails.get(DEMO_SHOP_ID);
      for (const [flow, level] of Object.entries(config.autonomy)) {
        assertEqual(level, 'L0_SHADOW', `flow "${flow}" must default to shadow mode`);
      }
      assertEqual(config.pricing.priceFloorPercent, 100, 'price floor must default to list price');
      assertEqual(
        config.pricing.discountCeilingPercent,
        0,
        'discount ceiling must default to zero',
      );
      assertEqual(
        config.disclosure.requireFirstContactDisclosure,
        true,
        'AI disclosure must be mandatory',
      );
      return `all 5 flows L0_SHADOW · floor ${config.pricing.priceFloorPercent}% · quiet hours ${config.quietHours.start}–${config.quietHours.end} ${config.quietHours.timezone}`;
    })

    .step('StoragePort round-trips an object', async () => {
      await storage.ensureBucket();
      const key = mediaKey({
        shopId: DEMO_SHOP_ID,
        jobCardId: 'demo',
        mediaId: uuidv7(),
        kind: 'PHOTO',
        extension: 'txt',
      });
      const body = Buffer.from('phase-1 demo evidence');
      const put = await storage.put({ key, body, contentType: 'text/plain' });
      const fetched = await storage.get(key);
      assertEqual(fetched.body.toString(), 'phase-1 demo evidence', 'stored bytes must round-trip');
      const url = await storage.presignGet(key, 60);
      assert(url.length > 0, 'a presigned URL must be issued');
      await storage.delete(key);
      return `${storage.driver} · ${put.sizeBytes} bytes · sha256 ${put.checksumSha256.slice(0, 12)}…`;
    })

    .step('A fresh job card is created for the scripted run', async () => {
      const created = await createScenarioCard(db);
      jobCardId = created.jobCardId;
      workItemId = created.workItemId;
      auditEntriesBefore = (await audit.verifyChain(DEMO_SHOP_ID)).entriesChecked;
      return `${created.code} · ${created.registration} · chain currently at ${auditEntriesBefore} entries`;
    })

    .step('Scripted lifecycle DRAFT → READY_FOR_DELIVERY', async () => {
      const script: Array<
        ['card', JobCardEvent] | ['item', 'SUBMIT_FOR_APPROVAL' | 'APPROVE' | 'START' | 'COMPLETE']
      > = [
        ['card', 'OPEN_CARD'],
        ['card', 'BEGIN_DIAGNOSIS'],
        ['item', 'SUBMIT_FOR_APPROVAL'],
        ['card', 'REQUEST_APPROVAL'],
        ['item', 'APPROVE'],
        ['card', 'APPROVAL_GRANTED'],
        ['item', 'START'],
        ['item', 'COMPLETE'],
        ['card', 'WORK_COMPLETED'],
        ['card', 'QUALITY_PASSED'],
      ];

      const path: string[] = ['DRAFT'];
      for (const [kind, event] of script) {
        if (kind === 'card') {
          const result = await cards.transition({
            shopId: DEMO_SHOP_ID,
            jobCardId,
            event,
            actor: ACTOR,
            traceId: TRACE,
          });
          path.push(result.to);
        } else {
          await items.transition({
            shopId: DEMO_SHOP_ID,
            workItemId,
            event,
            actor: ACTOR,
            traceId: TRACE,
          });
        }
      }

      const [card] = await db
        .select()
        .from(schema.jobCards)
        .where(eq(schema.jobCards.id, jobCardId));
      assertEqual(card?.state, 'READY_FOR_DELIVERY', 'the card must finish ready for delivery');
      return path.join(' → ');
    })

    .step('An illegal transition is refused and audited', async () => {
      let refused = false;
      try {
        await cards.transition({
          shopId: DEMO_SHOP_ID,
          jobCardId,
          event: 'BEGIN_DIAGNOSIS',
          actor: ACTOR,
          traceId: TRACE,
        });
      } catch (error) {
        refused = true;
        assert(
          error instanceof Error && error.message.includes('not a legal transition'),
          'the refusal must name the illegal transition',
        );
      }
      assert(refused, 'BEGIN_DIAGNOSIS from READY_FOR_DELIVERY must be refused');

      const rejections = await db
        .select()
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.action, 'job_card.transition_rejected'));
      assert(rejections.length > 0, 'the rejected attempt must appear in the audit log');

      const [card] = await db
        .select()
        .from(schema.jobCards)
        .where(eq(schema.jobCards.id, jobCardId));
      assertEqual(card?.state, 'READY_FOR_DELIVERY', 'a refused transition must not change state');
      return `${rejections.length} rejected attempt(s) recorded; card state unchanged`;
    })

    .step('A guard refuses a transition it cannot allow', async () => {
      // Payment before delivery is on by default and the estimate is unpaid,
      // so handing the vehicle back must be refused.
      let guardCode = '';
      try {
        await cards.transition({
          shopId: DEMO_SHOP_ID,
          jobCardId,
          event: 'VEHICLE_DELIVERED',
          actor: ACTOR,
          traceId: TRACE,
        });
      } catch (error) {
        const details = (error as { details?: { guardCode?: string } }).details;
        guardCode = details?.guardCode ?? '';
      }
      assertEqual(
        guardCode,
        'PAYMENT_REQUIRED_BEFORE_DELIVERY',
        'the delivery guard must refuse an unpaid handover',
      );
      return 'guard PAYMENT_REQUIRED_BEFORE_DELIVERY held';
    })

    .step('Audit chain verifies end to end', async () => {
      const verification = await audit.verifyChain(DEMO_SHOP_ID);
      assert(verification.valid, `audit chain broken: ${verification.reason ?? 'unknown'}`);
      assert(
        verification.entriesChecked > auditEntriesBefore,
        'the scripted run must have extended the chain',
      );
      return `chain valid · ${verification.entriesChecked} entries · +${verification.entriesChecked - auditEntriesBefore} from this run`;
    })

    .step('Tampering is detected at the exact index', async () => {
      // Verified against a copy of the real chain: the database is never touched,
      // so the demo leaves the shop's audit log intact.
      const rows = await db
        .select()
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.shopId, DEMO_SHOP_ID))
        .orderBy(asc(schema.auditEvents.seq));

      const entries: AuditChainEntry[] = rows.map((row) => ({
        id: row.id,
        shopId: row.shopId,
        seq: Number(row.seq),
        actorType: row.actorType,
        actorId: row.actorId,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        payload: row.payload,
        createdAt: row.createdAt.toISOString(),
        prevHash: row.prevHash,
        hash: row.hash,
      }));

      assert(entries.length > 5, 'need a chain of some length to tamper with');
      const targetIndex = 3;
      const tampered = [...entries];
      const original = entries[targetIndex];
      assert(original !== undefined, 'target entry must exist');
      tampered[targetIndex] = { ...original, payload: { tampered: true } };

      const verification = verifyAuditChain(tampered);
      assertEqual(verification.valid, false, 'a tampered chain must not verify');
      assertEqual(verification.brokenAtIndex, targetIndex, 'the break index must be exact');
      return `break reported at index ${String(verification.brokenAtIndex)} (${verification.reason ?? ''})`;
    })

    .step('Outbox dispatches to the right queues', async () => {
      const before = await outbox.countByStatus();
      assert(before.PENDING > 0, 'the scripted run must have produced pending outbox events');

      const queues = new Map(
        QUEUE_NAMES.map((name) => [
          name,
          new Queue(name, { connection: redis, defaultJobOptions: { removeOnComplete: true } }),
        ]),
      );

      // Batch after batch until the table is empty. The step's claim is a
      // *full* drain, and the backlog is routinely larger than one batch —
      // running `demo:phase2` first is enough to make it so.
      const dispatched: string[] = [];
      for (;;) {
        const claimedNow = await uow.transaction(async (tx: Tx) => {
          const claimed = await outbox.claimPendingBatch(tx, env.OUTBOX_BATCH_SIZE);
          const ids: string[] = [];
          for (const event of claimed) {
            const queue = queues.get(queueForEventType(event.envelope.type));
            assert(queue !== undefined, `no queue registered for ${event.envelope.type}`);
            await queue?.add(event.envelope.type, event.envelope, { jobId: event.envelope.id });
            ids.push(event.id);
          }
          await outbox.markDispatched(tx, ids);
          return ids;
        });

        if (claimedNow.length === 0) break;
        dispatched.push(...claimedNow);
      }

      dispatchedEventIds = dispatched;
      const after = await outbox.countByStatus();
      assertEqual(after.PENDING, 0, 'no pending events should remain after a full drain');
      assert(after.FAILED === 0, 'no event should have failed to dispatch');

      for (const queue of queues.values()) await queue.close();
      assertEqual(
        EVENT_TYPES.every((type) => QUEUE_NAMES.includes(queueForEventType(type))),
        true,
        'every event type must route to a known queue',
      );

      return `${dispatched.length} events dispatched · pending ${after.PENDING} · dispatched ${after.DISPATCHED} · failed ${after.FAILED}`;
    })

    .step('A redelivered event produces exactly one side effect', async () => {
      const eventId = dispatchedEventIds[0];
      assert(eventId !== undefined, 'need at least one dispatched event');

      const guard = new IdempotencyGuard();
      let sideEffects = 0;

      const handle = async (): Promise<boolean> =>
        uow.transaction(async (tx: Tx) => {
          const claimed = await guard.claim(tx, 'demo-consumer', eventId);
          if (!claimed) return false;
          sideEffects += 1;
          await guard.recordResult(tx, 'demo-consumer', eventId, { sideEffects });
          return true;
        });

      assertEqual(await handle(), true, 'the first delivery must be processed');
      assertEqual(await handle(), false, 'a duplicate delivery must be ignored');
      assertEqual(await handle(), false, 'a third delivery must also be ignored');
      assertEqual(sideEffects, 1, 'the side effect must run exactly once');
      return 'three deliveries → one side effect';
    })

    .step('Guardrail patch is validated, applied and audited', async () => {
      const patched = await guardrails.validateAndPatch(
        DEMO_SHOP_ID,
        { quietHours: { start: '21:30' } },
        { type: 'STAFF', id: DEMO_ADVISOR.id, displayName: DEMO_ADVISOR.fullName },
        TRACE,
      );
      assertEqual(patched.config.quietHours.start, '21:30', 'the patch must apply');
      assertEqual(patched.diffs.length, 1, 'exactly one field should have changed');
      assert(patched.auditEventId !== null, 'the change must be audited');

      let rejected = false;
      try {
        await guardrails.validateAndPatch(
          DEMO_SHOP_ID,
          { pricing: { priceFloorPercent: 250 } },
          { type: 'STAFF', id: DEMO_ADVISOR.id },
          TRACE,
        );
      } catch {
        rejected = true;
      }
      assert(rejected, 'an out-of-range price floor must be rejected');

      // Restore the default so repeated demo runs stay idempotent.
      await guardrails.validateAndPatch(
        DEMO_SHOP_ID,
        { quietHours: { start: '21:00' } },
        { type: 'STAFF', id: DEMO_ADVISOR.id },
        TRACE,
      );

      return `diff [${patched.diffs.map((diff) => diff.path).join(', ')}] audited as ${patched.auditEventId?.slice(0, 8) ?? ''}…`;
    })

    .step('Cross-tenant reads return nothing', async () => {
      const foreignShopId = uuidv7();
      const detail = await repository.findDetail(foreignShopId, jobCardId);
      assertEqual(detail, null, 'another shop must not be able to read this card');

      const board = await repository.board(foreignShopId);
      assertEqual(board.totalCards, 0, 'another shop must see an empty board');

      const staffRepository = new StaffRepository(db);
      const memberships = await staffRepository.findMembershipsByPhone('+919999999999');
      assertEqual(memberships.length, 0, 'an unknown phone must resolve to no membership');
      return 'foreign shop sees no cards and no memberships';
    })

    .step('Board reflects the scripted card', async () => {
      const detail = await repository.findDetail(DEMO_SHOP_ID, jobCardId);
      assert(detail !== null, 'the scripted card must be readable');
      assertEqual(detail?.state, 'READY_FOR_DELIVERY', 'board state must match the domain state');
      assert((detail?.auditTrail.length ?? 0) >= 6, 'the card drawer must show its audit trail');
      const total = detail?.estimates[0]?.totalPaise ?? 0;
      return `${detail?.code ?? ''} · ${detail?.workItems.length ?? 0} work item(s) · estimate ${formatPaise(total)} · ${detail?.auditTrail.length ?? 0} audit entries`;
    });

  runner.onTeardown(async () => {
    await redis.quit();
    await database.close();
  });

  process.exitCode = await runner.run();
}

async function createScenarioCard(db: Database): Promise<{
  jobCardId: string;
  workItemId: string;
  code: string;
  registration: string;
}> {
  const suffix = uuidv7().replace(/-/g, '').slice(-8).toUpperCase();
  const customerId = uuidv7();
  const vehicleId = uuidv7();
  const jobCardId = uuidv7();
  const workItemId = uuidv7();
  const estimateId = uuidv7();
  const registration = `TN09DM${suffix.slice(0, 4)}`;
  const code = `JC-DEMO-${suffix.slice(0, 6)}`;
  const phone = `+9198765${String(Math.floor(10000 + Math.random() * 89999))}`;

  const { blindIndex } = await import('@serviceloop/db');

  await db.transaction(async (tx) => {
    await tx.insert(schema.customers).values({
      id: customerId,
      shopId: DEMO_SHOP_ID,
      fullNameEncrypted: 'Demo Scenario Customer',
      phoneEncrypted: phone,
      phoneHash: blindIndex(DEMO_SHOP_ID, phone),
      preferredLanguage: 'ta',
      whatsappOptIn: true,
    });
    await tx.insert(schema.vehicles).values({
      id: vehicleId,
      shopId: DEMO_SHOP_ID,
      customerId,
      registrationRaw: registration,
      registrationNormalised: registration,
      make: 'Maruti Suzuki',
      model: 'Swift VDi',
    });
    await tx.insert(schema.jobCards).values({
      id: jobCardId,
      shopId: DEMO_SHOP_ID,
      customerId,
      vehicleId,
      code,
      state: 'DRAFT',
      source: 'PAPER_CARD',
      complaintText: 'Front brake noise; customer reports vibration above 60 kmph',
      assignedAdvisorId: DEMO_ADVISOR.id,
    });
    await tx.insert(schema.workItems).values({
      id: workItemId,
      shopId: DEMO_SHOP_ID,
      jobCardId,
      title: 'Front brake pad replacement',
      description: 'Replace front brake pads and clean callipers',
      technicianNote: 'Front pads measured 2.1mm against a 3mm service limit.',
      state: 'PROPOSED',
      requiresApproval: true,
      estimatedMinutes: 60,
    });
    // The estimate is written as DRAFT and accepted only after its lines are
    // in place: the `estimate_lines_immutable_when_accepted` trigger refuses
    // to add a line to an already-accepted estimate, and rightly so.
    await tx.insert(schema.estimates).values({
      id: estimateId,
      shopId: DEMO_SHOP_ID,
      jobCardId,
      version: 1,
      status: 'DRAFT',
      subtotalPaise: 305000,
      taxPaise: 60900,
      totalPaise: 365900,
    });
    await tx.insert(schema.estimateLines).values({
      shopId: DEMO_SHOP_ID,
      estimateId,
      workItemId,
      kind: 'PART',
      description: 'Front brake pad set (OEM)',
      quantityMilli: 1000,
      unitPricePaise: 245000,
      lineTotalPaise: 245000,
      taxRateBp: 2800,
    });
    await tx
      .update(schema.estimates)
      .set({ status: 'ACCEPTED', acceptedAt: new Date() })
      .where(eq(schema.estimates.id, estimateId));
  });

  return { jobCardId, workItemId, code, registration };
}

main().catch((error: unknown) => {
  console.error('\n[demo:phase1] the scenario crashed before it could finish');
  console.error(error);
  process.exit(1);
});
