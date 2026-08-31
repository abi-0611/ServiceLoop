import { defaultShopConfig, type ShopConfig } from '@serviceloop/config';
import {
  addWorkingMinutes,
  crossesLocalDay,
  fixedClock,
  instantFromZonedParts,
  nextWorkingInstant,
  workingMinutesBetween,
  type WorkingWindow,
} from '@serviceloop/shared';
import { describe, expect, it } from 'vitest';
import {
  classifyEtaChange,
  computeEta,
  isCommitted,
  minutesFor,
  requiresImmediateNotice,
  type EtaWorkItem,
} from './eta-rules';
import { describeChange, toEtaWorkItems } from './eta-service';
import {
  AUTO_APPLY_CONFIDENCE,
  registrationMatches,
  resolveCard,
  shouldAutoApply,
} from './card-matching';
import { cardEventFor, decideRoute, etaReasonFor, resolveWorkItems, titleMatches } from './status-signal-service';
import { isActiveForSilence, truncateToWindow } from './silent-bay';
import { candidateCard } from '../testing/in-memory-status';
import type { JobCardContext } from '../agent/ports';
import type { ParsedStatusSignal } from './types';

/**
 * Phase 4 status-sentinel rules.
 *
 * Everything here is a pure function, so every case is a table row. That is the
 * point of having built the ETA engine as a rules table rather than a
 * prediction: the acceptance gate asks for "table-driven recalc tests", and a
 * model would have made that impossible to write.
 */

const IST = 'Asia/Kolkata';
const HOURS: WorkingWindow = { days: [1, 2, 3, 4, 5, 6], open: '09:00', close: '19:00' };

/** A local wall-clock reading in IST, as an instant. */
function ist(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return instantFromZonedParts({ year, month, day, hour, minute }, IST);
}

const config: ShopConfig = defaultShopConfig(IST);

function item(partial: Partial<EtaWorkItem> & { id: string }): EtaWorkItem {
  return {
    state: 'APPROVED',
    estimatedMinutes: null,
    lineKind: 'LABOUR',
    ...partial,
  };
}

/* -------------------------------------------------------------------------- *
 * Working-hours arithmetic — everything else stands on this
 * -------------------------------------------------------------------------- */

describe('working-hours arithmetic', () => {
  it('round-trips a local reading through instantFromZonedParts', () => {
    // 2026-08-17 is a Monday.
    const at = ist(2026, 8, 17, 14, 30);
    expect(nextWorkingInstant(at, IST, HOURS).getTime()).toBe(at.getTime());
  });

  it.each([
    // [label, from, minutes, expected]
    ['inside one day', ist(2026, 8, 17, 10, 0), 120, ist(2026, 8, 17, 12, 0)],
    ['spills to the next morning', ist(2026, 8, 17, 18, 0), 120, ist(2026, 8, 18, 10, 0)],
    ['starts out of hours', ist(2026, 8, 17, 6, 0), 60, ist(2026, 8, 17, 10, 0)],
    ['skips Sunday', ist(2026, 8, 22, 18, 0), 120, ist(2026, 8, 24, 10, 0)],
    ['zero normalises into hours', ist(2026, 8, 17, 22, 0), 0, ist(2026, 8, 18, 9, 0)],
  ])('addWorkingMinutes %s', (_label, from, minutes, expected) => {
    expect(addWorkingMinutes(from, IST, HOURS, minutes).toISOString()).toBe(expected.toISOString());
  });

  it('counts only shop-floor minutes across a closed weekend', () => {
    // Saturday 18:50 → Monday 09:10. Ten minutes on Saturday, ten on Monday.
    const from = ist(2026, 8, 22, 18, 50);
    const to = ist(2026, 8, 24, 9, 10);
    expect(workingMinutesBetween(from, to, IST, HOURS)).toBe(20);
  });

  it('does not count a whole weekend as silence', () => {
    const wallClockHours =
      (ist(2026, 8, 24, 9, 10).getTime() - ist(2026, 8, 22, 18, 50).getTime()) / 3_600_000;
    expect(wallClockHours).toBeGreaterThan(38);
    // The whole point: 38 hours of wall clock is 20 minutes of shop time.
    expect(workingMinutesBetween(ist(2026, 8, 22, 18, 50), ist(2026, 8, 24, 9, 10), IST, HOURS)).toBe(
      20,
    );
  });
});

