import type { InvoiceConfig } from '@serviceloop/config';
import { applyRateBp, zonedParts, type EstimateLineKind, type Paise } from '@serviceloop/shared';

/**
 * Invoice construction and the GST split (phase 4.8) — pure, and deliberately
 * so: this is the arithmetic on a tax document a customer may hand to their
 * accountant, and it must be reproducible from its inputs alone.
 *
 * The rule that generates everything else: **intra-state supply splits the rate
 * into CGST and SGST; inter-state charges IGST at the full rate, and never
 * both.** Whether a supply is intra-state is decided by comparing the shop's
 * GST state code with the place of supply, which for a vehicle handed over at
 * the counter is the shop's own state — the overwhelmingly common case for an
 * independent workshop, and the default when nothing else is known.
 */

export interface InvoiceLineDraft {
  readonly estimateLineId: string | null;
  readonly workItemId: string | null;
  readonly description: string;
  readonly kind: EstimateLineKind;
  readonly hsnSac: string | null;
  readonly quantityMilli: number;
  readonly unitPricePaise: Paise;
  readonly lineTotalPaise: Paise;
  readonly taxRateBp: number;
  readonly cgstPaise: Paise;
  readonly sgstPaise: Paise;
  readonly igstPaise: Paise;
  /** Work added after intake and approved by the customer. */
  readonly isAdditionalWork: boolean;
  readonly approvedAt: Date | null;
  readonly evidenceMediaIds: readonly string[];
  readonly sequence: number;
}

export interface InvoiceDraft {
  readonly number: string;
  readonly subtotalPaise: Paise;
  readonly cgstPaise: Paise;
  readonly sgstPaise: Paise;
  readonly igstPaise: Paise;
  readonly totalPaise: Paise;
  readonly intraState: boolean;
  readonly sellerName: string;
  readonly sellerGstin: string | null;
  readonly sellerAddress: readonly string[];
  readonly sellerStateCode: string | null;
  readonly placeOfSupplyStateCode: string | null;
  readonly footerNote: string;
  readonly lines: readonly InvoiceLineDraft[];
  readonly evidenceMediaIds: readonly string[];
}

/** A billable line as the invoice builder receives it. */
export interface BillableLine {
  readonly estimateLineId: string | null;
  readonly workItemId: string | null;
  readonly description: string;
  readonly kind: EstimateLineKind;
  readonly quantityMilli: number;
  readonly unitPricePaise: Paise;
  readonly lineTotalPaise: Paise;
  readonly taxRateBp: number;
  readonly hsnSac?: string | null;
  readonly isAdditionalWork: boolean;
  readonly approvedAt: Date | null;
  /** Media backing this line — the appendix prints a block per line that has any. */
  readonly evidenceMediaIds?: readonly string[];
}

export interface BuildInvoiceInput {
  readonly number: string;
  readonly config: InvoiceConfig;
  readonly shopName: string;
  /** Where the service was supplied. Null means "assume the shop's own state". */
  readonly placeOfSupplyStateCode: string | null;
  readonly lines: readonly BillableLine[];
}

export type BuildInvoiceResult =
  | { readonly ok: true; readonly draft: InvoiceDraft }
  | { readonly ok: false; readonly code: string; readonly reason: string };

/**
 * Builds the invoice.
 *
 * Refuses rather than guessing when the shop has not filled in its legal
 * identity. A tax invoice printed with a placeholder name — or worse, with the
 * trading name where the registered name belongs — is a document with a false
 * statement on it, and the shop, not this system, is the one that answers for
 * it. The refusal names the missing field so an owner can fix it in one visit
 * to Settings.
 */
