import { defaultShopConfig } from '@serviceloop/config';
import { lineTotal, uuidv7 } from '@serviceloop/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/client';
import { blindIndex, decryptPii, encryptPii, isEncryptedPii } from '../src/crypto/pii';
import { StaffRepository } from '../src/repositories/staff-repository';
import {
  advisorTasks,
  agentRuns,
  agentSteps,
  approvalRequests,
  auditEvents,
  consents,
  conversations,
  customers,
  declinedWorkLedger,
  deliveryBookings,
  escalations,
  estimateLines,
  estimates,
  etaEntries,
  eventsOutbox,
  evidenceBundles,
  gatePasses,
  idempotencyKeys,
  callConsentEvents,
  callTurns,
  callUsage,
  calls,
  invoiceLines,
  invoices,
  jobCards,
  llmUsage,
  mediaAssets,
  messageReviews,
  messages,
  paymentEvents,
  payments,
  shopConfig,
  shops,
  silentBayNudges,
  staff,
  statusSignals,
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

/**
 * Asserts that `work` is refused by the database, and by *which* guardrail.
 *
 * The pattern matters as much as the rejection. `rejects.toThrow()` bare would
 * pass on a typo'd column name too, and then the day somebody drops the
 * append-only trigger the test still goes green.
 *
 * Walks the `cause` chain rather than reading `error.message`, because drizzle
 * wraps the driver error in its own `Failed query: ...` and the constraint name
 * — the whole point of the assertion — is on the cause. Which layer holds the
 * text is a detail of the ORM version; that it is *somewhere* in the chain is
 * the stable property, so this matches on the chain.
 */
async function rejectedBy(work: Promise<unknown>, pattern: RegExp): Promise<void> {
  let thrown: unknown;
  try {
    await work;
  } catch (error) {
    thrown = error;
  }

  expect(thrown, `expected a rejection matching ${pattern.source}`).toBeDefined();

  const chain: string[] = [];
  for (let error = thrown; error !== undefined && error !== null; ) {
    chain.push(error instanceof Error ? error.message : String(error));
    error = error instanceof Error ? (error.cause as unknown) : undefined;
  }

  expect(chain.join(' | '), `no link in the error chain matched ${pattern.source}`).toMatch(
    pattern,
  );
}

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
    const messageId = uuidv7();
    await db.insert(messages).values({
      id: messageId,
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

    /* Phase 3 — the agent's own record. */

    await db.insert(llmUsage).values({
      shopId: SHOP_ID,
      taskClass: 'AGENT',
      model: 'sandbox-agent',
      driver: 'sandbox',
      inputTokens: 120,
      outputTokens: 30,
      latencyMs: 40,
      attempts: 1,
      // Null cost: an unpriced model meters its tokens and leaves the money
      // column empty rather than reporting a number derived from a stale rate.
      costUsdMicros: null,
      promptHash: 'a'.repeat(64),
      traceId: 'test',
    });

    const runId = uuidv7();
    await db.insert(agentRuns).values({
      id: runId,
      shopId: SHOP_ID,
      objective: 'request_approval',
      status: 'RUNNING',
      conversationId,
      jobCardId: base.jobCardId,
      customerId: base.customerId,
      maxSteps: 6,
      model: 'sandbox-agent',
      promptContext: { sections: ['constitution'] },
    });
    await db.insert(agentSteps).values({
      shopId: SHOP_ID,
      runId,
      stepIndex: 0,
      promptHash: 'b'.repeat(64),
      model: 'sandbox-agent',
      responseText: null,
      toolCalls: [{ name: 'get_job_card', args: {} }],
      toolResults: [{ name: 'get_job_card', ok: true, result: {} }],
      checkerVerdicts: [],
    });
    await db.insert(advisorTasks).values({
      shopId: SHOP_ID,
      kind: 'CALL_CUSTOMER',
      urgency: 'HIGH',
      brief: 'Call Ravi about the brake pads',
      context: { jobCardId: base.jobCardId },
      jobCardId: base.jobCardId,
      conversationId,
      customerId: base.customerId,
      dedupeKey: 'escalation:test:2',
    });
    await db.insert(messageReviews).values({
      shopId: SHOP_ID,
      messageId,
      conversationId,
      agentRunId: runId,
      action: 'APPROVE_SEND',
      bodyBefore: 'Front brake pads come to ₹3,200.00.',
      bodyAfter: null,
      diff: [],
      checkerReasons: [],
      waitedMs: 45_000,
    });

    /* Phase 4 — the middle and the end of the loop. */

    const signalId = uuidv7();
    await db.insert(statusSignals).values({
      id: signalId,
      shopId: SHOP_ID,
      jobCardId: base.jobCardId,
      conversationId,
      senderStaffId: base.staffId,
      signalType: 'blocked_parts',
      source: 'VOICE_NOTE',
      route: 'AUTO_APPLIED',
      confidence: 9_200,
      transcript: 'Caliper open irukku, part varum 4 maniku. 4432.',
      language: 'ta',
      transcriptConfidence: 8_700,
      workItemIds: [base.workItemId],
      matchBasis: 'REGISTRATION',
    });

    await db.insert(etaEntries).values({
      shopId: SHOP_ID,
      jobCardId: base.jobCardId,
      version: 1,
      eta: new Date('2026-08-17T11:30:00.000Z'),
      reason: 'BLOCKED_PARTS',
      materiality: 'MATERIAL_SLIP',
      deltaMinutes: 120,
      detail: 'Waiting on a part; 108 working minutes remaining across 1 approved item(s)',
      statusSignalId: signalId,
    });

    await db.insert(silentBayNudges).values({
      shopId: SHOP_ID,
      jobCardId: base.jobCardId,
      windowStart: new Date('2026-08-17T06:00:00.000Z'),
      state: 'IN_PROGRESS',
      quietForMinutes: 200,
      consecutiveWindows: 1,
    });

    await db.insert(deliveryBookings).values({
      shopId: SHOP_ID,
      jobCardId: base.jobCardId,
      customerId: base.customerId,
      conversationId,
      status: 'OFFERED',
      offeredSlots: ['2026-08-17T11:00:00.000Z'],
      amountDuePaise: 566_400,
    });

    const invoiceId = uuidv7();
    await db.insert(invoices).values({
      id: invoiceId,
      shopId: SHOP_ID,
      jobCardId: base.jobCardId,
      customerId: base.customerId,
      number: 'INV/2026-27/0001',
      status: 'ISSUED',
      issuedAt: new Date(),
      subtotalPaise: 245_000,
      cgstPaise: 22_050,
      sgstPaise: 22_050,
      igstPaise: 0,
      totalPaise: 289_100,
      sellerName: 'Sri Murugan Auto Works',
      sellerAddress: ['12 Anna Salai'],
      intraState: true,
    });
    await db.insert(invoiceLines).values({
      shopId: SHOP_ID,
      invoiceId,
      description: 'Front brake pad set',
      quantityMilli: 1000,
      unitPricePaise: 245_000,
      lineTotalPaise: 245_000,
      cgstPaise: 22_050,
      sgstPaise: 22_050,
    });

    const paymentId = uuidv7();
    await db.insert(payments).values({
      id: paymentId,
      shopId: SHOP_ID,
      jobCardId: base.jobCardId,
      invoiceId,
      customerId: base.customerId,
      provider: 'mock',
      providerPaymentLinkId: 'plink_mock_smoke',
      status: 'PENDING',
      amountPaise: 289_100,
    });
    await db.insert(paymentEvents).values({
      shopId: SHOP_ID,
      paymentId,
      kind: 'LINK_CREATED',
      providerEventId: 'payment_link.created:plink_mock_smoke',
      amountPaise: 0,
      runningPaidPaise: 0,
      occurredAt: new Date(),
    });

    await db.insert(gatePasses).values({
      shopId: SHOP_ID,
      jobCardId: base.jobCardId,
      customerId: base.customerId,
      code: 'K7M2QD',
      tokenHash: 'c'.repeat(64),
      status: 'ISSUED',
      expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
    });

    /* --- phase 5: one telephone call, with its transcript and its bill --- */

    const callId = uuidv7();
    await db.insert(calls).values({
      id: callId,
      shopId: SHOP_ID,
      direction: 'OUTBOUND',
      status: 'COMPLETED',
      driver: 'loopback',
      providerCallSid: `loopback:${callId}`,
      toEncrypted: '+919841100001',
      toMasked: '••••0001',
      fromNumber: '+911140000000',
      jobCardId: base.jobCardId,
      customerId: base.customerId,
      objective: 'request_approval',
      language: 'en',
      outcome: 'DECISION_RECORDED',
      endReason: 'OBJECTIVE_MET',
      traceId: 'schema-smoke',
      retentionUntil: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
    });

    await db.insert(callTurns).values({
      shopId: SHOP_ID,
      callId,
      turnIndex: 0,
      role: 'SYSTEM',
      inputMode: 'NONE',
      text: 'This is the ServiceLoop assistant. I am an AI assistant, not a person.',
      mandatorySegment: true,
      scriptKey: 'voice.disclosure',
      languageTag: 'en-IN',
      startedAt: new Date(),
    });

    // The notice, then the recorder — in that order, and the constraint at the
    // foot of migration 0005 refuses a recording attached to a call whose
    // consent events do not contain one.
    for (const fact of ['AI_DISCLOSURE_PLAYED', 'RECORDING_NOTICE_PLAYED', 'RECORDING_STARTED'] as const) {
      await db.insert(callConsentEvents).values({
        shopId: SHOP_ID,
        callId,
        fact,
        turnIndex: 0,
        occurredAt: new Date(),
      });
    }

    await db.insert(callUsage).values({
      shopId: SHOP_ID,
      callId,
      telcoSeconds: 42,
      sttSeconds: 18,
      ttsSeconds: 24,
      llmInputTokens: 1_800,
      llmOutputTokens: 160,
      estimatedCostPaise: 91,
      traceId: 'schema-smoke',
    });

    // Schema v1's 20 tables, plus the three phase 2 adds (`wa_templates`,
    // `job_card_drafts`, `merge_suggestions`), the five phase 3 adds
    // (`llm_usage`, `agent_runs`, `agent_steps`, `advisor_tasks`,
    // `message_reviews`), the nine phase 4 adds (`status_signals`,
    // `eta_entries`, `silent_bay_nudges`, `delivery_bookings`, `invoices`,
    // `invoice_lines`, `payments`, `payment_events`, `gate_passes`), the four
    // phase 5 adds (`calls`, `call_turns`, `call_consent_events`,
    // `call_usage`) and the nine phase 6 adds (`retention_touches`,
    // `retention_holds`, `odometer_readings`, `feedback_requests`,
    // `service_due_forecasts`, `vehicle_documents`, `owner_digests`,
    // `exception_alerts`, `metric_rollups`), the four phase 7.2 adds
    // (`data_requests`, `data_request_steps`, `conversation_costs`,
    // `sms_costs`) and the one phase 7.3 add (`template_registrations`).
    // Counting rather than listing is deliberate — it catches a table added
    // without a migration being noticed, which is exactly what it did on phase
    // 4, and again on phase 7 (the DPDP tables landed with this number left at
    // 50).
    const tables = await db.execute<{ count: number }>(sql`
      select count(*)::int as count from information_schema.tables where table_schema = 'public'
    `);
    expect(Number(tables.rows[0]?.count ?? 0)).toBe(55);
  });

  it('enforces the per-shop unique registration index', async () => {
    const base = await seedMinimum();
    await rejectedBy(
      db.insert(vehicles).values({
        shopId: SHOP_ID,
        customerId: base.customerId,
        registrationRaw: 'TN-09-BX-1234',
        registrationNormalised: 'TN09BX1234',
      }),
      /vehicles_shop_registration_key/,
    );
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

    await rejectedBy(
      db.update(auditEvents).set({ action: 'tampered' }).where(eq(auditEvents.shopId, SHOP_ID)),
      /append-only/,
    );

    await rejectedBy(
      db.delete(auditEvents).where(eq(auditEvents.shopId, SHOP_ID)),
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

    await rejectedBy(
      db.update(estimateLines).set({ unitPricePaise: 1 }).where(eq(estimateLines.id, lineId)),
      /immutable/,
    );
    await rejectedBy(db.delete(estimateLines).where(eq(estimateLines.id, lineId)), /immutable/);
    await rejectedBy(
      db.insert(estimateLines).values({
        shopId: SHOP_ID,
        estimateId: base.estimateId,
        kind: 'FEE',
        description: 'Sneaky extra',
        quantityMilli: 1000,
        unitPricePaise: 100000,
        lineTotalPaise: 100000,
      }),
      /immutable/,
    );
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
    await rejectedBy(
      db.insert(estimateLines).values({
        shopId: SHOP_ID,
        estimateId: base.estimateId,
        kind: 'PART',
        description: 'Zero quantity',
        quantityMilli: 0,
        unitPricePaise: 1000,
        lineTotalPaise: 0,
      }),
      /estimate_lines_quantity_positive/,
    );
  });
});