/* -------------------------------------------------------------------------- *
 * 4.3 — the ETA rules table
 * -------------------------------------------------------------------------- */

describe('computeEta', () => {
  it('counts only work the customer has committed to', () => {
    const items = [
      item({ id: 'a', state: 'APPROVED', estimatedMinutes: 60 }),
      item({ id: 'b', state: 'IN_PROGRESS', estimatedMinutes: 30 }),
      // Neither of these has been paid for, so neither is time the shop owes.
      item({ id: 'c', state: 'PENDING_APPROVAL', estimatedMinutes: 240 }),
      item({ id: 'd', state: 'DECLINED', estimatedMinutes: 240 }),
      item({ id: 'e', state: 'DONE', estimatedMinutes: 240 }),
    ];
    expect(items.filter(isCommitted).map((entry) => entry.id)).toEqual(['a', 'b']);

    const result = computeEta({
      from: ist(2026, 8, 17, 10, 0),
      timezone: IST,
      workingHours: HOURS,
      config: config.eta,
      workItems: items,
      reason: 'WORK_APPROVED',
      includeQualityCheck: false,
    });

    // 90 minutes of labour + 20% buffer = 108.
    expect(result.remainingMinutes).toBe(108);
    expect(result.countedWorkItemIds).toEqual(['a', 'b']);
    expect(result.eta.toISOString()).toBe(ist(2026, 8, 17, 11, 48).toISOString());
  });

  it('falls back to the per-kind default when an item carries no estimate', () => {
    expect(minutesFor(item({ id: 'a', lineKind: 'LABOUR' }), config.eta)).toBe(60);
    expect(minutesFor(item({ id: 'a', lineKind: 'PART' }), config.eta)).toBe(30);
    expect(minutesFor(item({ id: 'a', lineKind: 'CONSUMABLE' }), config.eta)).toBe(10);
    expect(minutesFor(item({ id: 'a', lineKind: 'FEE' }), config.eta)).toBe(0);
    // An item with no estimate line at all is labour — work somebody does by hand.
    expect(minutesFor(item({ id: 'a', lineKind: null }), config.eta)).toBe(60);
  });

  it('adds the quality check exactly once, and only before the work is done', () => {
    const items = [item({ id: 'a', estimatedMinutes: 60 })];
    const withCheck = computeEta({
      from: ist(2026, 8, 17, 10, 0),
      timezone: IST,
      workingHours: HOURS,
      config: config.eta,
      workItems: items,
      reason: 'WORK_APPROVED',
      includeQualityCheck: true,
    });
    const without = computeEta({
      from: ist(2026, 8, 17, 10, 0),
      timezone: IST,
      workingHours: HOURS,
      config: config.eta,
      workItems: items,
      reason: 'WORK_APPROVED',
      includeQualityCheck: false,
    });

    // (60 + 30) × 1.2 = 108 versus 60 × 1.2 = 72.
    expect(withCheck.remainingMinutes).toBe(108);
    expect(without.remainingMinutes).toBe(72);
  });

  it('adds the parts lead time in wall-clock hours but fits during working hours', () => {
    const result = computeEta({
      from: ist(2026, 8, 17, 16, 0),
      timezone: IST,
      workingHours: HOURS,
      config: config.eta,
      workItems: [item({ id: 'a', estimatedMinutes: 60 })],
      reason: 'BLOCKED_PARTS',
      includeQualityCheck: false,
    });

    // 36 hours from Monday 16:00 is Wednesday 04:00 — a courier does not wait
    // for opening time, but the fitting does.
    expect(result.startsAt.toISOString()).toBe(ist(2026, 8, 19, 9, 0).toISOString());
    expect(result.eta.toISOString()).toBe(ist(2026, 8, 19, 10, 12).toISOString());
  });

  it("trusts the technician's own time over the configured lead", () => {
    const result = computeEta({
      from: ist(2026, 8, 17, 11, 0),
      timezone: IST,
      workingHours: HOURS,
      config: config.eta,
      workItems: [item({ id: 'a', estimatedMinutes: 60 })],
      reason: 'BLOCKED_PARTS',
      // "part varum 4 maniku" — they have spoken to the parts shop.
      partsAvailableAt: ist(2026, 8, 17, 16, 0),
      includeQualityCheck: false,
    });

    expect(result.startsAt.toISOString()).toBe(ist(2026, 8, 17, 16, 0).toISOString());
    expect(result.eta.toISOString()).toBe(ist(2026, 8, 17, 17, 12).toISOString());
  });

  it('pulls earlier when the work is finished ahead of time', () => {
    const result = computeEta({
      from: ist(2026, 8, 17, 11, 0),
      timezone: IST,
      workingHours: HOURS,
      config: config.eta,
      workItems: [item({ id: 'a', state: 'DONE', estimatedMinutes: 240 })],
      reason: 'WORK_DONE',
      includeQualityCheck: true,
    });

    // Nothing left but the check: 30 × 1.2 = 36 minutes.
    expect(result.remainingMinutes).toBe(36);
    expect(result.eta.toISOString()).toBe(ist(2026, 8, 17, 11, 36).toISOString());
  });
});

