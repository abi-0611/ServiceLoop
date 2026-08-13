import { z } from 'zod';
import { type Result, err, ok } from './result';

/**
 * Indian vehicle registration normalisation.
 *
 * The vehicle is the natural key a workshop thinks in ("the white Swift, TN 09
 * BX 1234"). Registrations arrive from paper cards, OCR, and customers typing
 * on WhatsApp, so they must collapse to one canonical uppercase, separator-free
 * form before anything keys on them.
 *
 * Supported formats:
 *   - Standard : `TN09BX1234`  (state 2 alpha, RTO 1-2 digits, series 0-3 alpha, 1-4 digits)
 *   - BH series: `24BH1234A`   (year 2 digits, `BH`, 4 digits, 1-2 alpha)
 */

export type RegistrationKind = 'STANDARD' | 'BH_SERIES';

export type RegistrationNormalisationError =
  { kind: 'EMPTY' } | { kind: 'UNRECOGNISED_FORMAT'; cleaned: string };

const STANDARD_RE = /^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{1,4})$/;
const BH_RE = /^(\d{2})(BH)(\d{4})([A-Z]{1,2})$/;

/** OCR of a paper job card routinely confuses these. Applied per character class. */
const DIGIT_LOOKALIKES: Readonly<Record<string, string>> = {
  O: '0',
  Q: '0',
  I: '1',
  L: '1',
  S: '5',
  Z: '2',
  B: '8',
};
const ALPHA_LOOKALIKES: Readonly<Record<string, string>> = {
  '0': 'O',
  '1': 'I',
  '5': 'S',
  '2': 'Z',
  '8': 'B',
};

export interface NormalisedRegistration {
  readonly normalised: string;
  readonly kind: RegistrationKind;
  readonly stateCode: string;
}

export function normaliseRegistration(
  input: string,
): Result<NormalisedRegistration, RegistrationNormalisationError> {
  const cleaned = input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .trim();

  if (cleaned.length === 0) return err({ kind: 'EMPTY' });

  const bh = BH_RE.exec(cleaned);
  if (bh) {
    return ok({ normalised: cleaned, kind: 'BH_SERIES', stateCode: 'BH' });
  }

  const standard = STANDARD_RE.exec(cleaned);
  if (standard) {
    const [, stateCode = '', rto = '', series = '', number = ''] = standard;
    return ok({
      normalised: `${stateCode}${rto.padStart(2, '0')}${series}${number.padStart(4, '0')}`,
      kind: 'STANDARD',
      stateCode,
    });
  }

  const repaired = repairCommonOcrErrors(cleaned);
  if (repaired !== null && repaired !== cleaned) {
    return normaliseRegistration(repaired);
  }

  return err({ kind: 'UNRECOGNISED_FORMAT', cleaned });
}

/**
 * Best-effort character repair for OCR'd registrations: positions 0-1 must be
 * alphabetic (state code) and positions 2-3 numeric (RTO code) in the standard
 * format, so lookalikes there can be corrected with confidence.
 */
function repairCommonOcrErrors(cleaned: string): string | null {
  if (cleaned.length < 6) return null;
  const chars = cleaned.split('');

  for (const index of [0, 1]) {
    const ch = chars[index];
    if (ch !== undefined && /\d/.test(ch)) chars[index] = ALPHA_LOOKALIKES[ch] ?? ch;
  }
  for (const index of [2, 3]) {
    const ch = chars[index];
    if (ch !== undefined && /[A-Z]/.test(ch)) chars[index] = DIGIT_LOOKALIKES[ch] ?? ch;
  }

  return chars.join('');
}

/** `TN09BX1234` → `TN 09 BX 1234` for console + customer-facing display. */
export function formatRegistrationForDisplay(normalised: string): string {
  const bh = BH_RE.exec(normalised);
  if (bh) {
    const [, year = '', , number = '', suffix = ''] = bh;
    return `${year} BH ${number} ${suffix}`;
  }
  const standard = STANDARD_RE.exec(normalised);
  if (!standard) return normalised;
  const [, stateCode = '', rto = '', series = '', number = ''] = standard;
  return [stateCode, rto, series, number].filter((part) => part.length > 0).join(' ');
}

export const RegistrationSchema = z
  .string()
  .transform((value, ctx) => {
    const result = normaliseRegistration(value);
    if (!result.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Not a recognisable Indian registration number (${result.error.kind})`,
      });
      return z.NEVER;
    }
    return result.value.normalised;
  })
  .pipe(z.string().min(4));
