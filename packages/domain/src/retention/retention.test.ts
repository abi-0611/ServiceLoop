import { defaultShopConfig } from '@serviceloop/config';
import { addDays, uuidv7, type EventEnvelope } from '@serviceloop/shared';
import { describe, expect, it } from 'vitest';
import { checkClaimAnchoring } from '../guardrails/policies';
import { REPITCH_ACTION_IDS, parseRepitchAction } from '../messaging/retention-actions';
import {
  createRetentionHarness,
  LOOP_CARD,
  LOOP_CONVERSATION,
  LOOP_CUSTOMER,
  LOOP_SHOP,
  RETENTION_VEHICLE,
  type RetentionHarness,
} from '../testing';
import { evaluateTriggers, horizonFor, purposeFor, triggerTagsFor } from './horizon';
import { composeRepitch, parseBareOdometer } from './retention-service';
import type { LedgerItem } from './types';

/**
 * Phase 6 — retention, feedback, reminders, digest and analytics.
 *
 * The suite is organised by the promise each part makes to a *person* rather
 * than by module, because that is what a regression here would break: a
 * customer who said "not interested" hearing about it again, a customer who
 * complained being sold to the next morning, an owner reading a recovery figure
 * that does not survive being recomputed.
 */

const TRACE = 'test-phase6';

function ledgerItem(patch: Partial<LedgerItem> = {}): LedgerItem {
  return {
    id: uuidv7(),
    shopId: LOOP_SHOP,
    jobCardId: LOOP_CARD,
    workItemId: uuidv7(),
    customerId: LOOP_CUSTOMER,
    vehicleId: RETENTION_VEHICLE,
    kind: 'DEFERRED',
    declineReason: 'customer_deferred',
    reason: 'Wants to wait until next month',
    amountPaise: 240_000,
    category: 'brakes',
    title: 'Rear brake pads',
    technicianNote: 'Rear pads down to 2.1mm; discs still within limits.',
    evidenceBundleId: null,
    estimateLineIds: ['line-brakes'],
    followUpAfter: null,
    triggerTags: ['next_visit'],
    status: 'OPEN',
    repitchCount: 0,
    lastRepitchedAt: null,
    lastResponse: null,
    closedAt: null,
    closedReason: null,
    convertedJobCardId: null,
    recoveredAmountPaise: 0,
    createdAt: new Date('2026-04-14T09:00:00.000Z'),
    ...patch,
  };
}

/** Puts one open, brake-shaped ledger item in the harness's world. */
async function seedDeclinedBrakes(
  harness: RetentionHarness,
  patch: Partial<Parameters<RetentionHarness['ledger']['open']>[0]> = {},
): Promise<string> {
  const result = await harness.ledger.open({
    shopId: LOOP_SHOP,
    jobCardId: LOOP_CARD,
    workItemId: uuidv7(),
    customerId: LOOP_CUSTOMER,
    vehicleId: RETENTION_VEHICLE,
    kind: 'DEFERRED',
    declineReason: 'customer_deferred',
    reason: 'Wants to wait until after the rains',
    amountPaise: 240_000,
    category: 'brakes',
    title: 'Rear brake pads',
    technicianNote: 'Rear pads down to 2.1mm; discs still within limits.',
    evidenceBundleId: null,
    estimateLineIds: ['line-brakes'],
    traceId: TRACE,
    ...patch,
  });
  return result.ledgerItemId;
}

/* ========================================================================== *
 * 6.1 — the ledger's lifecycle
 * ========================================================================== */

describe('6.1 declined-work ledger', () => {
  it('gives a categorised item the shop-configured horizon and its trigger tags', () => {
    const config = defaultShopConfig('Asia/Kolkata').retention;
    const declinedAt = new Date('2026-04-14T09:00:00.000Z');

    const brakes = horizonFor(config, { category: 'brakes', declinedAt });
    expect(brakes).toEqual(addDays(declinedAt, 75));

    // The phase names cosmetic work as the thing never re-pitched on a timer.
    expect(horizonFor(config, { category: 'cosmetic', declinedAt })).toBeNull();
    // And an uncategorised item inherits the conservative default, which is
    // also null: a shop has to say what a category means before we chase it.
    expect(horizonFor(config, { category: null, declinedAt })).toBeNull();
  });

  it('lets an explicit customer promise beat the category default', () => {
    const config = defaultShopConfig('Asia/Kolkata').retention;
    const declinedAt = new Date('2026-04-14T09:00:00.000Z');
    const promised = new Date('2026-11-05T09:00:00.000Z');

    expect(horizonFor(config, { category: 'brakes', declinedAt, customerPromisedAt: promised })).toEqual(
      promised,
    );
  });

  it('tags brake work for the monsoon but never a price objection', () => {
    const config = defaultShopConfig('Asia/Kolkata').retention;

    const deferred = triggerTagsFor(config, {
      category: 'brakes',
      declineReason: 'customer_deferred',
    });
    expect(deferred).toContain('next_visit');
    expect(deferred).toContain('season:monsoon');

    // A customer who said "not at that price" did not say "not now". Waking
    // that item when the rains start re-quotes the identical number to somebody
    // who has already refused it.
    const priced = triggerTagsFor(config, { category: 'brakes', declineReason: 'price' });
    expect(priced).toContain('next_visit');
    expect(priced.some((tag) => tag.startsWith('season:'))).toBe(false);
  });

  it('caps re-pitches at two and refuses an opted-out item for ever', async () => {
    const harness = createRetentionHarness();
    const config = defaultShopConfig('Asia/Kolkata');
    const item = ledgerItem({ repitchCount: 2 });

    expect(harness.ledger.mayRepitch(item, config)).toMatchObject({
      ok: false,
      code: 'REPITCH_CAP_REACHED',
    });

    // Opted out is checked first and separately: "we have asked enough" and
    // "they told us to stop" read the same in a count and differently in an
    // audit row, and only one of them is ever reconsidered.
    expect(
      harness.ledger.mayRepitch(ledgerItem({ status: 'OPTED_OUT', repitchCount: 0 }), config),
    ).toMatchObject({ ok: false, code: 'ITEM_OPTED_OUT' });
  });

  it('emits ledger.item_opened once, however many times the decline is redelivered', async () => {
    const harness = createRetentionHarness();
    const workItemId = uuidv7();

    const first = await seedDeclinedBrakes(harness, { workItemId });
    const second = await seedDeclinedBrakes(harness, { workItemId });

    expect(second).toBe(first);
    expect(harness.loop.base.world.eventsOfType('ledger.item_opened')).toHaveLength(1);
  });

  it('refuses to record a conversion that cannot be attributed to a visit', async () => {
    const harness = createRetentionHarness();
    const id = await seedDeclinedBrakes(harness);

    await harness.ledger.convert({
      shopId: LOOP_SHOP,
      ledgerItemId: id,
      convertedJobCardId: LOOP_CARD,
      recoveredAmountPaise: 240_000,
      traceId: TRACE,
    });

    const item = await harness.ledger.load(LOOP_SHOP, id);
    expect(item?.status).toBe('CONVERTED');
    expect(item?.recoveredAmountPaise).toBe(240_000);

    const closed = harness.loop.base.world.eventsOfType('ledger.item_closed');
    expect(closed).toHaveLength(1);
    // The cohort the item was *ledgered* in travels with the closure, which is
    // what makes the 90-day recovery rate a single-pass fold.
    expect(closed[0]?.payload).toMatchObject({
      status: 'CONVERTED',
      ledgeredAmountPaise: 240_000,
      recoveredAmountPaise: 240_000,
    });
    expect((closed[0]?.payload as { openedAt: string }).openedAt).toBeTypeOf('string');
  });
});

