import { createHash } from 'node:crypto';
import {
  Document,
  Image,
  Page,
  StyleSheet,
  Text,
  View,
  renderToBuffer,
  type DocumentProps,
} from '@react-pdf/renderer';
import type {
  InvoiceEvidenceBlock,
  InvoiceRenderInput,
  InvoiceRenderer,
} from '@serviceloop/domain';
import { formatPaise, zonedParts } from '@serviceloop/shared';
import { createElement, type ReactElement } from 'react';

/**
 * `ReactPdfInvoiceRenderer` — the invoice PDF (phase 4.8).
 *
 * `@react-pdf/renderer` server-side rather than a headless browser (master §2):
 * a workshop's invoice does not need a browser engine, and shipping Chromium
 * into a Cloud Run image to lay out a table is a 300 MB answer to a 30 KB
 * question.
 *
 * Written with `createElement` rather than JSX on purpose. The adapters package
 * compiles as plain TypeScript with no JSX pragma, and adding one so a single
 * file can use angle brackets would change how *every* file in the package is
 * compiled. The layout below is verbose as a result and reads top-to-bottom in
 * exactly the order the page prints.
 *
 * ## Determinism
 *
 * The output is byte-stable for fixed inputs, which is what makes the golden
 * test a golden test — with two things forced to make it so: the PDF's creation
 * date is pinned to the invoice's own issue date rather than `now`, and no font
 * is loaded from the network. Without the first, the same invoice hashes
 * differently every second.
 */

export interface PdfRendererOptions {
  /** Overridden by the golden test so the hash does not move with the clock. */
  readonly creationDate?: Date;
}

export class ReactPdfInvoiceRenderer implements InvoiceRenderer {
  constructor(private readonly options: PdfRendererOptions = {}) {}

  async render(input: InvoiceRenderInput): Promise<{ readonly bytes: Buffer; readonly hash: string }> {
    const bytes = await renderToBuffer(
      buildDocument(input, this.options.creationDate ?? input.invoice.issuedAt ?? EPOCH),
    );
    return { bytes, hash: createHash('sha256').update(bytes).digest('hex') };
  }
}

/** A fixed fallback so a draft with no issue date still renders deterministically. */
const EPOCH = new Date('2020-01-01T00:00:00.000Z');

const styles = StyleSheet.create({
  page: { padding: 32, fontSize: 9, lineHeight: 1.4, color: '#111827' },
  header: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 16 },
  sellerName: { fontSize: 15, marginBottom: 2 },
  muted: { color: '#6B7280' },
  title: { fontSize: 12, textAlign: 'right' },
  section: { marginBottom: 12 },
  sectionTitle: { fontSize: 8, color: '#6B7280', marginBottom: 3, textTransform: 'uppercase' },
  row: { flexDirection: 'row' },
  tableHead: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#111827',
    paddingBottom: 3,
    marginBottom: 3,
  },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: 0.5,
    borderBottomColor: '#E5E7EB',
    paddingVertical: 3,
  },
  cellDescription: { flex: 4 },
  cellHsn: { flex: 1.2 },
  cellQty: { flex: 1, textAlign: 'right' },
  cellRate: { flex: 1.4, textAlign: 'right' },
  cellTax: { flex: 1.4, textAlign: 'right' },
  cellAmount: { flex: 1.6, textAlign: 'right' },
  totals: { marginTop: 10, marginLeft: 'auto', width: 230 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 1.5 },
  grandTotal: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: '#111827',
    paddingTop: 4,
    marginTop: 4,
    fontSize: 11,
  },
  appendixBlock: { marginBottom: 14, breakInside: 'avoid' },
  thumbRow: { flexDirection: 'row', marginTop: 4 },
  thumb: { width: 110, height: 82, marginRight: 8, objectFit: 'cover' },
  thumbMissing: {
    width: 110,
    height: 82,
    marginRight: 8,
    borderWidth: 0.5,
    borderColor: '#D1D5DB',
    padding: 4,
  },
  footer: { marginTop: 18, paddingTop: 6, borderTopWidth: 0.5, borderTopColor: '#E5E7EB' },
  additionalTag: { color: '#B45309' },
});