describe('classifyEtaChange', () => {
  const threshold = config.eta.materialSlipMinutes;

  it.each([
    ['a 20-minute slip is not worth interrupting anyone', 20, 'IMMATERIAL'],
    ['a 46-minute slip is', 46, 'MATERIAL_SLIP'],
    ['exactly the threshold is not', threshold, 'IMMATERIAL'],
    ['a 20-minute gain is not', -20, 'IMMATERIAL'],
    ['a 90-minute gain is good news worth sending', -90, 'MATERIAL_GAIN'],
  ] as const)('%s', (_label, deltaMinutes, expected) => {
    const previous = ist(2026, 8, 17, 15, 0);
    const verdict = classifyEtaChange({
      previousEta: previous,
      newEta: new Date(previous.getTime() + deltaMinutes * 60_000),
      promisedAt: previous,
      timezone: IST,
      thresholdMinutes: threshold,
    });
    expect(verdict.materiality).toBe(expected);
    expect(verdict.deltaMinutes).toBe(deltaMinutes);
  });

  it('treats crossing the promised day as material however small the slip', () => {
    // 23:50 → 00:10 is twenty minutes and a different day.
    const promised = ist(2026, 8, 17, 23, 50);
    const verdict = classifyEtaChange({
      previousEta: promised,
      newEta: ist(2026, 8, 18, 0, 10),
      promisedAt: promised,
      timezone: IST,
      thresholdMinutes: threshold,
    });

    expect(verdict.deltaMinutes).toBe(20);
    expect(verdict.crossesPromisedDay).toBe(true);
    expect(verdict.materiality).toBe('MATERIAL_SLIP');
  });

  it('says the car will miss the day once, not on every subsequent nudge', () => {
    const promised = ist(2026, 8, 17, 17, 0);
    const alreadyLate = ist(2026, 8, 18, 11, 0);

    const second = classifyEtaChange({
      previousEta: alreadyLate,
      newEta: ist(2026, 8, 18, 11, 20),
      promisedAt: promised,
      timezone: IST,
      thresholdMinutes: threshold,
    });

    expect(second.crossesPromisedDay).toBe(false);
    expect(second.materiality).toBe('IMMATERIAL');
  });

  it('compares against the counter promise when there is no previous ETA', () => {
    const promised = ist(2026, 8, 17, 15, 0);
    const verdict = classifyEtaChange({
      previousEta: null,
      newEta: ist(2026, 8, 17, 17, 0),
      promisedAt: promised,
      timezone: IST,
      thresholdMinutes: threshold,
    });
    expect(verdict.materiality).toBe('MATERIAL_SLIP');
    expect(verdict.deltaMinutes).toBe(120);
  });

  it('is immaterial when there is nothing at all to compare against', () => {
    const verdict = classifyEtaChange({
      previousEta: null,
      newEta: ist(2026, 8, 17, 17, 0),
      promisedAt: null,
      timezone: IST,
      thresholdMinutes: threshold,
    });
    expect(verdict.materiality).toBe('IMMATERIAL');
  });
});

