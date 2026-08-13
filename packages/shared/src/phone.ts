import { z } from 'zod';
import { type Result, err, ok } from './result';

/**
 * Indian mobile number normalisation to E.164.
 *
 * Customers hand over numbers as `98765 43210`, `098765-43210`, `+91 98765
 * 43210`, `0091...`. Everything downstream (WhatsApp ids, blind-index lookup,
 * telephony) requires one canonical form, so normalisation happens once here.
 */

export const DEFAULT_COUNTRY_CODE = '91';

export type PhoneNormalisationError =
  | { kind: 'EMPTY' }
  | { kind: 'TOO_SHORT'; digits: string }
  | { kind: 'TOO_LONG'; digits: string }
  | { kind: 'INVALID_INDIAN_MOBILE'; digits: string };

/** Indian mobile numbers are 10 digits beginning 6–9. */
const INDIAN_MOBILE_RE = /^[6-9]\d{9}$/;

export function normalisePhone(input: string): Result<string, PhoneNormalisationError> {
  const trimmed = input.trim();
  if (trimmed.length === 0) return err({ kind: 'EMPTY' });

  let digits = trimmed.replace(/[^\d]/g, '');
  if (digits.length === 0) return err({ kind: 'EMPTY' });

  // 0091XXXXXXXXXX / 91XXXXXXXXXX / 0XXXXXXXXXX → XXXXXXXXXX
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 12 && digits.startsWith(DEFAULT_COUNTRY_CODE)) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);

  if (digits.length < 10) return err({ kind: 'TOO_SHORT', digits });
  if (digits.length > 10) return err({ kind: 'TOO_LONG', digits });
  if (!INDIAN_MOBILE_RE.test(digits)) return err({ kind: 'INVALID_INDIAN_MOBILE', digits });

  return ok(`+${DEFAULT_COUNTRY_CODE}${digits}`);
}

export function isNormalisedPhone(value: string): boolean {
  return /^\+91[6-9]\d{9}$/.test(value);
}

/** `+919876543210` → `+91 98765 43210` for console display. */
export function formatPhoneForDisplay(e164: string): string {
  if (!isNormalisedPhone(e164)) return e164;
  const national = e164.slice(3);
  return `+91 ${national.slice(0, 5)} ${national.slice(5)}`;
}

/** Log-safe rendering: `+91 98xxx xx210`. Never log a full customer number. */
export function maskPhone(e164: string): string {
  if (e164.length < 6) return '***';
  return `${e164.slice(0, 5)}xxxxx${e164.slice(-3)}`;
}

export const PhoneSchema = z
  .string()
  .transform((value, ctx) => {
    const result = normalisePhone(value);
    if (!result.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Not a valid Indian mobile number (${result.error.kind})`,
      });
      return z.NEVER;
    }
    return result.value;
  })
  .pipe(z.string().refine(isNormalisedPhone));