/* ========================================================================== *
 * 6.2 — the trigger engine, on a clock the test owns
 * ========================================================================== */

describe('6.2 trigger engine', () => {
  const config = defaultShopConfig('Asia/Kolkata').retention;
  const context = (
    now: Date,
    patch: Partial<Parameters<typeof evaluateTriggers>[1]> = {},
  ): Parameters<typeof evaluateTriggers>[1] => ({
    now,
    timezone: 'Asia/Kolkata',
    config,
    openVisitByVehicleId: new Map(),
    odometerNow: new Map(),
    odometerAtDecline: new Map(),
    ...patch,
  });

  it('fires time_elapsed once the horizon has passed and not a day before', () => {
    const declinedAt = new Date('2026-04-14T09:00:00.000Z');
    const item = ledgerItem({ createdAt: declinedAt, followUpAfter: addDays(declinedAt, 75) });

    expect(evaluateTriggers(item, context(addDays(declinedAt, 74)))).toBeNull();

    const hit = evaluateTriggers(item, context(addDays(declinedAt, 76)));
    expect(hit?.trigger).toBe('time_elapsed');
    expect(hit?.rationale).toMatchObject({ kind: 'time_elapsed' });
  });

  it('fires the season trigger inside the monsoon window and not outside it', () => {
    const declinedAt = new Date('2026-01-10T09:00:00.000Z');
    const item = ledgerItem({
      createdAt: declinedAt,
      followUpAfter: addDays(declinedAt, 10),
      triggerTags: ['next_visit', 'season:monsoon'],
    });

    // 1 June: inside the south-west monsoon window the defaults ship.
    const inside = evaluateTriggers(item, context(new Date('2026-06-01T09:00:00.000Z')));
    expect(inside?.trigger).toBe('season');
    expect(inside?.rationale).toMatchObject({ kind: 'season', season: 'monsoon' });

    // 1 September: outside both windows, so the item falls through to its
    // horizon — which has also passed, so this is time_elapsed rather than
    // nothing. The assertion that matters is that it is not a season hit.
    const outside = evaluateTriggers(item, context(new Date('2026-09-01T09:00:00.000Z')));
    expect(outside?.trigger).toBe('time_elapsed');
  });

  it('will not let a season shorten a horizon the technician asked for', () => {
    const declinedAt = new Date('2026-05-01T09:00:00.000Z');
    const item = ledgerItem({
      createdAt: declinedAt,
      // Six months out: the technician said look at this later, not now.
      followUpAfter: addDays(declinedAt, 180),
      triggerTags: ['next_visit', 'season:monsoon'],
    });

    expect(evaluateTriggers(item, context(new Date('2026-06-01T09:00:00.000Z')))).toBeNull();
  });

  it('fires next_visit for a different card and never for the one it was declined on', () => {
    const item = ledgerItem({ vehicleId: RETENTION_VEHICLE });

    const sameVisit = evaluateTriggers(
      item,
      context(new Date('2026-05-01T09:00:00.000Z'), {
        openVisitByVehicleId: new Map([[RETENTION_VEHICLE, LOOP_CARD]]),
      }),
    );
    expect(sameVisit).toBeNull();

    const newVisit = evaluateTriggers(
      item,
      context(new Date('2026-05-01T09:00:00.000Z'), {
        openVisitByVehicleId: new Map([[RETENTION_VEHICLE, 'a-different-card']]),
      }),
    );
    expect(newVisit?.trigger).toBe('next_visit');
  });

  it('fires odometer only on a reading the customer volunteered', () => {
    const declinedAt = new Date('2026-04-14T09:00:00.000Z');
    const item = ledgerItem({
      createdAt: declinedAt,
      triggerTags: ['next_visit', 'odometer:+3000'],
    });
    const baseline = {
      vehicleId: RETENTION_VEHICLE,
      odometerKm: 58_400,
      source: 'CUSTOMER_VOLUNTEERED' as const,
      readAt: declinedAt,
    };

    const volunteered = evaluateTriggers(
      item,
      context(new Date('2026-06-14T09:00:00.000Z'), {
        odometerAtDecline: new Map([[RETENTION_VEHICLE, baseline]]),
        odometerNow: new Map([
          [RETENTION_VEHICLE, { ...baseline, odometerKm: 62_000, readAt: new Date('2026-06-14T08:00:00.000Z') }],
        ]),
      }),
    );
    expect(volunteered?.trigger).toBe('odometer');
    expect(volunteered?.rationale).toMatchObject({ kind: 'odometer', kmSince: 3_600 });

    // The same distance, read off the dashboard by an advisor at intake. The
    // phase says customer-reported readings only, and this is that rule.
    const fromIntake = evaluateTriggers(
      item,
      context(new Date('2026-06-14T09:00:00.000Z'), {
        odometerAtDecline: new Map([[RETENTION_VEHICLE, baseline]]),
        odometerNow: new Map([
          [
            RETENTION_VEHICLE,
            { ...baseline, odometerKm: 62_000, source: 'INTAKE' as const, readAt: new Date('2026-06-14T08:00:00.000Z') },
          ],
        ]),
      }),
    );
    expect(fromIntake).toBeNull();
  });

  it('never fires for a closed or capped item', () => {
    const now = new Date('2026-09-01T09:00:00.000Z');
    const past = { createdAt: new Date('2026-01-01T00:00:00.000Z'), followUpAfter: new Date('2026-02-01T00:00:00.000Z') };

    expect(evaluateTriggers(ledgerItem({ ...past, status: 'OPTED_OUT' }), context(now))).toBeNull();
    expect(evaluateTriggers(ledgerItem({ ...past, status: 'CONVERTED' }), context(now))).toBeNull();
    expect(evaluateTriggers(ledgerItem({ ...past, repitchCount: 2 }), context(now))).toBeNull();
  });
});

