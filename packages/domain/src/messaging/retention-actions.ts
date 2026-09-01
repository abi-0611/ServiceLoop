import type { DocumentKind, FeedbackSentiment, RepitchResponse } from '@serviceloop/shared';

/**
 * Channel vocabulary for the phase-6 taps.
 *
 * Here, and not in `retention/`, for the dependency reason the approval and
 * status buttons are here: the retention module imports `OutboundGate` from
 * this one, so `InboundHandler` importing the retention services would close a
 * cycle. A button id is not retention logic anyway — it is a string the channel
 * carries back, and whoever reads inbound messages has to recognise it.
 *
 * Every id carries its subject, for the reason `status-actions.ts` gives at
 * length and which matters more here than anywhere else: a re-pitch is answered
 * days or weeks after it was sent, quite possibly after two other re-pitches
 * about two other items. A bare "not interested" with no subject is a tap that
 * could silence the wrong piece of work for ever.
 */

const REPITCH_PREFIX = 'repitch:';
const FEEDBACK_PREFIX = 'feedback:';
const DOC_ENROL_PREFIX = 'docs:enrol:';
const MARKETING_PREFIX = 'marketing:';
const DIGEST_CLAIM_PREFIX = 'digest:claim:';

/**
 * The three one-tap answers to a re-pitch (phase 6.3).
 *
 * `remind` is deliberately one of the three rather than an absence of an
 * answer: a customer who defers has been asked, and the item's two-re-pitch cap
 * has to see that. Making "later" silent would let a shop ask indefinitely by
 * never being told no.
 */
export const REPITCH_ACTION_IDS = {
  book: (ledgerItemId: string): string => `${REPITCH_PREFIX}book:${ledgerItemId}`,
  remind: (ledgerItemId: string): string => `${REPITCH_PREFIX}later:${ledgerItemId}`,
  notInterested: (ledgerItemId: string): string => `${REPITCH_PREFIX}no:${ledgerItemId}`,
} as const;

export interface ParsedRepitchAction {
  readonly response: RepitchResponse;
  readonly ledgerItemId: string;
}

const REPITCH_RESPONSE_BY_VERB: Readonly<Record<string, RepitchResponse>> = {
  book: 'BOOK',
  later: 'REMIND_LATER',
  no: 'NOT_INTERESTED',
};

/**
 * A reply id → which item and which answer, or null.
 *
 * Exact verb match with a non-empty subject. `repitch:no:` on its own is a
 * malformed id, not "decline the most recent pitch" — reading it that way is
 * how a stray tap permanently silences an item nobody meant to close.
 */
export function parseRepitchAction(replyId: string | null): ParsedRepitchAction | null {
  if (replyId === null || !replyId.startsWith(REPITCH_PREFIX)) return null;

  const rest = replyId.slice(REPITCH_PREFIX.length);
  const separator = rest.indexOf(':');
  if (separator <= 0) return null;

  const response = REPITCH_RESPONSE_BY_VERB[rest.slice(0, separator)];
  const ledgerItemId = rest.slice(separator + 1);
  if (response === undefined || ledgerItemId.length === 0) return null;

  return { response, ledgerItemId };
}

/** The three faces (phase 6.4). */
export const FEEDBACK_ACTION_IDS = {
  positive: (feedbackId: string): string => `${FEEDBACK_PREFIX}good:${feedbackId}`,
  neutral: (feedbackId: string): string => `${FEEDBACK_PREFIX}ok:${feedbackId}`,
  negative: (feedbackId: string): string => `${FEEDBACK_PREFIX}bad:${feedbackId}`,
} as const;

export interface ParsedFeedbackAction {
  readonly sentiment: FeedbackSentiment;
  readonly feedbackId: string;
}

const SENTIMENT_BY_VERB: Readonly<Record<string, FeedbackSentiment>> = {
  good: 'POSITIVE',
  ok: 'NEUTRAL',
  bad: 'NEGATIVE',
};

export function parseFeedbackAction(replyId: string | null): ParsedFeedbackAction | null {
  if (replyId === null || !replyId.startsWith(FEEDBACK_PREFIX)) return null;

  const rest = replyId.slice(FEEDBACK_PREFIX.length);
  const separator = rest.indexOf(':');
  if (separator <= 0) return null;

  const sentiment = SENTIMENT_BY_VERB[rest.slice(0, separator)];
  const feedbackId = rest.slice(separator + 1);
  if (sentiment === undefined || feedbackId.length === 0) return null;

  return { sentiment, feedbackId };
}

/** Enrolling a vehicle's papers for expiry tracking (phase 6.5). */
export const DOCUMENT_ACTION_IDS = {
  enrol: (vehicleId: string): string => `${DOC_ENROL_PREFIX}yes:${vehicleId}`,
  decline: (vehicleId: string): string => `${DOC_ENROL_PREFIX}no:${vehicleId}`,
} as const;

export interface ParsedDocumentEnrolment {
  readonly enrol: boolean;
  readonly vehicleId: string;
}

export function parseDocumentEnrolment(replyId: string | null): ParsedDocumentEnrolment | null {
  if (replyId === null || !replyId.startsWith(DOC_ENROL_PREFIX)) return null;

  const rest = replyId.slice(DOC_ENROL_PREFIX.length);
  const separator = rest.indexOf(':');
  if (separator <= 0) return null;

  const verb = rest.slice(0, separator);
  const vehicleId = rest.slice(separator + 1);
  if ((verb !== 'yes' && verb !== 'no') || vehicleId.length === 0) return null;

  return { enrol: verb === 'yes', vehicleId };
}

/**
 * The MARKETING consent ask (phase 6.6).
 *
 * Its own ids rather than reusing `CONSENT_ACTION_IDS`, and that separation is
 * the point of 6.6: MARKETING is a second, explicit ask, and a tap that could
 * be read as either purpose would be a tap that grants the wider one by
 * accident. DPDP purpose limitation is not satisfied by a shared button.
 */
export const MARKETING_ACTION_IDS = {
  grant: 'marketing:yes',
  decline: 'marketing:no',
} as const;

export function parseMarketingAction(replyId: string | null): 'GRANT' | 'DECLINE' | null {
  if (replyId === MARKETING_ACTION_IDS.grant) return 'GRANT';
  if (replyId === MARKETING_ACTION_IDS.decline) return 'DECLINE';
  if (replyId === null || !replyId.startsWith(MARKETING_PREFIX)) return null;
  // A `marketing:` id we do not recognise is not a grant. Failing closed is the
  // whole reason this returns null rather than falling through to a default.
  return null;
}

/**
 * "I'll call" on a digest line (phase 6.7).
 *
 * The owner claiming a stuck approval. The approval's id travels because the
 * digest is a list — a tap that meant "the third one" would depend on the order
 * a message was rendered in, which is not a thing to bet a customer's call on.
 */
export const DIGEST_ACTION_IDS = {
  claim: (approvalId: string): string => `${DIGEST_CLAIM_PREFIX}${approvalId}`,
} as const;

export function parseDigestClaim(replyId: string | null): string | null {
  if (replyId === null || !replyId.startsWith(DIGEST_CLAIM_PREFIX)) return null;
  const approvalId = replyId.slice(DIGEST_CLAIM_PREFIX.length);
  return approvalId.length === 0 ? null : approvalId;
}

/** The i18n key naming a document kind in the customer's own language. */
export function documentLabelKey(kind: DocumentKind): 'reminder.document.insurance' | 'reminder.document.puc' {
  return kind === 'INSURANCE' ? 'reminder.document.insurance' : 'reminder.document.puc';
}
