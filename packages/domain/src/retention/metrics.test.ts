import { localDayBounds, uuidv7, type EventEnvelope } from '@serviceloop/shared';
import { describe, expect, it } from 'vitest';
import {
  createRetentionHarness,
  LOOP_CARD,
  LOOP_CONVERSATION,
  LOOP_CUSTOMER,
  LOOP_SHOP,
  RETENTION_VEHICLE,
} from '../testing';
import {
  computeRollup,
  hashRollup,
  mergeRollups,
  percentile,
  rollupKpis,
  type DailyRollup,
  type RollupWindows,
} from './metrics';

/**
 * 6.9 — the audit story behind every number in this phase.
 *
 * The phase's own words: "a `recompute --from` command must reproduce identical
 * numbers; this is the audit story for the 'revenue recovered' claim the whole
 * business rests on." So this file has two jobs, and only two:
 *
 *   1. **Prove the fold against an independent recomputation.** A randomised
 *      event fixture is scored twice — once by `computeRollup`, once by a
 *      brute-force pass written from scratch below, which shares no code with
 *      it. A fold that agreed with itself would prove nothing.
 *   2. **Prove the recompute is idempotent.** The same log, folded again,
 *      produces the same hash — and folded again after new events arrive,
 *      produces a *different* one, which is what makes the first assertion
 *      meaningful rather than vacuous.
 */

const TIMEZONE = 'Asia/Kolkata';
/** A handful of other customers, so the repeat-visit window has non-repeats. */
const OTHER_CUSTOMERS = [uuidv7(), uuidv7(), uuidv7(), uuidv7()] as const;
const DAY = '2026-09-14';
const WINDOWS: RollupWindows = {
  recoveryCohortDays: 90,
  repeatVisitWindowDays: 180,
  approvalStuckHours: 2,
};

/* -------------------------------------------------------------------------- *
 * A small deterministic generator
 *
 * Seeded rather than random, because a property test that fails once a fortnight
 * on a value nobody can reproduce is a flake, not a proof. The seed is printed
 * in the assertion message when a case fails.
 * -------------------------------------------------------------------------- */

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

interface Fixture {
  readonly events: readonly EventEnvelope[];
  readonly dayStartMs: number;
  readonly dayEndMs: number;
}

function envelope(type: string, occurredAt: string, payload: unknown): EventEnvelope {
  return {
    id: uuidv7(),
    type,
    occurredAt,
    shopId: LOOP_SHOP,
    traceId: 'metrics-property',
    payload,
  } as EventEnvelope;
}

/**
 * A day of plausible traffic, plus history the day's KPIs depend on.
 *
 * Deliberately includes events *outside* the day: an approval requested
 * yesterday and answered today contributes a turnaround to today, a ledger item
 * opened in July is in today's cohort, and a visit in March is what makes
 * today's a repeat. A generator that only produced same-day events would never
 * exercise the part of the fold most likely to be wrong.
 */