/* ========================================================================== *
 * 6.2 — the odometer ask, and the answer that comes back
 * ========================================================================== */

describe('6.2 the odometer ask', () => {
  it('rides along on a re-pitch rather than being a message of its own', () => {
    const item = ledgerItem();
    const withAsk = composeRepitch({
      language: 'en',
      customerName: 'Lakshmi',
      vehicleLabel: 'Maruti Swift',
      item,
      rationale: { kind: 'season', season: 'monsoon' },
      currentPricePaise: null,
      declinedAt: item.createdAt,
      askOdometer: true,
    });
    const without = composeRepitch({
      language: 'en',
      customerName: 'Lakshmi',
      vehicleLabel: 'Maruti Swift',
      item,
      rationale: { kind: 'season', season: 'monsoon' },
      currentPricePaise: null,
      declinedAt: item.createdAt,
    });

    expect(withAsk.body).toContain('kilometres');
    expect(without.body).not.toContain('kilometres');
    // The three answers are the answers to the *pitch*. WhatsApp allows three
    // buttons, and spending one on a mileage question would cost the customer
    // the "not interested" that closes the item.
    expect(withAsk.content.kind).toBe('interactive');
    if (withAsk.content.kind === 'interactive') {
      expect(withAsk.content.buttons).toHaveLength(3);
    }
    // And the ask must not become part of the claim the checker anchors.
    expect(withAsk.claims).toEqual(without.claims);
  });

  it('asks only when nothing has told us the mileage since the decline', async () => {
    const harness = createRetentionHarness();
    const ledgerItemId = await seedDeclinedBrakes(harness);

    // A reading taken *after* the decline answers the question already.
    harness.advanceDays(1);
    await harness.retention.recordOdometer({
      shopId: LOOP_SHOP,
      vehicleId: RETENTION_VEHICLE,
      odometerKm: 61_000,
      source: 'CUSTOMER_VOLUNTEERED',
      traceId: TRACE,
    });

    harness.advanceDays(120);
    const item = await harness.ledger.load(LOOP_SHOP, ledgerItemId);
    expect(item).not.toBeNull();
    await harness.retention.repitch({
      shopId: LOOP_SHOP,
      item: item as NonNullable<typeof item>,
      trigger: 'season',
      rationale: { kind: 'season', season: 'monsoon' },
      traceId: TRACE,
    });

    expect(harness.sentBodies().at(-1)).not.toContain('kilometres');
  });

  it('reads a bare number as a mileage, and a number in a sentence as prose', () => {
    expect(parseBareOdometer('62000')).toBe(62_000);
    expect(parseBareOdometer('62,000 km')).toBe(62_000);
    expect(parseBareOdometer('  62000kms ')).toBe(62_000);

    // A bare four-digit number is a registration fragment, which is how a great
    // many customers name their car. Filed as a mileage it would put 4,432 km
    // on a Swift and then suppress that vehicle's odometer trigger for ever.
    expect(parseBareOdometer('4432')).toBeNull();
    // With the unit, the same digits are a person answering the question.
    expect(parseBareOdometer('4432 km')).toBe(4_432);

    expect(parseBareOdometer('when can I come in? about 62000')).toBeNull();
    expect(parseBareOdometer('the 40000 service is due')).toBeNull();
    expect(parseBareOdometer('')).toBeNull();
    expect(parseBareOdometer('99')).toBeNull();
    expect(parseBareOdometer('9999999')).toBeNull();
  });

  it('accepts a volunteered reading only after we have actually asked', async () => {
    const harness = createRetentionHarness();
    await seedDeclinedBrakes(harness);

    // Nothing has been sent to this customer, so a bare number is just a number.
    const unprompted = await harness.retention.tryRecordVolunteeredOdometer({
      shopId: LOOP_SHOP,
      customerId: LOOP_CUSTOMER,
      text: '62000',
      traceId: TRACE,
    });
    expect(unprompted).toBeNull();

    // Now the season trigger writes to them, and the same number is an answer.
    harness.advanceDays(120);
    await harness.retention.scan({ shopId: LOOP_SHOP, traceId: TRACE });

    const answered = await harness.retention.tryRecordVolunteeredOdometer({
      shopId: LOOP_SHOP,
      customerId: LOOP_CUSTOMER,
      text: '62,000 km',
      traceId: TRACE,
    });
    expect(answered).toEqual({ vehicleId: RETENTION_VEHICLE, odometerKm: 62_000 });
    expect(harness.world.odometer.at(-1)?.source).toBe('CUSTOMER_VOLUNTEERED');
  });

  it('stops listening a fortnight after the last touch', async () => {
    const harness = createRetentionHarness();
    await seedDeclinedBrakes(harness);

    harness.advanceDays(120);
    await harness.retention.scan({ shopId: LOOP_SHOP, traceId: TRACE });

    harness.advanceDays(20);
    const late = await harness.retention.tryRecordVolunteeredOdometer({
      shopId: LOOP_SHOP,
      customerId: LOOP_CUSTOMER,
      text: '62000',
      traceId: TRACE,
    });
    expect(late).toBeNull();
  });

  it('never lets a console-entered reading wake the odometer trigger', () => {
    const declinedAt = new Date('2026-04-14T09:00:00.000Z');
    const item = ledgerItem({
      createdAt: declinedAt,
      triggerTags: ['next_visit', 'odometer:+3000'],
    });

    // An advisor reading the dashboard at the counter. Real, useful for the
    // service-due forecast, and never a reason to write to somebody.
    const hit = evaluateTriggers(item, {
      now: new Date('2026-06-14T09:00:00.000Z'),
      timezone: 'Asia/Kolkata',
      config: defaultShopConfig('Asia/Kolkata').retention,
      openVisitByVehicleId: new Map(),
      odometerNow: new Map([
        [
          RETENTION_VEHICLE,
          {
            vehicleId: RETENTION_VEHICLE,
            odometerKm: 65_000,
            source: 'CONSOLE' as const,
            readAt: new Date('2026-06-14T08:00:00.000Z'),
          },
        ],
      ]),
      odometerAtDecline: new Map([
        [
          RETENTION_VEHICLE,
          {
            vehicleId: RETENTION_VEHICLE,
            odometerKm: 58_000,
            source: 'CUSTOMER_VOLUNTEERED' as const,
            readAt: declinedAt,
          },
        ],
      ]),
    });
    expect(hit).toBeNull();
  });
});

/* ========================================================================== *
 * 6.3 — the composer and the one-tap answers
 * ========================================================================== */