describe('requiresImmediateNotice — bad news early', () => {
  it('always sends a parts delay, even when the slip is small', () => {
    expect(requiresImmediateNotice('BLOCKED_PARTS', 'IMMATERIAL')).toBe(true);
  });

  it('sends every material slip', () => {
    expect(requiresImmediateNotice('WORK_APPROVED', 'MATERIAL_SLIP')).toBe(true);
  });

  it('lets good news and immaterial changes ride the next touchpoint', () => {
    expect(requiresImmediateNotice('WORK_DONE', 'MATERIAL_GAIN')).toBe(false);
    expect(requiresImmediateNotice('WORK_APPROVED', 'IMMATERIAL')).toBe(false);
  });
});

describe('describeChange', () => {
  it('always states a reason a person can read', () => {
    const detail = describeChange({
      reason: 'BLOCKED_PARTS',
      note: 'caliper from Anna Nagar',
      remainingMinutes: 108,
      countedItems: 2,
      crossesPromisedDay: true,
      overridden: false,
    });
    expect(detail).toContain('Waiting on a part');
    expect(detail).toContain('108 working minutes');
    expect(detail).toContain('caliper from Anna Nagar');
    expect(detail).toContain('after the promised day');
  });
});

describe('toEtaWorkItems', () => {
  it('takes the line kind from the estimate line that bills the item', () => {
    const items = toEtaWorkItems({
      workItems: [
        { id: 'w1', state: 'APPROVED', estimatedMinutes: null },
        { id: 'w2', state: 'APPROVED', estimatedMinutes: 45 },
        { id: 'w3', state: 'APPROVED', estimatedMinutes: null },
      ],
      estimate: {
        lines: [
          { workItemId: 'w1', kind: 'PART' },
          { workItemId: 'w2', kind: 'LABOUR' },
          { workItemId: null, kind: 'FEE' },
        ],
      },
    });

    expect(items[0]?.lineKind).toBe('PART');
    expect(items[1]?.estimatedMinutes).toBe(45);
    // No line bills w3, so it falls back to labour.
    expect(items[2]?.lineKind).toBeNull();
  });
});

/* -------------------------------------------------------------------------- *
 * 4.2 — card resolution and confidence routing
 * -------------------------------------------------------------------------- */

describe('registrationMatches', () => {
  it.each([
    ['4432', 'TN09BX4432', true],
    ['09 BX 4432', 'TN09BX4432', true],
    ['09-bx-4432', 'TN09BX4432', true],
    ['TN09BX4432', 'TN09BX4432', true],
    ['4433', 'TN09BX4432', false],
    // Three characters would match half the yard.
    ['432', 'TN09BX4432', false],
  ])('%s against %s → %s', (fragment, registration, expected) => {
    expect(registrationMatches(fragment, registration)).toBe(expected);
  });
});

