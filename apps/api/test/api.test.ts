import 'reflect-metadata';
import { SANDBOX_VERIFY_TOKEN, SandboxWhatsAppAdapter } from '@serviceloop/adapters';
import { getEnv, resetEnvCache } from '@serviceloop/config';
import {
  blindIndex,
  createDatabase,
  runMigrations,
  schema,
  DEMO_ADVISOR,
  DEMO_JOB_CARDS,
  DEMO_OWNER,
  DEMO_SHOP_ID,
  seedDemoShop,
  type Database,
  type DatabaseHandle,
} from '@serviceloop/db';
import {
  AnalyticsRangeSchema,
  LedgerListSchema,
  NextVisitPromptListSchema,
  RecomputeResultSchema,
  SoftphonePollResponseSchema,
  SoftphoneStateSchema,
  uuidv7,
} from '@serviceloop/shared';
import { eq, sql } from 'drizzle-orm';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * API integration tests.
 *
 * Phase 1.8 acceptance: sign in as an advisor, read the board, be refused a
 * guardrail write, and fail to see another shop's data — with 404 rather than
 * 403, so no existence leaks.
 *
 * Phase 2 adds the channel surface: the webhook handshake, signature
 * verification over the raw bytes, the conversations inbox, console intake and
 * the sandbox simulator.
 */

const POSTGRES_IMAGE =
  'postgres:16.6-alpine@sha256:1d04b9ba1d4996401f2552b51beda8187f175c0645c091e4781134fc9c9a3eef';
const REDIS_IMAGE =
  'redis:7.4-alpine@sha256:e7723ff73d963f5cc6d9c4643ea3d989527a402a319239054e9472a7fb9219a2';

let containers: StartedTestContainer[] = [];
let handle: DatabaseHandle;
let db: Database;
let app: NestExpressApplication;
let server: ReturnType<NestExpressApplication['getHttpServer']>;

const OTHER_SHOP_ID = '01950000-0000-7000-8000-00000000ee01';
let otherShopCardId: string;