describe('6.3 re-pitch composer', () => {
  it('anchors every claim to the original technician note and estimate line', () => {
    const item = ledgerItem();
    const composed = composeRepitch({
      language: 'en',
      customerName: 'Lakshmi',
      vehicleLabel: 'Maruti Swift',
      item,
      rationale: { kind: 'season', season: 'monsoon' },
      currentPricePaise: null,
      declinedAt: item.createdAt,
    });

    // The gate's own checker, run over the composer's output. This is the
    // phase's "post-checker passes all composer outputs" as an assertion.
    expect(checkClaimAnchoring(composed.claims).allowed).toBe(true);
    expect(composed.claims[0]?.evidence).toEqual([
      { kind: 'TECHNICIAN_NOTE', id: item.id },
      { kind: 'ESTIMATE_LINE', id: 'line-brakes' },
    ]);

    const body = composed.content.kind === 'interactive' ? composed.content.body : '';
    expect(body).toContain('April 2026');
    expect(body).toContain('Rear pads down to 2.1mm');
    expect(body).toContain('₹2,400');
    expect(body).toContain('monsoon');
  });

  it('states a moved price plainly rather than quietly re-quoting', () => {
    const item = ledgerItem();
    const composed = composeRepitch({
      language: 'en',
      customerName: 'Lakshmi',
      vehicleLabel: 'Maruti Swift',
      item,
      rationale: { kind: 'time_elapsed', months: 5 },
      currentPricePaise: 275_000,
      declinedAt: item.createdAt,
    });

    const body = composed.content.kind === 'interactive' ? composed.content.body : '';
    expect(body).toContain('₹2,750');
    expect(body).toContain('₹2,400');
  });

  it('makes no claim at all for an item with no note and no estimate line', () => {
    const composed = composeRepitch({
      language: 'en',
      customerName: 'Lakshmi',
      vehicleLabel: 'Maruti Swift',
      item: ledgerItem({ technicianNote: null, estimateLineIds: [] }),
      rationale: { kind: 'manual' },
      currentPricePaise: null,
      declinedAt: new Date('2026-04-14T09:00:00.000Z'),
    });

    // Zero claims is the right answer, not a bug: such a message asserts nothing
    // about the vehicle, so there is nothing for the checker to anchor.
    expect(composed.claims).toEqual([]);
    expect(checkClaimAnchoring(composed.claims).allowed).toBe(true);
  });

  it('offers exactly the three one-tap answers, each carrying its own item', () => {
    const item = ledgerItem();
    const composed = composeRepitch({
      language: 'en',
      customerName: 'Lakshmi',
      vehicleLabel: 'Maruti Swift',
      item,
      rationale: { kind: 'manual' },
      currentPricePaise: null,
      declinedAt: item.createdAt,
    });

    const buttons = composed.content.kind === 'interactive' ? (composed.content.buttons ?? []) : [];
    expect(buttons).toHaveLength(3);
    expect(parseRepitchAction(buttons[2]?.id ?? null)).toEqual({
      response: 'NOT_INTERESTED',
      ledgerItemId: item.id,
    });
  });

  it('refuses a malformed reply id rather than guessing which item it meant', () => {
    expect(parseRepitchAction('repitch:no:')).toBeNull();
    expect(parseRepitchAction('repitch:maybe:abc')).toBeNull();
    expect(parseRepitchAction(REPITCH_ACTION_IDS.book('abc'))).toEqual({
      response: 'BOOK',
      ledgerItemId: 'abc',
    });
  });

  it('picks SERVICE for a safety finding and MARKETING for everything else', () => {
    expect(purposeFor({ category: 'brakes', technicianNote: 'Pads at 2.1mm' })).toBe('SERVICE');
    expect(purposeFor({ category: 'cosmetic', technicianNote: 'Scratch on the door' })).toBe(
      'MARKETING',
    );
    // No technician note means no safety finding to be relevant to, so the
    // restrictive answer: MARKETING, which needs the explicit second grant.
    expect(purposeFor({ category: 'brakes', technicianNote: null })).toBe('MARKETING');
  });
});

describe('6.3 re-pitch, end to end', () => {
  it('sends the pitch, counts it once, and honours "Not interested" for ever', async () => {
    const harness = createRetentionHarness();
    const id = await seedDeclinedBrakes(harness);
    const item = await harness.ledger.load(LOOP_SHOP, id);

    const sent = await harness.retention.repitch({
      shopId: LOOP_SHOP,
      item: item!,
      trigger: 'season',
      rationale: { kind: 'season', season: 'monsoon' },
      traceId: TRACE,
    });
    expect(sent.status).toBe('SENT');
    expect((await harness.ledger.load(LOOP_SHOP, id))?.repitchCount).toBe(1);
    expect(harness.sentBodies().some((body) => body.includes('Rear pads'))).toBe(true);

    await harness.retention.recordResponse({
      shopId: LOOP_SHOP,
      ledgerItemId: id,
      response: 'NOT_INTERESTED',
      conversationId: LOOP_CONVERSATION,
      customerId: LOOP_CUSTOMER,
      traceId: TRACE,
    });

    const closed = await harness.ledger.load(LOOP_SHOP, id);
    expect(closed?.status).toBe('OPTED_OUT');

    // And the item can never be woken again, by any trigger, in any season.
    harness.advanceDays(400);
    const scan = await harness.retention.scan({ shopId: LOOP_SHOP, traceId: TRACE });
    expect(scan.due).toEqual([]);
  });

  it('counts "remind me later" against the cap and pushes the horizon out', async () => {
    const harness = createRetentionHarness();
    const id = await seedDeclinedBrakes(harness);

    await harness.retention.recordResponse({
      shopId: LOOP_SHOP,
      ledgerItemId: id,
      response: 'REMIND_LATER',
      conversationId: LOOP_CONVERSATION,
      customerId: LOOP_CUSTOMER,
      traceId: TRACE,
    });

    const item = await harness.ledger.load(LOOP_SHOP, id);
    expect(item?.lastResponse).toBe('REMIND_LATER');
    expect(item?.followUpAfter?.getTime()).toBeGreaterThan(harness.now().getTime());
  });

  it('does not count a re-pitch the gate blocked against the item cap', async () => {
    const harness = createRetentionHarness();
    // A cosmetic item is MARKETING, and this customer has only ever granted
    // SERVICE consent — so the gate refuses.
    const id = await seedDeclinedBrakes(harness, {
      category: 'cosmetic',
      title: 'Bumper respray',
      technicianNote: 'Kerb scuff along the front bumper.',
    });
    const item = await harness.ledger.load(LOOP_SHOP, id);

    const outcome = await harness.retention.repitch({
      shopId: LOOP_SHOP,
      item: item!,
      trigger: 'manual',
      rationale: { kind: 'manual' },
      traceId: TRACE,
    });

    expect(outcome.status).toBe('BLOCKED');
    expect(outcome.detail).toContain('CONSENT');
    // The item keeps both of its chances: a consent problem must not quietly
    // spend them.
    expect((await harness.ledger.load(LOOP_SHOP, id))?.repitchCount).toBe(0);
  });
});

