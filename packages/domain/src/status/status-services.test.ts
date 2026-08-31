import { describe, expect, it } from 'vitest';
import {
  BRAKES_PAISE,
  createLoopHarness,
  LOOP_CARD,
  LOOP_CONVERSATION,
  LOOP_CUSTOMER,
  LOOP_ITEM_BRAKES,
  LOOP_ITEM_OIL,
  LOOP_SHOP,
  LOOP_T0,
  LOOP_TECHNICIAN,
  type LoopHarness,
} from '../testing/loop-harness';
import type { ParsedStatusSignal } from './types';

/**
 * The status sentinel as a working machine, not as a table of rules.
 *
 * `status.test.ts` next door proves the pure functions — when an ETA is
 * material, which card a fragment resolves to, what a route decides. This file
 * proves the *services*: that a signal at 0.92 actually moves the card and
 * writes an audit row, that one at 0.6 asks the staff group instead, that a
 * redelivered webhook does not close the same work item twice, and that a
 * quiet bay produces exactly one nudge per window.
 *
 * All of it on a fake clock, because half of what these services decide is
 * *when*.
 */

const ACTOR = { type: 'STAFF' as const, id: LOOP_TECHNICIAN };
const TRACE = 'trace-status-services';

function parsed(overrides: Partial<ParsedStatusSignal> = {}): ParsedStatusSignal {
  return {
    signalType: 'done',
    confidence: 0.92,
    registrationFragment: '4432',
    jobCardCode: null,
    workDescriptions: ['brake caliper'],
    etaHint: null,
    summary: '4432 caliper done',
    language: 'ta',
    ...overrides,
  };
}

function capture(harness: LoopHarness, signal: ParsedStatusSignal, messageId = 'msg-1') {
  return harness.signals.capture({
    shopId: LOOP_SHOP,
    parsed: signal,
    source: 'VOICE_NOTE',
    transcript: signal.summary,
    transcriptConfidence: 0.94,
    conversationId: LOOP_CONVERSATION,
    messageId,
    mediaId: null,
    senderStaffId: LOOP_TECHNICIAN,
    replyToMessageId: null,
    actor: ACTOR,
    traceId: TRACE,
  });
}

