import { defaultShopConfig } from '@serviceloop/config';
import { uuidv7 } from '@serviceloop/shared';
import { eq, sql as raw } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database, Tx } from '../src/client';
import { blindIndex } from '../src/crypto/pii';
import {
  PgDeliveryBookingStore,
  PgGatePassStore,
  PgInvoiceStore,
  PgPaymentStore,
} from '../src/stores/delivery-store';
import {
  PgCardResolver,
  PgEtaStore,
  PgSilentBayStore,
  PgStatusCommsStore,
  PgStatusSignalStore,
} from '../src/stores/status-store';
import { customers, jobCards, shopConfig, shops, staff, vehicles } from '../src/schema';
import { startTestDatabase, truncateAll, type TestDatabase } from './harness';

/**
 * Phase-4 Postgres stores, against real SQL.
 *
 * These are the assertions the in-memory doubles cannot make: that the queries
 * parse, that the enum casts are right, that `bigint` money survives the driver
 * as a number, and — most importantly — that the **idempotency the domain
 * depends on actually comes from the unique indexes**. A double can be written
 * to return null on a repeat; only Postgres can prove the index does.
 */

let harness: TestDatabase;
let db: Database;

const SHOP_ID = '01920000-0000-7000-8000-0000000000f4';
const CUSTOMER_ID = '01920000-0000-7000-8000-0000000000f5';
const VEHICLE_ID = '01920000-0000-7000-8000-0000000000f6';
const TECHNICIAN_ID = '01920000-0000-7000-8000-0000000000f7';
const CARD_ID = '01920000-0000-7000-8000-0000000000f8';
const OTHER_CARD_ID = '01920000-0000-7000-8000-0000000000f9';

const NOW = new Date('2026-08-17T06:00:00.000Z');

beforeAll(async () => {
  harness = await startTestDatabase();
  db = harness.db;
}, 180_000);

afterAll(async () => {
  await harness?.stop();
});

beforeEach(async () => {
  await truncateAll(db);
  await seedWorld();
});

/** A shop with one technician, one customer and two open cards. */
async function seedWorld(): Promise<void> {
  await db.insert(shops).values({
    id: SHOP_ID,
    name: 'Sri Murugan Auto Works',
    city: 'Chennai',
    timezone: 'Asia/Kolkata',
  });

  await db.insert(shopConfig).values({
    shopId: SHOP_ID,
    configVersion: 4,
    config: defaultShopConfig('Asia/Kolkata'),
  });

  await db.insert(staff).values({
    id: TECHNICIAN_ID,
    shopId: SHOP_ID,
    fullName: 'Suresh',
    role: 'TECHNICIAN',
    phoneEncrypted: '+919000000009',
    phoneHash: blindIndex(SHOP_ID, '+919000000009'),
  });

  await db.insert(customers).values({
    id: CUSTOMER_ID,
    shopId: SHOP_ID,
    fullNameEncrypted: 'Ravi Kumar',
    phoneEncrypted: '+919000000001',
    phoneHash: blindIndex(SHOP_ID, '+919000000001'),
  });

  await db.insert(vehicles).values({
    id: VEHICLE_ID,
    shopId: SHOP_ID,
    customerId: CUSTOMER_ID,
    registrationRaw: 'TN 09 BX 4432',
    registrationNormalised: 'TN09BX4432',
    make: 'Maruti',
    model: 'Swift',
  });

  await db.insert(jobCards).values([
    {
      id: CARD_ID,
      shopId: SHOP_ID,
      customerId: CUSTOMER_ID,
      vehicleId: VEHICLE_ID,
      code: 'JC-2026-0042',
      state: 'IN_PROGRESS',
      stateChangedAt: new Date('2026-08-17T02:00:00.000Z'),
      assignedTechnicianId: TECHNICIAN_ID,
      promisedAt: new Date('2026-08-17T11:30:00.000Z'),
    },
    {
      id: OTHER_CARD_ID,
      shopId: SHOP_ID,
      customerId: CUSTOMER_ID,
      vehicleId: VEHICLE_ID,
      code: 'JC-2026-0043',
      state: 'IN_PROGRESS',
      stateChangedAt: new Date('2026-08-17T05:50:00.000Z'),
      assignedTechnicianId: TECHNICIAN_ID,
    },
  ]);
}

/** Runs `work` in a transaction, as every store expects. */
function inTx<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(work);
}

/* -------------------------------------------------------------------------- *
 * ETA history
 * -------------------------------------------------------------------------- */

