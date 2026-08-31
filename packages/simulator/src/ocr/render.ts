import { createHash } from 'node:crypto';
import type { CardFixture, CardLine } from './fixtures';

/**
 * HTML job-card templates.
 *
 * These render to the PNGs the OCR eval reads. They are not trying to be
 * photorealistic — they are trying to reproduce the *features that break
 * extraction*: irregular baselines, ditto marks, struck-through corrections,
 * rupee shorthand, mixed scripts, tight rows, and faint carbon impressions.
 *
 * Everything is deterministic. The "handwriting" jitter is a seeded PRNG keyed
 * on the fixture id and the field name, so a card renders byte-identically on
 * every machine and a fixture hash stays stable across CI runs.
 */

/** Mulberry32 — small, fast, and identical everywhere. */
function seeded(seed: string): () => number {
  const digest = createHash('sha256').update(seed).digest();
  let state = digest.readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Wraps text so it looks written rather than typeset: a small rotation, a
 * vertical nudge and a slight letter-spacing change, all seeded.
 */
function hand(fixtureId: string, key: string, text: string, className = ''): string {
  const random = seeded(`${fixtureId}:${key}`);
  const rotate = (random() - 0.5) * 1.6;
  const shiftY = (random() - 0.5) * 3;
  const spacing = (random() - 0.5) * 0.6;
  const style = `transform:rotate(${rotate.toFixed(2)}deg) translateY(${shiftY.toFixed(2)}px);letter-spacing:${spacing.toFixed(2)}px`;
  return `<span class="hand ${className}" style="${style}">${escapeHtml(text)}</span>`;
}

/** Rupee amounts as a workshop writes them: `/-`, comma groups, or a `k`. */
function rupees(fixtureId: string, key: string, amount: number | null, style: number): string {
  if (amount === null) return '';
  if (style === 0) return hand(fixtureId, key, `${amount.toLocaleString('en-IN')}/-`);
  if (style === 1) return hand(fixtureId, key, `${amount.toLocaleString('en-IN')}`);
  if (style === 2 && amount % 1000 === 0) return hand(fixtureId, key, `${amount / 1000}k`);
  return hand(fixtureId, key, `Rs. ${amount.toLocaleString('en-IN')}`);
}

function qtyCell(fixtureId: string, key: string, qty: number | null, style: number): string {
  if (qty === null) return '';
  if (style === 0) return hand(fixtureId, key, `${qty} nos`);
  if (style === 1) return hand(fixtureId, key, String(qty).padStart(2, '0'));
  return hand(fixtureId, key, String(qty));
}

function lineDescription(fixtureId: string, key: string, line: CardLine): string {
  if (line.ditto === true) {
    // A ditto mark, exactly as it appears: the value is implied by the row above.
    return `<span class="ditto">&Prime;</span>`;
  }
  if (line.struckThrough !== undefined) {
    return `${hand(fixtureId, `${key}-struck`, line.struckThrough, 'struck')} ${hand(fixtureId, key, line.description)}`;
  }
  return hand(fixtureId, key, line.description);
}

const BASE_CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; width: 900px; background: #fff; font-family: Georgia, 'Times New Roman', serif; }
  .card { position: relative; padding: 28px 32px; min-height: 1180px; }
  .hand {
    display: inline-block;
    font-family: 'Segoe Print', 'Bradley Hand', 'Comic Sans MS', cursive;
    color: #14213d;
    font-size: 19px;
  }
  .struck { text-decoration: line-through; color: #4a5568; }
  .ditto { font-family: Georgia, serif; font-size: 22px; color: #14213d; padding-left: 18px; }
  .head { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #1a1a1a; padding-bottom: 8px; }
  .shop { font-size: 26px; font-weight: bold; letter-spacing: 0.5px; }
  .sub { font-size: 12px; color: #444; }
  .meta { text-align: right; font-size: 13px; }
  .rows { margin-top: 18px; }
  .row { display: flex; gap: 12px; align-items: baseline; padding: 7px 0; }
  .label { width: 150px; font-size: 13px; color: #333; text-transform: uppercase; letter-spacing: 0.6px; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  th { font-size: 12px; text-transform: uppercase; letter-spacing: 0.6px; text-align: left; padding: 6px 8px; }
  td { padding: 7px 8px; vertical-align: bottom; }
  .num { text-align: right; }
  .foot { position: absolute; bottom: 40px; left: 32px; right: 32px; display: flex; justify-content: space-between; align-items: flex-end; }
  .sig { border-top: 1px solid #333; padding-top: 4px; width: 220px; font-size: 12px; text-align: center; }
`;

const LAYOUT_CSS: Readonly<Record<string, string>> = {
  'ruled-register': `
    body { background: #fdfdf6; }
    .card { background-image: repeating-linear-gradient(to bottom, transparent 0 33px, #c9d6e3 33px 34px); }
    .card::before { content: ''; position: absolute; top: 0; bottom: 0; left: 64px; width: 2px; background: #e3b7b7; }
    .head { border-bottom-color: #556; }
    table th { border-bottom: 1px solid #99a; }
  `,
  'carbon-pad': `
    body { background: #eef1f7; }
    .card { background: #eef1f7; }
    /* The faint, doubled impression a carbon second copy leaves. */
    .hand { color: #3d4d80; opacity: 0.72; text-shadow: 1.3px 1.3px 0 rgba(61, 77, 128, 0.3); }
    .head { border-bottom: 2px dashed #7b88a8; }
    table td { border-bottom: 1px dotted #aab; }
  `,
  'printed-form': `
    body { background: #fff; }
    .card { border: 3px double #222; }
    .row { border-bottom: 1px solid #ddd; }
    .label { font-weight: bold; color: #111; }
    .box { border: 1px solid #888; padding: 3px 8px; min-width: 220px; display: inline-block; }
    table { border: 1px solid #333; }
    table th { background: #f0f0f0; border-bottom: 1px solid #333; }
    table td { border-bottom: 1px solid #ccc; }
  `,
  'receipt-slip': `
    body { width: 520px; background: #fffdf8; }
    .card { min-height: 760px; padding: 20px; }
    .shop { font-size: 20px; }
    .label { width: 110px; font-size: 11px; }
    .hand { font-size: 17px; }
    .head { border-bottom: 1px dashed #444; }
    table th, table td { padding: 5px 4px; font-size: 13px; }
  `,
  'two-column-pad': `
    body { background: #fffef7; }
    .card { background: #fffef7; }
    .head { border-bottom: 3px solid #8a6d3b; }
    .rows { display: grid; grid-template-columns: 1fr 1fr; column-gap: 24px; }
    .row { padding: 5px 0; }
    .label { width: 120px; }
    table th { background: #f6efdf; border: 1px solid #b9a67c; }
    table td { border: 1px solid #d6c9a8; padding: 5px 8px; }
  `,
};

function detailRow(fixtureId: string, label: string, value: string | null, key: string): string {
  if (value === null || value === '') {
    return `<div class="row"><div class="label">${escapeHtml(label)}</div><div></div></div>`;
  }
  return `<div class="row"><div class="label">${escapeHtml(label)}</div><div>${hand(fixtureId, key, value)}</div></div>`;
}

export function renderCardHtml(fixture: CardFixture): string {
  const { data, id } = fixture;
  // Amount and quantity notation vary per card but are fixed per card, so a
  // fixture always exercises the same convention.
  const moneyStyle = seeded(`${id}:money`)() * 4;
  const qtyStyle = seeded(`${id}:qty`)() * 3;

  const rows = [
    detailRow(id, 'Customer', data.customerName, 'customer'),
    detailRow(id, 'Phone', data.phone, 'phone'),
    detailRow(id, 'Reg. No.', data.registrationWritten, 'registration'),
    detailRow(
      id,
      'Vehicle',
      data.make === null && data.model === null
        ? null
        : [data.make, data.model].filter((part) => part !== null).join(' '),
      'vehicle',
    ),
    detailRow(
      id,
      'Odometer',
      data.odometerKm === null ? null : `${data.odometerKm.toLocaleString('en-IN')} km`,
      'odometer',
    ),
    detailRow(id, 'Delivery', data.promisedAt, 'promised'),
  ].join('\n');

  const complaints = data.complaints
    .map(
      (complaint, index) =>
        `<div class="row"><div class="label">${index === 0 ? 'Complaint' : ''}</div><div>${hand(id, `complaint-${index}`, `${index + 1}. ${complaint}`)}</div></div>`,
    )
    .join('\n');

  const lines = data.lines
    .map(
      (line, index) => `
        <tr>
          <td>${lineDescription(id, `line-${index}`, line)}</td>
          <td class="num">${qtyCell(id, `qty-${index}`, line.qty, Math.floor(qtyStyle))}</td>
          <td class="num">${rupees(id, `rate-${index}`, line.rateRupees, Math.floor(moneyStyle))}</td>
        </tr>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="${fixture.language}">
<head><meta charset="utf-8"><style>${BASE_CSS}${LAYOUT_CSS[fixture.layout] ?? ''}</style></head>
<body>
  <div class="card">
    <div class="head">
      <div>
        <div class="shop">${escapeHtml(fixture.shopName)}</div>
        <div class="sub">Job Card / Estimate</div>
      </div>
      <div class="meta">
        <div>No. ${escapeHtml(fixture.cardNumber)}</div>
        <div>Date ${hand(id, 'date', fixture.dateWritten)}</div>
      </div>
    </div>

    <div class="rows">
      ${rows}
      ${complaints}
    </div>

    <table>
      <thead><tr><th>Particulars</th><th class="num">Qty</th><th class="num">Rate</th></tr></thead>
      <tbody>${lines}</tbody>
    </table>

    <div class="foot">
      <div class="sig">${data.advisorName === null ? '' : hand(id, 'advisor', data.advisorName)}<br>Service Advisor</div>
      <div class="sig">Customer Signature</div>
    </div>
  </div>
</body>
</html>`;
}

/** A stable hash of the rendered HTML, used to detect fixture drift. */
export function cardHtmlHash(fixture: CardFixture): string {
  return createHash('sha256').update(renderCardHtml(fixture)).digest('hex').slice(0, 16);
}