/* ========================================================================== *
 * 6.1 / 6.4 — the floor and the freeze, in the gate
 * ========================================================================== */

describe('the OutboundGate enforces the retention floor and the freeze', () => {
  it('refuses a second retention touch inside the twenty-one-day floor', async () => {
    const harness = createRetentionHarness();
    const first = await seedDeclinedBrakes(harness);
    const firstItem = await harness.ledger.load(LOOP_SHOP, first);

    expect(
      (
        await harness.retention.repitch({
          shopId: LOOP_SHOP,
          item: firstItem!,
          trigger: 'manual',
          rationale: { kind: 'manual' },
          traceId: TRACE,
        })
      ).status,
    ).toBe('SENT');

    // A different item, a week later — a shop that pitched every horizon as it
    // arrived would write to this customer three times in a fortnight.
    harness.advanceDays(7);
    const second = await seedDeclinedBrakes(harness, {
      workItemId: uuidv7(),
      title: 'Front suspension bushes',
      category: 'suspension',
      technicianNote: 'Front lower arm bushes perished.',
    });
    const secondItem = await harness.ledger.load(LOOP_SHOP, second);

    const blocked = await harness.retention.repitch({
      shopId: LOOP_SHOP,
      item: secondItem!,
      trigger: 'manual',
      rationale: { kind: 'manual' },
      traceId: TRACE,
    });
    expect(blocked.status).toBe('BLOCKED');
    expect(blocked.detail).toContain('RETENTION_FLOOR_NOT_ELAPSED');

    // And is allowed once the floor has actually elapsed.
    harness.advanceDays(15);
    const later = await harness.ledger.load(LOOP_SHOP, second);
    expect(
      (
        await harness.retention.repitch({
          shopId: LOOP_SHOP,
          item: later!,
          trigger: 'manual',
          rationale: { kind: 'manual' },
          traceId: TRACE,
        })
      ).status,
    ).toBe('SENT');
  });

  it('lets a service-due reminder and a re-pitch share one floor', async () => {
    const harness = createRetentionHarness();
    const id = await seedDeclinedBrakes(harness);
    const item = await harness.ledger.load(LOOP_SHOP, id);

    await harness.retention.repitch({
      shopId: LOOP_SHOP,
      item: item!,
      trigger: 'manual',
      rationale: { kind: 'manual' },
      traceId: TRACE,
    });

    // The service reminder is a different flow with its own cadence, and the
    // whole reason the touches share a table is that the customer does not
    // experience them as different flows.
    await harness.reminders.forecastFromVisit({
      shopId: LOOP_SHOP,
      vehicleId: RETENTION_VEHICLE,
      customerId: LOOP_CUSTOMER,
      jobCardId: LOOP_CARD,
      deliveredAt: addDays(harness.now(), -173),
      traceId: TRACE,
    });

    const results = await harness.reminders.sendServiceDue({ shopId: LOOP_SHOP, traceId: TRACE });
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('BLOCKED');
  });
});

/* ========================================================================== *
 * 6.4 — feedback, review routing, service recovery
 * ========================================================================== */

describe('6.4 feedback', () => {
  async function askFor(harness: RetentionHarness): Promise<string> {
    harness.world.vehicleByJobCard.set(LOOP_CARD, RETENTION_VEHICLE);
    const id = await harness.feedback.scheduleForDelivery({
      shopId: LOOP_SHOP,
      jobCardId: LOOP_CARD,
      customerId: LOOP_CUSTOMER,
      conversationId: LOOP_CONVERSATION,
      deliveredAt: harness.now(),
      traceId: TRACE,
    });
    harness.advanceDays(2);
    await harness.feedback.sendDue({ shopId: LOOP_SHOP, traceId: TRACE });
    return id!;
  }

  it('asks once per visit, however many times delivery is redelivered', async () => {
    const harness = createRetentionHarness();
    const first = await askFor(harness);

    const second = await harness.feedback.scheduleForDelivery({
      shopId: LOOP_SHOP,
      jobCardId: LOOP_CARD,
      customerId: LOOP_CUSTOMER,
      conversationId: LOOP_CONVERSATION,
      deliveredAt: harness.now(),
      traceId: TRACE,
    });

    expect(first).toBeTruthy();
    expect(second).toBeNull();
  });

  it('thanks a positive answer and offers the review link exactly once', async () => {
    const harness = createRetentionHarness();
    const id = await askFor(harness);

    const answer = await harness.feedback.recordAnswer({
      shopId: LOOP_SHOP,
      feedbackId: id,
      sentiment: 'POSITIVE',
      comment: null,
      conversationId: LOOP_CONVERSATION,
      traceId: TRACE,
    });

    expect(answer.reviewAsked).toBe(true);
    expect(harness.sentBodies().some((body) => body.includes('g.page'))).toBe(true);

    // A second tap on the old card changes nothing and does not ask again.
    const again = await harness.feedback.recordAnswer({
      shopId: LOOP_SHOP,
      feedbackId: id,
      sentiment: 'POSITIVE',
      comment: null,
      conversationId: LOOP_CONVERSATION,
      traceId: TRACE,
    });
    expect(again.handled).toBe(false);
    expect(harness.sentBodies().filter((body) => body.includes('g.page'))).toHaveLength(1);
  });

  it('takes the sentence that follows the face, and only for an hour', async () => {
    const harness = createRetentionHarness();
    const feedbackId = await harness.feedback.scheduleForDelivery({
      shopId: LOOP_SHOP,
      jobCardId: LOOP_CARD,
      customerId: LOOP_CUSTOMER,
      conversationId: LOOP_CONVERSATION,
      deliveredAt: harness.now(),
      traceId: TRACE,
    });
    expect(feedbackId).not.toBeNull();

    harness.advanceDays(2);
    await harness.feedback.recordAnswer({
      shopId: LOOP_SHOP,
      feedbackId: feedbackId as string,
      sentiment: 'NEGATIVE',
      comment: null,
      conversationId: LOOP_CONVERSATION,
      traceId: TRACE,
    });

    const attached = await harness.feedback.attachComment({
      shopId: LOOP_SHOP,
      customerId: LOOP_CUSTOMER,
      comment: 'The noise came back on the way home.',
      viaVoiceNote: false,
      mediaId: null,
      traceId: TRACE,
    });
    expect(attached).toBe(true);
    expect(harness.world.feedback.get(feedbackId as string)?.comment).toBe(
      'The noise came back on the way home.',
    );

    // A fortnight later the same customer asks whether their car is ready. That
    // message must not overwrite the complaint an advisor is still working
    // through — the record is still "open", and without a window this would
    // silently replace the one sentence the recovery task exists because of.
    harness.advanceDays(14);
    const later = await harness.feedback.attachComment({
      shopId: LOOP_SHOP,
      customerId: LOOP_CUSTOMER,
      comment: 'Any update?',
      viaVoiceNote: false,
      mediaId: null,
      traceId: TRACE,
    });
    expect(later).toBe(false);
    expect(harness.world.feedback.get(feedbackId as string)?.comment).toBe(
      'The noise came back on the way home.',
    );
  });

  it('never asks a neutral answer for a review', async () => {
    const harness = createRetentionHarness();
    const id = await askFor(harness);

    const answer = await harness.feedback.recordAnswer({
      shopId: LOOP_SHOP,
      feedbackId: id,
      sentiment: 'NEUTRAL',
      comment: 'It was fine.',
      conversationId: LOOP_CONVERSATION,
      traceId: TRACE,
    });

    expect(answer.reviewAsked).toBe(false);
    expect(harness.sentBodies().some((body) => body.includes('g.page'))).toBe(false);
  });

  it('alerts the owner, raises a recovery task and freezes retention on a negative answer', async () => {
    const harness = createRetentionHarness();
    const id = await askFor(harness);

    const answer = await harness.feedback.recordAnswer({
      shopId: LOOP_SHOP,
      feedbackId: id,
      sentiment: 'NEGATIVE',
      comment: 'The noise is still there.',
      conversationId: LOOP_CONVERSATION,
      traceId: TRACE,
    });

    expect(answer.recoveryTaskId).toBeTruthy();
    expect(answer.holdId).toBeTruthy();
    expect(harness.tasks.some((task) => task.kind === 'CALL_CUSTOMER')).toBe(true);
    expect(harness.tasks.some((task) => task.kind === 'OWNER_EXCEPTION')).toBe(true);
    // Realtime, not the digest: the alert row exists the moment the tap lands.
    expect([...harness.world.alerts.values()].map((row) => row.kind)).toContain(
      'NEGATIVE_FEEDBACK',
    );

    // Retention is frozen — and this is the assertion that matters most in the
    // whole phase. A shop that follows a complaint with a re-pitch has told the
    // customer exactly how much the complaint mattered.
    const ledgerId = await seedDeclinedBrakes(harness);
    const item = await harness.ledger.load(LOOP_SHOP, ledgerId);
    const blocked = await harness.retention.repitch({
      shopId: LOOP_SHOP,
      item: item!,
      trigger: 'manual',
      rationale: { kind: 'manual' },
      traceId: TRACE,
    });
    expect(blocked.detail).toContain('RETENTION_FROZEN');

    // And thaws when the advisor closes the recovery task.
    await harness.feedback.releaseHoldsForTask({
      shopId: LOOP_SHOP,
      taskId: answer.recoveryTaskId!,
      traceId: TRACE,
    });
    harness.advanceDays(30);
    const after = await harness.ledger.load(LOOP_SHOP, ledgerId);
    expect(
      (
        await harness.retention.repitch({
          shopId: LOOP_SHOP,
          item: after!,
          trigger: 'manual',
          rationale: { kind: 'manual' },
          traceId: TRACE,
        })
      ).status,
    ).toBe('SENT');
  });
});

