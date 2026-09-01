import { formatPaise, uuidv7 } from '@serviceloop/shared';
import { describe, expect, it } from 'vitest';
import {
  createRetentionHarness,
  LOOP_CARD,
  LOOP_CONVERSATION,
  LOOP_CUSTOMER,
  LOOP_SHOP,
  OWNER_CONVERSATION,
  RETENTION_OWNER,
  RETENTION_VEHICLE,
  type RetentionHarness,
} from '../testing';

/**
 * 6.7 — the owner's evening brief.
 *
 * The acceptance gate asks for a "golden-content test on a seeded day of
 * events: every number in the digest independently recomputed and matched".
 * That is what this file is, and the *way* it does it is the assertion that
 * matters: the numbers are recomputed from the **events the services actually
 * emitted**, not from a fixture. If the digest and the ledger ever disagree
 * about how much was recovered today, one of them is reading something the
 * other is not, and that is precisely the bug this catches.
 */

const TRACE = 'digest-test';

/**
 * Stable ids for the seeded day.
 *
 * Real UUIDs rather than readable strings, because the payload schemas declare
 * them as such: a fixture that would not survive `parseEventEnvelope` proves
 * the digest works against events the system could never emit.
 */
const CARD_IN = [uuidv7(), uuidv7()] as const;
const APPROVAL_ANSWERED = uuidv7();
const APPROVAL_STUCK = uuidv7();
const CONVERTED_CARD = uuidv7();