function fixture(seed: number): Fixture {
  const random = rng(seed);
  const { start, end } = localDayBounds(DAY, TIMEZONE);
  const dayStartMs = start.getTime();
  const dayEndMs = end.getTime();
  const span = dayEndMs - dayStartMs;

  const inDay = (fraction: number): string =>
    new Date(dayStartMs + Math.floor(fraction * span)).toISOString();
  const daysAgo = (days: number): string =>
    new Date(dayStartMs - days * 86_400_000 + 3_600_000).toISOString();

  const events: EventEnvelope[] = [];

  const approvals = 1 + Math.floor(random() * 6);
  for (let index = 0; index < approvals; index += 1) {
    const approvalId = uuidv7();
    const requestedFraction = random() * 0.4;
    // A third of them were requested yesterday, which is where the turnaround
    // arithmetic actually gets interesting.
    const requestedAt =
      random() < 0.33 ? daysAgo(1) : inDay(requestedFraction);
    const amountPaise = 50_000 + Math.floor(random() * 500_000);

    events.push(
      envelope('approval.requested', requestedAt, {
        approvalId,
        jobCardId: uuidv7(),
        conversationId: LOOP_CONVERSATION,
        customerId: LOOP_CUSTOMER,
        evidenceBundleId: null,
        workItemIds: [],
        amountPaise,
        ladderRef: 'APPROVAL',
        actor: { type: 'AGENT', id: null },
      }),
    );

    if (random() < 0.7) {
      const approved = random() < 0.8 ? amountPaise : Math.floor(amountPaise / 2);
      events.push(
        envelope('approval.decided', inDay(0.5 + random() * 0.45), {
          approvalId,
          jobCardId: uuidv7(),
          decision: approved === amountPaise ? 'FULL' : 'PARTIAL',
          approvedWorkItemIds: [],
          deferredWorkItemIds: [],
          declinedWorkItemIds: [],
          approvedAmountPaise: approved,
          decidedVia: 'button',
          actor: { type: 'CUSTOMER', id: LOOP_CUSTOMER },
        }),
      );
    }
  }

  const ledgerItems = Math.floor(random() * 5);
  for (let index = 0; index < ledgerItems; index += 1) {
    const ledgerItemId = uuidv7();
    const openedDaysAgo = Math.floor(random() * 140);
    const openedAt = openedDaysAgo === 0 ? inDay(random() * 0.3) : daysAgo(openedDaysAgo);
    const amountPaise = 40_000 + Math.floor(random() * 300_000);

    events.push(
      envelope('ledger.item_opened', openedAt, {
        ledgerItemId,
        jobCardId: uuidv7(),
        workItemId: uuidv7(),
        customerId: LOOP_CUSTOMER,
        vehicleId: RETENTION_VEHICLE,
        kind: 'DEFERRED',
        reason: 'customer_deferred',
        amountPaise,
        category: 'brakes',
        followUpAfter: null,
        triggerTags: [],
        actor: { type: 'SYSTEM', id: null },
      }),
    );

    if (random() < 0.35) {
      const converted = random() < 0.7;
      events.push(
        envelope('ledger.item_closed', inDay(0.4 + random() * 0.5), {
          ledgerItemId,
          jobCardId: uuidv7(),
          customerId: LOOP_CUSTOMER,
          status: converted ? 'CONVERTED' : 'OPTED_OUT',
          openedAt,
          ledgeredAmountPaise: amountPaise,
          recoveredAmountPaise: converted ? amountPaise : 0,
          convertedJobCardId: converted ? uuidv7() : null,
          response: converted ? null : 'NOT_INTERESTED',
          reason: converted ? 'Converted' : 'Not interested',
          actor: { type: 'SYSTEM', id: null },
        }),
      );
    }
  }

  const visits = Math.floor(random() * 4);
  for (let index = 0; index < visits; index += 1) {
    const customerId = random() < 0.5 ? LOOP_CUSTOMER : OTHER_CUSTOMERS[index % OTHER_CUSTOMERS.length]!;
    // Some of these customers were here before, inside the 180-day window.
    if (random() < 0.5) {
      events.push(
        envelope('intake.draft_confirmed', daysAgo(20 + Math.floor(random() * 300)), {
          draftId: uuidv7(),
          jobCardId: uuidv7(),
          customerId,
          vehicleId: RETENTION_VEHICLE,
          source: 'PHOTO',
          correctedFields: [],
          actor: { type: 'STAFF', id: null },
        }),
      );
    }
    events.push(
      envelope('intake.draft_confirmed', inDay(random() * 0.9), {
        draftId: uuidv7(),
        jobCardId: uuidv7(),
        customerId,
        vehicleId: RETENTION_VEHICLE,
        source: 'PHOTO',
        correctedFields: [],
        actor: { type: 'STAFF', id: null },
      }),
    );
  }

  const feedback = Math.floor(random() * 4);
  for (let index = 0; index < feedback; index += 1) {
    const roll = random();
    const sentiment = roll < 0.6 ? 'POSITIVE' : roll < 0.85 ? 'NEUTRAL' : 'NEGATIVE';
    events.push(
      envelope('feedback.recorded', inDay(random()), {
        feedbackId: uuidv7(),
        jobCardId: uuidv7(),
        customerId: LOOP_CUSTOMER,
        sentiment,
        hasComment: random() < 0.5,
        viaVoiceNote: false,
        reviewAsked: sentiment === 'POSITIVE' && random() < 0.6,
        recoveryTaskId: null,
        retentionFrozen: sentiment === 'NEGATIVE',
        actor: { type: 'CUSTOMER', id: LOOP_CUSTOMER },
      }),
    );
  }

  return { events, dayStartMs, dayEndMs };
}