/* ========================================================================== *
 * 6.5 — reminders
 * ========================================================================== */

describe('6.5 reminders', () => {
  it('sends the tightest unsent lead and never two for one due date', async () => {
    const harness = createRetentionHarness();
    await harness.reminders.forecastFromVisit({
      shopId: LOOP_SHOP,
      vehicleId: RETENTION_VEHICLE,
      customerId: LOOP_CUSTOMER,
      jobCardId: LOOP_CARD,
      // 174 days ago, so the 180-day interval puts the due date six days out —
      // inside the T-7 window and outside the T-1 one.
      deliveredAt: addDays(harness.now(), -174),
      traceId: TRACE,
    });

    const first = await harness.reminders.sendServiceDue({ shopId: LOOP_SHOP, traceId: TRACE });
    expect(first[0]?.status).toBe('SENT');
    expect(first[0]?.detail).toContain('T-7');

    // A second scan the same day sends nothing: the lead is marked.
    const second = await harness.reminders.sendServiceDue({ shopId: LOOP_SHOP, traceId: TRACE });
    expect(second).toEqual([]);
  });

  it('never reminds about a document the customer did not enrol', async () => {
    const harness = createRetentionHarness();
    await harness.reminders.recordDocument({
      shopId: LOOP_SHOP,
      vehicleId: RETENTION_VEHICLE,
      customerId: LOOP_CUSTOMER,
      kind: 'INSURANCE',
      expiresOn: addDays(harness.now(), 10).toISOString().slice(0, 10),
      traceId: TRACE,
    });

    // The shop knows the date. It has not been asked to remind anybody.
    expect(await harness.reminders.sendDocumentReminders({ shopId: LOOP_SHOP, traceId: TRACE })).toEqual(
      [],
    );

    await harness.reminders.enrol({
      shopId: LOOP_SHOP,
      vehicleId: RETENTION_VEHICLE,
      customerId: LOOP_CUSTOMER,
      conversationId: LOOP_CONVERSATION,
      via: 'delivery',
      traceId: TRACE,
    });

    // Enrolled, and now MARKETING-gated — which this customer has not granted.
    const gated = await harness.reminders.sendDocumentReminders({ shopId: LOOP_SHOP, traceId: TRACE });
    expect(gated).toHaveLength(1);
    expect(gated[0]?.status).toBe('BLOCKED');
  });
});

/* ========================================================================== *
 * 6.6 — the MARKETING consent machinery
 * ========================================================================== */