describe('PgEtaStore', () => {
  const store = new PgEtaStore();

  function entry(version: number, overrides: Partial<Parameters<typeof store.append>[1]> = {}) {
    return {
      id: uuidv7(),
      shopId: SHOP_ID,
      jobCardId: CARD_ID,
      version,
      previousEta: null,
      eta: new Date('2026-08-17T11:30:00.000Z'),
      promisedAt: new Date('2026-08-17T11:30:00.000Z'),
      reason: 'WORK_APPROVED' as const,
      materiality: 'IMMATERIAL' as const,
      deltaMinutes: 0,
      detail: 'Customer approved additional work',
      statusSignalId: null,
      notifiedAt: null,
      createdAt: NOW,
      ...overrides,
    };
  }

  it('reads the card head, including a promise made at intake', async () => {
    const head = await inTx((tx) => store.lockHead(tx, SHOP_ID, CARD_ID));

    expect(head).not.toBeNull();
    expect(head?.version).toBe(0);
    expect(head?.currentEta).toBeNull();
    expect(head?.promisedAt?.toISOString()).toBe('2026-08-17T11:30:00.000Z');
    expect(head?.state).toBe('IN_PROGRESS');
  });

  it('is shop-scoped: another shop cannot read this card', async () => {
    const head = await inTx((tx) => store.lockHead(tx, uuidv7(), CARD_ID));
    expect(head).toBeNull();
  });

  it('moves the card head and the history in the same write', async () => {
    await inTx((tx) => store.append(tx, entry(1)));

    const head = await inTx((tx) => store.lockHead(tx, SHOP_ID, CARD_ID));
    const history = await inTx((tx) => store.history(tx, SHOP_ID, CARD_ID, 10));

    // The board reads the head and the drawer reads the history; a shop where
    // those disagree is a shop where nobody trusts either.
    expect(head?.version).toBe(1);
    expect(head?.currentEta?.toISOString()).toBe('2026-08-17T11:30:00.000Z');
    expect(history).toHaveLength(1);
    expect(history[0]?.eta.toISOString()).toBe(head?.currentEta?.toISOString());
  });

  it('refuses a duplicate version — the unique index, not the caller', async () => {
    await inTx((tx) => store.append(tx, entry(1)));
    await expect(inTx((tx) => store.append(tx, entry(1)))).rejects.toThrow();
  });

  it('returns history newest first and honours the limit', async () => {
    await inTx((tx) => store.append(tx, entry(1)));
    await inTx((tx) => store.append(tx, entry(2, { eta: new Date('2026-08-17T13:00:00.000Z') })));
    await inTx((tx) => store.append(tx, entry(3, { eta: new Date('2026-08-17T14:00:00.000Z') })));

    const history = await inTx((tx) => store.history(tx, SHOP_ID, CARD_ID, 2));
    expect(history.map((row) => row.version)).toEqual([3, 2]);

    const latest = await inTx((tx) => store.latest(tx, SHOP_ID, CARD_ID));
    expect(latest?.version).toBe(3);
  });

  it('claims only material changes nobody has been told about', async () => {
    await inTx((tx) => store.append(tx, entry(1, { materiality: 'IMMATERIAL' })));
    await inTx((tx) => store.append(tx, entry(2, { materiality: 'MATERIAL_SLIP' })));
    await inTx((tx) => store.append(tx, entry(3, { materiality: 'MATERIAL_GAIN' })));

    const claimed = await inTx((tx) => store.claimUnnotified(tx, { shopId: SHOP_ID, limit: 10 }));
    expect(claimed.map((row) => row.version).sort()).toEqual([2, 3]);
  });

  it('stops claiming an entry once it has been notified', async () => {
    const material = entry(1, { materiality: 'MATERIAL_SLIP' });
    await inTx((tx) => store.append(tx, material));

    await inTx((tx) => store.markNotified(tx, { entryId: material.id, messageId: null, at: NOW }));

    const claimed = await inTx((tx) => store.claimUnnotified(tx, { shopId: null, limit: 10 }));
    expect(claimed).toHaveLength(0);
  });

  it('round-trips a signed delta and a null previous ETA', async () => {
    await inTx((tx) =>
      store.append(
        tx,
        entry(1, {
          previousEta: new Date('2026-08-17T11:30:00.000Z'),
          eta: new Date('2026-08-17T10:00:00.000Z'),
          deltaMinutes: -90,
          materiality: 'MATERIAL_GAIN',
        }),
      ),
    );

    const [row] = await inTx((tx) => store.history(tx, SHOP_ID, CARD_ID, 1));
    expect(row?.deltaMinutes).toBe(-90);
    expect(row?.previousEta?.toISOString()).toBe('2026-08-17T11:30:00.000Z');
  });
});

/* -------------------------------------------------------------------------- *
 * Status signals
 * -------------------------------------------------------------------------- */