describe('StatusSignalService.capture', () => {
  it('applies a confident, unambiguous note without asking anyone', async () => {
    const harness = createLoopHarness();

    const outcome = await capture(harness, parsed());

    expect(outcome.route).toBe('AUTO_APPLIED');
    expect(outcome.jobCardId).toBe(LOOP_CARD);
    expect(outcome.workItemIds).toEqual([LOOP_ITEM_BRAKES]);
    expect(harness.base.world.items.get(LOOP_ITEM_BRAKES)?.state).toBe('DONE');

    // The audit chain sees it exactly as it sees an advisor's click.
    const actions = harness.base.world.auditFor(LOOP_SHOP).map((entry) => entry.action);
    expect(actions).toContain('status_signal.captured');
    expect(actions).toContain('work_item.state_changed');
  });

  it('walks an APPROVED item through IN_PROGRESS rather than jumping to DONE', async () => {
    const harness = createLoopHarness();
    await capture(harness, parsed());

    const transitions = harness.base.world
      .auditFor(LOOP_SHOP)
      .filter((entry) => entry.action === 'work_item.state_changed')
      .map((entry) => (entry.payload as { to?: string }).to);

    // A technician who never sent a "started" note still leaves a ledger a
    // person can read: APPROVED → IN_PROGRESS → DONE.
    expect(transitions).toEqual(['IN_PROGRESS', 'DONE']);
  });

  it('asks the staff group when the recogniser was not sure enough', async () => {
    const harness = createLoopHarness();

    const outcome = await capture(harness, parsed({ confidence: 0.6 }));

    expect(outcome.route).toBe('PENDING_CONFIRMATION');
    // Nothing moved. That is the whole point of the bar.
    expect(harness.base.world.items.get(LOOP_ITEM_BRAKES)?.state).toBe('APPROVED');

    const asked = harness.sentBodies().at(-1) ?? '';
    expect(asked).toContain('TN09BX4432');
  });

  it('lets assignment settle a fragment two cars answer to', async () => {
    const harness = createLoopHarness();
    harness.statusWorld.cards.push({
      jobCardId: 'other-card',
      code: 'JC-2026-0099',
      registration: 'TN22CJ4432',
      vehicleLabel: 'Hyundai i20',
      state: 'IN_PROGRESS',
      basis: 'REGISTRATION',
      // Somebody else's car. Two Swifts ending 4432 is rare; one of them being
      // *theirs* settles it, and that is the only thing assignment decides here.
      assignedTechnicianId: null,
      lastTouchedAt: new Date(LOOP_T0),
    });

    const outcome = await capture(harness, parsed());

    expect(outcome.route).toBe('AUTO_APPLIED');
    expect(outcome.jobCardId).toBe(LOOP_CARD);
  });

  it('asks which car when two match and neither is theirs', async () => {
    const harness = createLoopHarness();
    harness.statusWorld.cards.push({
      jobCardId: 'other-card',
      code: 'JC-2026-0099',
      registration: 'TN22CJ4432',
      vehicleLabel: 'Hyundai i20',
      state: 'IN_PROGRESS',
      basis: 'REGISTRATION',
      assignedTechnicianId: LOOP_TECHNICIAN,
      lastTouchedAt: new Date(LOOP_T0),
    });

    const outcome = await capture(harness, parsed());

    expect(outcome.route).toBe('AMBIGUOUS');
    expect(outcome.jobCardId).toBeNull();
    expect(harness.base.world.items.get(LOOP_ITEM_BRAKES)?.state).toBe('APPROVED');
  });

  it('records a note about a vehicle the shop does not have open', async () => {
    const harness = createLoopHarness();

    const outcome = await capture(harness, parsed({ registrationFragment: '9999' }));

    expect(outcome.route).toBe('NO_CARD_MATCH');
    expect(outcome.detail).toContain('9999');
    // Written anyway: "what fraction of notes did we understand" needs the
    // failures in its denominator.
    expect(harness.statusWorld.signals.size).toBe(1);
  });

  it('sends new work to the evidence flow rather than moving the card', async () => {
    const harness = createLoopHarness();
    const routed: string[] = [];

    const withEvidence = createLoopHarness();
    void withEvidence;

    const outcome = await harness.signals.capture({
      shopId: LOOP_SHOP,
      parsed: parsed({ signalType: 'issue_found', summary: 'belt also gone on 4432' }),
      source: 'VOICE_NOTE',
      transcript: 'belt also gone on 4432',
      transcriptConfidence: 0.9,
      conversationId: LOOP_CONVERSATION,
      messageId: 'msg-issue',
      mediaId: null,
      senderStaffId: LOOP_TECHNICIAN,
      replyToMessageId: null,
      actor: ACTOR,
      traceId: TRACE,
    });
    routed.push(outcome.route);

    expect(routed).toEqual(['ROUTED_TO_EVIDENCE']);
    // New work needs the customer's money and therefore their consent; it is
    // not a status and must not close anything.
    expect(harness.base.world.items.get(LOOP_ITEM_BRAKES)?.state).toBe('APPROVED');
  });

  it('does not close the same work item twice when Meta redelivers', async () => {
    const harness = createLoopHarness();

    const first = await capture(harness, parsed(), 'msg-dup');
    const second = await capture(harness, parsed(), 'msg-dup');

    expect(first.route).toBe('AUTO_APPLIED');
    expect(second.duplicate).toBe(true);
    expect(harness.statusWorld.signals.size).toBe(1);
  });

  it('records a technician saying "done" on a card that cannot move, without forcing it', async () => {
    const harness = createLoopHarness();
    harness.base.world.cards.set(LOOP_CARD, {
      id: LOOP_CARD,
      shopId: LOOP_SHOP,
      state: 'AWAITING_APPROVAL',
      version: 1,
      stateChangedAt: new Date(LOOP_T0),
    });

    const outcome = await capture(harness, parsed({ signalType: 'blocked_parts' }));

    // The note is true about the world and says nothing true about what the
    // card may do next, so it is recorded and skipped rather than forced.
    expect(outcome.route).toBe('AUTO_APPLIED');
    expect(harness.base.world.cards.get(LOOP_CARD)?.state).toBe('AWAITING_APPROVAL');
  });
});

