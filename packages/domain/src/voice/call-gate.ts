import type { ShopConfig } from '@serviceloop/config';
import type { Paise } from '@serviceloop/shared';
import { evaluateQuietHours, checkConsent, type ConsentSnapshot } from '../guardrails/policies';
import { evaluateCap, startOfShopDay } from './cost-meter';
import type { CallGateVerdict, CallRefusalCode } from './types';

/**
 * May this call be placed? (phase 5.6 / 5.7)
 *
 * This is the single choke point every origination passes, and it is the voice
 * layer's answer to the same demand §10 makes of messaging: *no code path
 * reaches a customer without passing the gate*. `VoiceCallService.originate`
 * calls it and nothing else may dial.
 *
 * The checks are ordered cheapest-and-most-absolute first, and the order is not
 * arbitrary — it is the order in which a refusal should be *explained*. A shop
 * whose kill switch is on wants to hear "the kill switch is on", not "you have
 * spent your daily budget", even when both are true.
 *
 *   1. **Kill switches.** Platform env flag, then the shop's own. Either alone
 *      stops a call, which is the correct shape for a brake: you never want the
 *      two parties who can stop something to have to agree.
 *   2. **Consent.** A customer who revoked SERVICE consent cannot be phoned —
 *      the phase's own words, "impossible at the port call-site". Not a policy
 *      the runtime consults and might mishandle: a refusal here, before the
 *      number is even decrypted.
 *   3. **Quiet hours.** A call is louder than a message. A rung that would have
 *      *deferred* a WhatsApp message must not ring a phone at 22:40.
 *   4. **Volume caps**, then **cost caps**. Both alert before they halt.
 *
 * Every refusal names whether the ladder should fall back to an advisor task.
 * That distinction is the difference between "we could not call, so a person
 * will" and "we could not call, so nothing happened" — and only the first is a
 * loop that closes (L3).
 */

export interface CallGateInput {
  readonly config: ShopConfig;
  readonly now: Date;
  /** `VOICE_KILL_SWITCH` — the platform's brake, above any shop's setting. */
  readonly platformKillSwitch: boolean;
  readonly direction: 'OUTBOUND' | 'INBOUND';
  readonly consents: readonly ConsentSnapshot[];
  /** Null when the caller could not be identified — an inbound stranger. */
  readonly customerId: string | null;
  readonly hasPhoneNumber: boolean;
  readonly callsToCustomerToday: number;
  readonly callsFromShopToday: number;
  readonly shopSpentTodayPaise: Paise;
  readonly platformSpentTodayPaise: Paise;
  readonly platformCapPaise: Paise;
  readonly alertRatio: number;
}

export function evaluateCallGate(input: CallGateInput): CallGateVerdict {
  const warnings: string[] = [];
  const voice = input.config.voice;

  if (input.platformKillSwitch) {
    return refuse(
      'KILL_SWITCH',
      'VOICE_KILL_SWITCH is set: every voice rung falls back to an advisor task',
      true,
    );
  }

  if (!voice.enabled) {
    return refuse('VOICE_DISABLED', 'This shop has not switched voice on', true);
  }

  // An inbound call is a customer who chose to ring. Nothing below this point
  // about consent, quiet hours or frequency applies to answering the phone —
  // those guardrails exist to stop a shop *initiating*, and refusing to answer
  // a customer who dialled would be the opposite of what they protect.
  if (input.direction === 'INBOUND') {
    if (!voice.inboundEnabled) {
      return refuse('VOICE_DISABLED', 'This shop has not switched its inbound line on', true);
    }
    return { allowed: true, warnings };
  }

  if (!voice.outboundEnabled) {
    return refuse(
      'OUTBOUND_DISABLED',
      'Outbound calling is off for this shop; the rung raises an advisor task instead',
      true,
    );
  }

  if (!input.hasPhoneNumber) {
    return refuse('NO_PHONE_NUMBER', 'There is no number on file for this customer', true);
  }

  /**
   * The phase's hardest requirement, and the reason it is checked here rather
   * than inside the runtime: "calls to customers with revoked SERVICE consent
   * are impossible at the port call-site".
   */
  if (input.customerId === null) {
    return refuse('NO_CONSENT', 'An outbound call needs an identified customer', true);
  }

  const consent = checkConsent('SERVICE', input.consents);
  if (!consent.allowed) {
    return refuse(
      consent.code === 'CONSENT_REVOKED' ? 'CONSENT_REVOKED' : 'NO_CONSENT',
      consent.reason,
      // A revoked customer must not be reached by a person on the agent's
      // behalf either. Advisors may of course still call them for reasons of
      // their own; what the ladder may not do is *task* somebody to do it.
      consent.code !== 'CONSENT_REVOKED',
    );
  }

  const quiet = evaluateQuietHours(input.config, input.now);
  if (quiet.withinQuietHours) {
    return refuse(
      'QUIET_HOURS',
      `Quiet hours until ${quiet.deferUntil?.toISOString() ?? 'the morning'}; a call is louder than a message`,
      true,
    );
  }

  if (input.callsToCustomerToday >= voice.maxCallsPerCustomerPerDay) {
    return refuse(
      'CUSTOMER_CALL_CAP',
      `This customer has already taken ${input.callsToCustomerToday} call(s) today`,
      true,
    );
  }

  if (input.callsFromShopToday >= voice.maxOutboundCallsPerDay) {
    return refuse(
      'SHOP_CALL_CAP',
      `This shop has placed its ${voice.maxOutboundCallsPerDay} calls for today`,
      true,
    );
  }

  const shopCap = evaluateCap({
    spentPaise: input.shopSpentTodayPaise,
    capPaise: voice.dailyCostCapPaise,
    alertRatio: input.alertRatio,
    scope: 'SHOP_DAILY',
  });

  if (shopCap.state === 'HALTED') {
    return refuse(
      'SHOP_COST_CAP',
      `This shop has spent its voice budget for today (${shopCap.spentPaise} of ${shopCap.capPaise} paise)`,
      true,
    );
  }
  if (shopCap.state === 'ALERT') {
    warnings.push(
      `Voice spend is at ${Math.round(shopCap.ratio * 100)}% of this shop's daily cap`,
    );
  }

  const platformCap = evaluateCap({
    spentPaise: input.platformSpentTodayPaise,
    capPaise: input.platformCapPaise,
    alertRatio: input.alertRatio,
    scope: 'PLATFORM_DAILY',
  });

  if (platformCap.state === 'HALTED') {
    return refuse(
      'PLATFORM_COST_CAP',
      `The platform has spent its voice budget for today (${platformCap.spentPaise} of ${platformCap.capPaise} paise)`,
      true,
    );
  }
  if (platformCap.state === 'ALERT') {
    warnings.push(`Platform voice spend is at ${Math.round(platformCap.ratio * 100)}% of the cap`);
  }

  return { allowed: true, warnings };
}

function refuse(
  code: CallRefusalCode,
  reason: string,
  fallBackToAdvisor: boolean,
): CallGateVerdict {
  return { allowed: false, code, reason, fallBackToAdvisor };
}

/** The window the daily caps are measured over, in the shop's own timezone. */
export function callDayWindow(config: ShopConfig, now: Date): Date {
  return startOfShopDay(now, config.quietHours.timezone);
}
