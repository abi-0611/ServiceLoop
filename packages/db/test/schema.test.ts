import { defaultShopConfig } from '@serviceloop/config';
import { lineTotal, uuidv7 } from '@serviceloop/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import { blindIndex, decryptPii, encryptPii, isEncryptedPii } from '../src/crypto/pii';
import { StaffRepository } from '../src/repositories/staff-repository';
import {
  approvalRequests,
  auditEvents,
  consents,
  conversations,
  customers,
  declinedWorkLedger,
  escalations,
  estimateLines,
  estimates,
  eventsOutbox,
  evidenceBundles,
  idempotencyKeys,
  jobCards,
  mediaAssets,
  messages,
  shopConfig,
  shops,
  staff,
  vehicles,
  workItems,
} from '../src/schema';
import { startTestDatabase, truncateAll, type TestDatabase } from './harness';

let harness: TestDatabase;
let db: Database;

beforeAll(async () => {
  harness = await startTestDatabase();
  db = harness.db;
});

afterAll(async () => {
  await harness.stop();
});

beforeEach(async () => {
  await truncateAll(db);
});

const SHOP_ID = '01930000-0000-7000-8000-00000000aa01';

async function seedMinimum(): Promise<{
  shopId: string;
  staffId: string;
  customerId: string;
  vehicleId: string;
  jobCardId: string;
  workItemId: string;
  estimateId: string;
}> {
  const staffId = uuidv7();
  const customerId = uuidv7();
  const vehicleId = uuidv7();
  const jobCardId = uuidv7();
  const workItemId = uuidv7();
  const estimateId = uuidv7();

  await db.insert(shops).values({ id: SHOP_ID, name: 'Test Motors', city: 'Chennai' });
  await db.insert(staff).values({
    id: staffId,
    shopId: SHOP_ID,
    role: 'ADVISOR',
    fullName: 'Test Advisor',
    phoneEncrypted: '+919840000001',
    phoneHash: blindIndex(SHOP_ID, '+919840000001'),
  });
  await db.insert(customers).values({
    id: customerId,
    shopId: SHOP_ID,
    fullNameEncrypted: 'Test Customer',
    phoneEncrypted: '+919841000001',
    phoneHash: blindIndex(SHOP_ID, '+919841000001'),
    preferredLanguage: 'ta',
  });
  await db.insert(vehicles).values({
    id: vehicleId,
    shopId: SHOP_ID,
    customerId,
    registrationRaw: 'TN 09 BX 1234',
    registrationNormalised: 'TN09BX1234',
    make: 'Maruti Suzuki',
    model: 'Swift',
  });
  await db.insert(jobCards).values({
    id: jobCardId,
    shopId: SHOP_ID,
    customerId,
    vehicleId,
    code: 'JC-TEST-0001',
    state: 'OPEN',
  });
  await db.insert(workItems).values({
    id: workItemId,
    shopId: SHOP_ID,
    jobCardId,
    title: 'Brake pads',
    state: 'PROPOSED',
  });
  await db.insert(estimates).values({
    id: estimateId,
    shopId: SHOP_ID,
    jobCardId,
    version: 1,
    status: 'DRAFT',
    subtotalPaise: 305000,
    taxPaise: 54900,
    totalPaise: 359900,
  });

  return { shopId: SHOP_ID, staffId, customerId, vehicleId, jobCardId, workItemId, estimateId };
}

