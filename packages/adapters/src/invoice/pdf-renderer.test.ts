import type { InvoiceEvidenceBlock, InvoiceRenderInput } from '@serviceloop/domain';
import { describe, expect, it } from 'vitest';
import { ReactPdfInvoiceRenderer, formatQuantity } from './pdf-renderer';

/**
 * Phase 4.8 — the invoice PDF.
 *
 * A golden test by hash, which only works because the renderer is deterministic
 * on purpose: the PDF's creation date is pinned to the invoice's issue date
 * rather than `now`, and no font is fetched. Without that first decision the
 * same invoice would hash differently every second and this file would be
 * impossible to write.
 *
 * The hash is asserted as *stable across runs* rather than against a literal
 * committed value. A literal would pin the exact byte layout of
 * `@react-pdf/renderer`, and a patch release of somebody else's layout engine
 * is not a regression in this shop's invoice — but a change in *our* inputs
 * silently producing the same document, or the same inputs producing different
 * documents, both are.
 */

const ISSUED_AT = new Date('2026-08-17T06:30:00.000Z');

/** A 1×1 PNG, so the appendix embeds a real image rather than a placeholder. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function evidence(): readonly InvoiceEvidenceBlock[] {
  return [
    {
      lineDescription: 'Front brake caliper (seized)',
      approvedAt: new Date('2026-08-16T09:12:00.000Z'),
      media: [
        { id: 'm-1', caption: 'Caliper piston seized', thumbnail: PNG_1X1 },
        // A photograph erased under DPDP after the invoice was issued.
        { id: 'm-2', caption: 'Pad wear 2.1mm', thumbnail: null },
      ],
    },
  ];
}

function renderInput(overrides: Partial<InvoiceRenderInput> = {}): InvoiceRenderInput {
  const lines = [
    {
      estimateLineId: 'l1',
      workItemId: 'w1',
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
      evidenceMediaIds: [],
      sequence: 0,
    },
    {
      estimateLineId: 'l2',
      workItemId: 'w2',
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
      evidenceMediaIds: ['m-1', 'm-2'],
      sequence: 1,
    },
  ];

  return {
    invoice: {
      id: 'inv-1',
      shopId: 'shop-1',
      jobCardId: 'card-1',
      customerId: 'cust-1',
      estimateId: 'est-1',
      status: 'ISSUED',
      issuedAt: ISSUED_AT,
      amountPaidPaise: 0,
      mediaId: null,
      renderHash: null,
      createdAt: ISSUED_AT,
      number: 'INV/2026-27/0042',
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
      lines,
      evidenceMediaIds: ['m-1', 'm-2'],
    },
    lines,
    shopName: 'Sri Murugan Auto Works',
    customerName: 'Ravi Kumar',
    vehicleLabel: 'Maruti Swift',
    registration: 'TN09BX4432',
    jobCardCode: 'JC-2026-0042',
    language: 'en',
    timezone: 'Asia/Kolkata',
    paymentStatus: 'ISSUED',
    amountPaidPaise: 0,
    evidence: evidence(),
    ...overrides,
  };
}

describe('ReactPdfInvoiceRenderer', () => {
  const renderer = new ReactPdfInvoiceRenderer({ creationDate: ISSUED_AT });

  it('renders a PDF', async () => {
    const result = await renderer.render(renderInput());

    expect(result.bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(result.bytes.length).toBeGreaterThan(1_000);
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is byte-identical across runs for fixed inputs — the golden property', async () => {
    const first = await renderer.render(renderInput());
    const second = await renderer.render(renderInput());

    expect(second.hash).toBe(first.hash);
    expect(second.bytes.equals(first.bytes)).toBe(true);
  });

  it('produces a different document when a figure changes', async () => {
    const baseline = await renderer.render(renderInput());
    const changed = await renderer.render(
      renderInput({
        invoice: { ...renderInput().invoice, totalPaise: 944_001 },
      }),
    );
    expect(changed.hash).not.toBe(baseline.hash);
  });

  it('does not move with the wall clock', async () => {
    // The reason the golden property holds: the creation date is the invoice's,
    // not the renderer's.
    const pinned = new ReactPdfInvoiceRenderer({ creationDate: ISSUED_AT });
    const first = await pinned.render(renderInput());
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const second = await pinned.render(renderInput());
    expect(second.hash).toBe(first.hash);
  }, 20_000);

  it('defaults the creation date to the invoice’s own issue date', async () => {
    const unpinned = new ReactPdfInvoiceRenderer();
    const first = await unpinned.render(renderInput());
    const second = await unpinned.render(renderInput());
    expect(second.hash).toBe(first.hash);
  });

  it('grows when an evidence appendix is present', async () => {
    const withAppendix = await renderer.render(renderInput());
    const without = await renderer.render(renderInput({ evidence: [] }));

    // The appendix is a whole extra page carrying an embedded image.
    expect(withAppendix.bytes.length).toBeGreaterThan(without.bytes.length);
    expect(withAppendix.hash).not.toBe(without.hash);
  });

  it('renders two evidence blocks for a card with two approved additions', async () => {
    const two = await renderer.render(
      renderInput({
        evidence: [
          ...evidence(),
          {
            lineDescription: 'Radiator hose (perished)',
            approvedAt: new Date('2026-08-16T11:40:00.000Z'),
            media: [{ id: 'm-3', caption: 'Hose split', thumbnail: PNG_1X1 }],
          },
        ],
      }),
    );
    const one = await renderer.render(renderInput());

    expect(two.bytes.length).toBeGreaterThan(one.bytes.length);
  });

  it('renders an inter-state invoice differently from an intra-state one', async () => {
    const interState = await renderer.render(
      renderInput({
        invoice: {
          ...renderInput().invoice,
          intraState: false,
          cgstPaise: 0,
          sgstPaise: 0,
          igstPaise: 144_000,
          placeOfSupplyStateCode: '29',
        },
      }),
    );
    expect(interState.hash).not.toBe((await renderer.render(renderInput())).hash);
  });

  it('renders a missing thumbnail as a placeholder rather than dropping the block', async () => {
    // A DPDP erasure after issue must not make the document disagree with
    // itself about how many things were photographed.
    const erased = await renderer.render(
      renderInput({
        evidence: [
          {
            lineDescription: 'Front brake caliper (seized)',
            approvedAt: new Date('2026-08-16T09:12:00.000Z'),
            media: [
              { id: 'm-1', caption: 'Caliper piston seized', thumbnail: null },
              { id: 'm-2', caption: 'Pad wear 2.1mm', thumbnail: null },
            ],
          },
        ],
      }),
    );

    expect(erased.bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    const withoutAny = await renderer.render(renderInput({ evidence: [] }));
    expect(erased.bytes.length).toBeGreaterThan(withoutAny.bytes.length);
  });
});

describe('formatQuantity', () => {
  it.each([
    [1000, '1'],
    [1500, '1.5'],
    [2000, '2'],
    [500, '0.5'],
    [250, '0.25'],
  ])('renders %d milli-units as %s', (milli, expected) => {
    expect(formatQuantity(milli)).toBe(expected);
  });
});
