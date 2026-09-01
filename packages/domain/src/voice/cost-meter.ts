import type { Paise } from '@serviceloop/shared';

/**
 * What a call costs, and when to stop (phase 5.7).
 *
 * Three currencies, metered separately because they fail separately: telco
 * minutes, speech seconds, and model tokens. A shop can be comfortably inside
 * its minute budget and outside its model budget on the same Saturday, and a
 * single blended number would hide which one to fix.
 *
 * The word *estimate* is load-bearing. The authoritative figure arrives on a
 * provider invoice weeks later; the cap has to decide **now** whether this shop
 * may place another call. A meter that waited for the true number would be a
 * meter that never stopped anything — so the rates are configuration, the
 * arithmetic is integer paise, and the row says `estimated_cost_paise`.
 */

export interface VoiceRates {
  /** Paise per minute of telco time. */
  readonly telcoPaisePerMinute: number;
  readonly sttPaisePerMinute: number;
  readonly ttsPaisePerMinute: number;
  /** Model spend comes from the phase-3 meter, already in micro-USD. */
  readonly usdMicrosToPaise: number;
}

export interface CallUsageTotals {
  readonly telcoSeconds: number;
  readonly sttSeconds: number;
  readonly ttsSeconds: number;
  readonly llmInputTokens: number;
  readonly llmOutputTokens: number;
  /** What the LLM meter already priced this call at, when it could. */
  readonly llmCostUsdMicros: number;
}

/**
 * Paise, rounded up.
 *
 * Up rather than nearest, deliberately: a cap that systematically
 * under-estimates is a cap a busy shop walks through, and the error on a single
 * call is a fraction of a rupee against a budget measured in hundreds.
 */
export function estimateCallCostPaise(totals: CallUsageTotals, rates: VoiceRates): Paise {
  const telco = Math.ceil((totals.telcoSeconds / 60) * rates.telcoPaisePerMinute);
  const stt = Math.ceil((totals.sttSeconds / 60) * rates.sttPaisePerMinute);
  const tts = Math.ceil((totals.ttsSeconds / 60) * rates.ttsPaisePerMinute);
  const llm = Math.ceil((totals.llmCostUsdMicros / 1_000_000) * rates.usdMicrosToPaise);
  return telco + stt + tts + Math.max(0, llm);
}

export type CapVerdict =
  | { readonly state: 'OK'; readonly spentPaise: Paise; readonly capPaise: Paise }
  | {
      readonly state: 'ALERT';
      readonly spentPaise: Paise;
      readonly capPaise: Paise;
      readonly ratio: number;
    }
  | {
      readonly state: 'HALTED';
      readonly spentPaise: Paise;
      readonly capPaise: Paise;
      readonly scope: 'SHOP_DAILY' | 'PLATFORM_DAILY';
    };

/**
 * Alert, then halt — never halt without having alerted.
 *
 * A shop whose voice rungs silently stopped working at 3 p.m. discovers it from
 * a customer complaint. The alert ratio exists so an owner hears from the
 * system first, while there is still budget left to decide what to do with.
 */
export function evaluateCap(input: {
  readonly spentPaise: Paise;
  readonly capPaise: Paise;
  readonly alertRatio: number;
  readonly scope: 'SHOP_DAILY' | 'PLATFORM_DAILY';
}): CapVerdict {
  // A cap of zero means "no ceiling configured", not "no calls". A shop that
  // wants voice off turns `voice.enabled` off, which says what it means.
  if (input.capPaise <= 0) {
    return { state: 'OK', spentPaise: input.spentPaise, capPaise: input.capPaise };
  }

  if (input.spentPaise >= input.capPaise) {
    return {
      state: 'HALTED',
      spentPaise: input.spentPaise,
      capPaise: input.capPaise,
      scope: input.scope,
    };
  }

  const ratio = input.spentPaise / input.capPaise;
  if (ratio >= input.alertRatio) {
    return { state: 'ALERT', spentPaise: input.spentPaise, capPaise: input.capPaise, ratio };
  }

  return { state: 'OK', spentPaise: input.spentPaise, capPaise: input.capPaise };
}

/**
 * The start of the shop's day, in its own timezone.
 *
 * A "daily" cap that reset at midnight UTC would reset at 05:30 IST — halfway
 * through the morning rush and in the middle of the shift the cap exists to
 * govern.
 */
export function startOfShopDay(now: Date, timezone: string): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const value = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  const localMidnightAsUtc = Date.UTC(value('year'), value('month') - 1, value('day'));
  const localNowAsUtc = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    value('hour') % 24,
    value('minute'),
    value('second'),
  );

  // The shop-local wall clock minus the same instant expressed in UTC gives the
  // offset, which is how local midnight is turned back into a real instant.
  const offsetMs = localNowAsUtc - now.getTime();
  return new Date(localMidnightAsUtc - offsetMs);
}

/** Seconds, rounded up: a partial second of telco time is a billed second. */
export function toBilledSeconds(milliseconds: number): number {
  return Math.max(0, Math.ceil(milliseconds / 1000));
}