export function buildInvoice(input: BuildInvoiceInput): BuildInvoiceResult {
  if (input.lines.length === 0) {
    return {
      ok: false,
      code: 'NO_BILLABLE_LINES',
      reason: 'There is no approved work to invoice on this card',
    };
  }

  const legalName = input.config.legalName;
  if (legalName === null || legalName.trim().length === 0) {
    return {
      ok: false,
      code: 'INVOICE_IDENTITY_MISSING',
      reason:
        'This shop has no registered legal name configured, and an invoice cannot be issued without one. Set it in Settings → Invoice.',
    };
  }

  // A GSTIN with no state code cannot be split; the config refuses that pairing
  // at the schema, and this is the belt to its braces.
  const sellerState = input.config.stateCode;
  if (input.config.gstin !== null && sellerState === null) {
    return {
      ok: false,
      code: 'INVOICE_STATE_MISSING',
      reason: 'A GSTIN is configured but no GST state code, so the CGST/SGST split cannot be decided',
    };
  }

  const placeOfSupply = input.placeOfSupplyStateCode ?? sellerState;
  const intraState = sellerState === null || placeOfSupply === null || sellerState === placeOfSupply;

  const lines = input.lines.map((line, index): InvoiceLineDraft => {
    const tax = splitTax(line.lineTotalPaise, line.taxRateBp, intraState);
    return {
      estimateLineId: line.estimateLineId,
      workItemId: line.workItemId,
      description: line.description,
      kind: line.kind,
      hsnSac: line.hsnSac ?? input.config.defaultHsnSac,
      quantityMilli: line.quantityMilli,
      unitPricePaise: line.unitPricePaise,
      lineTotalPaise: line.lineTotalPaise,
      taxRateBp: line.taxRateBp,
      ...tax,
      isAdditionalWork: line.isAdditionalWork,
      approvedAt: line.approvedAt,
      evidenceMediaIds: [...(line.evidenceMediaIds ?? [])],
      sequence: index,
    };
  });

  const subtotalPaise = sum(lines.map((line) => line.lineTotalPaise));
  const cgstPaise = sum(lines.map((line) => line.cgstPaise));
  const sgstPaise = sum(lines.map((line) => line.sgstPaise));
  const igstPaise = sum(lines.map((line) => line.igstPaise));

  return {
    ok: true,
    draft: {
      number: input.number,
      subtotalPaise,
      cgstPaise,
      sgstPaise,
      igstPaise,
      totalPaise: subtotalPaise + cgstPaise + sgstPaise + igstPaise,
      intraState,
      sellerName: legalName,
      sellerGstin: input.config.gstin,
      sellerAddress: [...input.config.addressLines],
      sellerStateCode: sellerState,
      placeOfSupplyStateCode: placeOfSupply,
      footerNote: input.config.footerNote,
      lines,
      evidenceMediaIds: input.config.includeEvidenceAppendix
        ? dedupe(lines.filter((line) => line.isAdditionalWork).flatMap((line) => line.evidenceMediaIds))
        : [],
    },
  };
}

/**
 * The tax on one line, split the way the supply requires.
 *
 * The halves are computed as `floor` and `remainder` rather than as two
 * roundings, so CGST + SGST always equals the tax exactly. Two independent
 * `round(rate/2)` calls disagree with the total by a paisa on any odd amount,
 * and a tax invoice whose columns do not add up is one an accountant will send
 * back.
 */
export function splitTax(
  taxablePaise: Paise,
  rateBp: number,
  intraState: boolean,
): { readonly cgstPaise: Paise; readonly sgstPaise: Paise; readonly igstPaise: Paise } {
  const tax = applyRateBp(taxablePaise, rateBp);
  if (!intraState) return { cgstPaise: 0, sgstPaise: 0, igstPaise: tax };

  const cgst = Math.floor(tax / 2);
  return { cgstPaise: cgst, sgstPaise: tax - cgst, igstPaise: 0 };
}

/**
 * The next invoice number for a shop.
 *
 * Prefix, financial year, and a zero-padded sequence: `INV/2026-27/0042`. Two
 * details that are not decoration. The Indian financial year starts on 1 April,
 * so a series that reset on the calendar year would be wrong on the document
 * every April; and the year is read in the *shop's* zone, because an invoice
 * raised at 01:00 IST on 1 April is a new-financial-year invoice even though
 * UTC still thinks it is March.
 */
export function invoiceNumber(
  prefix: string,
  sequence: number,
  issuedAt: Date,
  timeZone: string,
): string {
  const parts = zonedParts(issuedAt, timeZone);
  const startYear = parts.month >= 4 ? parts.year : parts.year - 1;
  const financialYear = `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
  return `${prefix}/${financialYear}/${String(sequence).padStart(4, '0')}`;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function dedupe(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