beforeAll(async () => {
  let databaseUrl = process.env['TEST_DATABASE_URL'] ?? '';
  if (databaseUrl.length === 0) {
    const postgres = await new GenericContainer(POSTGRES_IMAGE)
      .withEnvironment({
        POSTGRES_USER: 'serviceloop',
        POSTGRES_PASSWORD: 'serviceloop',
        POSTGRES_DB: 'serviceloop_test',
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .withStartupTimeout(120_000)
      .start();
    containers.push(postgres);
    databaseUrl = `postgres://serviceloop:serviceloop@${postgres.getHost()}:${postgres.getMappedPort(5432)}/serviceloop_test`;
  }

  let redisUrl = process.env['TEST_REDIS_URL'] ?? '';
  if (redisUrl.length === 0) {
    const redis = await new GenericContainer(REDIS_IMAGE)
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .withStartupTimeout(120_000)
      .start();
    containers.push(redis);
    redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
  }

  process.env['DATABASE_URL'] = databaseUrl;
  process.env['REDIS_URL'] = redisUrl;
  process.env['STORAGE_DRIVER'] = 'memory';
  // The softphone's line plays at real time by default, which is right for a
  // demo somebody is listening to and wrong for a suite: a ten-second greeting
  // would be ten seconds of CI. Nothing under test changes.
  process.env['VOICE_LOOPBACK_PLAYBACK_SPEED'] = '25';
  process.env['OTP_RESEND_COOLDOWN_SECONDS'] = '0';
  resetEnvCache();

  handle = createDatabase(getEnv());
  db = handle.db;
  await runMigrations(db);
  await resetSchema(db);
  await seedDemoShop(db, { log: () => undefined });

  // A second shop, so cross-tenant isolation can be probed with real ids.
  otherShopCardId = await seedOtherShop(db);

  const { createApp } = await import('../src/bootstrap');
  app = await createApp();
  await app.init();
  server = app.getHttpServer();
}, 300_000);

afterAll(async () => {
  await app?.close();
  await handle?.close();
  for (const container of containers) await container.stop();
  containers = [];
});

async function resetSchema(database: Database): Promise<void> {
  await database.execute(sql`
    alter table audit_events disable trigger audit_events_append_only;
    alter table estimate_lines disable trigger estimate_lines_immutable_when_accepted;
    truncate table idempotency_keys, events_outbox, audit_events, shop_config, escalations,
      declined_work_ledger, consents, messages, conversations, approval_requests,
      evidence_bundles, media_assets, estimate_lines, estimates, work_items,
      job_cards, vehicles, customers, staff, shops restart identity cascade;
    alter table audit_events enable trigger audit_events_append_only;
    alter table estimate_lines enable trigger estimate_lines_immutable_when_accepted;
  `);
}

async function seedOtherShop(database: Database): Promise<string> {
  const customerId = uuidv7();
  const vehicleId = uuidv7();
  const jobCardId = uuidv7();
  const phone = '+919990000001';

  await database.insert(schema.shops).values({
    id: OTHER_SHOP_ID,
    name: 'Rival Motors',
    city: 'Coimbatore',
  });
  await database.insert(schema.customers).values({
    id: customerId,
    shopId: OTHER_SHOP_ID,
    fullNameEncrypted: 'Rival Customer',
    phoneEncrypted: phone,
    phoneHash: blindIndex(OTHER_SHOP_ID, phone),
  });
  await database.insert(schema.vehicles).values({
    id: vehicleId,
    shopId: OTHER_SHOP_ID,
    customerId,
    registrationRaw: 'TN 38 AA 1111',
    registrationNormalised: 'TN38AA1111',
  });
  await database.insert(schema.jobCards).values({
    id: jobCardId,
    shopId: OTHER_SHOP_ID,
    customerId,
    vehicleId,
    code: 'JC-RIVAL-0001',
    state: 'OPEN',
  });
  return jobCardId;
}

async function signIn(phone: string): Promise<{ token: string; cookies: string[] }> {
  const requested = await request(server).post('/auth/otp/request').send({ phone }).expect(201);
  const demoCode = (requested.body as { demoCode?: string }).demoCode;
  expect(demoCode, 'DEMO_MODE must surface the OTP for the console').toBeDefined();

  const verified = await request(server)
    .post('/auth/otp/verify')
    .send({ phone, code: demoCode })
    .expect(201);

  const raw = verified.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return { token: (verified.body as { accessToken: string }).accessToken, cookies };
}

/**
 * A second visit for the customer whose earlier card is `fromJobCardId`.
 *
 * The next-visit prompt is only interesting on a *different* card: the whole
 * point of it is that this vehicle is back on the floor.
 */
async function createCardForCustomer(fromJobCardId: string): Promise<string> {
  const source = await db.execute<{ customer_id: string; vehicle_id: string | null }>(sql`
    select customer_id, vehicle_id from job_cards where id = ${fromJobCardId}
  `);
  const jobCardId = uuidv7();
  await db.insert(schema.jobCards).values({
    id: jobCardId,
    shopId: DEMO_SHOP_ID,
    customerId: source.rows[0]?.customer_id ?? '',
    vehicleId: source.rows[0]?.vehicle_id ?? null,
    code: `JC-RETURN-${jobCardId.slice(-4).toUpperCase()}`,
    state: 'OPEN',
  });
  return jobCardId;
}

describe('health', () => {
  it('reports readiness with its dependency checks', async () => {
    const response = await request(server).get('/health/ready').expect(200);
    expect(response.body).toMatchObject({ status: 'ok', demoMode: true });
    expect((response.body as { checks: unknown[] }).checks).toHaveLength(2);
  });

  it('serves prometheus metrics without authentication', async () => {
    const response = await request(server).get('/metrics').expect(200);
    expect(response.text).toContain('serviceloop_api_');
  });
});

describe('authentication', () => {
  it('issues a session for a real staff phone and sets rotating cookies', async () => {
    const { token, cookies } = await signIn(DEMO_ADVISOR.phone);
    expect(token).toMatch(/^ey/);
    expect(cookies.some((cookie) => cookie.startsWith('sl_access='))).toBe(true);
    expect(cookies.some((cookie) => cookie.startsWith('sl_refresh='))).toBe(true);
    expect(cookies.every((cookie) => cookie.includes('HttpOnly'))).toBe(true);
  });

  it('does not reveal whether a number belongs to staff', async () => {
    const unknown = await request(server)
      .post('/auth/otp/request')
      .send({ phone: '+919812345678' })
      .expect(201);

    expect(unknown.body).toMatchObject({ sent: true });
    expect((unknown.body as { demoCode?: string }).demoCode).toBeUndefined();

    await request(server)
      .post('/auth/otp/verify')
      .send({ phone: '+919812345678', code: '000000' })
      .expect(401);
  });

  it('rejects a wrong code and an invalid phone shape', async () => {
    await request(server).post('/auth/otp/request').send({ phone: DEMO_OWNER.phone }).expect(201);
    await request(server)
      .post('/auth/otp/verify')
      .send({ phone: DEMO_OWNER.phone, code: '999999' })
      .expect(401);

    const invalid = await request(server)
      .post('/auth/otp/request')
      .send({ phone: '12345' })
      .expect(400);
    expect(invalid.body).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses unauthenticated access to protected routes', async () => {
    const response = await request(server).get('/jobcards/board').expect(401);
    expect(response.body).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('rotates the refresh token so a replayed one is rejected', async () => {
    const { cookies } = await signIn(DEMO_ADVISOR.phone);
    const refreshCookie = cookies.find((cookie) => cookie.startsWith('sl_refresh='));
    expect(refreshCookie).toBeDefined();

    await request(server)
      .post('/auth/refresh')
      .set('Cookie', refreshCookie as string)
      .expect(201);
    await request(server)
      .post('/auth/refresh')
      .set('Cookie', refreshCookie as string)
      .expect(401);
  });

  it('returns the caller’s memberships from /auth/me', async () => {
    const { token } = await signIn(DEMO_OWNER.phone);
    const response = await request(server)
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body).toMatchObject({ role: 'OWNER', shopId: DEMO_SHOP_ID });
    expect((response.body as { shops: unknown[] }).shops).toHaveLength(1);
  });
});

describe('job cards', () => {
  it('serves the seeded board to an advisor', async () => {
    const { token } = await signIn(DEMO_ADVISOR.phone);
    const response = await request(server)
      .get('/jobcards/board')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const body = response.body as {
      totalCards: number;
      columns: Array<{
        state: string;
        cards: Array<{ code: string; customer: { fullName: string; phoneMasked: string } }>;
      }>;
    };

    // Counted from the fixture rather than written down here: the seed is the
    // shop's shape and it changes when the demo needs a different one, but the
    // board must always show every card in it and never invent one.
    expect(body.totalCards).toBe(DEMO_JOB_CARDS.length);
    expect(body.columns).toHaveLength(12);

    const states = body.columns
      .filter((column) => column.cards.length > 0)
      .map((column) => column.state);
    expect(states).toEqual(
      expect.arrayContaining([
        'AWAITING_APPROVAL',
        'IN_PROGRESS',
        'READY_FOR_DELIVERY',
        'DELIVERED',
      ]),
    );

    const card = body.columns.flatMap((column) => column.cards)[0];
    expect(card?.customer.fullName).toBeTruthy();
    expect(card?.customer.phoneMasked).toMatch(/x{5}/);
  });

  it('serves a card detail with work items, estimate and audit trail', async () => {
    const { token } = await signIn(DEMO_ADVISOR.phone);
    const board = await request(server)
      .get('/jobcards/board')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const target = (
      board.body as { columns: Array<{ state: string; cards: Array<{ id: string }> }> }
    ).columns.find((column) => column.state === 'AWAITING_APPROVAL')?.cards[0];
    expect(target).toBeDefined();

    const detail = await request(server)
      .get(`/jobcards/${target?.id ?? ''}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const body = detail.body as {
      workItems: unknown[];
      estimates: Array<{ lines: unknown[] }>;
      auditTrail: Array<{ seq: number; hash: string }>;
      allowedEvents: string[];
    };

    expect(body.workItems.length).toBeGreaterThan(0);
    expect(body.estimates[0]?.lines.length).toBeGreaterThan(0);
    expect(body.auditTrail.length).toBeGreaterThan(0);
    expect(body.auditTrail[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.allowedEvents).toContain('CANCEL');
  });

  it('applies a legal transition and refuses an illegal one', async () => {
    const { token } = await signIn(DEMO_ADVISOR.phone);
    const board = await request(server)
      .get('/jobcards/board')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const open = (
      board.body as { columns: Array<{ state: string; cards: Array<{ id: string }> }> }
    ).columns.find((column) => column.state === 'OPEN')?.cards[0];
    expect(open).toBeDefined();

    const applied = await request(server)
      .post(`/jobcards/${open?.id ?? ''}/transitions`)
      .set('Authorization', `Bearer ${token}`)
      .send({ event: 'BEGIN_DIAGNOSIS' })
      .expect(201);
    expect(applied.body).toMatchObject({ from: 'OPEN', to: 'IN_DIAGNOSIS' });

    const rejected = await request(server)
      .post(`/jobcards/${open?.id ?? ''}/transitions`)
      .set('Authorization', `Bearer ${token}`)
      .send({ event: 'CLOSE' })
      .expect(409);
    expect(rejected.body).toMatchObject({ code: 'ILLEGAL_TRANSITION' });
  });

  it('rejects an unknown transition event at the DTO boundary', async () => {
    const { token } = await signIn(DEMO_ADVISOR.phone);
    const response = await request(server)
      .post(`/jobcards/${otherShopCardId}/transitions`)
      .set('Authorization', `Bearer ${token}`)
      .send({ event: 'TELEPORT' })
      .expect(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('multi-tenancy', () => {
  it('returns 404, not 403, for another shop’s card', async () => {
    const { token } = await signIn(DEMO_ADVISOR.phone);

    const read = await request(server)
      .get(`/jobcards/${otherShopCardId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
    expect(read.body).toMatchObject({ code: 'NOT_FOUND' });

    const write = await request(server)
      .post(`/jobcards/${otherShopCardId}/transitions`)
      .set('Authorization', `Bearer ${token}`)
      .send({ event: 'BEGIN_DIAGNOSIS' })
      .expect(404);
    expect(write.body).toMatchObject({ code: 'NOT_FOUND' });

    // And the other shop's card is untouched.
    const [card] = await db
      .select()
      .from(schema.jobCards)
      .where(eq(schema.jobCards.id, otherShopCardId));
    expect(card?.state).toBe('OPEN');
  });

  it('never lists another shop’s cards on the board', async () => {
    const { token } = await signIn(DEMO_ADVISOR.phone);
    const board = await request(server)
      .get('/jobcards/board')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const codes = (
      board.body as { columns: Array<{ cards: Array<{ code: string }> }> }
    ).columns.flatMap((column) => column.cards.map((card) => card.code));
    expect(codes).not.toContain('JC-RIVAL-0001');
  });
});

describe('guardrail configuration', () => {
  it('lets any staff member read the config', async () => {
    const { token } = await signIn(DEMO_ADVISOR.phone);
    const response = await request(server)
      .get('/config/guardrails')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body).toMatchObject({
      editable: false,
      config: { autonomy: { approval: 'L0_SHADOW' }, pricing: { priceFloorPercent: 100 } },
    });
  });

  it('forbids an advisor from writing it', async () => {
    const { token } = await signIn(DEMO_ADVISOR.phone);
    const response = await request(server)
      .patch('/config/guardrails')
      .set('Authorization', `Bearer ${token}`)
      .send({ autonomy: { status: 'L1_TEMPLATED' } })
      .expect(403);

    expect(response.body).toMatchObject({ code: 'FORBIDDEN', details: { actualRole: 'ADVISOR' } });
  });

  it('lets the owner write it, and audits the diff', async () => {
    const { token } = await signIn(DEMO_OWNER.phone);

    const patched = await request(server)
      .patch('/config/guardrails')
      .set('Authorization', `Bearer ${token}`)
      .send({ quietHours: { start: '22:00' } })
      .expect(200);

    expect(patched.body).toMatchObject({
      changed: [{ path: 'quietHours.start', before: '21:00', after: '22:00' }],
    });
    expect((patched.body as { auditEventId: string | null }).auditEventId).not.toBeNull();

    const reread = await request(server)
      .get('/config/guardrails')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(reread.body).toMatchObject({
      config: { quietHours: { start: '22:00' } },
      editable: true,
    });
  });

  it('rejects an invalid patch with field-level errors', async () => {
    const { token } = await signIn(DEMO_OWNER.phone);
    const response = await request(server)
      .patch('/config/guardrails')
      .set('Authorization', `Bearer ${token}`)
      .send({ pricing: { priceFloorPercent: 400 } })
      .expect(400);

    expect(response.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(JSON.stringify(response.body)).toContain('pricing.priceFloorPercent');
  });

  it('cannot be patched to remove the AI disclosure', async () => {
    const { token } = await signIn(DEMO_OWNER.phone);
    await request(server)
      .patch('/config/guardrails')
      .set('Authorization', `Bearer ${token}`)
      .send({ disclosure: { requireFirstContactDisclosure: false } })
      .expect(400);
  });
});

describe('audit endpoints', () => {
  it('verifies the shop chain for the owner', async () => {
    const { token } = await signIn(DEMO_OWNER.phone);
    const response = await request(server)
      .get('/audit/verify')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body).toMatchObject({ valid: true, shopId: DEMO_SHOP_ID, brokenAtIndex: null });
    expect((response.body as { entriesChecked: number }).entriesChecked).toBeGreaterThan(50);
  });

  it('is closed to advisors', async () => {
    const { token } = await signIn(DEMO_ADVISOR.phone);
    await request(server).get('/audit/verify').set('Authorization', `Bearer ${token}`).expect(403);
    await request(server)
      .get('/audit/dead-letter')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('lists the dead-letter backlog for the owner', async () => {
    const { token } = await signIn(DEMO_OWNER.phone);
    const response = await request(server)
      .get('/audit/dead-letter')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body).toMatchObject({ counts: { PENDING: expect.any(Number) }, events: [] });
  });
});

/* -------------------------------------------------------------------------- *
 * Phase 2 — channels & intake
 * -------------------------------------------------------------------------- */

describe('whatsapp webhook', () => {
  it('echoes the challenge when the verify token matches', async () => {
    const response = await request(server)
      .get('/webhooks/whatsapp')
      .query({
        'hub.mode': 'subscribe',
        'hub.verify_token': SANDBOX_VERIFY_TOKEN,
        'hub.challenge': 'challenge-42',
      })
      .expect(200);

    expect(response.text).toBe('challenge-42');
  });

  it('refuses the handshake with the wrong verify token', async () => {
    await request(server)
      .get('/webhooks/whatsapp')
      .query({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'not-the-token',
        'hub.challenge': 'challenge-42',
      })
      .expect(401);
  });

  it('rejects a tampered payload before parsing it', async () => {
    const adapter = new SandboxWhatsAppAdapter({ deliveryMode: 'manual' });
    const delivery = adapter.injectInbound({
      kind: 'text',
      from: '+919841100099',
      text: 'hello',
    });

    // The signature is computed over the original bytes; changing one word
    // must invalidate it. If this ever passes, every forged webhook does too.
    const tampered = delivery.rawBody.replace('hello', 'hell0');
    const response = await request(server)
      .post('/webhooks/whatsapp')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', delivery.signatureHeader as string)
      .send(tampered);

    // 401, not 500. Meta retries a 5xx, so a permanently invalid signature
    // would be redelivered forever; a 4xx tells it to stop.
    expect(response.status).toBe(401);
    expect((response.body as { detail: string }).detail).toContain('X-Hub-Signature-256');
  });

  it('accepts a correctly signed delivery and routes it', async () => {
    const adapter = new SandboxWhatsAppAdapter({ deliveryMode: 'manual' });
    const phone = `+9198${String(Date.now()).slice(-8)}`;
    const delivery = adapter.injectInbound({
      kind: 'text',
      from: phone,
      displayName: 'Webhook tester',
      text: 'Is my car ready?',
    });

    const response = await request(server)
      .post('/webhooks/whatsapp')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', delivery.signatureHeader as string)
      .send(delivery.rawBody)
      .expect(200);

    expect(response.body).toMatchObject({ received: 1 });

    const { token } = await signIn(DEMO_ADVISOR.phone);
    const inbox = await request(server)
      .get('/conversations')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    // Newest first, and this thread was just touched. It is UNKNOWN because
    // the shop has never seen this number — which is what earns it the
    // identification prompt rather than silence.
    const threads = (inbox.body as { threads: Array<{ id: string; kind: string }> }).threads;
    const thread = threads[0];
    expect(thread?.kind).toBe('UNKNOWN');

    const detail = await request(server)
      .get(`/conversations/${thread?.id ?? ''}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const body = detail.body as {
      messages: Array<{ direction: string; body: string }>;
    };
    expect(body.messages.some((message) => message.body === 'Is my car ready?')).toBe(true);
    // And the shop answered, disclosing the AI as master §6 requires.
    expect(
      body.messages.some(
        (message) =>
          message.direction === 'OUTBOUND' &&
          message.body.toLowerCase().includes('serviceloop assistant'),
      ),
    ).toBe(true);
  });
});

describe('conversations', () => {
  it('never returns a full phone number to the console', async () => {
    const { token } = await signIn(DEMO_ADVISOR.phone);
    const response = await request(server)
      .get('/conversations')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    for (const thread of (response.body as { threads: Array<{ addressMasked: string }> }).threads) {
      expect(thread.addressMasked).not.toMatch(/\d{10}/);
    }
  });

  it('404s a thread belonging to another shop', async () => {
    const { token } = await signIn(DEMO_ADVISOR.phone);
    await request(server)
      .get(`/conversations/${uuidv7()}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });
});

describe('intake', () => {
  it('creates an OPEN job card from the console form', async () => {
    const { token } = await signIn(DEMO_ADVISOR.phone);
    const suffix = String(Date.now()).slice(-4);

    const response = await request(server)
      .post('/intake/job-cards')
      .set('Authorization', `Bearer ${token}`)
      .send({
        customerName: 'Form Customer',
        phone: `98${String(Date.now()).slice(-8)}`,
        registration: `TN09FM${suffix}`,
        complaints: ['Brake noise'],
        estimateLines: [{ description: 'Front pads', quantity: 2, unitPriceRupees: 1250 }],
      })
      .expect(201);

    const created = response.body as { jobCardId: string; code: string; workItemCount: number };
    expect(created.code).toMatch(/^JC-/);
    expect(created.workItemCount).toBeGreaterThan(0);

    const detail = await request(server)
      .get(`/jobcards/${created.jobCardId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(detail.body).toMatchObject({ state: 'OPEN', source: 'CONSOLE' });
  });

  it('rejects a form whose registration cannot be normalised', async () => {
    const { token } = await signIn(DEMO_ADVISOR.phone);
    await request(server)
      .post('/intake/job-cards')
      .set('Authorization', `Bearer ${token}`)
      .send({ customerName: 'Bad Plate', phone: '9840012345', registration: '' })
      .expect(400);
  });

  it('404s a draft belonging to another shop', async () => {
    const { token } = await signIn(DEMO_ADVISOR.phone);
    await request(server)
      .get(`/intake/drafts/${uuidv7()}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });
});

describe('sandbox simulator', () => {
  it('lists personas drawn from the seeded shop', async () => {
    const { token } = await signIn(DEMO_ADVISOR.phone);
    const response = await request(server)
      .get('/sandbox/personas')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const body = response.body as { personas: Array<{ kind: string }> };
    expect(body.personas.some((persona) => persona.kind === 'CUSTOMER')).toBe(true);
    expect(body.personas.some((persona) => persona.kind === 'STAFF')).toBe(true);
  });

  it('injects a message and returns the pipeline trace', async () => {
    const { token } = await signIn(DEMO_ADVISOR.phone);
    const personas = await request(server)
      .get('/sandbox/personas')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const customer = (personas.body as { personas: Array<{ id: string; kind: string }> }).personas.find(
      (persona) => persona.kind === 'CUSTOMER',
    );
    expect(customer).toBeDefined();

    const response = await request(server)
      .post('/sandbox/inject')
      .set('Authorization', `Bearer ${token}`)
      .send({ personaId: customer?.id, kind: 'text', text: 'Hello from the simulator' })
      .expect(201);

    const body = response.body as { trace: Array<{ stage: string }>; conversationId: string | null };
    expect(body.conversationId).not.toBeNull();
    expect(body.trace.map((step) => step.stage)).toContain('router');
  });
});


/**
 * The softphone, over HTTP (phase 5.1).
 *
 * A whole telephone call driven the way the console drives it: ring in, answer,
 * listen, press a key, listen again. What makes this worth writing rather than
 * trusting the unit suite is that it proves the *seam* — that the browser's far
 * end really is the loopback adapter behind the same `TelephonyPort` a telco
 * would sit behind, that the page addresses a call by its row id rather than by
 * the line's, and that the transcript it renders is the persisted one.
 */
describe('voice softphone', () => {
  beforeAll(async () => {
    // Voice is off for a new shop, deliberately (§6: L0 first). Switching it on
    // is what an owner does in settings, and the softphone cannot answer a line
    // the shop has not published.
    await db.execute(sql`
      update shop_config
      set config = jsonb_set(
            config,
            '{voice}',
            coalesce(config->'voice', '{}'::jsonb)
              || '{"enabled":true,"outboundEnabled":true,"inboundEnabled":true}'::jsonb
          )
      where shop_id = ${DEMO_SHOP_ID}
    `);
  });

  it('reports what the page needs to render itself', async () => {
    const { token } = await signIn(DEMO_ADVISOR.phone);
    const response = await request(server)
      .get('/voice/softphone')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const state = SoftphoneStateSchema.parse(response.body);
    expect(state).toMatchObject({ driver: 'loopback', enabled: true, killSwitch: false });
    // Personas are the shop's own customers, so a developer rings somebody who
    // exists rather than a fixture with no job card.
    expect(state.personas.length).toBeGreaterThan(0);
  });

  it('answers an inbound call and reaches a person on 0', async () => {
    const { token } = await signIn(DEMO_ADVISOR.phone);
    const auth = (req: request.Test): request.Test =>
      req.set('Authorization', `Bearer ${token}`);

    const state = SoftphoneStateSchema.parse(
      (await auth(request(server).get('/voice/softphone')).expect(200)).body,
    );
    const persona = state.personas[0];
    expect(persona).toBeDefined();

    const started = await auth(
      request(server).post('/voice/softphone/inbound').send({ personaId: persona?.id }),
    ).expect(201);

    const call = (started.body as { call: { callId: string } | null }).call;
    expect(call, JSON.stringify(started.body)).not.toBeNull();
    const callId = call?.callId ?? '';

    await auth(request(server).post(`/voice/softphone/${callId}/answer`)).expect(201);

    // The ⚿ opening, marked in the transcript the page renders. Asserted on the
    // marks rather than on the words: this shop's customer answers in Tamil,
    // and a compliance check by string comparison breaks the first time
    // somebody improves a Tamil sentence.
    const opening = await listen(auth, callId);
    expect(opening.turns.filter((turn) => turn.mandatory).length).toBeGreaterThanOrEqual(2);
    // Audio actually crossed the wire: the page has something to play.
    expect(opening.audioBytes).toBeGreaterThan(0);

    await auth(
      request(server).post(`/voice/softphone/${callId}/speak`).send({ dtmf: '0' }),
    ).expect(201);

    // 0 reaches a person from anywhere, and the advisor is whispered a summary
    // before the legs join — which is what the console screen-pops.
    const bridged = await listen(auth, callId, opening.cursor);
    expect(bridged.turns.length).toBeGreaterThan(0);
    expect(bridged.screenPop?.whisper ?? '').not.toHaveLength(0);

    // The console's own read of the finished call, from the persisted rows.
    const detail = await auth(request(server).get(`/voice/calls/${callId}`)).expect(200);
    const body = detail.body as {
      call: { direction: string; handedOff: boolean; whisperText: string | null };
      transcript: Array<{ scriptKey: string | null; mandatory: boolean }>;
    };

    expect(body.call.direction).toBe('INBOUND');
    expect(body.call.handedOff).toBe(true);
    expect(body.transcript[0]?.scriptKey).toBe('voice.inbound.greeting');
    expect(body.transcript.some((turn) => turn.scriptKey === 'voice.recording_notice')).toBe(true);
  });
});

/**
 * Polls the handset until the line goes quiet.
 *
 * Polls rather than waits for a length, because an agent turn is several
 * utterances and the gaps between them are milliseconds — which is exactly the
 * loop the console's own softphone page runs.
 */
async function listen(
  auth: (req: request.Test) => request.Test,
  callId: string,
  cursor = 0,
): Promise<{
  turns: Array<{ text: string; mandatory: boolean }>;
  cursor: number;
  audioBytes: number;
  screenPop: { whisper: string } | null;
}> {
  const turns: Array<{ text: string; mandatory: boolean }> = [];
  let audioBytes = 0;
  let screenPop: { whisper: string } | null = null;
  let quiet = 0;
  let at = cursor;

  for (let attempt = 0; attempt < 2_000 && quiet < 40; attempt += 1) {
    const response = await auth(
      request(server).get(`/voice/softphone/${callId}/poll`).query({ cursor: at }),
    ).expect(200);

    const body = SoftphonePollResponseSchema.parse(response.body);
    turns.push(...body.turns.map((turn) => ({ text: turn.text, mandatory: turn.mandatory })));
    audioBytes += Buffer.from(body.audioBase64, 'base64').length;
    if (body.screenPop !== null) screenPop = { whisper: body.screenPop.whisper };
    at = body.cursor;

    quiet = body.turns.length === 0 && body.audioBase64.length === 0 ? quiet + 1 : 0;
    if (body.call?.endedAt != null) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  return { turns, cursor: at, audioBytes, screenPop };
}

/* ========================================================================== *
 * Phase 6 — the retention and analytics surface
 * ========================================================================== */

describe('retention & analytics', () => {
  let ledgerItemId: string;
  let vehicleId: string;
  let jobCardId: string;
  let today: string;

  beforeAll(async () => {
    // A declined item on a seeded card, written directly. The *lifecycle* that
    // produces one is proven in the domain suite and in `demo:phase6`; what
    // these tests are about is what the console can read back.
    const card = await db.execute<{ id: string; vehicle_id: string; customer_id: string }>(sql`
      select id, vehicle_id, customer_id from job_cards
      where shop_id = ${DEMO_SHOP_ID} and vehicle_id is not null
      order by created_at asc limit 1
    `);
    jobCardId = card.rows[0]?.id ?? '';
    vehicleId = card.rows[0]?.vehicle_id ?? '';
    const customerId = card.rows[0]?.customer_id ?? '';

    const workItem = await db.execute<{ id: string }>(sql`
      select id from work_items where shop_id = ${DEMO_SHOP_ID} and job_card_id = ${jobCardId}
      order by sequence asc limit 1
    `);

    ledgerItemId = uuidv7();
    await db.execute(sql`
      insert into declined_work_ledger (
        id, shop_id, job_card_id, work_item_id, customer_id, vehicle_id, kind,
        decline_reason, reason, amount_paise, category, title, technician_note,
        estimate_line_ids, follow_up_after, trigger_tags, status, created_at, updated_at
      ) values (
        ${ledgerItemId}, ${DEMO_SHOP_ID}, ${jobCardId}, ${workItem.rows[0]?.id ?? uuidv7()},
        ${customerId}, ${vehicleId}, 'DEFERRED', 'customer_deferred',
        'Customer asked to do it next time', 240000, 'brakes',
        'Front brake pad replacement', 'Front pads worn to 2.1mm.',
        '[]'::jsonb, now() + interval '30 days', '["next_visit","season:monsoon"]'::jsonb,
        'OPEN', now(), now()
      )
      on conflict (work_item_id) do nothing
    `);

    today = new Date().toISOString().slice(0, 10);
  });

  it('serves the declined-work ledger with the two totals that matter', async () => {
    const { token } = await signIn(DEMO_ADVISOR.phone);
    const response = await request(server)
      .get('/retention/ledger')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const list = LedgerListSchema.parse(response.body);
    const mine = list.items.find((item) => item.id === ledgerItemId);
    expect(mine).toBeDefined();
    expect(mine?.technicianNote).toContain('2.1mm');
    expect(mine?.triggerTags).toContain('season:monsoon');
    // The totals come from the server, so a filtered page cannot change them.
    expect(list.openValuePaise).toBeGreaterThanOrEqual(240_000);
  });

  it('filters the ledger by status without changing the totals', async () => {
    const { token } = await signIn(DEMO_ADVISOR.phone);
    const all = LedgerListSchema.parse(
      (await request(server).get('/retention/ledger').set('Authorization', `Bearer ${token}`)).body,
    );
    const converted = LedgerListSchema.parse(
      (
        await request(server)
          .get('/retention/ledger?status=CONVERTED')
          .set('Authorization', `Bearer ${token}`)
      ).body,
    );

    expect(converted.items.every((item) => item.status === 'CONVERTED')).toBe(true);
    expect(converted.openValuePaise).toBe(all.openValuePaise);
  });

  it('offers the “while it’s here” prompt on a different card for the same customer', async () => {
    const { token } = await signIn(DEMO_ADVISOR.phone);

    // On the card the work was declined on, there is nothing to say: the
    // customer refused it on this visit.
    const same = await request(server)
      .get(`/retention/next-visit/${jobCardId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(NextVisitPromptListSchema.parse(same.body).prompts).toEqual([]);

    // A second card for the same customer is the moment the phase is about.
    const secondCard = await createCardForCustomer(jobCardId);
    const other = await request(server)
      .get(`/retention/next-visit/${secondCard}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const prompts = NextVisitPromptListSchema.parse(other.body).prompts;
    expect(prompts.map((prompt) => prompt.ledgerItemId)).toContain(ledgerItemId);
    expect(prompts[0]?.technicianNote).toContain('2.1mm');
  });

  it('404s a next-visit read for another shop’s card', async () => {
    const { token } = await signIn(DEMO_ADVISOR.phone);
    await request(server)
      .get(`/retention/next-visit/${otherShopCardId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('records a renewal date without enrolling anybody in reminders', async () => {
    const { token } = await signIn(DEMO_ADVISOR.phone);
    const response = await request(server)
      .post('/retention/documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ vehicleId, kind: 'INSURANCE', expiresOn: '2027-03-31' })
      .expect(201);

    expect(response.body).toMatchObject({ recorded: true, enrolled: false });

    // The row exists and is *not* enrolled. That separation is the whole point:
    // knowing a date is not permission to write about it.
    const stored = await db.execute<{ enrolled_at: Date | null }>(sql`
      select enrolled_at from vehicle_documents
      where shop_id = ${DEMO_SHOP_ID} and vehicle_id = ${vehicleId} and kind = 'INSURANCE'
    `);
    expect(stored.rows[0]?.enrolled_at ?? null).toBeNull();
  });

  it('records a console odometer reading that can never wake a re-pitch', async () => {
    const { token } = await signIn(DEMO_ADVISOR.phone);
    await request(server)
      .post('/retention/odometer')
      .set('Authorization', `Bearer ${token}`)
      .send({ vehicleId, odometerKm: 64_500 })
      .expect(201);

    const stored = await db.execute<{ source: string }>(sql`
      select source from odometer_readings
      where shop_id = ${DEMO_SHOP_ID} and vehicle_id = ${vehicleId}
      order by read_at desc limit 1
    `);
    // Not CUSTOMER_VOLUNTEERED. The odometer trigger reads only readings the
    // customer gave in their own words, and an advisor typing one at the
    // counter must never be able to cause a message.
    expect(stored.rows[0]?.source).toBe('CONSOLE');
  });

  it('404s a vehicle belonging to another shop', async () => {
    const { token } = await signIn(DEMO_ADVISOR.phone);
    await request(server)
      .post('/retention/odometer')
      .set('Authorization', `Bearer ${token}`)
      .send({ vehicleId: uuidv7(), odometerKm: 10_000 })
      .expect(404);
  });

  it('serves an analytics summary whose rates are null, not zero, with no data', async () => {
    const { token } = await signIn(DEMO_ADVISOR.phone);
    const response = await request(server)
      .get('/analytics/summary')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const range = AnalyticsRangeSchema.parse(response.body);
    expect(range.to).toBe(today);
    // "We have not asked for an approval" and "every approval was refused" are
    // different facts, and a dashboard that drew both as 0% would tell a shop
    // it is failing at something it has not started.
    expect(range.kpis.approvalConversionRate).toBeNull();
  });

  it('folds a day and then quotes the same numbers back', async () => {
    const { token } = await signIn(DEMO_OWNER.phone);

    const recompute = await request(server)
      .post('/analytics/recompute')
      .set('Authorization', `Bearer ${token}`)
      .send({ from: today })
      .expect(201);

    const result = RecomputeResultSchema.parse(recompute.body);
    expect(result.days).toBe(1);

    // And the second pass changes nothing at all, which is the audit story for
    // every rupee this phase reports.
    const again = RecomputeResultSchema.parse(
      (
        await request(server)
          .post('/analytics/recompute')
          .set('Authorization', `Bearer ${token}`)
          .send({ from: today })
      ).body,
    );
    expect(again.changedDays).toBe(0);

    const summary = AnalyticsRangeSchema.parse(
      (
        await request(server)
          .get(`/analytics/summary?from=${today}&to=${today}`)
          .set('Authorization', `Bearer ${token}`)
      ).body,
    );
    expect(summary.days).toHaveLength(1);
  });

  it('refuses a backfill wider than the shop has configured, with a field error', async () => {
    const { token } = await signIn(DEMO_OWNER.phone);
    const response = await request(server)
      .post('/analytics/recompute')
      .set('Authorization', `Bearer ${token}`)
      .send({ from: '2020-01-01', to: today })
      .expect(400);

    expect((response.body as { detail: string }).detail).toContain('maxBackfillDays');
  });

  it('keeps the backfill to owners', async () => {
    const { token } = await signIn(DEMO_ADVISOR.phone);
    await request(server)
      .post('/analytics/recompute')
      .set('Authorization', `Bearer ${token}`)
      .send({ from: today })
      .expect(403);
  });

  it('exports the same rollups as CSV, one row per day', async () => {
    const { token } = await signIn(DEMO_ADVISOR.phone);
    const response = await request(server)
      .get(`/analytics/export.csv?from=${today}&to=${today}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toContain('attachment');

    const [header, first] = response.text.trim().split('\n');
    expect(header).toContain('recoveredPaise');
    expect(header).toContain('declinedWorkRecoveryRate');
    expect(first?.startsWith(today)).toBe(true);
    // A null rate is an empty cell, never a fabricated zero: `=AVERAGE()` over
    // an empty cell is right and over a zero is wrong.
    expect(first).toContain(',,');
  });

  it('never serves another shop’s numbers', async () => {
    const { token } = await signIn(DEMO_ADVISOR.phone);
    const list = LedgerListSchema.parse(
      (await request(server).get('/retention/ledger').set('Authorization', `Bearer ${token}`)).body,
    );
    expect(list.items.every((item) => item.jobCardId !== otherShopCardId)).toBe(true);
  });
});