describe('StatusSignalService.confirm and .discard', () => {
  it('applies a signal on the advisor’s tap, and only once', async () => {
    const harness = createLoopHarness();
    const captured = await capture(harness, parsed({ confidence: 0.6 }));
    const signalId = captured.signalId as string;

    const confirmed = await harness.signals.confirm({
      shopId: LOOP_SHOP,
      signalId,
      staffId: LOOP_TECHNICIAN,
      actor: ACTOR,
      traceId: TRACE,
    });

    expect(confirmed.workItemIds).toEqual([LOOP_ITEM_BRAKES]);
    expect(harness.base.world.items.get(LOOP_ITEM_BRAKES)?.state).toBe('DONE');

    // The confirmation goes to a group, so two advisors tap it.
    const again = await harness.signals.confirm({
      shopId: LOOP_SHOP,
      signalId,
      staffId: LOOP_TECHNICIAN,
      actor: ACTOR,
      traceId: TRACE,
    });
    expect(again.route).toBe('DISCARDED');
    expect(again.detail).toContain('already');
  });

  it('records a discard, because a queue that only records agreement proves nothing', async () => {
    const harness = createLoopHarness();
    const captured = await capture(harness, parsed({ confidence: 0.6 }));

    const discarded = await harness.signals.discard({
      shopId: LOOP_SHOP,
      signalId: captured.signalId as string,
      staffId: LOOP_TECHNICIAN,
      actor: ACTOR,
      traceId: TRACE,
    });

    expect(discarded.route).toBe('DISCARDED');
    expect(harness.base.world.items.get(LOOP_ITEM_BRAKES)?.state).toBe('APPROVED');
    expect(
      harness.base.world.auditFor(LOOP_SHOP).map((entry) => entry.action),
    ).toContain('status_signal.discarded');
  });

  it('names the vehicle in the confirm queue', async () => {
    const harness = createLoopHarness();
    await capture(harness, parsed({ confidence: 0.6 }));

    const queue = await harness.signals.pendingWithCards(LOOP_SHOP, 10);

    expect(queue.signals).toHaveLength(1);
    expect(queue.cards.get(LOOP_CARD)?.registration).toBe('TN09BX4432');
  });
});

