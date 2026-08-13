import type { ShopConfig } from '@serviceloop/config';
import {
  type AutonomyFlow,
  type AutonomyLevel,
  type ConsentPurpose,
  isWithinQuietHours,
  nextInstantOutsideQuietHours,
  type Paise,
  percentOf,
} from '@serviceloop/shared';

/**
 * Pure guardrail evaluators (master §6).
 *
 * These are the checks the tool layer runs before anything reaches a customer.
 * They are pure functions of (config, facts) so they can be unit-tested
 * exhaustively and can never be talked out of a verdict by a prompt — phase 3
 * calls them from `send_customer_message`, phase 4/5/6 from their own tools.
 */

export type PolicyVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: string; readonly reason: string };

const PASS: PolicyVerdict = { allowed: true };

function deny(code: string, reason: string): PolicyVerdict {
  return { allowed: false, code, reason };
}

export type SendMode = 'AUTO_SEND' | 'HITL_REQUIRED';

export interface MessageRisk {
  /** A templated message has no free-form generated content. */
  readonly templated: boolean;
  readonly channel: 'WHATSAPP' | 'SMS' | 'VOICE';
}

/**
 * L0 SHADOW never auto-sends. L1 auto-sends templated chat only. L2 adds
 * free-form chat. Voice autonomy is L3 and is tracked on the `voice` flow.
 */
export function resolveSendMode(level: AutonomyLevel, risk: MessageRisk): SendMode {
  if (risk.channel === 'VOICE') return level === 'L3_VOICE' ? 'AUTO_SEND' : 'HITL_REQUIRED';

  switch (level) {
    case 'L0_SHADOW':
      return 'HITL_REQUIRED';
    case 'L1_TEMPLATED':
      return risk.templated ? 'AUTO_SEND' : 'HITL_REQUIRED';
    case 'L2_CONVERSATIONAL':
    case 'L3_VOICE':
      return 'AUTO_SEND';
  }
}

export function autonomyFor(config: ShopConfig, flow: AutonomyFlow): AutonomyLevel {
  return config.autonomy[flow];
}

export interface QuietHoursVerdict extends Record<string, unknown> {
  readonly withinQuietHours: boolean;
  /** When blocked, the earliest instant the message may be sent. */
  readonly deferUntil: Date | null;
}

export function evaluateQuietHours(config: ShopConfig, at: Date): QuietHoursVerdict {
  const window = { start: config.quietHours.start, end: config.quietHours.end };
  const within = isWithinQuietHours(at, config.quietHours.timezone, window);
  return {
    withinQuietHours: within,
    deferUntil: within
      ? nextInstantOutsideQuietHours(at, config.quietHours.timezone, window)
      : null,
  };
}

/** Price floor and discount ceiling are hard, tool-layer limits. */
export function checkOfferedPrice(
  config: ShopConfig,
  listPricePaise: Paise,
  offeredPricePaise: Paise,
): PolicyVerdict {
  if (offeredPricePaise < 0) return deny('NEGATIVE_PRICE', 'An offered price cannot be negative');
  if (listPricePaise <= 0) {
    return offeredPricePaise === 0
      ? PASS
      : deny('NO_LIST_PRICE', 'Cannot offer a price for an item with no list price on record');
  }

  const floor = percentOf(listPricePaise, config.pricing.priceFloorPercent);
  if (offeredPricePaise < floor) {
    return deny(
      'PRICE_BELOW_FLOOR',
      `Offered price ${offeredPricePaise} paise is below this shop's floor of ${floor} paise (${config.pricing.priceFloorPercent}% of list)`,
    );
  }

  const discountPaise = listPricePaise - offeredPricePaise;
  const ceiling = percentOf(listPricePaise, config.pricing.discountCeilingPercent);
  if (discountPaise > ceiling) {
    return deny(
      'DISCOUNT_ABOVE_CEILING',
      `Discount of ${discountPaise} paise exceeds this shop's ceiling of ${ceiling} paise (${config.pricing.discountCeilingPercent}% of list)`,
    );
  }

  return PASS;
}

export interface OutboundHistory {
  /** Timestamps of prior outbound messages to this customer, newest first. */
  readonly sentAt: readonly Date[];
}