describe('PgStatusSignalStore', () => {
  const store = new PgStatusSignalStore();

  function signal(overrides: Record<string, unknown> = {}) {
    return {
      id: uuidv7(),
      shopId: SHOP_ID,
      jobCardId: CARD_ID,
      conversationId: null,
      messageId: null,
      mediaId: null,
      senderStaffId: TECHNICIAN_ID,
      signalType: 'blocked_parts' as const,
      source: 'VOICE_NOTE' as const,
      route: 'AUTO_APPLIED' as const,
      confidence: 0.92,
      transcript: 'Caliper open irukku, part varum 4 maniku. 4432.',
      language: 'ta' as const,
      transcriptConfidence: 0.87,
      workItemIds: [] as readonly string[],
      etaHint: new Date('2026-08-17T10:30:00.000Z'),
      candidateJobCardIds: [] as readonly string[],
      matchBasis: 'REGISTRATION',
      appliedDetail: null,
      createdAt: NOW,
      ...overrides,
    };
  }

  it('round-trips confidence through basis points without drifting', async () => {
    const record = signal({ confidence: 0.92, transcriptConfidence: 0.87 });
    await inTx((tx) => store.insert(tx, record));

    const loaded = await inTx((tx) => store.load(tx, SHOP_ID, record.id));
    expect(loaded?.confidence).toBeCloseTo(0.92, 4);
    expect(loaded?.transcriptConfidence).toBeCloseTo(0.87, 4);
    expect(loaded?.etaHint?.toISOString()).toBe('2026-08-17T10:30:00.000Z');
    expect(loaded?.language).toBe('ta');
    expect(loaded?.signalType).toBe('blocked_parts');
  });

  it('captures one signal per inbound message — the unique index does it', async () => {
    const messageId = await seedMessage();

    const first = await inTx((tx) => store.insert(tx, signal({ messageId })));
    const second = await inTx((tx) => store.insert(tx, signal({ messageId })));

    expect(first).not.toBeNull();
    // A redelivered staff-group webhook must not close the same work item twice.
    expect(second).toBeNull();
  });

  it('does not let one console signal block another — nulls are distinct', async () => {
    const first = await inTx((tx) => store.insert(tx, signal({ messageId: null })));
    const second = await inTx((tx) => store.insert(tx, signal({ messageId: null })));

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
  });

  it('locks only signals that are actually awaiting a human', async () => {
    const applied = signal({ route: 'AUTO_APPLIED' });
    const pending = signal({ route: 'PENDING_CONFIRMATION' });
    await inTx((tx) => store.insert(tx, applied));
    await inTx((tx) => store.insert(tx, pending));

    expect(await inTx((tx) => store.lockPending(tx, SHOP_ID, applied.id))).toBeNull();
    expect(await inTx((tx) => store.lockPending(tx, SHOP_ID, pending.id))).not.toBeNull();
  });

  it('resolves a pending signal onto a card and its work items', async () => {
    const pending = signal({ route: 'PENDING_CONFIRMATION', jobCardId: null });
    await inTx((tx) => store.insert(tx, pending));

    await inTx((tx) =>
      store.resolve(tx, {
        signalId: pending.id,
        route: 'CONFIRMED',
        jobCardId: CARD_ID,
        workItemIds: ['0192aaaa-0000-7000-8000-000000000001'],
        staffId: TECHNICIAN_ID,
        appliedDetail: 'Confirmed by an advisor',
        at: NOW,
      }),
    );

    const loaded = await inTx((tx) => store.load(tx, SHOP_ID, pending.id));
    expect(loaded?.route).toBe('CONFIRMED');
    expect(loaded?.jobCardId).toBe(CARD_ID);
    expect(loaded?.workItemIds).toEqual(['0192aaaa-0000-7000-8000-000000000001']);
  });

  it('lists what is waiting on a human, newest first', async () => {
    await inTx((tx) => store.insert(tx, signal({ route: 'AUTO_APPLIED' })));
    await inTx((tx) => store.insert(tx, signal({ route: 'PENDING_CONFIRMATION' })));
    await inTx((tx) => store.insert(tx, signal({ route: 'AMBIGUOUS', jobCardId: null })));

    const pending = await inTx((tx) => store.pending(tx, SHOP_ID, 10));
    expect(pending).toHaveLength(2);
    expect(pending.every((row) => row.route !== 'AUTO_APPLIED')).toBe(true);
  });

  it('reports the newest signal per card for the silent-bay scan', async () => {
    await inTx((tx) =>
      store.insert(tx, signal({ jobCardId: CARD_ID, createdAt: new Date('2026-08-17T03:00:00Z') })),
    );
    await inTx((tx) =>
      store.insert(tx, signal({ jobCardId: CARD_ID, createdAt: new Date('2026-08-17T05:00:00Z') })),
    );

    const last = await inTx((tx) => store.lastSignalAt(tx, SHOP_ID, [CARD_ID, OTHER_CARD_ID]));
    expect(last.get(CARD_ID)?.toISOString()).toBe('2026-08-17T05:00:00.000Z');
    expect(last.has(OTHER_CARD_ID)).toBe(false);
  });

  it('returns an empty map rather than building a malformed array literal', async () => {
    const last = await inTx((tx) => store.lastSignalAt(tx, SHOP_ID, []));
    expect(last.size).toBe(0);
  });

  it('refuses an auto-applied signal with no card — the CHECK constraint', async () => {
    await expect(
      inTx((tx) => store.insert(tx, signal({ route: 'AUTO_APPLIED', jobCardId: null }))),
    ).rejects.toThrow();
  });
});

/* -------------------------------------------------------------------------- *
 * Card resolution
 * -------------------------------------------------------------------------- */