function buildDocument(
  input: InvoiceRenderInput,
  creationDate: Date,
): ReactElement<DocumentProps> {
  const { invoice } = input;

  const pages: ReactElement[] = [
    createElement(
      Page,
      { size: 'A4', style: styles.page, key: 'invoice' },
      letterhead(input),
      parties(input),
      lineTable(input),
      totals(input),
      paymentBlock(input),
      footer(input),
    ),
  ];

  // The evidence appendix goes on its own page. Deliberately: it is the part a
  // customer photographs and sends to their spouse, and it should not be
  // half-way down a page of tax columns.
  if (input.evidence.length > 0) {
    pages.push(
      createElement(
        Page,
        { size: 'A4', style: styles.page, key: 'appendix' },
        createElement(
          View,
          { style: styles.section },
          createElement(Text, { style: styles.sectionTitle }, 'Evidence for additional work'),
          createElement(
            Text,
            { style: styles.muted },
            `Every item below was photographed before it was carried out, and billed only after ${input.customerName} approved it.`,
          ),
        ),
        ...input.evidence.map((block, index) => evidenceBlock(block, index, input.timezone)),
      ),
    );
  }

  return createElement(
    Document,
    {
      title: `Invoice ${invoice.number}`,
      author: input.shopName,
      subject: `${input.jobCardCode} — ${input.registration}`,
      creator: 'ServiceLoop',
      producer: 'ServiceLoop',
      // Pinned so the same invoice always produces the same bytes.
      creationDate,
    },
    ...pages,
  );
}

function letterhead(input: InvoiceRenderInput): ReactElement {
  const { invoice } = input;
  return createElement(
    View,
    { style: styles.header },
    createElement(
      View,
      {},
      createElement(Text, { style: styles.sellerName }, invoice.sellerName),
      ...invoice.sellerAddress.map((line, index) =>
        createElement(Text, { style: styles.muted, key: `addr-${index}` }, line),
      ),
      invoice.sellerGstin === null
        ? null
        : createElement(Text, { style: styles.muted }, `GSTIN: ${invoice.sellerGstin}`),
    ),
    createElement(
      View,
      {},
      createElement(Text, { style: styles.title }, 'TAX INVOICE'),
      createElement(Text, { style: [styles.title, styles.muted] }, invoice.number),
      createElement(
        Text,
        { style: [styles.title, styles.muted] },
        invoice.issuedAt === null ? 'Draft' : formatDate(invoice.issuedAt, input.timezone),
      ),
    ),
  );
}

function parties(input: InvoiceRenderInput): ReactElement {
  const { invoice } = input;
  return createElement(
    View,
    { style: [styles.section, styles.row] },
    createElement(
      View,
      { style: { flex: 1 } },
      createElement(Text, { style: styles.sectionTitle }, 'Billed to'),
      createElement(Text, {}, input.customerName),
      createElement(Text, { style: styles.muted }, `${input.vehicleLabel} · ${input.registration}`),
      invoice.placeOfSupplyStateCode === null
        ? null
        : createElement(
            Text,
            { style: styles.muted },
            `Place of supply: ${invoice.placeOfSupplyStateCode}`,
          ),
    ),
    createElement(
      View,
      { style: { flex: 1 } },
      createElement(Text, { style: styles.sectionTitle }, 'Job card'),
      createElement(Text, {}, input.jobCardCode),
      createElement(
        Text,
        { style: styles.muted },
        invoice.intraState ? 'Intra-state supply (CGST + SGST)' : 'Inter-state supply (IGST)',
      ),
    ),
  );
}

function lineTable(input: InvoiceRenderInput): ReactElement {
  return createElement(
    View,
    { style: styles.section },
    createElement(
      View,
      { style: styles.tableHead },
      createElement(Text, { style: styles.cellDescription }, 'Description'),
      createElement(Text, { style: styles.cellHsn }, 'HSN/SAC'),
      createElement(Text, { style: styles.cellQty }, 'Qty'),
      createElement(Text, { style: styles.cellRate }, 'Rate'),
      createElement(Text, { style: styles.cellTax }, 'Tax'),
      createElement(Text, { style: styles.cellAmount }, 'Amount'),
    ),
    ...input.lines.map((line, index) =>
      createElement(
        View,
        { style: styles.tableRow, key: `line-${index}` },
        createElement(
          View,
          { style: styles.cellDescription },
          createElement(Text, {}, line.description),
          line.isAdditionalWork
            ? createElement(
                Text,
                { style: [styles.muted, styles.additionalTag] },
                line.approvedAt === null
                  ? 'Additional work — approved by the customer'
                  : `Additional work — approved ${formatDateTime(line.approvedAt, input.timezone)}`,
              )
            : null,
        ),
        createElement(Text, { style: styles.cellHsn }, line.hsnSac ?? '—'),
        createElement(Text, { style: styles.cellQty }, formatQuantity(line.quantityMilli)),
        createElement(
          Text,
          { style: styles.cellRate },
          formatPaise(line.unitPricePaise, { withSymbol: false }),
        ),
        createElement(Text, { style: styles.cellTax }, `${(line.taxRateBp / 100).toFixed(0)}%`),
        createElement(
          Text,
          { style: styles.cellAmount },
          formatPaise(line.lineTotalPaise, { withSymbol: false }),
        ),
      ),
    ),
  );
}