describe('resolveCard', () => {
  const mine = candidateCard({ code: 'JC-1', registration: 'TN09BX4432', assignedTechnicianId: 's1' });
  const theirs = candidateCard({ code: 'JC-2', registration: 'TN10CD4432', assignedTechnicianId: 's2' });

  it('takes an explicit code over everything else', () => {
    const outcome = resolveCard({
      registrationFragment: '4432',
      jobCardCode: 'JC-2',
      replyContext: null,
      assigned: [mine],
      byRegistration: [mine, theirs],
      byCode: theirs,
    });
    expect(outcome).toEqual({ kind: 'matched', card: theirs });
  });

  it('resolves a unique registration match', () => {
    const outcome = resolveCard({
      registrationFragment: 'TN09BX4432',
      jobCardCode: null,
      replyContext: null,
      assigned: [],
      byRegistration: [mine],
      byCode: null,
    });
    expect(outcome).toEqual({ kind: 'matched', card: mine });
  });

  it('breaks a two-way registration tie with the technician’s own assignment', () => {
    const outcome = resolveCard({
      registrationFragment: '4432',
      jobCardCode: null,
      replyContext: null,
      assigned: [mine],
      byRegistration: [mine, theirs],
      byCode: null,
    });
    expect(outcome).toEqual({ kind: 'matched', card: mine });
  });

  it('asks when two cards match and neither is theirs', () => {
    const outcome = resolveCard({
      registrationFragment: '4432',
      jobCardCode: null,
      replyContext: null,
      assigned: [],
      byRegistration: [mine, theirs],
      byCode: null,
    });
    expect(outcome.kind).toBe('ambiguous');
  });

  it('does not fall back to assignment when a named plate matched nothing', () => {
    // They named a vehicle this shop does not have open. Applying the signal to
    // their one assigned card would be applying it to a car nobody mentioned.
    const outcome = resolveCard({
      registrationFragment: '9999',
      jobCardCode: null,
      replyContext: null,
      assigned: [mine],
      byRegistration: [],
      byCode: null,
    });
    expect(outcome.kind).toBe('none');
  });

  it('uses reply context when no plate was spoken', () => {
    const outcome = resolveCard({
      registrationFragment: null,
      jobCardCode: null,
      replyContext: theirs,
      assigned: [mine],
      byRegistration: [],
      byCode: null,
    });
    expect(outcome).toEqual({ kind: 'matched', card: theirs });
  });

  it('resolves a lone assigned card, and asks when there are two', () => {
    expect(
      resolveCard({
        registrationFragment: null,
        jobCardCode: null,
        replyContext: null,
        assigned: [mine],
        byRegistration: [],
        byCode: null,
      }),
    ).toEqual({ kind: 'matched', card: mine });

    expect(
      resolveCard({
        registrationFragment: null,
        jobCardCode: null,
        replyContext: null,
        assigned: [mine, theirs],
        byRegistration: [],
        byCode: null,
      }).kind,
    ).toBe('ambiguous');
  });
});

describe('shouldAutoApply', () => {
  const matched = { kind: 'matched' as const, card: candidateCard({ code: 'JC-1', registration: 'TN09BX4432' }) };

  it('is the phase’s 0.85 bar, exactly', () => {
    expect(AUTO_APPLY_CONFIDENCE).toBe(0.85);
    expect(shouldAutoApply(0.85, matched)).toBe(true);
    expect(shouldAutoApply(0.8499, matched)).toBe(false);
  });

  it('never auto-applies an ambiguous match however confident the parse', () => {
    expect(shouldAutoApply(1, { kind: 'ambiguous', candidates: [] })).toBe(false);
    expect(shouldAutoApply(1, { kind: 'none' })).toBe(false);
  });
});

describe('decideRoute', () => {
  const matched = { kind: 'matched' as const, card: candidateCard({ code: 'JC-1', registration: 'TN09BX4432' }) };

  it('routes a confident, unambiguous signal to auto-apply', () => {
    expect(
      decideRoute({
        signalType: 'done',
        confidence: 0.92,
        resolution: matched,
        workItemIds: ['w1'],
        hasCardContext: true,
      }),
    ).toBe('AUTO_APPLIED');
  });

  it('routes new work to the evidence flow whatever the confidence', () => {
    expect(
      decideRoute({
        signalType: 'issue_found',
        confidence: 0.99,
        resolution: matched,
        workItemIds: ['w1'],
        hasCardContext: true,
      }),
    ).toBe('ROUTED_TO_EVIDENCE');
  });

  it('asks when the parse was unsure', () => {
    expect(
      decideRoute({
        signalType: 'done',
        confidence: 0.6,
        resolution: matched,
        workItemIds: ['w1'],
        hasCardContext: true,
      }),
    ).toBe('PENDING_CONFIRMATION');
  });

  it('refuses to close anything when "done" cannot say what is done', () => {
    expect(
      decideRoute({
        signalType: 'done',
        confidence: 0.99,
        resolution: matched,
        workItemIds: [],
        hasCardContext: true,
      }),
    ).toBe('PENDING_CONFIRMATION');
  });

  it('asks which card when two matched', () => {
    expect(
      decideRoute({
        signalType: 'progress',
        confidence: 0.99,
        resolution: { kind: 'ambiguous', candidates: [] },
        workItemIds: [],
        hasCardContext: false,
      }),
    ).toBe('AMBIGUOUS');
  });
});

