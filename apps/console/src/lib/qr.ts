import qrcode from 'qrcode-generator';

/**
 * The gate-pass QR, drawn at the counter (phase 4.10).
 *
 * The same symbol the customer receives on WhatsApp, rendered here so an
 * advisor can hold the screen up when the message has not arrived — a customer
 * standing at the counter with a dead battery is the case the code exists for.
 *
 * Error-correction level Q for the same reason the adapter uses it: this gets
 * scanned outdoors, off a screen, at an angle.
 */
export function qrPathData(text: string): { path: string; size: number } {
  const qr = qrcode(0, 'Q');
  qr.addData(text, 'Byte');
  qr.make();

  const modules = qr.getModuleCount();
  const quiet = 4;
  const size = modules + quiet * 2;

  // One path rather than a rect per module: a version-6 symbol is over a
  // thousand modules, and a thousand DOM nodes in a drawer is a visible stall
  // on the phones advisors actually carry.
  const segments: string[] = [];
  for (let row = 0; row < modules; row += 1) {
    for (let column = 0; column < modules; column += 1) {
      if (!qr.isDark(row, column)) continue;
      segments.push(`M${column + quiet} ${row + quiet}h1v1h-1z`);
    }
  }

  return { path: segments.join(''), size };
}