export function checkFrequencyCaps(
  config: ShopConfig,
  history: OutboundHistory,
  at: Date,
): PolicyVerdict {
  const caps = config.frequencyCaps;
  const dayAgo = at.getTime() - 24 * 60 * 60 * 1000;
  const weekAgo = at.getTime() - 7 * 24 * 60 * 60 * 1000;

  const inDay = history.sentAt.filter((sent) => sent.getTime() >= dayAgo).length;
  if (inDay >= caps.maxOutboundPerCustomerPerDay) {
    return deny(
      'DAILY_CAP_REACHED',
      `Daily outbound cap of ${caps.maxOutboundPerCustomerPerDay} messages already reached for this customer`,
    );
  }

  const inWeek = history.sentAt.filter((sent) => sent.getTime() >= weekAgo).length;
  if (inWeek >= caps.maxOutboundPerCustomerPerWeek) {
    return deny(
      'WEEKLY_CAP_REACHED',
      `Weekly outbound cap of ${caps.maxOutboundPerCustomerPerWeek} messages already reached for this customer`,
    );
  }

  const mostRecent = history.sentAt.reduce<number | null>(
    (latest, sent) => (latest === null || sent.getTime() > latest ? sent.getTime() : latest),
    null,
  );
  if (mostRecent !== null) {
    const minutesSince = (at.getTime() - mostRecent) / 60_000;
    if (minutesSince < caps.minMinutesBetweenMessages) {
      return deny(
        'MIN_INTERVAL_NOT_ELAPSED',
        `Only ${Math.floor(minutesSince)} minutes since the last message; this shop requires ${caps.minMinutesBetweenMessages}`,
      );
    }
  }

  return PASS;
}

export interface ConsentSnapshot {
  readonly purpose: ConsentPurpose;
  readonly status: 'PENDING' | 'GRANTED' | 'REVOKED';
}

/**
 * Consent gate. SERVICE consent is required for any business-initiated
 * message; MARKETING requires its own explicit grant and is never implied by a
 * SERVICE grant (DPDP purpose limitation, master §7).
 */
export function checkConsent(
  purpose: ConsentPurpose,
  consents: readonly ConsentSnapshot[],
): PolicyVerdict {
  const relevant = consents.find((consent) => consent.purpose === purpose);
  if (relevant === undefined) {
    return deny('CONSENT_MISSING', `No ${purpose} consent on record for this customer`);
  }
  if (relevant.status === 'REVOKED') {
    return deny('CONSENT_REVOKED', `${purpose} consent has been revoked by this customer`);
  }
  if (relevant.status === 'PENDING') {
    return deny('CONSENT_PENDING', `${purpose} consent has been requested but not granted`);
  }
  return PASS;
}

export interface EvidenceRef {
  readonly kind: 'MEDIA' | 'ESTIMATE_LINE' | 'TECHNICIAN_NOTE';
  readonly id: string;
}

/**
 * L7 — evidence or silence. Every factual claim in a customer-visible message
 * must cite at least one evidence id; an unanchored claim is blocked to HITL
 * rather than sent.
 */
export function checkClaimAnchoring(
  claims: readonly { readonly text: string; readonly evidence: readonly EvidenceRef[] }[],
): PolicyVerdict {
  const unanchored = claims.filter((claim) => claim.evidence.length === 0);
  if (unanchored.length === 0) return PASS;
  return deny(
    'CLAIM_NOT_ANCHORED',
    `${unanchored.length} claim(s) cite no technician note, media asset or estimate line: ${unanchored
      .map((claim) => JSON.stringify(claim.text.slice(0, 60)))
      .join(', ')}`,
  );
}

/** First contact in a session, and every voice call, must disclose the AI. */
export function checkDisclosure(
  config: ShopConfig,
  context: {
    readonly isFirstContactInSession: boolean;
    readonly isVoiceCall: boolean;
    readonly bodyIncludesDisclosure: boolean;
  },
): PolicyVerdict {
  const required =
    (context.isFirstContactInSession && config.disclosure.requireFirstContactDisclosure) ||
    (context.isVoiceCall && config.disclosure.requireVoiceCallDisclosure);

  if (!required || context.bodyIncludesDisclosure) return PASS;
  return deny(
    'DISCLOSURE_MISSING',
    'The AI disclosure line is mandatory for first contact in a session and for every voice call',
  );
}
