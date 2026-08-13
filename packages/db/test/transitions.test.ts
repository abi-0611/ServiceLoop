import { defaultShopConfig } from '@serviceloop/config';
import {
  IllegalTransitionError,
  JobCardTransitionService,
  TransitionGuardError,
  WorkItemTransitionService,
  type Actor,
} from '@serviceloop/domain';
import { uuidv7 } from '@serviceloop/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgUnitOfWork, type Database, type Tx } from '../src/client';
import { blindIndex } from '../src/crypto/pii';
import {
  auditEvents,
  customers,
  declinedWorkLedger,
  eventsOutbox,
  jobCards,
  shopConfig,
  shops,
  vehicles,
  workItems,
} from '../src/schema';
import { AuditService } from '../src/services/audit-service';
import { OutboxService } from '../src/services/outbox-service';
import { PgJobCardStore } from '../src/stores/job-card-store';
import { PgShopConfigStore } from '../src/stores/shop-config-store';
import { PgWorkItemStore } from '../src/stores/work-item-store';
import { startTestDatabase, truncateAll, type TestDatabase } from './harness';

let harness: TestDatabase;
let db: Database;
let cardService: JobCardTransitionService<Tx>;
let itemService: WorkItemTransitionService<Tx>;
let auditService: AuditService;

const SHOP_ID = '01930000-0000-7000-8000-00000000bb01';
const ACTOR: Actor = { type: 'STAFF', id: null, displayName: 'integration test' };

beforeAll(async () => {
  harness = await startTestDatabase();
  db = harness.db;

  const uow = new PgUnitOfWork(db);
  auditService = new AuditService(db);
  const outbox = new OutboxService(db);

  cardService = new JobCardTransitionService({
    uow,
    cards: new PgJobCardStore(),
    config: new PgShopConfigStore(),
    audit: auditService,
    outbox,
  });
  itemService = new WorkItemTransitionService({
    uow,
    items: new PgWorkItemStore(),
    audit: auditService,
    outbox,
  });
});

afterAll(async () => {
  await harness.stop();
});

beforeEach(async () => {
  await truncateAll(db);
  await db.insert(shops).values({ id: SHOP_ID, name: 'Race Motors', city: 'Chennai' });
  await db.insert(shopConfig).values({
    shopId: SHOP_ID,
    configVersion: 1,
    config: defaultShopConfig() as unknown as Record<string, unknown>,
  });
});

async function makeCard(state: 'DRAFT' | 'OPEN' | 'IN_DIAGNOSIS' = 'OPEN'): Promise<string> {
  const customerId = uuidv7();
  const vehicleId = uuidv7();
  const jobCardId = uuidv7();
  const phone = `+9198410${Math.floor(10000 + Math.random() * 89999)}`;

  await db.insert(customers).values({
    id: customerId,
    shopId: SHOP_ID,
    fullNameEncrypted: 'Race Customer',
    phoneEncrypted: phone,
    phoneHash: blindIndex(SHOP_ID, phone),
  });
  await db.insert(vehicles).values({
    id: vehicleId,
    shopId: SHOP_ID,
    customerId,
    registrationRaw: `TN 09 ZZ ${Math.floor(1000 + Math.random() * 8999)}`,
    registrationNormalised: `TN09ZZ${Math.floor(1000 + Math.random() * 8999)}`,
  });
  await db.insert(jobCards).values({
    id: jobCardId,
    shopId: SHOP_ID,
    customerId,
    vehicleId,
    code: `JC-${jobCardId.slice(0, 8)}`,
    state,
  });
  return jobCardId;
}

