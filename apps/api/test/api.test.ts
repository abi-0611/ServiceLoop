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
import { uuidv7 } from '@serviceloop/shared';
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