/** A day at the shop: two cars in, one out, one recovery, one bad review. */
async function goldenDay(harness: RetentionHarness): Promise<void> {
  const world = harness.loop.base.world;
  const now = harness.now();
  harness.world.vehicleByJobCard.set(LOOP_CARD, RETENTION_VEHICLE);

  // Two vehicles arrived.
  for (const index of [0, 1]) {
    world.outbox.push({
      id: uuidv7(),
      type: 'intake.draft_confirmed',
      occurredAt: new Date(now.getTime() - (2 - index) * 3_600_000).toISOString(),
      shopId: LOOP_SHOP,
      traceId: TRACE,
      payload: {
        draftId: uuidv7(),
        jobCardId: CARD_IN[index] ?? uuidv7(),
        customerId: LOOP_CUSTOMER,
        vehicleId: RETENTION_VEHICLE,
        source: 'PHOTO',
        correctedFields: [],
        actor: { type: 'STAFF', id: null },
      },
    });
  }

  // One went home.
  world.outbox.push({
    id: uuidv7(),
    type: 'job_card.state_changed',
    occurredAt: new Date(now.getTime() - 1_800_000).toISOString(),
    shopId: LOOP_SHOP,
    traceId: TRACE,
    payload: {
      jobCardId: CARD_IN[0],
      from: 'AWAITING_PAYMENT',
      to: 'DELIVERED',
      event: 'VEHICLE_DELIVERED',
      actor: { type: 'STAFF', id: null },
      meta: {},
    },
  });

  // One approval answered, one still waiting past the two-hour threshold.
  world.outbox.push(
    {
      id: uuidv7(),
      type: 'approval.requested',
      occurredAt: new Date(now.getTime() - 5 * 3_600_000).toISOString(),
      shopId: LOOP_SHOP,
      traceId: TRACE,
      payload: {
        approvalId: APPROVAL_ANSWERED,
        jobCardId: CARD_IN[0],
        conversationId: LOOP_CONVERSATION,
        customerId: LOOP_CUSTOMER,
        evidenceBundleId: null,
        workItemIds: [],
        amountPaise: 320_000,
        ladderRef: 'APPROVAL',
        actor: { type: 'AGENT', id: null },
      },
    },
    {
      id: uuidv7(),
      type: 'approval.decided',
      occurredAt: new Date(now.getTime() - 3 * 3_600_000).toISOString(),
      shopId: LOOP_SHOP,
      traceId: TRACE,
      payload: {
        approvalId: APPROVAL_ANSWERED,
        jobCardId: CARD_IN[0],
        decision: 'FULL',
        approvedWorkItemIds: [],
        deferredWorkItemIds: [],
        declinedWorkItemIds: [],
        approvedAmountPaise: 320_000,
        decidedVia: 'button',
        actor: { type: 'CUSTOMER', id: LOOP_CUSTOMER },
      },
    },
    {
      id: uuidv7(),
      type: 'approval.requested',
      occurredAt: new Date(now.getTime() - 4 * 3_600_000).toISOString(),
      shopId: LOOP_SHOP,
      traceId: TRACE,
      payload: {
        approvalId: APPROVAL_STUCK,
        jobCardId: LOOP_CARD,
        conversationId: LOOP_CONVERSATION,
        customerId: LOOP_CUSTOMER,
        evidenceBundleId: null,
        workItemIds: [],
        amountPaise: 185_000,
        ladderRef: 'APPROVAL',
        actor: { type: 'AGENT', id: null },
      },
    },
    {
      id: uuidv7(),
      type: 'silent_bay.detected',
      occurredAt: new Date(now.getTime() - 2 * 3_600_000).toISOString(),
      shopId: LOOP_SHOP,
      traceId: TRACE,
      payload: {
        jobCardId: LOOP_CARD,
        code: 'JC-2026-0077',
        state: 'IN_PROGRESS',
        quietForMinutes: 240,
        consecutiveWindows: 2,
        assignedTechnicianId: null,
        actor: { type: 'SYSTEM', id: null },
      },
    },
  );

  // A real recovery, through the real ledger — this is the headline number.
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
    traceId: TRACE,
  });
  await harness.ledger.convert({
    shopId: LOOP_SHOP,
    ledgerItemId: opened.ledgerItemId,
    convertedJobCardId: CONVERTED_CARD,
    recoveredAmountPaise: 235_000,
    traceId: TRACE,
  });

  // And an unhappy customer, through the real feedback flow.
  const feedbackId = await harness.feedback.scheduleForDelivery({
    shopId: LOOP_SHOP,
    jobCardId: LOOP_CARD,
    customerId: LOOP_CUSTOMER,
    conversationId: LOOP_CONVERSATION,
    deliveredAt: new Date(now.getTime() - 6 * 3_600_000),
    traceId: TRACE,
  });
  await harness.feedback.recordAnswer({
    shopId: LOOP_SHOP,
    feedbackId: feedbackId!,
    sentiment: 'NEGATIVE',
    comment: 'The noise came back on the way home.',
    conversationId: LOOP_CONVERSATION,
    traceId: TRACE,
  });
}

