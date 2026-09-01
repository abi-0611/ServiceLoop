import type { DtmfDigit, Language } from '@serviceloop/shared';
import { t } from '@serviceloop/shared';
import type { DtmfAction, DtmfOption, ScriptSegment } from './types';

/**
 * The keypad (phase 5.5).
 *
 * Every decision point offers keys, and `0` reaches a person from anywhere.
 * This is not a degraded mode for a broken recogniser — it is the *primary*
 * interface for a large share of the customers this product exists for: an
 * older owner in a loud street, a driver on a hands-free set, anyone whose
 * Tamil the model was not trained on. A voice agent whose keypad is an
 * afterthought is a voice agent that excludes them.
 *
 * Two rules, and they are absolute:
 *
 *   - **`0` always means a person**, at every point in every flow, whether or
 *     not it was offered. L6 says human handoff is one step away; on a phone
 *     that step is one key.
 *   - **`9` always repeats.** A customer who did not catch the amount must be
 *     able to hear it again without having to ask in words — which is exactly
 *     the thing they could not do.
 */

/** Reachable from anywhere, offered or not. */
export const GLOBAL_DTMF: Readonly<Record<string, DtmfAction>> = {
  '0': 'HANDOFF',
  '9': 'REPEAT',
};

/** The keypad at an approval decision point. */
export const APPROVAL_DTMF: Readonly<Record<string, DtmfAction>> = {
  '1': 'APPROVE',
  '2': 'HANDOFF',
  '3': 'DECLINE',
  '4': 'DEFER',
  ...GLOBAL_DTMF,
};

/** The keypad on the inbound line's intent menu. */
export const INBOUND_DTMF: Readonly<Record<string, DtmfAction>> = {
  '1': 'STATUS',
  '2': 'APPROVE',
  '3': 'BOOKING',
  ...GLOBAL_DTMF,
};

export type DtmfMap = Readonly<Record<string, DtmfAction>>;

/**
 * What a key press means here.
 *
 * The global map is consulted *after* the point-specific one, so a flow that
 * genuinely needs `9` for something else can take it — but never `0`, which is
 * merged last and therefore always wins.
 */
export function resolveDtmf(digit: DtmfDigit, map: DtmfMap): DtmfAction | null {
  if (digit === '0') return 'HANDOFF';
  return map[digit] ?? GLOBAL_DTMF[digit] ?? null;
}

export function dtmfOptions(map: DtmfMap, language: Language, advisorName: string): DtmfOption[] {
  const labels: Readonly<Record<DtmfAction, string>> = {
    APPROVE: t(language, 'voice.ask'),
    DECLINE: t(language, 'voice.declined'),
    DEFER: t(language, 'voice.deferred', { when: '—' }),
    REPEAT: t(language, 'voice.repeat_intro'),
    HANDOFF: t(language, 'voice.handoff_offer', { advisorName }),
    STATUS: t(language, 'voice.inbound.intent_prompt'),
    BOOKING: t(language, 'voice.inbound.booking_prompt'),
  };

  return Object.entries(map)
    .map(([digit, action]) => ({ digit: digit as DtmfDigit, action, label: labels[action] }))
    .sort((left, right) => left.digit.localeCompare(right.digit));
}

/**
 * Whether the call should abandon speech and finish on the keypad.
 *
 * Two consecutive turns under the confidence floor. Two rather than one because
 * a single bad turn is a lorry going past; two is a line, a dialect or a
 * microphone the recogniser is not going to cope with, and continuing to ask
 * open questions of somebody it cannot hear is how a customer ends up shouting
 * at a robot.
 */
export function shouldDegradeToIvr(input: {
  readonly consecutivePoorTurns: number;
  readonly threshold: number;
  readonly alreadyDegraded: boolean;
}): boolean {
  if (input.alreadyDegraded) return true;
  return input.consecutivePoorTurns >= input.threshold;
}

export function isPoorTurn(input: {
  readonly confidence: number | null;
  readonly text: string;
  readonly minConfidence: number;
  readonly inputMode: 'SPEECH' | 'DTMF' | 'NONE';
}): boolean {
  // A DTMF turn has no confidence and is never poor: a keypress is the one
  // input on a phone line that cannot be mis-heard.
  if (input.inputMode === 'DTMF') return false;

  // Silence is. A caller who said nothing needs the same answer as one the
  // recogniser could not read — an offer of the keypad — and it reaches it by
  // the same branch. Deciding this on confidence alone would file silence under
  // "a good turn with an empty transcript" and hand the agent nothing to plan
  // from, which is how a call goes quiet at exactly the wrong moment.
  if (input.inputMode === 'NONE') return true;

  if (input.confidence === null) return false;
  if (input.text.trim().length === 0) return true;
  return input.confidence < input.minConfidence;
}

/** The one-sentence announcement that the call has moved to the keypad. */
export function ivrModeSegment(language: Language, advisorName: string): ScriptSegment {
  return {
    key: 'voice.ivr_mode',
    text: t(language, 'voice.ivr_mode', { advisorName }),
    mandatory: false,
  };
}

export function notUnderstoodSegment(language: Language, advisorName: string): ScriptSegment {
  return {
    key: 'voice.not_understood',
    text: t(language, 'voice.not_understood', { advisorName }),
    mandatory: false,
  };
}

export function noInputSegment(language: Language): ScriptSegment {
  return { key: 'voice.no_input', text: t(language, 'voice.no_input'), mandatory: false };
}