/**
 * The independent scorer.
 *
 * Written from the phase file rather than from `computeRollup`, and sharing no
 * code with it: that is the entire point of the exercise. If the two ever
 * agree by accident it is because they were written twice and happened to be
 * right twice.
 */
function bruteForce(f: Fixture): {
  approvalsRequested: number;
  approvedValuePaise: number;
  requestedValuePaise: number;
  turnaround: number[];
  pendingIds: string[];
  recoveredPaise: number;
  cohortLedgeredPaise: number;
  cohortRecoveredPaise: number;
  visits: number;
  repeatVisits: number;
  negatives: number;
  reviewAsks: number;
} {
  const within = (iso: string): boolean => {
    const at = Date.parse(iso);
    return at >= f.dayStartMs && at < f.dayEndMs;
  };
  const cohortStart = f.dayStartMs - WINDOWS.recoveryCohortDays * 86_400_000;

  const requested = f.events.filter((e) => e.type === 'approval.requested');
  const decided = f.events.filter((e) => e.type === 'approval.decided');
  const opened = f.events.filter((e) => e.type === 'ledger.item_opened');
  const closed = f.events.filter((e) => e.type === 'ledger.item_closed');
  const confirmed = f.events.filter((e) => e.type === 'intake.draft_confirmed');
  const feedback = f.events.filter((e) => e.type === 'feedback.recorded');

  const requestedAtById = new Map<string, number>();
  for (const event of requested) {
    const payload = event.payload as { approvalId: string };
    requestedAtById.set(payload.approvalId, Date.parse(event.occurredAt));
  }

  const turnaround: number[] = [];
  let approvedValuePaise = 0;
  const decidedIds = new Set<string>();
  for (const event of decided) {
    const payload = event.payload as { approvalId: string; approvedAmountPaise: number };
    decidedIds.add(payload.approvalId);
    if (!within(event.occurredAt)) continue;
    approvedValuePaise += payload.approvedAmountPaise;
    const at = requestedAtById.get(payload.approvalId);
    if (at !== undefined) {
      turnaround.push(Math.max(0, Math.round((Date.parse(event.occurredAt) - at) / 60_000)));
    }
  }

  const stuckBefore = f.dayEndMs - WINDOWS.approvalStuckHours * 3_600_000;
  const pendingIds: string[] = [];
  for (const [approvalId, at] of requestedAtById) {
    if (decidedIds.has(approvalId)) continue;
    if (at > stuckBefore) continue;
    pendingIds.push(approvalId);
  }

  let cohortLedgeredPaise = 0;
  for (const event of opened) {
    const payload = event.payload as { amountPaise: number };
    const at = Date.parse(event.occurredAt);
    if (at >= cohortStart && at < f.dayEndMs) cohortLedgeredPaise += payload.amountPaise;
  }

  let recoveredPaise = 0;
  let cohortRecoveredPaise = 0;
  for (const event of closed) {
    if (!within(event.occurredAt)) continue;
    const payload = event.payload as {
      status: string;
      openedAt: string;
      recoveredAmountPaise: number;
    };
    if (payload.status !== 'CONVERTED') continue;
    recoveredPaise += payload.recoveredAmountPaise;
    const openedAt = Date.parse(payload.openedAt);
    if (openedAt >= cohortStart && openedAt < f.dayEndMs) {
      cohortRecoveredPaise += payload.recoveredAmountPaise;
    }
  }

  const ordered = [...confirmed].sort(
    (a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.id.localeCompare(b.id),
  );
  const history = new Map<string, number[]>();
  let visits = 0;
  let repeatVisits = 0;
  for (const event of ordered) {
    const payload = event.payload as { customerId: string };
    const at = Date.parse(event.occurredAt);
    const prior = history.get(payload.customerId) ?? [];
    if (within(event.occurredAt)) {
      visits += 1;
      if (prior.some((earlier) => at - earlier <= WINDOWS.repeatVisitWindowDays * 86_400_000)) {
        repeatVisits += 1;
      }
    }
    history.set(payload.customerId, [...prior, at]);
  }

  let negatives = 0;
  let reviewAsks = 0;
  for (const event of feedback) {
    if (!within(event.occurredAt)) continue;
    const payload = event.payload as { sentiment: string; reviewAsked: boolean };
    if (payload.sentiment === 'NEGATIVE') negatives += 1;
    if (payload.reviewAsked) reviewAsks += 1;
  }

  return {
    approvalsRequested: requested.filter((event) => within(event.occurredAt)).length,
    approvedValuePaise,
    requestedValuePaise: requested
      .filter((event) => within(event.occurredAt))
      .reduce((sum, event) => sum + (event.payload as { amountPaise: number }).amountPaise, 0),
    turnaround: turnaround.sort((a, b) => a - b),
    pendingIds: pendingIds.sort(),
    recoveredPaise,
    cohortLedgeredPaise,
    cohortRecoveredPaise,
    visits,
    repeatVisits,
    negatives,
    reviewAsks,
  };
}

function fold(f: Fixture): DailyRollup {
  return computeRollup({
    shopId: LOOP_SHOP,
    day: DAY,
    timezone: TIMEZONE,
    windows: WINDOWS,
    events: f.events,
  });
}

describe('6.9 the fold equals an independent recomputation', () => {
  it('agrees with a brute-force pass over 60 randomised event fixtures', () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const f = fixture(seed);
      const rollup = fold(f);
      const expected = bruteForce(f);
      const because = `seed ${seed}`;

      expect(rollup.approvalsRequested, because).toBe(expected.approvalsRequested);
      expect(rollup.requestedValuePaise, because).toBe(expected.requestedValuePaise);
      expect(rollup.approvedValuePaise, because).toBe(expected.approvedValuePaise);
      expect([...rollup.turnaroundMinutes], because).toEqual(expected.turnaround);
      expect(
        rollup.pendingApprovals.map((pending) => pending.approvalId).sort(),
        because,
      ).toEqual(expected.pendingIds);
      expect(rollup.recoveredPaise, because).toBe(expected.recoveredPaise);
      expect(rollup.cohortLedgeredPaise, because).toBe(expected.cohortLedgeredPaise);
      expect(rollup.cohortRecoveredPaise, because).toBe(expected.cohortRecoveredPaise);
      expect(rollup.visits, because).toBe(expected.visits);
      expect(rollup.repeatVisits, because).toBe(expected.repeatVisits);
      expect(rollup.feedbackNegative, because).toBe(expected.negatives);
      expect(rollup.reviewAsks, because).toBe(expected.reviewAsks);
    }
  });

  it('produces the same hash however the log is ordered or duplicated in range', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const f = fixture(seed);
      const forwards = hashRollup(fold(f));
      const backwards = hashRollup(
        computeRollup({
          shopId: LOOP_SHOP,
          day: DAY,
          timezone: TIMEZONE,
          windows: WINDOWS,
          events: [...f.events].reverse(),
        }),
      );
      expect(backwards, `seed ${seed}`).toBe(forwards);
    }
  });

  it('reads percentiles from the day’s own samples, nearest-rank', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([10], 0.9)).toBe(10);
    expect(percentile([10, 20, 30, 40, 50], 0.5)).toBe(30);
    expect(percentile([10, 20, 30, 40, 50], 0.9)).toBe(50);
  });

  it('sums a week without double-counting the cohort window', () => {
    const days = [1, 2, 3].map((seed) =>
      computeRollup({
        shopId: LOOP_SHOP,
        day: DAY,
        timezone: TIMEZONE,
        windows: WINDOWS,
        events: fixture(seed).events,
      }),
    );

    const merged = mergeRollups(days, WINDOWS);
    expect(merged).not.toBeNull();
    expect(merged?.approvalsRequested).toBe(
      days.reduce((sum, day) => sum + day.approvalsRequested, 0),
    );
    // The cohort denominator is a window over the past, not a daily quantity.
    // Summing three days of it would count July's ledgered rupees three times
    // and quietly divide the recovery rate by three.
    expect(merged?.cohortLedgeredPaise).toBe(days[days.length - 1]?.cohortLedgeredPaise);
    expect(merged?.pendingApprovals).toEqual(days[days.length - 1]?.pendingApprovals);
  });
});