describe('work-item resolution', () => {
  const card: JobCardContext = {
    jobCardId: 'card-1',
    code: 'JC-2026-0001',
    state: 'IN_PROGRESS',
    customerId: 'cust-1',
    customerName: 'Ravi',
    customerLanguage: 'ta',
    vehicleLabel: 'Maruti Swift',
    registration: 'TN09BX4432',
    odometerKm: 48_000,
    promisedAt: null,
    complaint: null,
    workItems: [
      { id: 'w-brakes', title: 'Front brake pad replacement', state: 'IN_PROGRESS', requiresApproval: true, technicianNote: null, estimatedMinutes: 60 },
      { id: 'w-oil', title: 'Engine oil and filter', state: 'APPROVED', requiresApproval: true, technicianNote: null, estimatedMinutes: 30 },
    ],
    estimate: null,
    media: [],
    advisorName: null,
  };

  function signal(partial: Partial<ParsedStatusSignal>): ParsedStatusSignal {
    return {
      signalType: 'done',
      confidence: 0.9,
      registrationFragment: null,
      jobCardCode: null,
      workDescriptions: [],
      etaHint: null,
      summary: '',
      language: 'ta',
      ...partial,
    };
  }

  it('matches on what the technician named', () => {
    const resolved = resolveWorkItems(signal({ workDescriptions: ['brake pad'] }), card);
    expect(resolved.workItemIds).toEqual(['w-brakes']);
    expect(resolved.basis).toBe('DESCRIPTION');
  });

  it('resolves to nothing when several are open and none was named', () => {
    // The alternative — applying to all of them — is one word closing three jobs.
    const resolved = resolveWorkItems(signal({}), card);
    expect(resolved.workItemIds).toEqual([]);
    expect(resolved.basis).toBe('NONE');
  });

  it('resolves the sole open item without being told', () => {
    const single = { ...card, workItems: [card.workItems[0] as (typeof card.workItems)[number]] };
    const resolved = resolveWorkItems(signal({}), single);
    expect(resolved.workItemIds).toEqual(['w-brakes']);
    expect(resolved.basis).toBe('SOLE');
  });

  it('matches titles loosely in both directions but not on short fragments', () => {
    expect(titleMatches('brake pad', 'Front brake pad replacement')).toBe(true);
    expect(titleMatches('engine oil and filter', 'Engine oil')).toBe(true);
    expect(titleMatches('ac', 'Engine oil and filter')).toBe(false);
  });
});

describe('cardEventFor', () => {
  const base: JobCardContext = {
    jobCardId: 'card-1',
    code: 'JC-1',
    state: 'IN_PROGRESS',
    customerId: 'c1',
    customerName: 'Ravi',
    customerLanguage: 'en',
    vehicleLabel: 'Swift',
    registration: 'TN09BX4432',
    odometerKm: null,
    promisedAt: null,
    complaint: null,
    workItems: [
      { id: 'w1', title: 'Brakes', state: 'IN_PROGRESS', requiresApproval: true, technicianNote: null, estimatedMinutes: null },
      { id: 'w2', title: 'Oil', state: 'APPROVED', requiresApproval: true, technicianNote: null, estimatedMinutes: null },
    ],
    estimate: null,
    media: [],
    advisorName: null,
  };

  it('blocks a card on parts only from IN_PROGRESS', () => {
    expect(cardEventFor('blocked_parts', 'IN_PROGRESS', base, [])).toBe('PARTS_AWAITED');
    expect(cardEventFor('blocked_parts', 'AWAITING_PARTS', base, [])).toBeNull();
  });

  it('reads progress on a blocked card as the part having arrived', () => {
    expect(cardEventFor('progress', 'AWAITING_PARTS', base, [])).toBe('PARTS_RECEIVED');
    expect(cardEventFor('progress', 'IN_PROGRESS', base, [])).toBeNull();
  });

  it('moves the card only when the last open item is done', () => {
    expect(cardEventFor('done', 'IN_PROGRESS', base, ['w1'])).toBeNull();
    expect(cardEventFor('done', 'IN_PROGRESS', base, ['w1', 'w2'])).toBe('WORK_COMPLETED');
  });

  it('never moves a card on a finding', () => {
    expect(cardEventFor('issue_found', 'IN_PROGRESS', base, ['w1', 'w2'])).toBeNull();
  });
});