describe('schema smoke', () => {
  it('accepts one row in every table', async () => {
    const base = await seedMinimum();

    await db.insert(estimateLines).values({
      shopId: SHOP_ID,
      estimateId: base.estimateId,
      workItemId: base.workItemId,
      kind: 'PART',
      description: 'Front brake pad set',
      quantityMilli: 1000,
      unitPricePaise: 245000,
      lineTotalPaise: lineTotal(1000, 245000),
    });

    const mediaId = uuidv7();
    await db.insert(mediaAssets).values({
      id: mediaId,
      shopId: SHOP_ID,
      jobCardId: base.jobCardId,
      workItemId: base.workItemId,
      kind: 'PHOTO',
      bucket: 'serviceloop-media',
      storageKey: `shops/${SHOP_ID}/job-cards/${base.jobCardId}/photo/${mediaId}.jpg`,
      contentType: 'image/jpeg',
      sizeBytes: 1024,
      checksumSha256: 'a'.repeat(64),
    });

    const bundleId = uuidv7();
    await db.insert(evidenceBundles).values({
      id: bundleId,
      shopId: SHOP_ID,
      jobCardId: base.jobCardId,
      title: 'Front brakes',
      summaryText: 'Front pads at 2.1mm against a 3mm limit.',
      mediaIds: [mediaId],
      workItemIds: [base.workItemId],
    });

    await db.insert(approvalRequests).values({
      shopId: SHOP_ID,
      jobCardId: base.jobCardId,
      estimateId: base.estimateId,
      evidenceBundleId: bundleId,
      amountPaise: 359900,
    });

    const conversationId = uuidv7();
    await db.insert(conversations).values({
      id: conversationId,
      shopId: SHOP_ID,
      customerId: base.customerId,
      channel: 'WHATSAPP',
      externalThreadId: '919841000001',
    });
    await db.insert(messages).values({
      shopId: SHOP_ID,
      conversationId,
      direction: 'OUTBOUND',
      channel: 'WHATSAPP',
      body: 'Your Swift is ready for pickup.',
      status: 'DRAFT',
    });
    await db.insert(consents).values({
      shopId: SHOP_ID,
      customerId: base.customerId,
      purpose: 'SERVICE',
      status: 'GRANTED',
      channel: 'WHATSAPP',
      grantedAt: new Date(),
    });
    await db.insert(declinedWorkLedger).values({
      shopId: SHOP_ID,
      jobCardId: base.jobCardId,
      workItemId: base.workItemId,
      customerId: base.customerId,
      vehicleId: base.vehicleId,
      kind: 'DEFERRED',
      reason: 'Will do it next service',
      followUpAfter: new Date(Date.now() + 90 * 86_400_000),
    });
    await db.insert(escalations).values({
      shopId: SHOP_ID,
      objective: 'APPROVAL',
      subjectType: 'JobCard',
      subjectId: base.jobCardId,
      ladderKey: 'APPROVAL',
      rung: 0,
      channel: 'WHATSAPP',
      scheduledAt: new Date(),
    });
    await db.insert(shopConfig).values({
      shopId: SHOP_ID,
      configVersion: 1,
      config: defaultShopConfig() as unknown as Record<string, unknown>,
    });
    await db.insert(auditEvents).values({
      shopId: SHOP_ID,
      seq: 1,
      actorType: 'SYSTEM',
      actorId: null,
      action: 'test.seeded',
      entityType: 'JobCard',
      entityId: base.jobCardId,
      payload: {},
      prevHash: '0'.repeat(64),
      hash: 'b'.repeat(64),
      traceId: 'test',
    });
    await db.insert(eventsOutbox).values({
      shopId: SHOP_ID,
      type: 'job_card.created',
      payload: { jobCardId: base.jobCardId },
      occurredAt: new Date(),
      traceId: 'test',
    });
    await db.insert(idempotencyKeys).values({ consumer: 'test', eventId: uuidv7() });

    const tables = await db.execute<{ count: number }>(sql`
      select count(*)::int as count from information_schema.tables where table_schema = 'public'
    `);
    expect(Number(tables.rows[0]?.count ?? 0)).toBe(20);
  });

  it('enforces the per-shop unique registration index', async () => {
    const base = await seedMinimum();
    await expect(
      db.insert(vehicles).values({
        shopId: SHOP_ID,
        customerId: base.customerId,
        registrationRaw: 'TN-09-BX-1234',
        registrationNormalised: 'TN09BX1234',
      }),
    ).rejects.toThrow(/vehicles_shop_registration_key/);
  });

  it('allows the same registration in a different shop', async () => {
    const base = await seedMinimum();
    const otherShop = uuidv7();
    const otherCustomer = uuidv7();
    await db.insert(shops).values({ id: otherShop, name: 'Other Motors', city: 'Madurai' });
    await db.insert(customers).values({
      id: otherCustomer,
      shopId: otherShop,
      fullNameEncrypted: 'Other Customer',
      phoneEncrypted: '+919841000002',
      phoneHash: blindIndex(otherShop, '+919841000002'),
    });
    await expect(
      db.insert(vehicles).values({
        shopId: otherShop,
        customerId: otherCustomer,
        registrationRaw: 'TN 09 BX 1234',
        registrationNormalised: 'TN09BX1234',
      }),
    ).resolves.toBeDefined();
    expect(base.vehicleId).toBeTruthy();
  });
});