function totals(input: InvoiceRenderInput): ReactElement {
  const { invoice } = input;
  const rows: ReactElement[] = [
    totalRow('Subtotal', invoice.subtotalPaise, 'subtotal'),
  ];

  if (invoice.intraState) {
    rows.push(totalRow('CGST', invoice.cgstPaise, 'cgst'));
    rows.push(totalRow('SGST', invoice.sgstPaise, 'sgst'));
  } else {
    rows.push(totalRow('IGST', invoice.igstPaise, 'igst'));
  }

  return createElement(
    View,
    { style: styles.totals },
    ...rows,
    createElement(
      View,
      { style: styles.grandTotal },
      createElement(Text, {}, 'Total'),
      createElement(Text, {}, formatPaise(invoice.totalPaise)),
    ),
  );
}

function totalRow(label: string, amountPaise: number, key: string): ReactElement {
  return createElement(
    View,
    { style: styles.totalRow, key },
    createElement(Text, { style: styles.muted }, label),
    createElement(Text, {}, formatPaise(amountPaise)),
  );
}

function paymentBlock(input: InvoiceRenderInput): ReactElement {
  const balance = input.invoice.totalPaise - input.amountPaidPaise;
  return createElement(
    View,
    { style: [styles.totals, { marginTop: 6 }] },
    createElement(
      View,
      { style: styles.totalRow },
      createElement(Text, { style: styles.muted }, 'Paid'),
      createElement(Text, {}, formatPaise(input.amountPaidPaise)),
    ),
    createElement(
      View,
      { style: styles.totalRow },
      createElement(Text, { style: styles.muted }, balance > 0 ? 'Balance due' : 'Status'),
      createElement(Text, {}, balance > 0 ? formatPaise(balance) : 'Paid in full'),
    ),
  );
}

function footer(input: InvoiceRenderInput): ReactElement {
  return createElement(
    View,
    { style: styles.footer },
    input.invoice.footerNote.length === 0
      ? null
      : createElement(Text, { style: styles.muted }, input.invoice.footerNote),
    createElement(
      Text,
      { style: styles.muted },
      'You are welcome to inspect any parts that were replaced.',
    ),
  );
}

/**
 * One appendix block: the line, when it was approved, and the photographs.
 *
 * A media asset whose bytes are gone renders as a labelled placeholder rather
 * than being dropped. A DPDP erasure can remove the photograph after the
 * invoice was issued, and an appendix that silently loses a block would make
 * the document disagree with itself about how many things were photographed.
 */
function evidenceBlock(
  block: InvoiceEvidenceBlock,
  index: number,
  timezone: string,
): ReactElement {
  return createElement(
    View,
    { style: styles.appendixBlock, key: `evidence-${index}` },
    createElement(Text, {}, block.lineDescription),
    createElement(
      Text,
      { style: styles.muted },
      block.approvedAt === null
        ? 'Approved by the customer before the work was carried out'
        : `Approved ${formatDateTime(block.approvedAt, timezone)}`,
    ),
    createElement(
      View,
      { style: styles.thumbRow },
      ...block.media.map((asset, mediaIndex) =>
        asset.thumbnail === null
          ? createElement(
              View,
              { style: styles.thumbMissing, key: `thumb-${mediaIndex}` },
              createElement(
                Text,
                { style: styles.muted },
                asset.caption ?? 'Photograph no longer stored',
              ),
            )
          : createElement(Image, {
              style: styles.thumb,
              src: asset.thumbnail,
              key: `thumb-${mediaIndex}`,
            }),
      ),
    ),
  );
}

/** Milli-units back to a readable quantity: 1500 → `1.5`, 1000 → `1`. */
export function formatQuantity(quantityMilli: number): string {
  const value = quantityMilli / 1000;
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '');
}

function formatDate(instant: Date, timeZone: string): string {
  const parts = zonedParts(instant, timeZone);
  return `${String(parts.day).padStart(2, '0')}/${String(parts.month).padStart(2, '0')}/${parts.year}`;
}

function formatDateTime(instant: Date, timeZone: string): string {
  const parts = zonedParts(instant, timeZone);
  return `${formatDate(instant, timeZone)} ${String(parts.hour).padStart(2, '0')}:${String(
    parts.minute,
  ).padStart(2, '0')}`;
}
