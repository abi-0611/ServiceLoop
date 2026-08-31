import { describe, expect, it } from 'vitest';
import {
  BRAKES_PAISE,
  createLoopHarness,
  LOOP_CARD,
  LOOP_CUSTOMER,
  LOOP_SHOP,
  LOOP_T0,
  LOOP_TECHNICIAN,
  OIL_PAISE,
  type LoopHarness,
} from '../testing/loop-harness';

/**
 * The end of the loop as a working machine.
 *
 * `delivery.test.ts` next door proves the pure parts — slot arithmetic, GST
 * splits, the token's signature. This file proves the *services*: that the
 * ready message actually offers times and refuses to offer them twice, that a
 * second press of "payment link" re-uses the live one, that a retried webhook
 * credits nothing, that the balance ladder stops after two rungs and raises a
 * person, and that a gate pass opens the barrier exactly once.
 *
 * Every one of those is a rule about *money* or about *letting a car out*, and
 * both are places where being nearly right is not a partial success.
 */

const ACTOR = { type: 'STAFF' as const, id: LOOP_TECHNICIAN };
const SYSTEM = { type: 'SYSTEM' as const, id: null };
const TRACE = 'trace-delivery-services';
const TOTAL_PAISE = BRAKES_PAISE + OIL_PAISE;

/** Puts the card where the ready message is legal to send. */
function makeReady(harness: LoopHarness): void {
  harness.base.world.cards.set(LOOP_CARD, {
    id: LOOP_CARD,
    shopId: LOOP_SHOP,
    state: 'READY_FOR_DELIVERY',
    version: 2,
    stateChangedAt: harness.now(),
  });
  const card = harness.agent.agentWorld.cards.get(LOOP_CARD);
  if (card !== undefined) {
    harness.agent.agentWorld.putCard({ ...card, state: 'READY_FOR_DELIVERY' });
  }
}

async function issueInvoice(harness: LoopHarness) {
  return harness.invoices.issue({
    shopId: LOOP_SHOP,
    jobCardId: LOOP_CARD,
    placeOfSupplyStateCode: '33',
    actor: ACTOR,
    traceId: TRACE,
  });
}

function withInvoiceIdentity() {
  return createLoopHarness({
    configPatch: {
      invoice: {
        legalName: 'Sri Murugan Auto Works Private Limited',
        gstin: '33AABCS1429B1Z1',
        addressLines: ['14 Nelson Manickam Road, Chennai'],
        stateCode: '33',
        defaultHsnSac: null,
        numberPrefix: 'INV',
        footerNote: '',
        includeEvidenceAppendix: true,
      },
    },
  });
}