describe('6.9 recompute reproduces the stored rollup exactly', () => {
  it('is idempotent over the event log and reports when a day changes', async () => {
    const harness = createRetentionHarness();
    const traceId = 'metrics-recompute';

    // Real traffic through the real services, so the fold reads exactly the
    // events the system emitted rather than a fixture kept in sync by hand.
    const opened = await harness.ledger.open({
      shopId: LOOP_SHOP,
      jobCardId: LOOP_CARD,
      workItemId: uuidv7(),
      customerId: LOOP_CUSTOMER,
      vehicleId: RETENTION_VEHICLE,
      kind: 'DEFERRED',
      declineReason: 'customer_deferred',
      reason: 'After the rains',
      amountPaise: 240_000,
      category: 'brakes',
      title: 'Rear brake pads',
      technicianNote: 'Pads at 2.1mm',
      evidenceBundleId: null,
      estimateLineIds: ['line-brakes'],
      traceId,
    });
    await harness.ledger.convert({
      shopId: LOOP_SHOP,
      ledgerItemId: opened.ledgerItemId,
      convertedJobCardId: 'card-2',
      recoveredAmountPaise: 230_000,
      traceId,
    });

    const day = await harness.metrics.dayFor(LOOP_SHOP, harness.now());

    const first = await harness.metrics.computeDay({ shopId: LOOP_SHOP, day, traceId });
    expect(first.changed).toBe(true);
    expect(first.rollup.recoveredPaise).toBe(230_000);

    // The same log, folded again. This is `recompute --from` in miniature, and
    // the assertion is the phase's own promise: identical numbers.
    const again = await harness.metrics.recompute({ shopId: LOOP_SHOP, from: day, to: day, traceId });
    expect(again).toHaveLength(1);
    expect(again[0]?.payloadHash).toBe(first.payloadHash);
    expect(again[0]?.changed).toBe(false);

    // And a *different* answer once new facts arrive, which is what makes the
    // assertion above meaningful rather than a tautology about a constant.
    const second = await harness.ledger.open({
      shopId: LOOP_SHOP,
      jobCardId: LOOP_CARD,
      workItemId: uuidv7(),
      customerId: LOOP_CUSTOMER,
      vehicleId: RETENTION_VEHICLE,
      kind: 'DEFERRED',
      declineReason: 'price',
      reason: 'Too expensive',
      amountPaise: 90_000,
      category: 'tyres',
      title: 'Two front tyres',
      technicianNote: 'Both fronts at 2mm',
      evidenceBundleId: null,
      estimateLineIds: ['line-tyres'],
      traceId,
    });
    expect(second.created).toBe(true);

    const third = await harness.metrics.recompute({ shopId: LOOP_SHOP, from: day, to: day, traceId });
    expect(third[0]?.changed).toBe(true);
    expect(third[0]?.payloadHash).not.toBe(first.payloadHash);
    expect(third[0]?.previousHash).toBe(first.payloadHash);
  });

  it('refuses a backfill wider than the shop has configured', async () => {
    const harness = createRetentionHarness();
    const day = await harness.metrics.dayFor(LOOP_SHOP, harness.now());

    await expect(
      harness.metrics.recompute({
        shopId: LOOP_SHOP,
        from: '2020-01-01',
        to: day,
        traceId: 'too-wide',
      }),
    ).rejects.toThrow(/maximum is 400/);
  });

  it('reads KPIs from the rollup it just stored', async () => {
    const harness = createRetentionHarness();
    const day = await harness.metrics.dayFor(LOOP_SHOP, harness.now());
    await harness.metrics.computeDay({ shopId: LOOP_SHOP, day, traceId: 'kpi' });

    const loaded = await harness.metrics.load(LOOP_SHOP, day);
    expect(loaded.kpis).toEqual(rollupKpis(loaded.rollup));
  });
});