describe('PgCardResolver', () => {
  const resolver = new PgCardResolver();

  it('matches a spoken plate fragment by suffix', async () => {
    const found = await inTx((tx) => resolver.byRegistrationFragment(tx, SHOP_ID, '4432'));
    expect(found.map((card) => card.code).sort()).toEqual(['JC-2026-0042', 'JC-2026-0043']);
    expect(found[0]?.basis).toBe('REGISTRATION');
    expect(found[0]?.vehicleLabel).toBe('Maruti Swift');
  });

  it('refuses a fragment shorter than four characters', async () => {
    // Three would match half the yard, and a match that broad produces a
    // confident wrong answer instead of a question.
    expect(await inTx((tx) => resolver.byRegistrationFragment(tx, SHOP_ID, '432'))).toEqual([]);
  });

  it('finds a technician’s own open cards', async () => {
    const mine = await inTx((tx) => resolver.byTechnician(tx, SHOP_ID, TECHNICIAN_ID));
    expect(mine).toHaveLength(2);
    expect(mine[0]?.basis).toBe('ASSIGNMENT');
  });

  it('does not offer a delivered card as a match', async () => {
    await db
      .update(jobCards)
      .set({ state: 'DELIVERED' })
      .where(eq(jobCards.id, OTHER_CARD_ID));

    const mine = await inTx((tx) => resolver.byTechnician(tx, SHOP_ID, TECHNICIAN_ID));
    expect(mine.map((card) => card.code)).toEqual(['JC-2026-0042']);
  });

  it('resolves an explicit code, case-insensitively', async () => {
    const found = await inTx((tx) => resolver.byCode(tx, SHOP_ID, 'jc-2026-0042'));
    expect(found?.jobCardId).toBe(CARD_ID);
    expect(found?.basis).toBe('CODE');
  });

  it('is shop-scoped', async () => {
    expect(await inTx((tx) => resolver.byCode(tx, uuidv7(), 'JC-2026-0042'))).toBeNull();
    expect(await inTx((tx) => resolver.byRegistrationFragment(tx, uuidv7(), '4432'))).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- *
 * Silent bay
 * -------------------------------------------------------------------------- */

describe('PgSilentBayStore', () => {
  const store = new PgSilentBayStore();

  it('reports active cards with when each was last heard from', async () => {
    const cards = await inTx((tx) => store.activeCards(tx, SHOP_ID));

    expect(cards).toHaveLength(2);
    const card = cards.find((row) => row.code === 'JC-2026-0042');
    expect(card?.assignedTechnicianName).toBe('Suresh');
    expect(card?.registration).toBe('TN09BX4432');
    // With no signals and no media, the last state change is the answer.
    expect(card?.lastSignalAt.toISOString()).toBe('2026-08-17T02:00:00.000Z');
  });

  it('treats a technician signal as being heard from', async () => {
    const signals = new PgStatusSignalStore();
    await inTx((tx) =>
      signals.insert(tx, {
        id: uuidv7(),
        shopId: SHOP_ID,
        jobCardId: CARD_ID,
        conversationId: null,
        messageId: null,
        mediaId: null,
        senderStaffId: TECHNICIAN_ID,
        signalType: 'progress',
        source: 'VOICE_NOTE',
        route: 'AUTO_APPLIED',
        confidence: 0.9,
        transcript: 'started',
        language: 'en',
        transcriptConfidence: null,
        workItemIds: [],
        etaHint: null,
        candidateJobCardIds: [],
        matchBasis: 'ASSIGNMENT',
        appliedDetail: null,
        createdAt: new Date('2026-08-17T05:30:00.000Z'),
      }),
    );

    const cards = await inTx((tx) => store.activeCards(tx, SHOP_ID));
    const card = cards.find((row) => row.code === 'JC-2026-0042');
    expect(card?.lastSignalAt.toISOString()).toBe('2026-08-17T05:30:00.000Z');
  });

  it('excludes cards that are supposed to be sitting still', async () => {
    await db.update(jobCards).set({ state: 'AWAITING_PARTS' }).where(eq(jobCards.id, CARD_ID));

    const cards = await inTx((tx) => store.activeCards(tx, SHOP_ID));
    expect(cards.map((row) => row.code)).toEqual(['JC-2026-0043']);
  });

  it('claims a window once — the unique index is the whole story', async () => {
    const windowStart = new Date('2026-08-17T06:00:00.000Z');
    const claim = {
      shopId: SHOP_ID,
      jobCardId: CARD_ID,
      windowStart,
      state: 'IN_PROGRESS' as const,
      quietForMinutes: 240,
      consecutiveWindows: 1,
    };

    const first = await inTx((tx) => store.claimWindow(tx, { id: uuidv7(), ...claim }));
    const second = await inTx((tx) => store.claimWindow(tx, { id: uuidv7(), ...claim }));

    expect(first).not.toBeNull();
    // Two workers, a restart, or a scan every five minutes: one nudge.
    expect(second).toBeNull();
  });

  it('lets the next window through', async () => {
    const claim = {
      shopId: SHOP_ID,
      jobCardId: CARD_ID,
      state: 'IN_PROGRESS' as const,
      quietForMinutes: 240,
      consecutiveWindows: 1,
    };

    const first = await inTx((tx) =>
      store.claimWindow(tx, {
        id: uuidv7(),
        ...claim,
        windowStart: new Date('2026-08-17T06:00:00.000Z'),
      }),
    );
    const next = await inTx((tx) =>
      store.claimWindow(tx, {
        id: uuidv7(),
        ...claim,
        windowStart: new Date('2026-08-17T09:00:00.000Z'),
      }),
    );

    expect(first).not.toBeNull();
    expect(next).not.toBeNull();
  });

  it('counts consecutive silent windows within a lookback', async () => {
    for (const hour of [0, 3, 6]) {
      await inTx((tx) =>
        store.claimWindow(tx, {
          id: uuidv7(),
          shopId: SHOP_ID,
          jobCardId: CARD_ID,
          windowStart: new Date(Date.UTC(2026, 7, 17, hour)),
          state: 'IN_PROGRESS',
          quietForMinutes: 200,
          consecutiveWindows: 1,
        }),
      );
    }

    const count = await inTx((tx) =>
      store.consecutiveWindows(tx, SHOP_ID, CARD_ID, new Date('2026-08-16T00:00:00.000Z')),
    );
    expect(count).toBe(3);

    const recent = await inTx((tx) =>
      store.consecutiveWindows(tx, SHOP_ID, CARD_ID, new Date('2026-08-17T04:00:00.000Z')),
    );
    expect(recent).toBe(1);
  });

  it('marks nothing when handed an empty escalation list', async () => {
    await expect(inTx((tx) => store.markEscalated(tx, []))).resolves.toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- *
 * Delivery bookings
 * -------------------------------------------------------------------------- */

describe('PgDeliveryBookingStore', () => {
  const store = new PgDeliveryBookingStore();

  function booking(overrides: Record<string, unknown> = {}) {
    return {
      id: uuidv7(),
      shopId: SHOP_ID,
      jobCardId: CARD_ID,
      customerId: CUSTOMER_ID,
      conversationId: null,
      status: 'OFFERED' as const,
      offeredSlots: [
        new Date('2026-08-17T11:00:00.000Z'),
        new Date('2026-08-17T11:30:00.000Z'),
      ],
      slotStart: null,
      slotEnd: null,
      chosenVia: null,
      chosenAt: null,
      offerMessageId: null,
      reminderScheduledFor: null,
      reminderSentAt: null,
      amountDuePaise: 566_400,
      createdAt: NOW,
      ...overrides,
    };
  }

  it('round-trips the offered slots and the amount due', async () => {
    const row = booking();
    await inTx((tx) => store.insert(tx, row));

    const found = await inTx((tx) => store.findOpenForCard(tx, SHOP_ID, CARD_ID));
    expect(found?.offeredSlots.map((slot) => slot.toISOString())).toEqual([
      '2026-08-17T11:00:00.000Z',
      '2026-08-17T11:30:00.000Z',
    ]);
    // bigint arrives from the driver as a string; it must not stay one.
    expect(found?.amountDuePaise).toBe(566_400);
    expect(typeof found?.amountDuePaise).toBe('number');
  });

  it('does not count an offer against the per-bin cap', async () => {
    await inTx((tx) => store.insert(tx, booking()));

    // Three times were put to a customer and none reserved; counting offers
    // would make a shop look full because it was being helpful.
    const booked = await inTx((tx) =>
      store.bookedSlotsBetween(tx, SHOP_ID, NOW, new Date('2026-08-20T00:00:00.000Z')),
    );
    expect(booked).toHaveLength(0);
  });

  it('counts a chosen slot, and schedules its reminder', async () => {
    const row = booking();
    await inTx((tx) => store.insert(tx, row));

    await inTx((tx) =>
      store.chooseSlot(tx, {
        bookingId: row.id,
        slotStart: new Date('2026-08-17T11:00:00.000Z'),
        slotEnd: new Date('2026-08-17T11:30:00.000Z'),
        chosenVia: 'whatsapp_button',
        reminderScheduledFor: new Date('2026-08-17T09:30:00.000Z'),
        at: NOW,
      }),
    );

    const booked = await inTx((tx) =>
      store.bookedSlotsBetween(tx, SHOP_ID, NOW, new Date('2026-08-20T00:00:00.000Z')),
    );
    expect(booked.map((slot) => slot.toISOString())).toEqual(['2026-08-17T11:00:00.000Z']);

    const found = await inTx((tx) => store.lockById(tx, SHOP_ID, row.id));
    expect(found?.status).toBe('CHOSEN');
    expect(found?.chosenVia).toBe('whatsapp_button');
  });

  it('refuses a CHOSEN booking with no slot — the CHECK constraint', async () => {
    const row = booking({ status: 'CHOSEN' });
    await expect(inTx((tx) => store.insert(tx, row))).rejects.toThrow();
  });

  it('claims only reminders that are due and unsent', async () => {
    const due = booking();
    const notYet = booking({ jobCardId: OTHER_CARD_ID });
    await inTx((tx) => store.insert(tx, due));
    await inTx((tx) => store.insert(tx, notYet));

    await inTx((tx) =>
      store.chooseSlot(tx, {
        bookingId: due.id,
        slotStart: new Date('2026-08-17T11:00:00.000Z'),
        slotEnd: new Date('2026-08-17T11:30:00.000Z'),
        chosenVia: 'whatsapp_button',
        reminderScheduledFor: new Date('2026-08-17T05:00:00.000Z'),
        at: NOW,
      }),
    );
    await inTx((tx) =>
      store.chooseSlot(tx, {
        bookingId: notYet.id,
        slotStart: new Date('2026-08-18T11:00:00.000Z'),
        slotEnd: new Date('2026-08-18T11:30:00.000Z'),
        chosenVia: 'whatsapp_button',
        reminderScheduledFor: new Date('2026-08-18T09:30:00.000Z'),
        at: NOW,
      }),
    );

    const claimed = await inTx((tx) =>
      store.claimDueReminders(tx, { shopId: SHOP_ID, dueBefore: NOW, limit: 10 }),
    );
    expect(claimed.map((row) => row.id)).toEqual([due.id]);

    await inTx((tx) => store.markReminded(tx, due.id, NOW));
    const again = await inTx((tx) =>
      store.claimDueReminders(tx, { shopId: SHOP_ID, dueBefore: NOW, limit: 10 }),
    );
    expect(again).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- *
 * Invoices
 * -------------------------------------------------------------------------- */

describe('PgInvoiceStore', () => {
  const store = new PgInvoiceStore();

  const draft = {
    number: 'INV/2026-27/0001',
    subtotalPaise: 800_000,
    cgstPaise: 72_000,
    sgstPaise: 72_000,
    igstPaise: 0,
    totalPaise: 944_000,
    intraState: true,
    sellerName: 'Sri Murugan Auto Works',
    sellerGstin: '33AABCS1429B1ZQ',
    sellerAddress: ['12 Anna Salai', 'Chennai 600002'],
    sellerStateCode: '33',
    placeOfSupplyStateCode: '33',
    footerNote: 'Thank you for your custom.',
    evidenceMediaIds: [] as readonly string[],
    lines: [
      {
        estimateLineId: null,
        workItemId: null,
        description: 'Front brake pads (set)',
        kind: 'PART' as const,
        hsnSac: '87083000',
        quantityMilli: 1000,
        unitPricePaise: 320_000,
        lineTotalPaise: 320_000,
        taxRateBp: 1800,
        cgstPaise: 28_800,
        sgstPaise: 28_800,
        igstPaise: 0,
        isAdditionalWork: false,
        approvedAt: null,
        evidenceMediaIds: [] as readonly string[],
        sequence: 0,
      },
      {
        estimateLineId: null,
        workItemId: null,
        description: 'Front brake caliper (seized)',
        kind: 'PART' as const,
        hsnSac: '87083000',
        quantityMilli: 1000,
        unitPricePaise: 480_000,
        lineTotalPaise: 480_000,
        taxRateBp: 1800,
        cgstPaise: 43_200,
        sgstPaise: 43_200,
        igstPaise: 0,
        isAdditionalWork: true,
        approvedAt: new Date('2026-08-16T09:12:00.000Z'),
        evidenceMediaIds: ['0192bbbb-0000-7000-8000-000000000001'] as readonly string[],
        sequence: 1,
      },
    ],
  };

  it('stores an invoice with its lines and reads the money back as numbers', async () => {
    const id = uuidv7();
    await inTx((tx) =>
      store.insert(tx, {
        id,
        shopId: SHOP_ID,
        jobCardId: CARD_ID,
        customerId: CUSTOMER_ID,
        estimateId: null,
        draft,
        issuedAt: NOW,
      }),
    );

    const invoice = await inTx((tx) => store.load(tx, SHOP_ID, id));
    expect(invoice?.number).toBe('INV/2026-27/0001');
    expect(invoice?.totalPaise).toBe(944_000);
    expect(invoice?.cgstPaise + invoice!.sgstPaise).toBe(144_000);
    expect(invoice?.intraState).toBe(true);
    expect(invoice?.sellerAddress).toEqual(['12 Anna Salai', 'Chennai 600002']);
    expect(invoice?.lines).toHaveLength(2);
    expect(invoice?.lines[1]?.isAdditionalWork).toBe(true);
    expect(invoice?.lines[1]?.approvedAt?.toISOString()).toBe('2026-08-16T09:12:00.000Z');
    expect(invoice?.lines[1]?.evidenceMediaIds).toEqual(['0192bbbb-0000-7000-8000-000000000001']);
  });

  it('allows one invoice per job card — the unique index', async () => {
    await inTx((tx) =>
      store.insert(tx, {
        id: uuidv7(),
        shopId: SHOP_ID,
        jobCardId: CARD_ID,
        customerId: CUSTOMER_ID,
        estimateId: null,
        draft,
        issuedAt: NOW,
      }),
    );

    // Two invoice numbers for one visit is exactly what a tax audit asks about.
    await expect(
      inTx((tx) =>
        store.insert(tx, {
          id: uuidv7(),
          shopId: SHOP_ID,
          jobCardId: CARD_ID,
          customerId: CUSTOMER_ID,
          estimateId: null,
          draft: { ...draft, number: 'INV/2026-27/0002' },
          issuedAt: NOW,
        }),
      ),
    ).rejects.toThrow();
  });

  it('refuses totals that do not add up — the CHECK constraint', async () => {
    await expect(
      inTx((tx) =>
        store.insert(tx, {
          id: uuidv7(),
          shopId: SHOP_ID,
          jobCardId: CARD_ID,
          customerId: CUSTOMER_ID,
          estimateId: null,
          draft: { ...draft, totalPaise: 999_999 },
          issuedAt: NOW,
        }),
      ),
    ).rejects.toThrow();
  });

  it('refuses an intra-state invoice that also charges IGST', async () => {
    await expect(
      inTx((tx) =>
        store.insert(tx, {
          id: uuidv7(),
          shopId: SHOP_ID,
          jobCardId: CARD_ID,
          customerId: CUSTOMER_ID,
          estimateId: null,
          draft: { ...draft, igstPaise: 10, totalPaise: 944_010 },
          issuedAt: NOW,
        }),
      ),
    ).rejects.toThrow();
  });

  it('allocates a gapless sequence per shop and financial year', async () => {
    const first = await inTx((tx) => store.nextSequence(tx, SHOP_ID, '2026-27'));
    expect(first).toBe(1);

    await inTx((tx) =>
      store.insert(tx, {
        id: uuidv7(),
        shopId: SHOP_ID,
        jobCardId: CARD_ID,
        customerId: CUSTOMER_ID,
        estimateId: null,
        draft,
        issuedAt: NOW,
      }),
    );

    expect(await inTx((tx) => store.nextSequence(tx, SHOP_ID, '2026-27'))).toBe(2);
    // A different financial year is a different series.
    expect(await inTx((tx) => store.nextSequence(tx, SHOP_ID, '2027-28'))).toBe(1);
  });

  it('marks an invoice paid once the money lands', async () => {
    const id = uuidv7();
    await inTx((tx) =>
      store.insert(tx, {
        id,
        shopId: SHOP_ID,
        jobCardId: CARD_ID,
        customerId: CUSTOMER_ID,
        estimateId: null,
        draft,
        issuedAt: NOW,
      }),
    );

    await inTx((tx) =>
      store.setStatus(tx, { invoiceId: id, status: 'PAID', amountPaidPaise: 944_000, at: NOW }),
    );

    const invoice = await inTx((tx) => store.load(tx, SHOP_ID, id));
    expect(invoice?.status).toBe('PAID');
    expect(invoice?.amountPaidPaise).toBe(944_000);
  });
});

/* -------------------------------------------------------------------------- *
 * Payments
 * -------------------------------------------------------------------------- */

describe('PgPaymentStore', () => {
  const store = new PgPaymentStore();

  function payment(overrides: Record<string, unknown> = {}) {
    return {
      id: uuidv7(),
      shopId: SHOP_ID,
      jobCardId: CARD_ID,
      invoiceId: null,
      customerId: CUSTOMER_ID,
      provider: 'mock',
      providerPaymentLinkId: null,
      status: 'PENDING' as const,
      amountPaise: 566_400,
      amountPaidPaise: 0,
      acceptPartial: false,
      shortUrl: null,
      referenceId: 'JC-2026-0042-abc',
      expiresAt: new Date('2026-08-20T00:00:00.000Z'),
      paidAt: null,
      remindersSent: 0,
      lastReminderAt: null,
      createdAt: NOW,
      ...overrides,
    };
  }

  async function withLink(linkId: string) {
    const row = payment();
    await inTx((tx) => store.insert(tx, row));
    await inTx((tx) =>
      store.attachLink(tx, {
        paymentId: row.id,
        providerPaymentLinkId: linkId,
        shortUrl: `https://pay.test/${linkId}`,
        expiresAt: new Date('2026-08-20T00:00:00.000Z'),
      }),
    );
    return row;
  }

  function event(paymentId: string, overrides: Record<string, unknown> = {}) {
    return {
      id: uuidv7(),
      shopId: SHOP_ID,
      paymentId,
      kind: 'PAID' as const,
      providerEventId: 'payment_link.paid:plink_1:pay_1',
      providerPaymentId: 'pay_1',
      method: 'UPI' as const,
      amountPaise: 566_400,
      runningPaidPaise: 566_400,
      instrument: 'ravi@okhdfcbank',
      failureReason: null,
      rawPayload: { event: 'payment_link.paid' },
      recordedByStaffId: null,
      occurredAt: NOW,
      ...overrides,
    };
  }

  it('resolves a payment from a provider link id with no shop id', async () => {
    const row = await withLink('plink_1');

    // A webhook arrives on one URL for every tenant and carries no shop of
    // ours; the provider's link id is the only thing that identifies the money.
    const found = await inTx((tx) => store.findByProviderLinkIdAnyShop(tx, 'plink_1'));
    expect(found?.id).toBe(row.id);
    expect(found?.shopId).toBe(SHOP_ID);
    expect(found?.amountPaise).toBe(566_400);
  });

  it('credits a retried webhook exactly once — the unique index', async () => {
    const row = await withLink('plink_1');

    const first = await inTx((tx) => store.appendEvent(tx, event(row.id)));
    const second = await inTx((tx) => store.appendEvent(tx, event(row.id)));

    expect(first).not.toBeNull();
    expect(second).toBeNull();

    const ledger = await inTx((tx) => store.events(tx, SHOP_ID, row.id));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.amountPaise).toBe(566_400);
    expect(ledger[0]?.method).toBe('UPI');
  });

  it('records a genuinely new instalment', async () => {
    const row = await withLink('plink_1');

    await inTx((tx) =>
      store.appendEvent(
        tx,
        event(row.id, {
          kind: 'PARTIALLY_PAID',
          providerEventId: 'payment_link.partially_paid:plink_1:pay_1',
          amountPaise: 283_200,
          runningPaidPaise: 283_200,
        }),
      ),
    );
    const second = await inTx((tx) =>
      store.appendEvent(
        tx,
        event(row.id, {
          kind: 'PARTIALLY_PAID',
          providerEventId: 'payment_link.partially_paid:plink_1:pay_2',
          amountPaise: 283_200,
          runningPaidPaise: 566_400,
        }),
      ),
    );

    expect(second).not.toBeNull();
    expect(await inTx((tx) => store.events(tx, SHOP_ID, row.id))).toHaveLength(2);
  });

  it('applies the ledger to the payment row', async () => {
    const row = await withLink('plink_1');
    await inTx((tx) =>
      store.applyLedger(tx, {
        paymentId: row.id,
        status: 'PAID',
        amountPaidPaise: 566_400,
        paidAt: NOW,
        at: NOW,
      }),
    );

    const found = await inTx((tx) => store.lockById(tx, SHOP_ID, row.id));
    expect(found?.status).toBe('PAID');
    expect(found?.amountPaidPaise).toBe(566_400);
    expect(found?.paidAt?.toISOString()).toBe(NOW.toISOString());
  });

  it('refuses a PAID row that has not covered its amount', async () => {
    const row = await withLink('plink_1');
    await expect(
      inTx((tx) =>
        store.applyLedger(tx, {
          paymentId: row.id,
          status: 'PAID',
          amountPaidPaise: 100,
          paidAt: NOW,
          at: NOW,
        }),
      ),
    ).rejects.toThrow();
  });

  it('caps reminders at two — the CHECK constraint, not the caller', async () => {
    const row = await withLink('plink_1');
    await inTx((tx) => store.recordReminder(tx, row.id, NOW));
    await inTx((tx) => store.recordReminder(tx, row.id, NOW));

    // Two rungs, then a person. A third is a debt-collection cadence.
    await expect(inTx((tx) => store.recordReminder(tx, row.id, NOW))).rejects.toThrow();
  });

  it('claims a balance whose next rung is due, and stops after the last', async () => {
    const row = await withLink('plink_1');
    const later = new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000);

    const first = await inTx((tx) =>
      store.claimDueReminders(tx, {
        shopId: SHOP_ID,
        now: later,
        afterMinutes: [1440, 4320],
        limit: 10,
      }),
    );
    expect(first.map((entry) => entry.id)).toEqual([row.id]);

    await inTx((tx) => store.recordReminder(tx, row.id, later));
    await inTx((tx) => store.recordReminder(tx, row.id, later));

    const exhausted = await inTx((tx) =>
      store.claimDueReminders(tx, {
        shopId: SHOP_ID,
        now: new Date(later.getTime() + 30 * 24 * 60 * 60 * 1000),
        afterMinutes: [1440, 4320],
        limit: 10,
      }),
    );
    expect(exhausted).toHaveLength(0);
  });

  it('never chases a settled payment', async () => {
    const row = await withLink('plink_1');
    await inTx((tx) =>
      store.applyLedger(tx, {
        paymentId: row.id,
        status: 'PAID',
        amountPaidPaise: 566_400,
        paidAt: NOW,
        at: NOW,
      }),
    );

    const claimed = await inTx((tx) =>
      store.claimDueReminders(tx, {
        shopId: null,
        now: new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000),
        afterMinutes: [1440, 4320],
        limit: 10,
      }),
    );
    expect(claimed).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- *
 * Gate passes
 * -------------------------------------------------------------------------- */

describe('PgGatePassStore', () => {
  const store = new PgGatePassStore();

  function pass(overrides: Record<string, unknown> = {}) {
    return {
      id: uuidv7(),
      shopId: SHOP_ID,
      jobCardId: CARD_ID,
      customerId: CUSTOMER_ID,
      code: 'K7M2QD',
      tokenHash: 'a'.repeat(64),
      status: 'ISSUED' as const,
      issuedAt: NOW,
      expiresAt: new Date('2026-08-17T18:00:00.000Z'),
      usedAt: null,
      verifiedByStaffId: null,
      overrideReason: null,
      overrideByStaffId: null,
      verificationAttempts: 0,
      lastVerifyResult: null,
      messageId: null,
      ...overrides,
    };
  }

  it('finds a pass by its short code, case-insensitively', async () => {
    await inTx((tx) => store.insert(tx, pass()));

    const found = await inTx((tx) => store.lockByCode(tx, SHOP_ID, 'k7m2qd'));
    expect(found?.code).toBe('K7M2QD');
    expect(found?.status).toBe('ISSUED');
  });

  it('keeps codes unique per shop', async () => {
    await inTx((tx) => store.insert(tx, pass()));
    await expect(
      inTx((tx) => store.insert(tx, pass({ jobCardId: OTHER_CARD_ID }))),
    ).rejects.toThrow();
  });

  it('refuses a pass that expires before it is issued', async () => {
    await expect(
      inTx((tx) =>
        store.insert(tx, pass({ expiresAt: new Date('2026-08-17T05:00:00.000Z') })),
      ),
    ).rejects.toThrow();
  });

  it('counts every verification and marks a valid one used', async () => {
    const row = pass();
    await inTx((tx) => store.insert(tx, row));

    await inTx((tx) =>
      store.recordVerification(tx, {
        gatePassId: row.id,
        result: 'EXPIRED',
        staffId: TECHNICIAN_ID,
        markUsed: false,
        at: NOW,
      }),
    );
    let found = await inTx((tx) => store.lockById(tx, SHOP_ID, row.id));
    // A repeatedly rejected code at a gate is the pattern nobody notices unless
    // it is counted.
    expect(found?.verificationAttempts).toBe(1);
    expect(found?.status).toBe('ISSUED');
    expect(found?.lastVerifyResult).toBe('EXPIRED');

    await inTx((tx) =>
      store.recordVerification(tx, {
        gatePassId: row.id,
        result: 'VALID',
        staffId: TECHNICIAN_ID,
        markUsed: true,
        at: NOW,
      }),
    );
    found = await inTx((tx) => store.lockById(tx, SHOP_ID, row.id));
    expect(found?.verificationAttempts).toBe(2);
    expect(found?.status).toBe('USED');
    expect(found?.usedAt).not.toBeNull();
    expect(found?.verifiedByStaffId).toBe(TECHNICIAN_ID);
  });

  it('stops offering a used pass as the card’s active one', async () => {
    const row = pass();
    await inTx((tx) => store.insert(tx, row));
    expect(await inTx((tx) => store.findActiveForCard(tx, SHOP_ID, CARD_ID))).not.toBeNull();

    await inTx((tx) =>
      store.recordVerification(tx, {
        gatePassId: row.id,
        result: 'VALID',
        staffId: null,
        markUsed: true,
        at: NOW,
      }),
    );
    expect(await inTx((tx) => store.findActiveForCard(tx, SHOP_ID, CARD_ID))).toBeNull();
  });

  it('revokes a pass', async () => {
    const row = pass();
    await inTx((tx) => store.insert(tx, row));
    await inTx((tx) => store.revoke(tx, SHOP_ID, row.id, NOW));

    const found = await inTx((tx) => store.lockById(tx, SHOP_ID, row.id));
    expect(found?.status).toBe('REVOKED');
  });

  it('records an owner override with its reason', async () => {
    const row = pass({
      overrideReason: 'Regular customer, settling on Monday',
      overrideByStaffId: TECHNICIAN_ID,
    });
    await inTx((tx) => store.insert(tx, row));

    const found = await inTx((tx) => store.lockById(tx, SHOP_ID, row.id));
    expect(found?.overrideReason).toBe('Regular customer, settling on Monday');
  });
});

/* -------------------------------------------------------------------------- *
 * Coalescing window
 * -------------------------------------------------------------------------- */

describe('PgStatusCommsStore', () => {
  const store = new PgStatusCommsStore();

  it('is null when nothing has been sent about the card', async () => {
    expect(await inTx((tx) => store.lastStatusUpdateAt(tx, SHOP_ID, CARD_ID))).toBeNull();
  });

  it('ignores a message the gate refused', async () => {
    // A message the gate blocked was never received, so it cannot have been an
    // interruption and must not start the coalescing window.
    await seedMessage({ status: 'BLOCKED', jobCardId: CARD_ID });
    expect(await inTx((tx) => store.lastStatusUpdateAt(tx, SHOP_ID, CARD_ID))).toBeNull();
  });

  it('reports the newest outbound message about the card', async () => {
    await seedMessage({
      status: 'SENT',
      jobCardId: CARD_ID,
      sentAt: new Date('2026-08-17T04:00:00.000Z'),
    });
    await seedMessage({
      status: 'SENT',
      jobCardId: CARD_ID,
      sentAt: new Date('2026-08-17T05:00:00.000Z'),
    });

    const last = await inTx((tx) => store.lastStatusUpdateAt(tx, SHOP_ID, CARD_ID));
    expect(last?.toISOString()).toBe('2026-08-17T05:00:00.000Z');
  });
});

/* ---------------------------------------------------------------- helpers -- */

/** A conversation plus one message, for the tests that need real foreign keys. */
async function seedMessage(
  overrides: {
    status?: 'SENT' | 'BLOCKED';
    jobCardId?: string | null;
    sentAt?: Date;
  } = {},
): Promise<string> {
  const conversationId = uuidv7();
  const messageId = uuidv7();

  await db.execute(raw`
    insert into conversations (id, shop_id, kind, channel, customer_id, external_thread_id, language)
    values (${conversationId}, ${SHOP_ID}, 'CUSTOMER'::conversation_kind, 'WHATSAPP'::channel_type,
            ${CUSTOMER_ID}, ${`thread-${messageId}`}, 'en'::language)
  `);

  await db.execute(raw`
    insert into messages (
      id, shop_id, conversation_id, direction, status, channel, kind, language, body, purpose,
      job_card_id, sent_at, blocked_code, blocked_reason
    ) values (
      ${messageId}, ${SHOP_ID}, ${conversationId}, 'OUTBOUND'::message_direction,
      ${overrides.status ?? 'SENT'}::message_status, 'WHATSAPP'::channel_type,
      'TEXT'::message_kind, 'en'::language, 'Update on your Swift', 'SERVICE'::consent_purpose,
      ${overrides.jobCardId ?? null}, ${overrides.sentAt ?? NOW},
      ${overrides.status === 'BLOCKED' ? 'CONSENT_MISSING' : null},
      ${overrides.status === 'BLOCKED' ? 'No SERVICE consent on record' : null}
    )
  `);

  return messageId;
}