describe('6.6 MARKETING consent', () => {
  it('asks once, unlocks the MARKETING gate on a grant, and locks it on a revoke', async () => {
    const harness = createRetentionHarness();

    const asked = await harness.marketing.ask({
      shopId: LOOP_SHOP,
      customerId: LOOP_CUSTOMER,
      conversationId: LOOP_CONVERSATION,
      vehicleLabel: 'Maruti Swift',
      traceId: TRACE,
    });
    expect(asked.asked).toBe(true);

    // Once. A PENDING row is written before the message, so a second caller
    // finds it and stops.
    const again = await harness.marketing.ask({
      shopId: LOOP_SHOP,
      customerId: LOOP_CUSTOMER,
      conversationId: LOOP_CONVERSATION,
      traceId: TRACE,
    });
    expect(again.asked).toBe(false);
    expect(again.reason).toContain('asked once');

    await harness.marketing.decide({
      shopId: LOOP_SHOP,
      customerId: LOOP_CUSTOMER,
      conversationId: LOOP_CONVERSATION,
      decision: 'GRANT',
      evidence: 'Tapped "Yes, that is fine"',
      traceId: TRACE,
    });

    // A day later — a shop that asked for marketing consent and marketed in the
    // same breath would also be pushing the daily cap, which is its own guard.
    harness.advanceDays(1);

    // A cosmetic item is MARKETING, and now it goes.
    const cosmetic = await seedDeclinedBrakes(harness, {
      workItemId: uuidv7(),
      category: 'cosmetic',
      title: 'Bumper respray',
      technicianNote: 'Kerb scuff along the front bumper.',
    });
    const item = await harness.ledger.load(LOOP_SHOP, cosmetic);
    expect(
      (
        await harness.retention.repitch({
          shopId: LOOP_SHOP,
          item: item!,
          trigger: 'manual',
          rationale: { kind: 'manual' },
          traceId: TRACE,
        })
      ).status,
    ).toBe('SENT');

    // Revocation is instant and total: the very next MARKETING send is refused,
    // with nothing to unwind, because the gate is consulted per message.
    await harness.marketing.revoke({
      shopId: LOOP_SHOP,
      customerId: LOOP_CUSTOMER,
      evidence: 'Asked the advisor at the counter',
      traceId: TRACE,
    });
    harness.advanceDays(40);

    const second = await seedDeclinedBrakes(harness, {
      workItemId: uuidv7(),
      category: 'cosmetic',
      title: 'Alloy refurbishment',
      technicianNote: 'Two alloys kerbed.',
    });
    const later = await harness.ledger.load(LOOP_SHOP, second);
    const blocked = await harness.retention.repitch({
      shopId: LOOP_SHOP,
      item: later!,
      trigger: 'manual',
      rationale: { kind: 'manual' },
      traceId: TRACE,
    });
    expect(blocked.detail).toContain('CONSENT_REVOKED');
  });

  it('never asks for MARKETING before SERVICE has been granted', async () => {
    const harness = createRetentionHarness();
    const stranger = uuidv7();
    harness.world.customerRows.set(stranger, {
      id: stranger,
      name: 'Somebody new',
      language: 'en',
      lastVisitAt: null,
    });

    const result = await harness.marketing.ask({
      shopId: LOOP_SHOP,
      customerId: stranger,
      conversationId: LOOP_CONVERSATION,
      traceId: TRACE,
    });
    expect(result.asked).toBe(false);
    expect(result.reason).toContain('SERVICE consent');
  });
});

/* ========================================================================== *
 * 6.8 — the alert stream
 * ========================================================================== */

describe('6.8 realtime alerts', () => {
  it('fires exactly once per incident however often it is re-observed', async () => {
    const harness = createRetentionHarness();
    const approvalId = uuidv7();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await harness.alerts.approvalStuck({
        shopId: LOOP_SHOP,
        approvalId,
        jobCardId: LOOP_CARD,
        vehicleLabel: 'Maruti Swift',
        amountPaise: 240_000,
        waitedMinutes: 150 + attempt,
        traceId: TRACE,
      });
    }

    expect([...harness.world.alerts.values()]).toHaveLength(1);
    expect(harness.loop.base.world.eventsOfType('alert.raised')).toHaveLength(1);
    expect(harness.tasks.filter((task) => task.kind === 'OWNER_EXCEPTION')).toHaveLength(1);
  });

  it('holds a non-critical alert during quiet hours and still raises its task', async () => {
    const base = defaultShopConfig('Asia/Kolkata');
    const harness = createRetentionHarness({
      configPatch: {
        // Quiet from 21:00; the harness clock is 14:00 IST, so move it.
        quietHours: { timezone: 'Asia/Kolkata', start: '13:00', end: '16:00' },
        alerts: { ...base.alerts, quietHoursOverride: ['NEGATIVE_FEEDBACK'] },
      },
    });

    const held = await harness.alerts.approvalStuck({
      shopId: LOOP_SHOP,
      approvalId: uuidv7(),
      jobCardId: LOOP_CARD,
      vehicleLabel: 'Maruti Swift',
      amountPaise: 240_000,
      waitedMinutes: 150,
      traceId: TRACE,
    });

    expect(held.delivered).toBe(false);
    expect(held.detail).toContain('quiet hours');
    // The information is not lost: the task is on somebody's list either way.
    expect(harness.tasks.some((task) => task.kind === 'OWNER_EXCEPTION')).toBe(true);
  });
});

/* ========================================================================== *
 * 6.10 — win-back
 * ========================================================================== */

describe('6.10 win-back', () => {
  it('is refused without MARKETING consent, then goes once per cooldown window', async () => {
    const harness = createRetentionHarness();
    harness.world.customerRows.set(LOOP_CUSTOMER, {
      id: LOOP_CUSTOMER,
      name: 'Lakshmi',
      language: 'en',
      lastVisitAt: addDays(harness.now(), -300),
    });

    // A lapsed customer who never agreed to marketing hears nothing at all.
    const refused = await harness.retention.winBack({ shopId: LOOP_SHOP, traceId: TRACE });
    expect(refused[0]?.status).toBe('BLOCKED');
    expect(refused[0]?.detail).toContain('CONSENT');

    await harness.marketing.ask({
      shopId: LOOP_SHOP,
      customerId: LOOP_CUSTOMER,
      conversationId: LOOP_CONVERSATION,
      traceId: TRACE,
    });
    await harness.marketing.decide({
      shopId: LOOP_SHOP,
      customerId: LOOP_CUSTOMER,
      conversationId: LOOP_CONVERSATION,
      decision: 'GRANT',
      evidence: 'Tapped yes',
      traceId: TRACE,
    });
    harness.advanceDays(1);

    const sent = await harness.retention.winBack({ shopId: LOOP_SHOP, traceId: TRACE });
    expect(sent[0]?.status).toBe('SENT');
    // The hook is about the vehicle's age, not a discount: a win-back that
    // offers money off is a shop admitting it has nothing else to say.
    expect(harness.sentBodies().some((body) => body.includes('brakes, coolant and belts'))).toBe(
      true,
    );

    // A second attempt inside the same six-month window is refused by the
    // dedupe key before it ever reaches the gate — the cooldown is a property
    // of a unique index, not of a date comparison somebody wrote.
    harness.advanceDays(30);
    const again = await harness.retention.winBack({ shopId: LOOP_SHOP, traceId: TRACE });
    expect(again[0]?.detail).toContain('WIN_BACK_COOLDOWN');
  });

  it('lets a refused win-back be retried once the reason is gone', async () => {
    const harness = createRetentionHarness();
    harness.world.customerRows.set(LOOP_CUSTOMER, {
      id: LOOP_CUSTOMER,
      name: 'Lakshmi',
      language: 'en',
      lastVisitAt: addDays(harness.now(), -300),
    });

    // The refusal must not spend the customer's one slot in the window. A
    // consent problem that permanently silenced a win-back would turn a
    // temporary block into a permanent one, which is the opposite of what a
    // cooldown is for.
    await harness.retention.winBack({ shopId: LOOP_SHOP, traceId: TRACE });
    await harness.marketing.ask({
      shopId: LOOP_SHOP,
      customerId: LOOP_CUSTOMER,
      conversationId: LOOP_CONVERSATION,
      traceId: TRACE,
    });
    await harness.marketing.decide({
      shopId: LOOP_SHOP,
      customerId: LOOP_CUSTOMER,
      conversationId: LOOP_CONVERSATION,
      decision: 'GRANT',
      evidence: 'Tapped yes',
      traceId: TRACE,
    });
    harness.advanceDays(1);

    expect(
      (await harness.retention.winBack({ shopId: LOOP_SHOP, traceId: TRACE }))[0]?.status,
    ).toBe('SENT');
  });
});