describe('DeliveryService.announceReady', () => {
  it('offers pickup times and records the booking', async () => {
    const harness = createLoopHarness();
    makeReady(harness);

    const result = await harness.delivery.announceReady({
      shopId: LOOP_SHOP,
      jobCardId: LOOP_CARD,
      actor: ACTOR,
      traceId: TRACE,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.offeredSlots.length).toBeGreaterThan(0);
    expect(result.amountDuePaise).toBe(TOTAL_PAISE);
    expect(harness.sentBodies().at(-1) ?? '').toMatch(/ready|Swift/i);
  });

  it('refuses a second offer rather than messaging the customer twice', async () => {
    const harness = createLoopHarness();
    makeReady(harness);

    await harness.delivery.announceReady({
      shopId: LOOP_SHOP,
      jobCardId: LOOP_CARD,
      actor: ACTOR,
      traceId: TRACE,
    });
    const before = harness.sentBodies().length;

    const again = await harness.delivery.announceReady({
      shopId: LOOP_SHOP,
      jobCardId: LOOP_CARD,
      actor: ACTOR,
      traceId: TRACE,
    });

    expect(again.ok).toBe(false);
    expect(harness.sentBodies()).toHaveLength(before);
  });

  it('books the slot the customer tapped, and only the first tap', async () => {
    const harness = createLoopHarness();
    makeReady(harness);
    const offered = await harness.delivery.announceReady({
      shopId: LOOP_SHOP,
      jobCardId: LOOP_CARD,
      actor: ACTOR,
      traceId: TRACE,
    });
    if (!offered.ok) throw new Error('nothing was offered');

    const first = await harness.delivery.chooseSlot({
      shopId: LOOP_SHOP,
      bookingId: offered.bookingId,
      slotIndex: 1,
      chosenVia: 'WHATSAPP',
      actor: { type: 'CUSTOMER', id: LOOP_CUSTOMER },
      traceId: TRACE,
    });
    // A customer who taps and sees nothing taps again.
    const second = await harness.delivery.chooseSlot({
      shopId: LOOP_SHOP,
      bookingId: offered.bookingId,
      slotIndex: 2,
      chosenVia: 'WHATSAPP',
      actor: { type: 'CUSTOMER', id: LOOP_CUSTOMER },
      traceId: TRACE,
    });

    expect(first.ok).toBe(true);
    const booking = await harness.delivery.openBooking(LOOP_SHOP, LOOP_CARD);
    expect(booking?.status).toBe('CHOSEN');
    expect(booking?.slotStart?.toISOString()).toBe(
      offered.offeredSlots[1]?.start.toISOString(),
    );
    // The second tap must not move the appointment out from under them.
    if (second.ok) {
      expect(second.slotStart.toISOString()).toBe(booking?.slotStart?.toISOString());
    }
  });

  it('refuses an index the booking was never offered', async () => {
    const harness = createLoopHarness();
    makeReady(harness);
    const offered = await harness.delivery.announceReady({
      shopId: LOOP_SHOP,
      jobCardId: LOOP_CARD,
      actor: ACTOR,
      traceId: TRACE,
    });
    if (!offered.ok) throw new Error('nothing was offered');

    const result = await harness.delivery.chooseSlot({
      shopId: LOOP_SHOP,
      bookingId: offered.bookingId,
      slotIndex: 99,
      chosenVia: 'WHATSAPP',
      actor: { type: 'CUSTOMER', id: LOOP_CUSTOMER },
      traceId: TRACE,
    });

    expect(result.ok).toBe(false);
  });
});

describe('InvoiceService', () => {
  it('refuses to print a tax document without the shop’s registered name', async () => {
    const harness = createLoopHarness();

    const result = await issueInvoice(harness);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The refusal names the missing field, because it is an owner's
    // five-second fix in Settings and not something an advisor can do.
    expect(result.reason.toLowerCase()).toContain('legal');
  });

  it('issues once, numbers it, and returns the same invoice on a second press', async () => {
    const harness = withInvoiceIdentity();

    const first = await issueInvoice(harness);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.number).toMatch(/^INV\//);
    expect(first.alreadyIssued).toBe(false);

    const second = await issueInvoice(harness);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // Two invoice numbers for one visit is precisely what a tax audit asks
    // about.
    expect(second.alreadyIssued).toBe(true);
    expect(second.number).toBe(first.number);
  });

  it('splits the tax between centre and state on an intra-state supply', async () => {
    const harness = withInvoiceIdentity();
    await issueInvoice(harness);

    const invoice = await harness.invoices.forCard(LOOP_SHOP, LOOP_CARD);
    expect(invoice).not.toBeNull();
    if (invoice === null) return;

    expect(invoice.igstPaise).toBe(0);
    expect(invoice.cgstPaise).toBe(invoice.sgstPaise);
    expect(invoice.subtotalPaise + invoice.cgstPaise + invoice.sgstPaise).toBe(
      invoice.totalPaise,
    );
  });

  it('charges IGST and no CGST when the supply crosses a state line', async () => {
    const harness = withInvoiceIdentity();

    const result = await harness.invoices.issue({
      shopId: LOOP_SHOP,
      jobCardId: LOOP_CARD,
      placeOfSupplyStateCode: '29',
      actor: ACTOR,
      traceId: TRACE,
    });
    expect(result.ok).toBe(true);

    const invoice = await harness.invoices.forCard(LOOP_SHOP, LOOP_CARD);
    expect(invoice?.cgstPaise).toBe(0);
    expect(invoice?.igstPaise).toBeGreaterThan(0);
  });
});

describe('PaymentService', () => {
  async function withLink(harness: LoopHarness) {
    const result = await harness.payments.createLink({
      shopId: LOOP_SHOP,
      jobCardId: LOOP_CARD,
      actor: ACTOR,
      traceId: TRACE,
    });
    if (!result.ok) throw new Error(`link refused: ${result.reason}`);
    return result;
  }

  it('mints one link and re-uses it however often the button is pressed', async () => {
    const harness = createLoopHarness();

    const first = await withLink(harness);
    const second = await harness.payments.createLink({
      shopId: LOOP_SHOP,
      jobCardId: LOOP_CARD,
      actor: ACTOR,
      traceId: TRACE,
    });

    expect(first.reused).toBe(false);
    expect(second.ok && second.reused).toBe(true);
    // A customer with two live links for one repair will eventually pay both.
    expect(harness.gateway.created).toHaveLength(1);
    expect(harness.gateway.created[0]?.amountPaise).toBe(TOTAL_PAISE);
  });

  it('settles the card when the money lands in full', async () => {
    const harness = createLoopHarness();
    makeReady(harness);
    const link = await withLink(harness);
    const payment = await harness.payments.openForCard(LOOP_SHOP, LOOP_CARD);

    const applied = await harness.payments.reconcile({
      event: {
        providerPaymentLinkId: payment?.providerPaymentLinkId as string,
        providerEventId: 'evt-1',
        providerPaymentId: 'pay-1',
        kind: 'PAID',
        amountPaise: link.amountPaise,
        method: 'UPI',
        instrument: 'customer@upi',
        failureReason: null,
        occurredAt: harness.now(),
        raw: {},
      },
      actor: SYSTEM,
      traceId: TRACE,
    });

    expect(applied.handled).toBe(true);
    expect(applied.status).toBe('PAID');
    expect(applied.balancePaise).toBe(0);
    // A fully paid card must not be left in the one state that means "still
    // owed" — the balance ladder reads it.
    expect(harness.base.world.cards.get(LOOP_CARD)?.state).toBe('DELIVERED');
  });

  it('credits a retried webhook exactly once', async () => {
    const harness = createLoopHarness();
    makeReady(harness);
    const link = await withLink(harness);
    const payment = await harness.payments.openForCard(LOOP_SHOP, LOOP_CARD);

    const event = {
      providerPaymentLinkId: payment?.providerPaymentLinkId as string,
      providerEventId: 'evt-retry',
      providerPaymentId: 'pay-1',
      kind: 'PAID' as const,
      amountPaise: link.amountPaise,
      method: 'UPI' as const,
      instrument: null,
      failureReason: null,
      occurredAt: harness.now(),
      raw: {},
    };

    const first = await harness.payments.reconcile({ event, actor: SYSTEM, traceId: TRACE });
    const retry = await harness.payments.reconcile({ event, actor: SYSTEM, traceId: TRACE });

    expect(first.duplicate).toBe(false);
    expect(retry.duplicate).toBe(true);
    expect(retry.amountPaidPaise).toBe(first.amountPaidPaise);
  });

  it('records a part payment and keeps the balance owing', async () => {
    const harness = createLoopHarness({
      configPatch: {
        payments: {
          paymentBeforeDelivery: true,
          acceptPartialPayment: true,
          minimumFirstPaymentPercent: 50,
          paymentLinkExpiryMinutes: 4320,
          balanceReminderAfterMinutes: [1440, 4320],
          gatePassTtlMinutes: 720,
          requireGatePass: true,
        },
      },
    });
    const link = await withLink(harness);
    const payment = await harness.payments.openForCard(LOOP_SHOP, LOOP_CARD);

    const applied = await harness.payments.reconcile({
      event: {
        providerPaymentLinkId: payment?.providerPaymentLinkId as string,
        providerEventId: 'evt-part',
        providerPaymentId: 'pay-part',
        kind: 'PARTIALLY_PAID',
        amountPaise: Math.round(link.amountPaise / 2),
        method: 'UPI',
        instrument: null,
        failureReason: null,
        occurredAt: harness.now(),
        raw: {},
      },
      actor: SYSTEM,
      traceId: TRACE,
    });

    expect(applied.status).toBe('PARTIALLY_PAID');
    expect(applied.balancePaise).toBe(link.amountPaise - Math.round(link.amountPaise / 2));
    expect(harness.base.world.cards.get(LOOP_CARD)?.state).toBe('IN_PROGRESS');
  });

  it('records cash taken at the counter, because that is how most shops are paid', async () => {
    const harness = createLoopHarness();
    makeReady(harness);
    await withLink(harness);
    const payment = await harness.payments.openForCard(LOOP_SHOP, LOOP_CARD);

    const recorded = await harness.payments.recordManualPayment({
      shopId: LOOP_SHOP,
      paymentId: payment?.id as string,
      amountPaise: TOTAL_PAISE,
      method: 'CASH',
      staffId: LOOP_TECHNICIAN,
      note: 'Counter',
      actor: ACTOR,
      traceId: TRACE,
    });

    expect(recorded.handled).toBe(true);
    expect(recorded.status).toBe('PAID');
    expect(harness.base.world.cards.get(LOOP_CARD)?.state).toBe('DELIVERED');
  });

  it('stops the balance ladder after two rungs and raises a person', async () => {
    const harness = createLoopHarness();
    await withLink(harness);
    const payment = await harness.payments.openForCard(LOOP_SHOP, LOOP_CARD);
    const paymentId = payment?.id as string;

    const rung = async () =>
      harness.payments.sendBalanceReminder({
        shopId: LOOP_SHOP,
        paymentId,
        actor: SYSTEM,
        traceId: TRACE,
      });

    harness.advanceMinutes(24 * 60);
    const first = await rung();
    harness.advanceMinutes(48 * 60);
    const second = await rung();
    harness.advanceMinutes(48 * 60);
    const third = await rung();

    expect(first.sent, first.detail).toBe(true);
    expect(second.sent, second.detail).toBe(true);
    // Everything else in this system retries. This is the one place where the
    // retry is a message to a person about money, so it stops and asks a human.
    expect(third.sent).toBe(false);
    expect([...harness.agent.agentWorld.tasks.values()].length).toBeGreaterThan(0);
  });
});

describe('GatePassService', () => {
  async function settle(harness: LoopHarness): Promise<void> {
    makeReady(harness);
    const link = await harness.payments.createLink({
      shopId: LOOP_SHOP,
      jobCardId: LOOP_CARD,
      actor: ACTOR,
      traceId: TRACE,
    });
    if (!link.ok) throw new Error('no link');
    const payment = await harness.payments.openForCard(LOOP_SHOP, LOOP_CARD);
    await harness.payments.reconcile({
      event: {
        providerPaymentLinkId: payment?.providerPaymentLinkId as string,
        providerEventId: 'evt-settle',
        providerPaymentId: 'pay-settle',
        kind: 'PAID',
        amountPaise: link.amountPaise,
        method: 'UPI',
        instrument: null,
        failureReason: null,
        occurredAt: harness.now(),
        raw: {},
      },
      actor: SYSTEM,
      traceId: TRACE,
    });
  }

  it('refuses to release a vehicle with money outstanding', async () => {
    const harness = createLoopHarness();
    makeReady(harness);
    await harness.payments.createLink({
      shopId: LOOP_SHOP,
      jobCardId: LOOP_CARD,
      actor: ACTOR,
      traceId: TRACE,
    });

    const result = await harness.gatePasses.issue({
      shopId: LOOP_SHOP,
      jobCardId: LOOP_CARD,
      actor: ACTOR,
      traceId: TRACE,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('BALANCE_OUTSTANDING');
  });

  it('releases it on an owner’s recorded override', async () => {
    const harness = createLoopHarness();
    makeReady(harness);
    await harness.payments.createLink({
      shopId: LOOP_SHOP,
      jobCardId: LOOP_CARD,
      actor: ACTOR,
      traceId: TRACE,
    });

    const result = await harness.gatePasses.issue({
      shopId: LOOP_SHOP,
      jobCardId: LOOP_CARD,
      overrideReason: 'Regular customer, settling on Monday',
      overrideByStaffId: LOOP_TECHNICIAN,
      actor: ACTOR,
      traceId: TRACE,
    });

    expect(result.ok).toBe(true);
    // Not a loophole — the shop's own decision, with a name against it.
    const audited = harness.base.world
      .auditFor(LOOP_SHOP)
      .find((entry) => entry.action === 'gate_pass.issued');
    expect((audited?.payload as { overrideReason?: string }).overrideReason).toContain('Monday');
  });

  it('opens the barrier once, and says which red it is afterwards', async () => {
    const harness = createLoopHarness();
    await settle(harness);

    const issued = await harness.gatePasses.issue({
      shopId: LOOP_SHOP,
      jobCardId: LOOP_CARD,
      actor: ACTOR,
      traceId: TRACE,
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const verify = (code: string) =>
      harness.gatePasses.verify({
        shopId: LOOP_SHOP,
        token: null,
        code,
        staffId: LOOP_TECHNICIAN,
        actor: ACTOR,
        traceId: TRACE,
      });

    const first = await verify(issued.code);
    expect(first.result).toBe('VALID');
    expect(first.summary?.registration).toBe('TN09BX4432');

    const second = await verify(issued.code);
    expect(second.result).toBe('ALREADY_USED');
  });

  it('refuses a token that was tampered with', async () => {
    const harness = createLoopHarness();
    await settle(harness);
    const issued = await harness.gatePasses.issue({
      shopId: LOOP_SHOP,
      jobCardId: LOOP_CARD,
      actor: ACTOR,
      traceId: TRACE,
    });
    if (!issued.ok) return;

    const forged = await harness.gatePasses.verify({
      shopId: LOOP_SHOP,
      token: `${issued.token.slice(0, -4)}0000`,
      code: null,
      staffId: LOOP_TECHNICIAN,
      actor: ACTOR,
      traceId: TRACE,
    });

    expect(forged.result).not.toBe('VALID');
  });

  it('refuses a pass whose time has run out', async () => {
    const harness = createLoopHarness();
    await settle(harness);
    const issued = await harness.gatePasses.issue({
      shopId: LOOP_SHOP,
      jobCardId: LOOP_CARD,
      actor: ACTOR,
      traceId: TRACE,
    });
    if (!issued.ok) return;

    // A QR lives in a chat thread for ever; the pass must not.
    harness.setNow(new Date(LOOP_T0.getTime() + 30 * 24 * 60 * 60_000));

    const late = await harness.gatePasses.verify({
      shopId: LOOP_SHOP,
      token: issued.token,
      code: null,
      staffId: LOOP_TECHNICIAN,
      actor: ACTOR,
      traceId: TRACE,
    });

    expect(late.result).toBe('EXPIRED');
  });

  it('stops working once an owner revokes it', async () => {
    const harness = createLoopHarness();
    await settle(harness);
    const issued = await harness.gatePasses.issue({
      shopId: LOOP_SHOP,
      jobCardId: LOOP_CARD,
      actor: ACTOR,
      traceId: TRACE,
    });
    if (!issued.ok) return;

    const revoked = await harness.gatePasses.revoke({
      shopId: LOOP_SHOP,
      gatePassId: issued.gatePassId,
      reason: 'Customer sent somebody else',
      actor: ACTOR,
      traceId: TRACE,
    });
    expect(revoked).toBe(true);

    const verdict = await harness.gatePasses.verify({
      shopId: LOOP_SHOP,
      token: null,
      code: issued.code,
      staffId: LOOP_TECHNICIAN,
      actor: ACTOR,
      traceId: TRACE,
    });
    expect(verdict.result).toBe('REVOKED');
  });
});
