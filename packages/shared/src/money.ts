import { z } from 'zod';

/**
 * Money is integer paise everywhere — never a float, never a string in
 * arithmetic. Estimates, approvals, invoices and price floors all compare
 * paise, so rounding is decided exactly once, here.
 */

export type Paise = number;

export const PaiseSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export function rupeesToPaise(rupees: number): Paise {
  return Math.round(rupees * 100);
}

export function paiseToRupees(paise: Paise): number {
  return paise / 100;
}

/** Indian digit grouping: ₹1,23,456.00 */
export function formatPaise(paise: Paise, opts: { withSymbol?: boolean } = {}): string {
  const withSymbol = opts.withSymbol ?? true;
  const formatted = new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(paiseToRupees(paise));
  return withSymbol ? `₹${formatted}` : formatted;
}

/** Basis points (1 bp = 0.01%) keep tax and discount maths in integers. */
export function applyRateBp(amount: Paise, rateBp: number): Paise {
  return Math.round((amount * rateBp) / 10_000);
}

export function percentOf(amount: Paise, percent: number): Paise {
  return Math.round((amount * percent) / 100);
}

export function sumPaise(values: readonly Paise[]): Paise {
  return values.reduce<Paise>((total, value) => total + value, 0);
}

export function lineTotal(quantityMilli: number, unitPricePaise: Paise): Paise {
  // Quantities are stored in milli-units (1.5 hrs => 1500) to avoid floats.
  return Math.round((quantityMilli * unitPricePaise) / 1000);
}