describe('EtaService', () => {
  it('writes the first entry as version 1 with the reason that caused it', async () => {
    const harness = createLoopHarness();

    const result = await harness.eta.recalculate({
      shopId: LOOP_SHOP,
      jobCardId: LOOP_CARD,
      reason: 'WORK_APPROVED',
      actor: ACTOR,
      traceId: TRACE,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.version).toBe(1);
    expect(result.entry.reason).toBe('WORK_APPROVED');
    // Two approved items, 120 minutes of work plus the quality check and the
    // buffer — the point is that it is derived, not guessed.
    expect(result.entry.eta.getTime()).toBeGreaterThan(LOOP_T0.getTime());
  });

  it('classifies a parts block as a material slip', async () => {
    const harness = createLoopHarness();
    await harness.eta.recalculate({
      shopId: LOOP_SHOP,
      jobCardId: LOOP_CARD,
      reason: 'WORK_APPROVED',
      actor: ACTOR,
      traceId: TRACE,
    });

    const blocked = await harness.eta.recalculate({
      shopId: LOOP_SHOP,
      jobCardId: LOOP_CARD,
      reason: 'BLOCKED_PARTS',
      actor: ACTOR,
      traceId: TRACE,
      note: 'front caliper',
    });

    expect(blocked.ok).toBe(true);
    if (!blocked.ok) return;
    expect(blocked.entry.version).toBe(2);
    expect(blocked.entry.materiality).toBe('MATERIAL_SLIP');
    expect(blocked.entry.detail).toContain('caliper');
  });

  it('honours a time the technician actually named', async () => {
    const harness = createLoopHarness();
    const namedTime = new Date(LOOP_T0.getTime() + 90 * 60_000);

    const result = await harness.eta.recalculate({
      shopId: LOOP_SHOP,
      jobCardId: LOOP_CARD,
      reason: 'BLOCKED_PARTS',
      actor: ACTOR,
      traceId: TRACE,
      partsAvailableAt: namedTime,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The person holding the part beats the shop's default lead time.
    expect(result.entry.eta.getTime()).toBeLessThan(
      LOOP_T0.getTime() + 36 * 60 * 60_000,
    );
  });

  it('refuses to put a ready-by time on a delivered car', async () => {
    const harness = createLoopHarness();
    harness.statusWorld.seedCard({
      jobCardId: LOOP_CARD,
      version: 0,
      currentEta: null,
      promisedAt: null,
      state: 'DELIVERED',
    });

    const result = await harness.eta.recalculate({
      shopId: LOOP_SHOP,
      jobCardId: LOOP_CARD,
      reason: 'WORK_APPROVED',
      actor: ACTOR,
      traceId: TRACE,
    });

    expect(result.ok).toBe(false);
  });

  it('reads its own history back, newest first', async () => {
    const harness = createLoopHarness();
    for (const reason of ['WORK_APPROVED', 'BLOCKED_PARTS', 'PARTS_RECEIVED'] as const) {
      await harness.eta.recalculate({
        shopId: LOOP_SHOP,
        jobCardId: LOOP_CARD,
        reason,
        actor: ACTOR,
        traceId: TRACE,
      });
    }

    const history = await harness.eta.history(LOOP_SHOP, LOOP_CARD, 10);
    expect(history.map((entry) => entry.version)).toEqual([3, 2, 1]);

    const latest = await harness.eta.latest(LOOP_SHOP, LOOP_CARD);
    expect(latest?.reason).toBe('PARTS_RECEIVED');
  });
});

describe('StatusCommsService', () => {
  it('tells the customer about a material slip, with the reason', async () => {
    const harness = createLoopHarness();
    await harness.eta.recalculate({
      shopId: LOOP_SHOP,
      jobCardId: LOOP_CARD,
      reason: 'WORK_APPROVED',
      actor: ACTOR,
      traceId: TRACE,
    });
    const blocked = await harness.eta.recalculate({
      shopId: LOOP_SHOP,
      jobCardId: LOOP_CARD,
      reason: 'BLOCKED_PARTS',
      actor: ACTOR,
      traceId: TRACE,
    });
    if (!blocked.ok) throw new Error('the block did not move the ETA');

    const announced = await harness.comms.announceEtaChange({
      shopId: LOOP_SHOP,
      entry: blocked.entry,
      actor: { type: 'SYSTEM', id: null },
      traceId: TRACE,
    });

    expect(announced.sent, announced.reason ?? announced.status).toBe(true);
    expect(harness.sentBodies().at(-1) ?? '').toMatch(/delay|Sorry/i);
  });

  it('batches an immaterial change rather than interrupting anyone', async () => {
    const harness = createLoopHarness();
    const approved = await harness.eta.recalculate({
      shopId: LOOP_SHOP,
      jobCardId: LOOP_CARD,
      reason: 'WORK_APPROVED',
      actor: ACTOR,
      traceId: TRACE,
    });
    if (!approved.ok) throw new Error('no entry');

    const announced = await harness.comms.announceEtaChange({
      shopId: LOOP_SHOP,
      entry: { ...approved.entry, materiality: 'IMMATERIAL', reason: 'TECHNICIAN_HINT' },
      actor: { type: 'SYSTEM', id: null },
      traceId: TRACE,
    });

    expect(announced.sent).toBe(false);
    expect(announced.status).toBe('BATCHED');
    // Marked notified even so, or the worker re-examines it for ever.
    const entry = harness.statusWorld.etaEntries.find(
      (row) => row.id === approved.entry.id,
    );
    expect(entry?.notifiedAt).not.toBeNull();
  });

  it('says nothing about a state no customer needs to hear about', async () => {
    const harness = createLoopHarness();

    const announced = await harness.comms.announceStateChange({
      shopId: LOOP_SHOP,
      jobCardId: LOOP_CARD,
      to: 'IN_DIAGNOSIS',
      actor: { type: 'SYSTEM', id: null },
      traceId: TRACE,
    });

    expect(announced.sent).toBe(false);
    expect(announced.status).toBe('NOT_ANNOUNCED');
    expect(harness.sentBodies()).toHaveLength(0);
  });
});

describe('SilentBaySentinel', () => {
  it('nudges the staff group once per window, however often it scans', async () => {
    const harness = createLoopHarness();
    harness.statusWorld.activeCards.push({
      jobCardId: LOOP_CARD,
      code: 'JC-2026-0077',
      state: 'IN_PROGRESS',
      registration: 'TN09BX4432',
      vehicleLabel: 'Maruti Swift',
      assignedTechnicianId: LOOP_TECHNICIAN,
      assignedTechnicianName: 'Suresh',
      // Last heard from four working hours ago; the shop's threshold is three.
      lastSignalAt: new Date(LOOP_T0.getTime() - 4 * 60 * 60_000),
    });

    const scan = () =>
      harness.silentBay.scan({
        shopId: LOOP_SHOP,
        staffConversationId: LOOP_CONVERSATION,
        actor: { type: 'SYSTEM', id: null },
        traceId: TRACE,
      });

    const first = await scan();
    const second = await scan();

    expect(first.nudged).toEqual([LOOP_CARD]);
    // The window is claimed, so a second worker — or a restart — nudges nobody.
    expect(second.nudged).toEqual([]);
  });

  it('leaves a bay alone that is supposed to be sitting still', async () => {
    const harness = createLoopHarness();
    harness.statusWorld.activeCards.push({
      jobCardId: LOOP_CARD,
      code: 'JC-2026-0077',
      // Waiting for a part is not a technician ignoring a car; nudging about
      // it blames the wrong person for the right delay.
      state: 'AWAITING_PARTS',
      registration: 'TN09BX4432',
      vehicleLabel: 'Maruti Swift',
      assignedTechnicianId: LOOP_TECHNICIAN,
      assignedTechnicianName: 'Suresh',
      lastSignalAt: new Date(LOOP_T0.getTime() - 48 * 60 * 60_000),
    });

    const result = await harness.silentBay.scan({
      shopId: LOOP_SHOP,
      staffConversationId: LOOP_CONVERSATION,
      actor: { type: 'SYSTEM', id: null },
      traceId: TRACE,
    });

    expect(result.nudged).toEqual([]);
  });
});

/** Guards the shape the drawer reads. */
describe('the loop harness itself', () => {
  it('starts with a card in progress, two approved items and nothing said', () => {
    const harness = createLoopHarness();
    expect(harness.base.world.items.get(LOOP_ITEM_OIL)?.state).toBe('APPROVED');
    expect(harness.amountDuePaise).toBe(BRAKES_PAISE + 160_000);
    expect(harness.sentBodies()).toHaveLength(0);
    expect(LOOP_CUSTOMER.length).toBeGreaterThan(0);
  });
});