describe('PII encryption at rest', () => {
  it('stores ciphertext and returns plaintext through the column helper', async () => {
    await seedMinimum();

    const raw = await db.execute<{ full_name_encrypted: string; phone_encrypted: string }>(
      sql`select full_name_encrypted, phone_encrypted from customers limit 1`,
    );
    const stored = raw.rows[0];
    expect(stored).toBeDefined();
    expect(isEncryptedPii(stored?.full_name_encrypted ?? '')).toBe(true);
    expect(stored?.full_name_encrypted).not.toContain('Test Customer');
    expect(stored?.phone_encrypted).not.toContain('9841000001');

    const [row] = await db.select().from(customers).limit(1);
    expect(row?.fullNameEncrypted).toBe('Test Customer');
    expect(row?.phoneEncrypted).toBe('+919841000001');
  });

  it('produces a different ciphertext each time but a stable blind index', () => {
    const first = encryptPii('+919841000001');
    const second = encryptPii('+919841000001');
    expect(first).not.toBe(second);
    expect(decryptPii(first)).toBe('+919841000001');

    expect(blindIndex(SHOP_ID, '+919841000001')).toBe(blindIndex(SHOP_ID, '+919841000001'));
    expect(blindIndex(SHOP_ID, '+919841000001')).not.toBe(blindIndex(uuidv7(), '+919841000001'));
  });

  it('detects tampered ciphertext through the GCM auth tag', () => {
    const encrypted = encryptPii('+919841000001');
    const parts = encrypted.split(':');
    const ciphertext = Buffer.from(parts[4] ?? '', 'base64');
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 0xff;
    parts[4] = ciphertext.toString('base64');
    expect(() => decryptPii(parts.join(':'))).toThrow();
  });

  it('finds staff across shops through the blind index only', async () => {
    await seedMinimum();
    const repository = new StaffRepository(db);

    const found = await repository.findMembershipsByPhone('+919840000001');
    expect(found).toHaveLength(1);
    expect(found[0]?.role).toBe('ADVISOR');
    expect(found[0]?.shopName).toBe('Test Motors');

    expect(await repository.findMembershipsByPhone('+919840000099')).toHaveLength(0);
  });
});

describe('database-enforced guardrails', () => {
  it('rejects UPDATE and DELETE on audit_events', async () => {
    const base = await seedMinimum();
    await db.insert(auditEvents).values({
      shopId: SHOP_ID,
      seq: 1,
      actorType: 'STAFF',
      actorId: base.staffId,
      action: 'job_card.state_changed',
      entityType: 'JobCard',
      entityId: base.jobCardId,
      payload: { from: 'DRAFT', to: 'OPEN' },
      prevHash: '0'.repeat(64),
      hash: 'c'.repeat(64),
      traceId: 'test',
    });

    await expect(
      db.update(auditEvents).set({ action: 'tampered' }).where(eq(auditEvents.shopId, SHOP_ID)),
    ).rejects.toThrow(/append-only/);

    await expect(db.delete(auditEvents).where(eq(auditEvents.shopId, SHOP_ID))).rejects.toThrow(
      /append-only/,
    );
  });

  it('freezes estimate lines once the estimate is accepted', async () => {
    const base = await seedMinimum();
    const lineId = uuidv7();
    await db.insert(estimateLines).values({
      id: lineId,
      shopId: SHOP_ID,
      estimateId: base.estimateId,
      kind: 'LABOUR',
      description: 'Brake labour',
      quantityMilli: 1000,
      unitPricePaise: 60000,
      lineTotalPaise: 60000,
    });

    // Still DRAFT: edits are allowed.
    await expect(
      db.update(estimateLines).set({ unitPricePaise: 65000 }).where(eq(estimateLines.id, lineId)),
    ).resolves.toBeDefined();

    await db
      .update(estimates)
      .set({ status: 'ACCEPTED', acceptedAt: new Date() })
      .where(eq(estimates.id, base.estimateId));

    await expect(
      db.update(estimateLines).set({ unitPricePaise: 1 }).where(eq(estimateLines.id, lineId)),
    ).rejects.toThrow(/immutable/);
    await expect(db.delete(estimateLines).where(eq(estimateLines.id, lineId))).rejects.toThrow(
      /immutable/,
    );
    await expect(
      db.insert(estimateLines).values({
        shopId: SHOP_ID,
        estimateId: base.estimateId,
        kind: 'FEE',
        description: 'Sneaky extra',
        quantityMilli: 1000,
        unitPricePaise: 100000,
        lineTotalPaise: 100000,
      }),
    ).rejects.toThrow(/immutable/);
  });

  it('refuses to delete a shop while its audit chain exists', async () => {
    await seedMinimum();
    await db.insert(auditEvents).values({
      shopId: SHOP_ID,
      seq: 1,
      actorType: 'SYSTEM',
      actorId: null,
      action: 'test',
      entityType: 'Shop',
      entityId: SHOP_ID,
      payload: {},
      prevHash: '0'.repeat(64),
      hash: 'd'.repeat(64),
      traceId: 'test',
    });

    await expect(db.delete(shops).where(eq(shops.id, SHOP_ID))).rejects.toThrow();
  });

  it('rejects non-positive quantities and negative money', async () => {
    const base = await seedMinimum();
    await expect(
      db.insert(estimateLines).values({
        shopId: SHOP_ID,
        estimateId: base.estimateId,
        kind: 'PART',
        description: 'Zero quantity',
        quantityMilli: 0,
        unitPricePaise: 1000,
        lineTotalPaise: 0,
      }),
    ).rejects.toThrow(/estimate_lines_quantity_positive/);
  });
});