describe('etaReasonFor', () => {
  it.each([
    ['blocked_parts', null, false, 'BLOCKED_PARTS'],
    ['done', 'WORK_COMPLETED', false, 'QUALITY_PASSED'],
    ['done', null, false, 'WORK_DONE'],
    ['progress', 'PARTS_RECEIVED', false, 'PARTS_RECEIVED'],
    ['progress', null, true, 'TECHNICIAN_HINT'],
    ['progress', null, false, null],
    ['issue_found', null, false, null],
  ] as const)('%s / %s / hint=%s → %s', (signalType, cardEvent, hasHint, expected) => {
    expect(etaReasonFor(signalType, cardEvent, hasHint)).toBe(expected);
  });
});

/* -------------------------------------------------------------------------- *
 * 4.6 — silent-bay windows
 * -------------------------------------------------------------------------- */

describe('silent-bay windowing', () => {
  it('only watches states where a vehicle should be moving', () => {
    expect(isActiveForSilence('IN_PROGRESS')).toBe(true);
    expect(isActiveForSilence('IN_DIAGNOSIS')).toBe(true);
    expect(isActiveForSilence('QUALITY_CHECK')).toBe(true);
    // Both of these are *supposed* to be sitting still: one waits on a courier,
    // the other on a customer. Nudging a technician about them blames the wrong
    // person for the right delay.
    expect(isActiveForSilence('AWAITING_PARTS')).toBe(false);
    expect(isActiveForSilence('AWAITING_APPROVAL')).toBe(false);
    expect(isActiveForSilence('READY_FOR_DELIVERY')).toBe(false);
  });

  it('puts every moment in a window into the same bucket', () => {
    // Buckets are fixed three-hour slices measured from the epoch, so in IST
    // they begin at 08:30, 11:30, 14:30 … Two scans inside one slice must agree
    // on the bucket; a scan in the next slice must not.
    const clock = fixedClock(ist(2026, 8, 17, 12, 0));
    const first = truncateToWindow(clock.now(), 3);
    const later = truncateToWindow(ist(2026, 8, 17, 14, 25), 3);
    const next = truncateToWindow(ist(2026, 8, 17, 15, 30), 3);

    expect(first.getTime()).toBe(later.getTime());
    expect(next.getTime()).not.toBe(first.getTime());
    // Three hours apart, exactly one window.
    expect(next.getTime() - first.getTime()).toBe(3 * 60 * 60 * 1000);
  });

  it('agrees between two workers whose clocks differ by seconds', () => {
    const a = truncateToWindow(new Date('2026-08-17T09:00:03.000Z'), 3);
    const b = truncateToWindow(new Date('2026-08-17T09:00:41.000Z'), 3);
    expect(a.getTime()).toBe(b.getTime());
  });
});

describe('crossesLocalDay', () => {
  it('is about the shop’s calendar, not UTC’s', () => {
    // 23:30 and 00:30 IST are the same UTC day and different local days.
    expect(crossesLocalDay(ist(2026, 8, 17, 23, 30), ist(2026, 8, 18, 0, 30), IST)).toBe(true);
    expect(crossesLocalDay(ist(2026, 8, 17, 9, 0), ist(2026, 8, 17, 18, 0), IST)).toBe(false);
  });
});
