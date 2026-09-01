import type { Language } from '@serviceloop/shared';

/**
 * SmsPort — the fallback rung (phase 7.3).
 *
 * SMS exists in this product for exactly one reason: WhatsApp is a single
 * commercial dependency, and a ladder whose every rung runs over it has no
 * rungs at all on the day Meta is down. It is not a channel a shop chooses; it
 * is the channel the system drops to, and everything about this port is shaped
 * by that.
 *
 * **DLT is not optional in India.** Commercial SMS terminating on an Indian
 * handset must be sent by a registered principal entity, from a registered
 * header, against a template registered *content-first* — the operator matches
 * the delivered text against the approved template and drops anything that does
 * not match. So the port does not take free text: it takes a registered
 * template id alongside the rendered body, and the adapter puts both on the
 * wire. A port that accepted only a body would be a port whose messages are
 * silently dropped by the operator at 2am with no error anybody sees.
 *
 * Template ids are configuration (master §7), never constants here: they are
 * issued per principal entity by the DLT registry, so two deployments of this
 * code have different ids for the same sentence.
 */

export interface SmsRequest {
  readonly shopId: string;
  /** E.164. The adapter normalises to whatever the provider wants on the wire. */
  readonly to: string;
  /** DLT-registered content template id. */
  readonly dltTemplateId: string;
  /** Rendered text. Must match the registered template with variables filled. */
  readonly body: string;
  readonly language: Language;
  /**
   * Which registered header ("sender id") to send from. Optional so a single
   * configured default covers the common case; a shop with its own registration
   * overrides it.
   */
  readonly senderId?: string;
}

export interface SmsReceipt {
  readonly providerMessageId: string;
  readonly acceptedAt: Date;
  readonly segments: number;
  /** Paise. Zero from the sandbox; the provider's quoted price when live. */
  readonly costPaise: number;
  readonly adapter: string;
}

export class SmsSendError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'SmsSendError';
  }
}

export interface SmsPort {
  readonly driver: 'sandbox' | 'dlt';
  send(request: SmsRequest): Promise<SmsReceipt>;
}

/**
 * Segment count, near enough for a cost estimate.
 *
 * "Near enough" is deliberate and bounded: this figure drives a *metric* and a
 * length warning, not the wire format. The provider's own count is what gets
 * billed, and the daily rollup reconciles against the provider receipt.
 *
 * The case worth being right about is the one this product actually hits: any
 * character outside the GSM 03.38 alphabet — which for us means any Tamil or
 * Devanagari at all — forces UCS-2 encoding at 70 characters a segment. A Tamil
 * ready-alert is four segments where its English twin is one, and a shop that
 * discovers that from its bill rather than from this number has been badly
 * served.
 */
export function smsSegments(body: string): number {
  const unicode = !isGsmAlphabet(body);
  const perSegment = unicode ? (body.length > 70 ? 67 : 70) : body.length > 160 ? 153 : 160;
  return Math.max(1, Math.ceil(body.length / perSegment));
}

/**
 * The GSM 03.38 basic set plus its extension table, as code points.
 *
 * Written as an explicit set rather than a regexp range because the alphabet is
 * not contiguous in Unicode and a range that looks right passes every ASCII
 * test while misclassifying the accented Latin characters it exists to cover.
 */
const GSM_EXTRA = new Set(
  [
    0x0a, 0x0d, 0x0c, 0x1b, 0x0c, 0xa3, 0xa4, 0xa5, 0xa7, 0xbf, 0xc4, 0xc5, 0xc6, 0xc7, 0xc9, 0xd1,
    0xd6, 0xd8, 0xdc, 0xdf, 0xe0, 0xe4, 0xe5, 0xe6, 0xe8, 0xe9, 0xec, 0xf1, 0xf2, 0xf6, 0xf8, 0xf9,
    0xfc, 0x20ac, 0x0393, 0x0394, 0x0398, 0x039b, 0x039e, 0x03a0, 0x03a3, 0x03a6, 0x03a8, 0x03a9,
  ],
);

function isGsmAlphabet(body: string): boolean {
  for (const character of body) {
    const code = character.codePointAt(0) ?? 0;
    // Printable ASCII covers the overwhelming majority of the basic set.
    if (code >= 0x20 && code <= 0x7e) continue;
    if (GSM_EXTRA.has(code)) continue;
    return false;
  }
  return true;
}