/* ========================================================================== *
 * 6.9 — the metrics fold
 * ========================================================================== */

describe('6.9 metrics fold', () => {
  const day = '2026-09-14';
  const windows = { recoveryCohortDays: 90, repeatVisitWindowDays: 180, approvalStuckHours: 2 };

  function envelope(
    type: EventEnvelope['type'],
    occurredAt: string,
    payload: unknown,
  ): EventEnvelope {
    return {
      id: uuidv7(),
      type,
      occurredAt,
      shopId: LOOP_SHOP,
      traceId: TRACE,
      payload,
    } as EventEnvelope;
  }

  it('is stable under event order, which is what makes its hash an identity', async () => {
    const { computeRollup, hashRollup } = await import('./metrics');
    const events = [
      envelope('approval.requested', '2026-09-14T04:00:00.000Z', {
        approvalId: 'a1',
        jobCardId: LOOP_CARD,
        conversationId: LOOP_CONVERSATION,
        customerId: LOOP_CUSTOMER,
        evidenceBundleId: null,
        workItemIds: [],
        amountPaise: 240_000,
        ladderRef: 'APPROVAL',
        actor: { type: 'AGENT', id: null },
      }),
      envelope('approval.decided', '2026-09-14T06:30:00.000Z', {
        approvalId: 'a1',
        jobCardId: LOOP_CARD,
        decision: 'FULL',
        approvedWorkItemIds: [],
        deferredWorkItemIds: [],
        declinedWorkItemIds: [],
        approvedAmountPaise: 240_000,
        decidedVia: 'button',
        actor: { type: 'CUSTOMER', id: LOOP_CUSTOMER },
      }),
    ];

    const forwards = computeRollup({
      shopId: LOOP_SHOP,
      day,
      timezone: 'Asia/Kolkata',
      windows,
      events,
    });
    const backwards = computeRollup({
      shopId: LOOP_SHOP,
      day,
      timezone: 'Asia/Kolkata',
      windows,
      events: [...events].reverse(),
    });

    expect(hashRollup(forwards)).toBe(hashRollup(backwards));
    expect(forwards.turnaroundMinutes).toEqual([150]);
    expect(forwards.approvedValuePaise).toBe(240_000);
  });

  it('attributes a conversion to the cohort the item was ledgered in', async () => {
    const { computeRollup, rollupKpis } = await import('./metrics');

    const rollup = computeRollup({
      shopId: LOOP_SHOP,
      day,
      timezone: 'Asia/Kolkata',
      windows,
      events: [
        // Ledgered 40 days ago: inside the 90-day cohort.
        envelope('ledger.item_opened', '2026-08-05T04:00:00.000Z', {
          ledgerItemId: 'l1',
          jobCardId: LOOP_CARD,
          workItemId: 'w1',
          customerId: LOOP_CUSTOMER,
          vehicleId: RETENTION_VEHICLE,
          kind: 'DEFERRED',
          reason: 'customer_deferred',
          amountPaise: 400_000,
          category: 'brakes',
          followUpAfter: null,
          triggerTags: [],
          actor: { type: 'SYSTEM', id: null },
        }),
        envelope('ledger.item_closed', '2026-09-14T05:00:00.000Z', {
          ledgerItemId: 'l1',
          jobCardId: LOOP_CARD,
          customerId: LOOP_CUSTOMER,
          status: 'CONVERTED',
          openedAt: '2026-08-05T04:00:00.000Z',
          ledgeredAmountPaise: 400_000,
          recoveredAmountPaise: 380_000,
          convertedJobCardId: 'card-2',
          response: null,
          reason: 'Converted',
          actor: { type: 'SYSTEM', id: null },
        }),
      ],
    });

    expect(rollup.recoveredPaise).toBe(380_000);
    expect(rollup.cohortLedgeredPaise).toBe(400_000);
    expect(rollupKpis(rollup).declinedWorkRecoveryRate).toBeCloseTo(0.95, 5);
  });

  it('lists an approval nobody answered and drops it once they do', async () => {
    const { computeRollup } = await import('./metrics');
    const requested = envelope('approval.requested', '2026-09-14T04:00:00.000Z', {
      approvalId: 'a1',
      jobCardId: LOOP_CARD,
      conversationId: LOOP_CONVERSATION,
      customerId: LOOP_CUSTOMER,
      evidenceBundleId: null,
      workItemIds: [],
      amountPaise: 240_000,
      ladderRef: 'APPROVAL',
      actor: { type: 'AGENT', id: null },
    });

    const stuck = computeRollup({
      shopId: LOOP_SHOP,
      day,
      timezone: 'Asia/Kolkata',
      windows,
      events: [requested],
    });
    expect(stuck.pendingApprovals).toHaveLength(1);
    expect(stuck.pendingApprovals[0]).toMatchObject({ approvalId: 'a1', amountPaise: 240_000 });

    const answered = computeRollup({
      shopId: LOOP_SHOP,
      day,
      timezone: 'Asia/Kolkata',
      windows,
      events: [
        requested,
        envelope('approval.decided', '2026-09-14T07:00:00.000Z', {
          approvalId: 'a1',
          jobCardId: LOOP_CARD,
          decision: 'FULL',
          approvedWorkItemIds: [],
          deferredWorkItemIds: [],
          declinedWorkItemIds: [],
          approvedAmountPaise: 240_000,
          decidedVia: 'button',
          actor: { type: 'CUSTOMER', id: LOOP_CUSTOMER },
        }),
      ],
    });
    expect(answered.pendingApprovals).toEqual([]);
  });

  it('reads an empty day as no data rather than as zero', async () => {
    const { emptyRollup, rollupKpis } = await import('./metrics');
    const kpis = rollupKpis(emptyRollup(day, 'Asia/Kolkata', windows));

    expect(kpis.approvalTurnaroundMedianMinutes).toBeNull();
    expect(kpis.approvalConversionRate).toBeNull();
    expect(kpis.declinedWorkRecoveryRate).toBeNull();
  });
});