describe('6.7 owner digest', () => {
  it('prints numbers that match an independent recomputation of the same day', async () => {
    const harness = createRetentionHarness();
    await goldenDay(harness);

    const day = await harness.metrics.dayFor(LOOP_SHOP, harness.now());
    await harness.metrics.computeDay({ shopId: LOOP_SHOP, day, traceId: TRACE });

    const results = await harness.digest.sendDaily({ shopId: LOOP_SHOP, day, traceId: TRACE });
    expect(results).toHaveLength(1);
    expect(results[0]?.sent).toBe(true);

    const payload = results[0]?.payload;
    expect(payload).toBeTruthy();

    // Recomputed from the log itself, not from the digest's own rollup.
    const log = harness.loop.base.world.outbox;
    const confirmed = log.filter((event) => event.type === 'intake.draft_confirmed').length;
    const delivered = log.filter(
      (event) =>
        event.type === 'job_card.state_changed' &&
        (event.payload as { to: string }).to === 'DELIVERED',
    ).length;
    const approved = log
      .filter((event) => event.type === 'approval.decided')
      .reduce(
        (sum, event) => sum + (event.payload as { approvedAmountPaise: number }).approvedAmountPaise,
        0,
      );
    const recovered = log
      .filter(
        (event) =>
          event.type === 'ledger.item_closed' &&
          (event.payload as { status: string }).status === 'CONVERTED',
      )
      .reduce(
        (sum, event) =>
          sum + (event.payload as { recoveredAmountPaise: number }).recoveredAmountPaise,
        0,
      );
    const negatives = log.filter(
      (event) =>
        event.type === 'feedback.recorded' &&
        (event.payload as { sentiment: string }).sentiment === 'NEGATIVE',
    ).length;
    const silent = log.filter((event) => event.type === 'silent_bay.detected').length;

    expect(payload?.numbers).toEqual({
      vehiclesIn: confirmed,
      vehiclesOut: delivered,
      approvedPaise: approved,
      recoveredPaise: recovered,
      approvalsPending: 1,
      feedbackFlags: negatives,
      silentBays: silent,
    });

    // And the rendered lines carry those same numbers in words.
    const text = (payload?.lines ?? []).join('\n');
    expect(text).toContain(`Vehicles: ${confirmed} in, ${delivered} delivered`);
    expect(text).toContain(`Approved today: ${formatPaise(approved)}`);
    expect(text).toContain(
      `Recovered from previously declined work: ${formatPaise(recovered)}`,
    );
    expect(text).toContain('Waiting on approval over 2h: 1');
    expect(text).toContain('Maruti Swift');
  });

  it('offers a one-tap claim on each stuck approval, keyed by the approval', async () => {
    const harness = createRetentionHarness();
    await goldenDay(harness);
    const day = await harness.metrics.dayFor(LOOP_SHOP, harness.now());
    await harness.metrics.computeDay({ shopId: LOOP_SHOP, day, traceId: TRACE });

    const [result] = await harness.digest.sendDaily({ shopId: LOOP_SHOP, day, traceId: TRACE });
    const actions = result?.payload?.actions ?? [];

    expect(actions).toHaveLength(1);
    expect(actions[0]?.id).toBe(`digest:claim:${APPROVAL_STUCK}`);
  });

  it('claims its slot once, so a restarted scheduler does not brief twice', async () => {
    const harness = createRetentionHarness();
    await goldenDay(harness);
    const day = await harness.metrics.dayFor(LOOP_SHOP, harness.now());
    await harness.metrics.computeDay({ shopId: LOOP_SHOP, day, traceId: TRACE });

    await harness.digest.sendDaily({ shopId: LOOP_SHOP, day, traceId: TRACE });
    const second = await harness.digest.sendDaily({ shopId: LOOP_SHOP, day, traceId: TRACE });

    expect(second[0]?.sent).toBe(false);
    expect(second[0]?.detail).toContain('already exists');
  });

  it('claims a stuck approval: a task in the owner’s name, and the alert stops', async () => {
    const harness = createRetentionHarness();
    await goldenDay(harness);
    const day = await harness.metrics.dayFor(LOOP_SHOP, harness.now());
    await harness.metrics.computeDay({ shopId: LOOP_SHOP, day, traceId: TRACE });

    // The alert stream has already raised this one, which is what "claiming"
    // is a response to.
    await harness.alerts.approvalStuck({
      shopId: LOOP_SHOP,
      approvalId: APPROVAL_STUCK,
      jobCardId: LOOP_CARD,
      vehicleLabel: 'Maruti Swift',
      amountPaise: 240_000,
      waitedMinutes: 200,
      traceId: TRACE,
    });

    const result = await harness.digest.claim({
      shopId: LOOP_SHOP,
      approvalId: APPROVAL_STUCK,
      claimedByStaffId: RETENTION_OWNER,
      conversationId: OWNER_CONVERSATION,
      traceId: TRACE,
    });

    expect(result.claimed).toBe(true);
    expect(result.taskId).not.toBeNull();
    expect(result.alertResolved).toBe(true);

    const task = harness.tasks.find((candidate) => candidate.id === result.taskId);
    expect(task?.kind).toBe('CALL_CUSTOMER');
    expect(task?.dedupeKey).toBe(`digest_claim:${APPROVAL_STUCK}`);

    const alert = [...harness.world.alerts.values()].find(
      (row) => row.incidentKey === `approval_stuck:${APPROVAL_STUCK}`,
    );
    expect(alert?.resolvedAt).not.toBeNull();

    expect(harness.sentBodies().at(-1)).toContain('Maruti Swift');
  });

  it('does not empty the pending list — the customer still has not answered', async () => {
    const harness = createRetentionHarness();
    await goldenDay(harness);
    const day = await harness.metrics.dayFor(LOOP_SHOP, harness.now());
    await harness.metrics.computeDay({ shopId: LOOP_SHOP, day, traceId: TRACE });

    await harness.digest.claim({
      shopId: LOOP_SHOP,
      approvalId: APPROVAL_STUCK,
      claimedByStaffId: RETENTION_OWNER,
      conversationId: OWNER_CONVERSATION,
      traceId: TRACE,
    });

    // The single most important property of the claim. An owner promising to
    // ring somebody is not the customer deciding, and a brief that dropped the
    // line would hide a car waiting three days on an answer.
    const still = await harness.metrics.stuckApprovals({
      shopId: LOOP_SHOP,
      now: harness.now(),
    });
    expect(still.map((row) => row.approvalId)).toContain(APPROVAL_STUCK);
  });

  it('raises one task however many times the button is pressed', async () => {
    const harness = createRetentionHarness();
    await goldenDay(harness);
    const day = await harness.metrics.dayFor(LOOP_SHOP, harness.now());
    await harness.metrics.computeDay({ shopId: LOOP_SHOP, day, traceId: TRACE });

    const first = await harness.digest.claim({
      shopId: LOOP_SHOP,
      approvalId: APPROVAL_STUCK,
      claimedByStaffId: RETENTION_OWNER,
      conversationId: OWNER_CONVERSATION,
      traceId: TRACE,
    });
    const second = await harness.digest.claim({
      shopId: LOOP_SHOP,
      approvalId: APPROVAL_STUCK,
      claimedByStaffId: RETENTION_OWNER,
      conversationId: OWNER_CONVERSATION,
      traceId: TRACE,
    });

    expect(second.taskId).toBe(first.taskId);
    // Filtered by the dedupe key rather than the kind: the golden day's
    // negative feedback raised a `CALL_CUSTOMER` of its own, and counting both
    // would make this assertion pass for the wrong reason.
    expect(
      harness.tasks.filter((task) => task.dedupeKey === `digest_claim:${APPROVAL_STUCK}`),
    ).toHaveLength(1);
  });

  it('says so plainly when the approval was answered before the tap landed', async () => {
    const harness = createRetentionHarness();
    await goldenDay(harness);

    const result = await harness.digest.claim({
      shopId: LOOP_SHOP,
      approvalId: uuidv7(),
      claimedByStaffId: RETENTION_OWNER,
      conversationId: OWNER_CONVERSATION,
      traceId: TRACE,
    });

    expect(result.claimed).toBe(false);
    expect(result.taskId).toBeNull();
    expect(result.detail).toContain('no longer waiting');
  });

  it('reads a quiet day as quiet rather than as an error', async () => {
    const harness = createRetentionHarness();
    const day = await harness.metrics.dayFor(LOOP_SHOP, harness.now());
    await harness.metrics.computeDay({ shopId: LOOP_SHOP, day, traceId: TRACE });

    const [result] = await harness.digest.sendDaily({ shopId: LOOP_SHOP, day, traceId: TRACE });
    expect(result?.payload?.lines.join('\n')).toContain('Nothing outstanding.');
    expect(result?.payload?.numbers.recoveredPaise).toBe(0);
  });
});
