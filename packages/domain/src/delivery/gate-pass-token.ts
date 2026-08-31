import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { GatePassVerifyResult } from '@serviceloop/shared';

/**
 * The gate-pass token (phase 4.10).
 *
 * A short signed capability, encoded into a QR the customer already has in
 * WhatsApp. Three properties, each of which is the reason for a design choice:
 *
 *   - **It is signed, so the gate does not need the database to trust it.** The
 *     verify screen still reads the row — to show the card summary and to catch
 *     a pass that has already been used — but the signature is what makes a
 *     forged code fail before any lookup happens.
 *   - **It expires**, because a QR lives in a chat thread for ever and a
 *     workshop gate does not have a way to revoke a photograph.
 *   - **Only its hash is stored.** A database read cannot mint a pass, which is
 *     the entire point of signing one. An operator with SQL access can see that
 *     a pass exists; they cannot produce the token that opens the gate.
 */

/** Payload the token carries. Small on purpose — it has to fit a QR legibly. */
export interface GatePassClaims {
  readonly gatePassId: string;
  readonly jobCardId: string;
  readonly shopId: string;
  /** Unix seconds. */
  readonly exp: number;
}

export interface SignedGatePass {
  readonly token: string;
  readonly tokenHash: string;
  readonly code: string;
  readonly expiresAt: Date;
}

/**
 * Characters a person can read off a phone screen and type on a keypad in the
 * rain.
 *
 * No `0`/`O`, no `1`/`I`/`L`, no `8`/`B`, no `5`/`S`. A gate person mistyping a
 * code is not a security event, but it is a customer waiting at a barrier while
 * somebody phones the advisor, which is the failure this whole feature exists
 * to remove.
 */
const CODE_ALPHABET = '23467ACDEFGHJKMNPQRTUVWXYZ';
const CODE_LENGTH = 6;

export function generateGatePassCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = '';
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    // Modulo bias over a 26-character alphabet and a 256-value byte is under
    // 2%, which does not matter here: the code is a *lookup* key scoped to one
    // shop, and the token's HMAC is what actually authorises anything.
    code += CODE_ALPHABET[(bytes[index] as number) % CODE_ALPHABET.length];
  }
  return code;
}

/**
 * `v1.<base64url(claims)>.<base64url(hmac)>`.
 *
 * Versioned so a future signing change can be rolled out without every pass in
 * circulation becoming unverifiable on the same afternoon.
 */
export function signGatePass(claims: GatePassClaims, secret: string): SignedGatePass {
  const body = base64Url(Buffer.from(JSON.stringify(claims), 'utf8'));
  const signature = base64Url(hmac(`v1.${body}`, secret));
  const token = `v1.${body}.${signature}`;

  return {
    token,
    tokenHash: hashToken(token),
    code: generateGatePassCode(),
    expiresAt: new Date(claims.exp * 1000),
  };
}

export type TokenVerdict =
  | { readonly ok: true; readonly claims: GatePassClaims }
  | { readonly ok: false; readonly result: Extract<GatePassVerifyResult, 'FORGED' | 'EXPIRED'> };

/**
 * Verifies a token's signature and expiry, and nothing else.
 *
 * Deliberately *not* a database check: the caller still has to load the pass to
 * find out whether it was already used or revoked, and separating the two means
 * a forged token is rejected without touching a row — so a gate being probed
 * costs no queries.
 *
 * A malformed token is `FORGED`, not a separate outcome. From the gate person's
 * side there is no difference between a token somebody made up and one they
 * mangled, and inventing a third red light would only make the screen harder to
 * read.
 */
export function verifyGatePassToken(token: string, secret: string, now: Date): TokenVerdict {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return { ok: false, result: 'FORGED' };

  const [, body = '', signature = ''] = parts;
  const expected = base64Url(hmac(`v1.${body}`, secret));

  if (!constantTimeEquals(signature, expected)) return { ok: false, result: 'FORGED' };

  let claims: GatePassClaims;
  try {
    const decoded: unknown = JSON.parse(fromBase64Url(body).toString('utf8'));
    if (!isClaims(decoded)) return { ok: false, result: 'FORGED' };
    claims = decoded;
  } catch {
    return { ok: false, result: 'FORGED' };
  }

  // Expiry is checked *after* the signature. Reporting "expired" for an
  // unsigned token would tell an attacker their forgery parsed.
  if (claims.exp * 1000 <= now.getTime()) return { ok: false, result: 'EXPIRED' };

  return { ok: true, claims };
}

/** What is stored on the row. sha256 via HMAC with a fixed label, so it is keyed. */
export function hashToken(token: string): string {
  return createHmac('sha256', GATE_PASS_HASH_LABEL).update(token).digest('hex');
}

/**
 * The label the stored hash is keyed with.
 *
 * A constant rather than the signing secret: the hash exists so a *used* pass
 * can be recognised, and keying it with the secret would mean rotating the
 * secret invalidated the record of every pass ever issued, not just the ones
 * still in circulation.
 */
const GATE_PASS_HASH_LABEL = 'serviceloop.gate-pass.v1';

function hmac(message: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(message).digest();
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  // `timingSafeEqual` throws on a length mismatch, which is itself a leak of
  // one bit. The lengths here are fixed by the algorithm, so an unequal length
  // is already a forgery.
  return a.length === b.length && timingSafeEqual(a, b);
}

function isClaims(value: unknown): value is GatePassClaims {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['gatePassId'] === 'string' &&
    typeof candidate['jobCardId'] === 'string' &&
    typeof candidate['shopId'] === 'string' &&
    typeof candidate['exp'] === 'number' &&
    Number.isFinite(candidate['exp'])
  );
}
