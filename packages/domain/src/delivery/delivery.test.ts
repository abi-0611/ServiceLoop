import { defaultShopConfig, type InvoiceConfig, type ShopConfig } from '@serviceloop/config';
import { applyRateBp, instantFromZonedParts, type WorkingWindow } from '@serviceloop/shared';
import { describe, expect, it } from 'vitest';
import { buildInvoice, invoiceNumber, splitTax, type BillableLine } from './invoice-builder';
import { financialYearOf, toBillableLines } from './invoice-service';
import { nextStatus } from './payment-service';
import {
  generateGatePassCode,
  hashToken,
  signGatePass,
  verifyGatePassToken,
} from './gate-pass-token';
import { overlapsRush, slotStillAvailable, suggestSlots } from './slots';

const IST = 'Asia/Kolkata';
const HOURS: WorkingWindow = { days: [1, 2, 3, 4, 5, 6], open: '09:00', close: '19:00' };
const config: ShopConfig = defaultShopConfig(IST);

function ist(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return instantFromZonedParts({ year, month, day, hour, minute }, IST);
}

/* -------------------------------------------------------------------------- *
 * 4.7 — pickup slotting
 * -------------------------------------------------------------------------- */

describe('suggestSlots', () => {
  it('offers three slots inside shop hours, an hour out at the earliest', () => {
    const slots = suggestSlots({
      from: ist(2026, 8, 17, 10, 0),
      timezone: IST,
      workingHours: HOURS,
      config: config.delivery,
      booked: [],
    });

    expect(slots).toHaveLength(3);
    // 10:00 + 60 minutes earliest offset lands on the 11:00 bin.
    expect(slots[0]?.start.toISOString()).toBe(ist(2026, 8, 17, 11, 0).toISOString());
    expect(slots[1]?.start.toISOString()).toBe(ist(2026, 8, 17, 11, 30).toISOString());
    expect(slots[2]?.start.toISOString()).toBe(ist(2026, 8, 17, 12, 0).toISOString());
    expect(slots[0]?.end.toISOString()).toBe(ist(2026, 8, 17, 11, 30).toISOString());
  });

  it('never offers a slot inside a configured rush window', () => {
    const slots = suggestSlots({
      from: ist(2026, 8, 17, 11, 30),
      timezone: IST,
      workingHours: HOURS,
      config: config.delivery,
      booked: [],
      count: 3,
    });

    // The shipped rush window is 13:00–14:00: the 12:30 bin runs into it, so the
    // offers jump straight from 12:00 to 14:00.
    const starts = slots.map((slot) => slot.start.toISOString());
    expect(starts).toContain(ist(2026, 8, 17, 12, 30).toISOString());
    expect(starts).not.toContain(ist(2026, 8, 17, 13, 0).toISOString());
    expect(starts).not.toContain(ist(2026, 8, 17, 13, 30).toISOString());
  });

  it('treats a bin that merely overlaps a rush window as unavailable', () => {
    // 12:45–13:15 runs into the 13:00 rush even though it starts before it.
    expect(overlapsRush(12 * 60 + 45, 13 * 60 + 15, config.delivery)).toBe(true);
    expect(overlapsRush(12 * 60, 12 * 60 + 30, config.delivery)).toBe(false);
  });

  it('skips a bin that is already at capacity', () => {
    const full = ist(2026, 8, 17, 11, 0);
    const slots = suggestSlots({
      from: ist(2026, 8, 17, 10, 0),
      timezone: IST,
      workingHours: HOURS,
      config: config.delivery,
      // maxPickupsPerSlot defaults to 2.
      booked: [full, full],
    });

    expect(slots.map((slot) => slot.start.toISOString())).not.toContain(full.toISOString());
    expect(slots[0]?.start.toISOString()).toBe(ist(2026, 8, 17, 11, 30).toISOString());
  });

  it('rolls over to the next working day rather than offering a closed shop', () => {
    const slots = suggestSlots({
      from: ist(2026, 8, 22, 18, 30),
      timezone: IST,
      workingHours: HOURS,
      config: config.delivery,
      booked: [],
    });

    // Saturday 18:30 + 60 minutes is past closing, and Sunday is shut.
    expect(slots[0]?.start.toISOString()).toBe(ist(2026, 8, 24, 9, 0).toISOString());
  });

  it('returns nothing rather than relaxing a cap when the shop is genuinely full', () => {
    const shortHorizon = { ...config.delivery, rushWindows: [{ start: '09:00', end: '19:00' }] };
    const slots = suggestSlots({
      from: ist(2026, 8, 17, 10, 0),
      timezone: IST,
      workingHours: HOURS,
      config: shortHorizon,
      booked: [],
    });
    expect(slots).toHaveLength(0);
  });

  it('re-checks availability when the tap arrives, not only when slots were composed', () => {
    const slot = ist(2026, 8, 17, 11, 0);
    expect(slotStillAvailable(slot, [slot], config.delivery)).toBe(true);
    expect(slotStillAvailable(slot, [slot, slot], config.delivery)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- *
 * 4.8 — GST arithmetic
 * -------------------------------------------------------------------------- */

const INVOICE_CONFIG: InvoiceConfig = {
  legalName: 'Sri Murugan Auto Works',
  gstin: '33AABCS1429B1ZQ',
  addressLines: ['12 Anna Salai', 'Chennai 600002'],
  stateCode: '33',
  defaultHsnSac: '998714',
  numberPrefix: 'INV',
  footerNote: 'Thank you for your custom.',
  includeEvidenceAppendix: true,
};

function line(partial: Partial<BillableLine> & { lineTotalPaise: number }): BillableLine {
  return {
    estimateLineId: 'line-1',
    workItemId: 'w-1',
    description: 'Front brake pads (set)',
    kind: 'PART',
    quantityMilli: 1000,
    unitPricePaise: partial.lineTotalPaise,
    taxRateBp: 1800,
    isAdditionalWork: false,
    approvedAt: null,
    ...partial,
  };
}

describe('splitTax', () => {
  it('splits an intra-state supply into two halves that add up exactly', () => {
    // 18% of ₹3,205.00 is ₹576.90 — an odd number of paise.
    const taxable = 320_500;
    const tax = applyRateBp(taxable, 1800);
    expect(tax).toBe(57_690);

    const split = splitTax(taxable, 1800, true);
    expect(split.cgstPaise + split.sgstPaise).toBe(tax);
    expect(split.igstPaise).toBe(0);
  });

  it('never produces a rounding gap, on any amount', () => {
    for (let taxable = 1; taxable <= 2_000; taxable += 7) {
      const split = splitTax(taxable, 1800, true);
      expect(split.cgstPaise + split.sgstPaise).toBe(applyRateBp(taxable, 1800));
    }
  });

  it('charges IGST and nothing else on an inter-state supply', () => {
    const split = splitTax(320_000, 1800, false);
    expect(split.igstPaise).toBe(57_600);
    expect(split.cgstPaise).toBe(0);
    expect(split.sgstPaise).toBe(0);
  });
});

describe('buildInvoice', () => {
  it('totals to the sum of its parts, and splits intra-state', () => {
    const built = buildInvoice({
      number: 'INV/2026-27/0001',
      config: INVOICE_CONFIG,
      shopName: 'Sri Murugan Auto Works',
      placeOfSupplyStateCode: '33',
      lines: [
        line({ lineTotalPaise: 320_000, description: 'Front brake pads (set)' }),
        line({
          lineTotalPaise: 160_000,
          description: 'Engine oil and filter',
          kind: 'CONSUMABLE',
          estimateLineId: 'line-2',
          workItemId: 'w-2',
        }),
      ],
    });

    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.draft.intraState).toBe(true);
    expect(built.draft.subtotalPaise).toBe(480_000);
    expect(built.draft.cgstPaise).toBe(43_200);
    expect(built.draft.sgstPaise).toBe(43_200);
    expect(built.draft.igstPaise).toBe(0);
    expect(built.draft.totalPaise).toBe(566_400);
    expect(built.draft.totalPaise).toBe(
      built.draft.subtotalPaise + built.draft.cgstPaise + built.draft.sgstPaise,
    );
  });

  it('charges IGST when the place of supply is another state', () => {
    const built = buildInvoice({
      number: 'INV/2026-27/0002',
      config: INVOICE_CONFIG,
      shopName: 'Sri Murugan Auto Works',
      placeOfSupplyStateCode: '29',
      lines: [line({ lineTotalPaise: 100_000 })],
    });

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.draft.intraState).toBe(false);
    expect(built.draft.igstPaise).toBe(18_000);
    expect(built.draft.cgstPaise).toBe(0);
  });

  it('assumes the shop’s own state when the place of supply is unknown', () => {
    const built = buildInvoice({
      number: 'INV/2026-27/0003',
      config: INVOICE_CONFIG,
      shopName: 'Sri Murugan Auto Works',
      placeOfSupplyStateCode: null,
      lines: [line({ lineTotalPaise: 100_000 })],
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.draft.intraState).toBe(true);
  });

  it('refuses rather than printing a placeholder legal name', () => {
    const built = buildInvoice({
      number: 'INV/2026-27/0004',
      config: { ...INVOICE_CONFIG, legalName: null },
      shopName: 'Sri Murugan Auto Works',
      placeOfSupplyStateCode: '33',
      lines: [line({ lineTotalPaise: 100_000 })],
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.code).toBe('INVOICE_IDENTITY_MISSING');
    expect(built.reason).toContain('Settings');
  });

  it('refuses an invoice with nothing on it', () => {
    const built = buildInvoice({
      number: 'INV/2026-27/0005',
      config: INVOICE_CONFIG,
      shopName: 'Sri Murugan Auto Works',
      placeOfSupplyStateCode: '33',
      lines: [],
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.code).toBe('NO_BILLABLE_LINES');
  });

  it('collects evidence media only from additional-work lines', () => {
    const built = buildInvoice({
      number: 'INV/2026-27/0006',
      config: INVOICE_CONFIG,
      shopName: 'Sri Murugan Auto Works',
      placeOfSupplyStateCode: '33',
      lines: [
        line({ lineTotalPaise: 100_000, evidenceMediaIds: ['m-original'] }),
        line({
          lineTotalPaise: 200_000,
          estimateLineId: 'line-2',
          isAdditionalWork: true,
          evidenceMediaIds: ['m-caliper', 'm-caliper-2'],
        }),
        line({
          lineTotalPaise: 50_000,
          estimateLineId: 'line-3',
          isAdditionalWork: true,
          evidenceMediaIds: ['m-caliper'],
        }),
      ],
    });

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    // Deduped, and the non-additional line's media does not appear.
    expect([...built.draft.evidenceMediaIds].sort()).toEqual(['m-caliper', 'm-caliper-2']);
  });

  it('falls back to the configured HSN when a line carries none', () => {
    const built = buildInvoice({
      number: 'INV/2026-27/0007',
      config: INVOICE_CONFIG,
      shopName: 'Sri Murugan Auto Works',
      placeOfSupplyStateCode: '33',
      lines: [line({ lineTotalPaise: 100_000 }), line({ lineTotalPaise: 100_000, hsnSac: '87089900' })],
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.draft.lines[0]?.hsnSac).toBe('998714');
    expect(built.draft.lines[1]?.hsnSac).toBe('87089900');
  });
});

describe('invoice numbering', () => {
  it('uses the Indian financial year, not the calendar year', () => {
    expect(invoiceNumber('INV', 42, ist(2026, 8, 17, 12), IST)).toBe('INV/2026-27/0042');
    // 31 March is still the old year; 1 April is the new one.
    expect(invoiceNumber('INV', 1, ist(2027, 3, 31, 23), IST)).toBe('INV/2026-27/0001');
    expect(invoiceNumber('INV', 1, ist(2027, 4, 1, 1), IST)).toBe('INV/2027-28/0001');
  });

  it('reads the year in the shop’s zone, not UTC', () => {
    // 01:00 IST on 1 April is 19:30 UTC on 31 March. The shop's answer wins.
    const justAfterMidnightIst = ist(2027, 4, 1, 1);
    expect(justAfterMidnightIst.toISOString()).toContain('2027-03-31');
    expect(financialYearOf(justAfterMidnightIst, IST)).toBe('2027-28');
  });
});

describe('toBillableLines', () => {
  const card = {
    workItems: [
      { id: 'w-approved', state: 'APPROVED', title: 'Brakes' },
      { id: 'w-done', state: 'DONE', title: 'Oil' },
      { id: 'w-declined', state: 'DECLINED', title: 'Wipers' },
      { id: 'w-pending', state: 'PENDING_APPROVAL', title: 'Belt' },
    ],
    estimate: {
      lines: [
        { id: 'l1', workItemId: 'w-approved', description: 'Brakes', kind: 'PART' as const, quantityMilli: 1000, unitPricePaise: 100, lineTotalPaise: 100, taxRateBp: 1800 },
        { id: 'l2', workItemId: 'w-done', description: 'Oil', kind: 'CONSUMABLE' as const, quantityMilli: 1000, unitPricePaise: 100, lineTotalPaise: 100, taxRateBp: 1800 },
        { id: 'l3', workItemId: 'w-declined', description: 'Wipers', kind: 'PART' as const, quantityMilli: 1000, unitPricePaise: 100, lineTotalPaise: 100, taxRateBp: 1800 },
        { id: 'l4', workItemId: 'w-pending', description: 'Belt', kind: 'PART' as const, quantityMilli: 1000, unitPricePaise: 100, lineTotalPaise: 100, taxRateBp: 1800 },
        { id: 'l5', workItemId: null, description: 'Shop supplies', kind: 'FEE' as const, quantityMilli: 1000, unitPricePaise: 50, lineTotalPaise: 50, taxRateBp: 1800 },
      ],
    },
    media: [{ id: 'm1', workItemId: 'w-approved' }],
    promisedAt: null,
  };

  it('bills only what the customer said yes to, plus unconditional fees', () => {
    const lines = toBillableLines(card);
    expect(lines.map((entry) => entry.estimateLineId)).toEqual(['l1', 'l2', 'l5']);
  });

  it('marks a line backed by photographs as additional work', () => {
    const lines = toBillableLines(card);
    expect(lines.find((entry) => entry.estimateLineId === 'l1')?.isAdditionalWork).toBe(true);
    expect(lines.find((entry) => entry.estimateLineId === 'l2')?.isAdditionalWork).toBe(false);
  });
});

/* -------------------------------------------------------------------------- *
 * 4.9 — payment status arithmetic
 * -------------------------------------------------------------------------- */

describe('nextStatus', () => {
  it('settles on the amount, not on the provider’s label', () => {
    // Two "partially paid" events that together cover the invoice.
    expect(nextStatus('PARTIALLY_PAID', 250_000, 500_000)).toBe('PARTIALLY_PAID');
    expect(nextStatus('PARTIALLY_PAID', 500_000, 500_000)).toBe('PAID');
  });

  it('treats an overpayment as paid', () => {
    expect(nextStatus('PAID', 510_000, 500_000)).toBe('PAID');
  });

  it('does not lose money already banked when a later attempt fails', () => {
    expect(nextStatus('FAILED', 250_000, 500_000)).toBe('PARTIALLY_PAID');
    expect(nextStatus('EXPIRED', 250_000, 500_000)).toBe('PARTIALLY_PAID');
    expect(nextStatus('CANCELLED', 250_000, 500_000)).toBe('PARTIALLY_PAID');
  });

  it('reports a clean failure when nothing was ever paid', () => {
    expect(nextStatus('FAILED', 0, 500_000)).toBe('FAILED');
    expect(nextStatus('EXPIRED', 0, 500_000)).toBe('EXPIRED');
  });

  it('records a counter payment like any other', () => {
    expect(nextStatus('MANUAL_RECORD', 500_000, 500_000)).toBe('PAID');
  });
});

/* -------------------------------------------------------------------------- *
 * 4.10 — gate pass tokens
 * -------------------------------------------------------------------------- */

describe('gate-pass tokens', () => {
  const SECRET = 'a-test-signing-secret-of-adequate-length';
  const now = ist(2026, 8, 17, 17, 0);
  const claims = {
    gatePassId: '018f0000-0000-7000-8000-000000000001',
    jobCardId: '018f0000-0000-7000-8000-000000000002',
    shopId: '018f0000-0000-7000-8000-000000000003',
    exp: Math.floor(ist(2026, 8, 18, 5, 0).getTime() / 1000),
  };

  it('round-trips a signed pass', () => {
    const signed = signGatePass(claims, SECRET);
    const verdict = verifyGatePassToken(signed.token, SECRET, now);

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.claims.gatePassId).toBe(claims.gatePassId);
    expect(verdict.claims.jobCardId).toBe(claims.jobCardId);
  });

  it('rejects a token signed with a different secret', () => {
    const signed = signGatePass(claims, 'somebody-elses-secret-of-adequate-len');
    const verdict = verifyGatePassToken(signed.token, SECRET, now);
    expect(verdict).toEqual({ ok: false, result: 'FORGED' });
  });

  it('rejects a tampered payload', () => {
    const signed = signGatePass(claims, SECRET);
    const [prefix, body, signature] = signed.token.split('.');
    const forgedBody = Buffer.from(
      JSON.stringify({ ...claims, jobCardId: 'someone-elses-car' }),
      'utf8',
    )
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    expect(body).not.toBe(forgedBody);
    const verdict = verifyGatePassToken(`${prefix}.${forgedBody}.${signature}`, SECRET, now);
    expect(verdict).toEqual({ ok: false, result: 'FORGED' });
  });

  it.each([['not-a-token'], ['v1.only-two-parts'], ['v2.abc.def'], ['']])(
    'rejects the malformed token %s as forged',
    (token) => {
      expect(verifyGatePassToken(token, SECRET, now)).toEqual({ ok: false, result: 'FORGED' });
    },
  );

  it('rejects an expired pass', () => {
    const signed = signGatePass(claims, SECRET);
    const nextDay = ist(2026, 8, 18, 6, 0);
    expect(verifyGatePassToken(signed.token, SECRET, nextDay)).toEqual({
      ok: false,
      result: 'EXPIRED',
    });
  });

  it('reports a forgery as forged even when it has also expired', () => {
    // Expiry is checked after the signature; saying "expired" for an unsigned
    // token would tell an attacker their forgery parsed.
    const stale = { ...claims, exp: Math.floor(ist(2026, 8, 16, 5, 0).getTime() / 1000) };
    const signed = signGatePass(stale, 'wrong-secret-but-long-enough-to-use');
    expect(verifyGatePassToken(signed.token, SECRET, now)).toEqual({
      ok: false,
      result: 'FORGED',
    });
  });

  it('stores only a hash, from which no token can be recovered', () => {
    const signed = signGatePass(claims, SECRET);
    expect(signed.tokenHash).not.toContain(signed.token);
    expect(signed.tokenHash).toHaveLength(64);
    expect(hashToken(signed.token)).toBe(signed.tokenHash);
    expect(hashToken(`${signed.token}x`)).not.toBe(signed.tokenHash);
  });

  it('mints codes a person can read off a screen in the rain', () => {
    const codes = new Set<string>();
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const code = generateGatePassCode();
      expect(code).toHaveLength(6);
      // No 0/O, 1/I/L, 8/B or 5/S — the pairs a gate person mistypes.
      expect(code).toMatch(/^[23467ACDEFGHJKMNPQRTUVWXYZ]{6}$/);
      codes.add(code);
    }
    // Not a uniqueness guarantee — the unique index is — but 400 draws
    // colliding heavily would mean the generator is broken.
    expect(codes.size).toBeGreaterThan(390);
  });
});
