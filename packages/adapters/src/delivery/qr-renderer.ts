import type { QrRenderer } from '@serviceloop/domain';
import qrcode from 'qrcode-generator';
import sharp from 'sharp';

/**
 * The gate pass, as a picture (phase 4.10).
 *
 * Two decisions worth stating.
 *
 * **Error-correction level Q, not L.** A gate pass is scanned outdoors, off a
 * phone held at an angle, sometimes with a thumb across a corner and often in
 * the dark with a torch reflecting off the screen protector. Q recovers about a
 * quarter of the symbol, which is the difference between one scan and asking a
 * customer to wipe their screen and try again while a queue forms behind them.
 *
 * **PNG rather than the library's own GIF.** WhatsApp's image message accepts
 * JPEG and PNG; the GIF data-URL `qrcode-generator` produces natively would be
 * rejected at the channel, after the pass had already been issued. `sharp` is
 * already in this package for media thumbnails, so the raster costs nothing new.
 */

/** Modules are drawn at this many pixels so the symbol survives compression. */
const MODULE_PIXELS = 8;

/** Four modules of quiet zone. Fewer and scanners hunt for the finder patterns. */
const QUIET_MODULES = 4;

export class QrPngRenderer implements QrRenderer {
  async render(text: string): Promise<{ readonly bytes: Buffer; readonly contentType: string }> {
    const svg = renderQrSvg(text);
    const bytes = await sharp(Buffer.from(svg, 'utf8')).png({ compressionLevel: 9 }).toBuffer();
    return { bytes, contentType: 'image/png' };
  }
}

/**
 * The symbol as a standalone SVG, at a fixed pixel size.
 *
 * Exported because the console renders the same code inline at the counter —
 * the advisor holds the screen up and the customer photographs it — and two
 * renderings of one token must be the same symbol.
 */
export function renderQrSvg(text: string): string {
  // Type 0 lets the library choose the smallest version that fits.
  const qr = qrcode(0, 'Q');
  qr.addData(text, 'Byte');
  qr.make();

  const modules = qr.getModuleCount();
  const size = (modules + QUIET_MODULES * 2) * MODULE_PIXELS;

  const rects: string[] = [];
  for (let row = 0; row < modules; row += 1) {
    for (let column = 0; column < modules; column += 1) {
      if (!qr.isDark(row, column)) continue;
      const x = (column + QUIET_MODULES) * MODULE_PIXELS;
      const y = (row + QUIET_MODULES) * MODULE_PIXELS;
      rects.push(
        `<rect x="${x}" y="${y}" width="${MODULE_PIXELS}" height="${MODULE_PIXELS}"/>`,
      );
    }
  }

  // White is painted explicitly rather than left transparent: a transparent PNG
  // shown on a dark phone theme is a QR code no scanner can read.
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">`,
    `<rect width="${size}" height="${size}" fill="#ffffff"/>`,
    `<g fill="#000000">${rects.join('')}</g>`,
    '</svg>',
  ].join('');
}