describe('JobCardTransitionService against Postgres', () => {
  it('writes state, audit and outbox in one transaction', async () => {
    const jobCardId = await makeCard('OPEN');

    const result = await cardService.transition({
      shopId: SHOP_ID,
      jobCardId,
      event: 'BEGIN_DIAGNOSIS',
      actor: ACTOR,
      traceId: 'trace-int-1',
    });

    expect(result.to).toBe('IN_DIAGNOSIS');

    const [card] = await db.select().from(jobCards).where(eq(jobCards.id, jobCardId));
    expect(card?.state).toBe('IN_DIAGNOSIS');
    expect(card?.version).toBe(2);

    const audit = await db.select().from(auditEvents).where(eq(auditEvents.shopId, SHOP_ID));
    expect(audit).toHaveLength(1);
    expect(audit[0]?.action).toBe('job_card.state_changed');

    const outboxRows = await db.select().from(eventsOutbox).where(eq(eventsOutbox.shopId, SHOP_ID));
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]?.status).toBe('PENDING');
    expect(outboxRows[0]?.type).toBe('job_card.state_changed');
  });

  it('audits an illegal transition and leaves the row untouched', async () => {
    const jobCardId = await makeCard('OPEN');

    await expect(
      cardService.transition({
        shopId: SHOP_ID,
        jobCardId,
        event: 'CLOSE',
        actor: ACTOR,
        traceId: 'trace-int-2',
      }),
    ).rejects.toBeInstanceOf(IllegalTransitionError);

    const [card] = await db.select().from(jobCards).where(eq(jobCards.id, jobCardId));
    expect(card?.state).toBe('OPEN');
    expect(card?.version).toBe(1);

    const audit = await db.select().from(auditEvents).where(eq(auditEvents.shopId, SHOP_ID));
    expect(audit).toHaveLength(1);
    expect(audit[0]?.action).toBe('job_card.transition_rejected');
  });

  it('lets exactly one of two concurrent transitions win', async () => {
    const jobCardId = await makeCard('OPEN');

    const attempts = [
      cardService.transition({
        shopId: SHOP_ID,
        jobCardId,
        event: 'BEGIN_DIAGNOSIS',
        actor: ACTOR,
        traceId: 'race-a',
      }),
      cardService.transition({
        shopId: SHOP_ID,
        jobCardId,
        event: 'BEGIN_DIAGNOSIS',
        actor: ACTOR,
        traceId: 'race-b',
      }),
    ];

    const settled = await Promise.allSettled(attempts);
    const fulfilled = settled.filter((entry) => entry.status === 'fulfilled');
    const rejected = settled.filter((entry) => entry.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // The loser saw the winner's state, so its event was no longer legal.
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(IllegalTransitionError);

    const [card] = await db.select().from(jobCards).where(eq(jobCards.id, jobCardId));
    expect(card?.state).toBe('IN_DIAGNOSIS');
    expect(card?.version).toBe(2);

    const stateChanges = await db
      .select()
      .from(auditEvents)
      .where(sql`${auditEvents.action} = 'job_card.state_changed'`);
    expect(stateChanges).toHaveLength(1);
  });

  it('serialises a burst of ten concurrent transitions to a single winner', async () => {
    const jobCardId = await makeCard('OPEN');

    const settled = await Promise.allSettled(
      Array.from({ length: 10 }, (_unused, index) =>
        cardService.transition({
          shopId: SHOP_ID,
          jobCardId,
          event: 'BEGIN_DIAGNOSIS',
          actor: ACTOR,
          traceId: `burst-${index}`,
        }),
      ),
    );

    expect(settled.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    const [card] = await db.select().from(jobCards).where(eq(jobCards.id, jobCardId));
    expect(card?.version).toBe(2);
  });

  it('refuses a guard-blocked transition and records why', async () => {
    const jobCardId = await makeCard('IN_DIAGNOSIS');

    await expect(
      cardService.transition({
        shopId: SHOP_ID,
        jobCardId,
        event: 'REQUEST_APPROVAL',
        actor: ACTOR,
        traceId: 'trace-int-3',
      }),
    ).rejects.toBeInstanceOf(TransitionGuardError);

    const audit = await db.select().from(auditEvents).where(eq(auditEvents.shopId, SHOP_ID));
    expect(audit[0]?.payload).toMatchObject({ code: 'NO_WORK_TO_APPROVE' });
  });

  it('keeps the audit chain verifiable across a driven lifecycle', async () => {
    const jobCardId = await makeCard('DRAFT');
    const workItemId = uuidv7();
    await db.insert(workItems).values({
      id: workItemId,
      shopId: SHOP_ID,
      jobCardId,
      title: 'Front brake pads',
      state: 'PROPOSED',
    });

    const card = async (event: Parameters<typeof cardService.transition>[0]['event']) =>
      cardService.transition({ shopId: SHOP_ID, jobCardId, event, actor: ACTOR, traceId: 'life' });
    const item = async (event: Parameters<typeof itemService.transition>[0]['event']) =>
      itemService.transition({ shopId: SHOP_ID, workItemId, event, actor: ACTOR, traceId: 'life' });

    await card('OPEN_CARD');
    await card('BEGIN_DIAGNOSIS');
    await item('SUBMIT_FOR_APPROVAL');
    await card('REQUEST_APPROVAL');
    await item('APPROVE');
    await card('APPROVAL_GRANTED');
    await item('START');
    await item('COMPLETE');
    await card('WORK_COMPLETED');
    await card('QUALITY_PASSED');

    const [final] = await db.select().from(jobCards).where(eq(jobCards.id, jobCardId));
    expect(final?.state).toBe('READY_FOR_DELIVERY');

    const verification = await auditService.verifyChain(SHOP_ID);
    expect(verification.valid).toBe(true);
    expect(verification.entriesChecked).toBe(10);
  });

  it('writes a deferred work item to the ledger in the same transaction', async () => {
    const jobCardId = await makeCard('OPEN');
    const workItemId = uuidv7();
    await db.insert(workItems).values({
      id: workItemId,
      shopId: SHOP_ID,
      jobCardId,
      title: 'Wheel alignment',
      state: 'PENDING_APPROVAL',
    });

    await itemService.transition({
      shopId: SHOP_ID,
      workItemId,
      event: 'DEFER',
      actor: { type: 'CUSTOMER', id: null },
      traceId: 'defer',
      reason: 'Next service please',
    });

    const ledger = await db
      .select()
      .from(declinedWorkLedger)
      .where(eq(declinedWorkLedger.workItemId, workItemId));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.kind).toBe('DEFERRED');
    expect(ledger[0]?.followUpAfter).toBeInstanceOf(Date);
  });

  it('does not leak another shop’s job card', async () => {
    const otherShop = uuidv7();
    await db.insert(shops).values({ id: otherShop, name: 'Other Motors', city: 'Salem' });
    const jobCardId = await makeCard('OPEN');

    await expect(
      cardService.transition({
        shopId: otherShop,
        jobCardId,
        event: 'BEGIN_DIAGNOSIS',
        actor: ACTOR,
        traceId: 'cross-tenant',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('AuditService chain verification', () => {
  it('reports the exact index of a tampered historical row', async () => {
    const jobCardId = await makeCard('DRAFT');
    await cardService.transition({
      shopId: SHOP_ID,
      jobCardId,
      event: 'OPEN_CARD',
      actor: ACTOR,
      traceId: 't',
    });
    await cardService.transition({
      shopId: SHOP_ID,
      jobCardId,
      event: 'BEGIN_DIAGNOSIS',
      actor: ACTOR,
      traceId: 't',
    });
    await cardService.transition({
      shopId: SHOP_ID,
      jobCardId,
      event: 'CANCEL',
      actor: ACTOR,
      traceId: 't',
    });

    expect((await auditService.verifyChain(SHOP_ID)).valid).toBe(true);

    // Tamper the way an attacker with database access would have to: by
    // disabling the append-only trigger first.
    await db.execute(sql`alter table audit_events disable trigger audit_events_append_only`);
    await db.execute(
      sql`update audit_events set payload = jsonb_set(payload, '{to}', '"CLOSED"') where shop_id = ${SHOP_ID} and seq = 2`,
    );
    await db.execute(sql`alter table audit_events enable trigger audit_events_append_only`);

    const verification = await auditService.verifyChain(SHOP_ID);
    expect(verification.valid).toBe(false);
    expect(verification.brokenAtIndex).toBe(1); // zero-based: seq 2
    expect(verification.reason).toMatch(/Content tampered/);
  });

  it('detects a deleted row as a sequence gap', async () => {
    const jobCardId = await makeCard('DRAFT');
    await cardService.transition({
      shopId: SHOP_ID,
      jobCardId,
      event: 'OPEN_CARD',
      actor: ACTOR,
      traceId: 't',
    });
    await cardService.transition({
      shopId: SHOP_ID,
      jobCardId,
      event: 'BEGIN_DIAGNOSIS',
      actor: ACTOR,
      traceId: 't',
    });
    await cardService.transition({
      shopId: SHOP_ID,
      jobCardId,
      event: 'CANCEL',
      actor: ACTOR,
      traceId: 't',
    });

    await db.execute(sql`alter table audit_events disable trigger audit_events_append_only`);
    await db.execute(sql`delete from audit_events where shop_id = ${SHOP_ID} and seq = 2`);
    await db.execute(sql`alter table audit_events enable trigger audit_events_append_only`);

    const verification = await auditService.verifyChain(SHOP_ID);
    expect(verification.valid).toBe(false);
    expect(verification.brokenAtIndex).toBe(1);
    expect(verification.reason).toMatch(/Sequence gap/);
  });

  it('keeps each shop on an independent chain', async () => {
    const otherShop = uuidv7();
    await db.insert(shops).values({ id: otherShop, name: 'Second Motors', city: 'Trichy' });

    const jobCardId = await makeCard('DRAFT');
    await cardService.transition({
      shopId: SHOP_ID,
      jobCardId,
      event: 'OPEN_CARD',
      actor: ACTOR,
      traceId: 't',
    });

    expect((await auditService.verifyChain(SHOP_ID)).entriesChecked).toBe(1);
    expect((await auditService.verifyChain(otherShop)).entriesChecked).toBe(0);
    expect((await auditService.verifyChain(otherShop)).valid).toBe(true);
  });
});
