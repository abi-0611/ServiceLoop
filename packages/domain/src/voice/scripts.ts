import type { ShopConfig } from '@serviceloop/config';
import { formatPaise, t, type Language, type Paise } from '@serviceloop/shared';
import { DomainError } from '../errors';
import type { DtmfOption, ScriptSegment } from './types';

/**
 * Call scripts (phase 5.4).
 *
 * The two segments the phase file marks ⚿ — the AI disclosure and the recording
 * notice — are non-removable, and this module is where that becomes true rather
 * than aspirational. Every script is built here, every script begins with both
 * segments, and `assertMandatorySegments` re-checks the composed turn list
 * before a single frame is synthesised. Deleting a key from the catalogue fails
 * a test; deleting a segment from a script fails an assertion at the moment the
 * call would otherwise have started talking.
 *
 * Everything else is written to be *heard* rather than read. Short sentences,
 * no bracketed asides, no currency symbol a synthesiser pronounces as "rupee
 * symbol", and every decision point restated as a keypad option — because the
 * customer this product exists for is often standing next to a compressor.
 */

/** The catalogue keys that may never be dropped from a script. */
export const MANDATORY_SCRIPT_KEYS = [
  'voice.disclosure',
  'voice.inbound.greeting',
  'voice.recording_notice',
] as const;

export type MandatoryScriptKey = (typeof MANDATORY_SCRIPT_KEYS)[number];

export interface ScriptContext {
  readonly language: Language;
  readonly shopName: string;
  readonly customerName: string;
  readonly advisorName: string;
  readonly vehicleLabel: string;
  readonly jobCardCode: string;
}

export interface ApprovalScriptContext extends ScriptContext {
  /** Plain-language summary of the work, from the evidence bundle (L7). */
  readonly workSummary: string;
  readonly amountPaise: Paise;
}

/**
 * The opening of every outbound call, in order.
 *
 * Disclosure first, then the recording notice, and only then anything about the
 * vehicle. The order is the compliance requirement: master §7 puts the
 * recording-consent line and the AI self-identification at the *top* of the
 * script, and the recorder does not start until the second one has been heard
 * (phase 5.6).
 */
export function openingSegments(context: ScriptContext): readonly ScriptSegment[] {
  return [
    {
      key: 'voice.disclosure',
      text: t(context.language, 'voice.disclosure', {
        customerName: context.customerName,
        shopName: context.shopName,
      }),
      mandatory: true,
    },
    {
      key: 'voice.recording_notice',
      text: t(context.language, 'voice.recording_notice', {
        advisorName: context.advisorName,
      }),
      mandatory: true,
    },
  ];
}

/** The inbound line's opening: the same obligation, worded for a caller. */
export function inboundOpeningSegments(
  context: Omit<ScriptContext, 'customerName' | 'vehicleLabel' | 'jobCardCode'>,
): readonly ScriptSegment[] {
  return [
    {
      key: 'voice.inbound.greeting',
      text: t(context.language, 'voice.inbound.greeting', { shopName: context.shopName }),
      mandatory: true,
    },
    {
      key: 'voice.recording_notice',
      text: t(context.language, 'voice.recording_notice', { advisorName: context.advisorName }),
      mandatory: true,
    },
  ];
}

/**
 * The outbound approval rung's script (phase 5.4a).
 *
 * ⚿ disclosure → ⚿ recording notice → context → evidence recap → ask → keypad.
 * Objection handling and the readback are separate: they depend on what the
 * customer says, and a script that scripted the answer as well as the question
 * would be a robocall.
 */
export function approvalCallScript(context: ApprovalScriptContext): readonly ScriptSegment[] {
  return [
    ...openingSegments(context),
    {
      key: 'voice.context',
      text: t(context.language, 'voice.context', {
        vehicle: context.vehicleLabel,
        code: context.jobCardCode,
      }),
      mandatory: false,
    },
    {
      key: 'voice.evidence_recap',
      text: t(context.language, 'voice.evidence_recap', {
        summary: context.workSummary,
        amount: formatPaise(context.amountPaise),
      }),
      mandatory: false,
    },
    { key: 'voice.ask', text: t(context.language, 'voice.ask'), mandatory: false },
    {
      key: 'voice.keypad_hint',
      text: t(context.language, 'voice.keypad_hint', { advisorName: context.advisorName }),
      mandatory: false,
    },
  ];
}

export function inboundGreetingScript(
  context: Omit<ScriptContext, 'customerName' | 'vehicleLabel' | 'jobCardCode'>,
): readonly ScriptSegment[] {
  return [
    ...inboundOpeningSegments(context),
    {
      key: 'voice.inbound.intent_prompt',
      text: t(context.language, 'voice.inbound.intent_prompt'),
      mandatory: false,
    },
  ];
}

/**
 * The readback that must precede any decision recorded from a call (phase 5.3).
 *
 * "So I'll go ahead with the brake pads at ₹2,400 — shall I confirm? Say yes or
 * press 1." A phone line mis-hears; the readback is what makes a mis-hearing
 * cost one extra sentence rather than somebody's money. `VoiceConfig` marks it
 * a literal `true` precisely so no shop configuration can switch it off.
 */
export function readbackSegment(context: ApprovalScriptContext): ScriptSegment {
  return {
    key: 'voice.readback',
    text: t(context.language, 'voice.readback', {
      summary: context.workSummary,
      amount: formatPaise(context.amountPaise),
    }),
    mandatory: false,
  };
}

/**
 * The readback for a decision that is *not* an approval (phase 5.5).
 *
 * Declining and deferring get read back too, and the reason is not symmetry for
 * its own sake: a misdialled 3 loses the shop the job and sends a car out with
 * the fault it came in with. `requireReadbackBeforeDecision` is a literal in the
 * schema precisely so no reading of "which decisions matter" can switch it off
 * for some of them, and the keypad is held to the same rule the agent's
 * `record_customer_decision` invariant enforces.
 *
 * The words differ because the decision does. Reading "so I will go ahead with
 * the brake pads" back to somebody who just pressed *decline* would be worse
 * than not reading anything back at all.
 */
export function decisionReadbackSegment(
  decision: 'DECLINED' | 'DEFERRED',
  context: ApprovalScriptContext,
): ScriptSegment {
  const key = decision === 'DECLINED' ? 'voice.readback.decline' : 'voice.readback.defer';
  return {
    // Filed under the readback key so one query over the transcript answers
    // "was this decision read back?" whatever the customer decided.
    key: 'voice.readback',
    text: t(context.language, key, {
      summary: context.workSummary,
      amount: formatPaise(context.amountPaise),
    }),
    mandatory: false,
  };
}

export function closingSegments(input: {
  readonly language: Language;
  readonly summarySent: boolean;
}): readonly ScriptSegment[] {
  const segments: ScriptSegment[] = [];
  if (input.summarySent) {
    segments.push({
      key: 'voice.summary_sent',
      text: t(input.language, 'voice.summary_sent'),
      mandatory: false,
    });
  }
  segments.push({
    key: 'voice.goodbye',
    text: t(input.language, 'voice.goodbye'),
    mandatory: false,
  });
  return segments;
}

/** The graceful exit when a step or time cap is reached (phase 5.3). */
export function gracefulExitSegment(language: Language, advisorName: string): ScriptSegment {
  return {
    key: 'voice.graceful_exit',
    text: t(language, 'voice.graceful_exit', { advisorName }),
    mandatory: false,
  };
}

/** The apology a mid-call pipeline failure plays before hanging up (5.7). */
export function pipelineFailureSegment(language: Language, advisorName: string): ScriptSegment {
  return {
    key: 'voice.pipeline_failure',
    text: t(language, 'voice.pipeline_failure', { advisorName }),
    mandatory: false,
  };
}

/** The comfort filler that keeps a line from going dead (phase 5.3). */
export function fillerSegment(language: Language): ScriptSegment {
  return { key: 'voice.filler', text: t(language, 'voice.filler'), mandatory: false };
}

export function whisperText(input: {
  readonly language: Language;
  readonly customerName: string;
  readonly vehicleLabel: string;
  readonly jobCardCode: string;
  readonly reason: string;
  readonly amountPaise: Paise;
}): string {
  return t(input.language, 'voice.whisper', {
    customerName: input.customerName,
    vehicle: input.vehicleLabel,
    code: input.jobCardCode,
    reason: input.reason,
    amount: formatPaise(input.amountPaise),
  });
}

/**
 * The guard that makes ⚿ mean something.
 *
 * Called by the voice runtime before it synthesises anything, and by the
 * simulator on every call in the suite. It checks the *keys*, not the words,
 * so improving a translation cannot accidentally satisfy or break it.
 */
export function assertMandatorySegments(
  segments: readonly ScriptSegment[],
  direction: 'OUTBOUND' | 'INBOUND',
): void {
  const keys = new Set(segments.filter((segment) => segment.mandatory).map((s) => s.key));
  const opener = direction === 'INBOUND' ? 'voice.inbound.greeting' : 'voice.disclosure';

  const missing: string[] = [];
  if (!keys.has(opener)) missing.push(opener);
  if (!keys.has('voice.recording_notice')) missing.push('voice.recording_notice');

  if (missing.length > 0) {
    throw new DomainError(
      'VOICE_DISCLOSURE_MISSING',
      `A ${direction.toLowerCase()} call script is missing the non-removable segment(s): ${missing.join(', ')}`,
      500,
      { direction, missing },
    );
  }
}

/**
 * Composition policy for a spoken turn (phase 5.3).
 *
 * At most two sentences, because a customer on a phone remembers the last thing
 * they heard and nothing before it. Trimming rather than refusing: the copy is
 * already past the post-checker at this point, and dropping a *later* sentence
 * can only ever remove information the caller has not yet been given — whereas
 * refusing the whole turn leaves dead air, which is the one failure the phase
 * explicitly forbids.
 */
export function trimToSpokenTurn(text: string, maxSentences: number): string {
  const sentences = text
    .trim()
    .split(/(?<=[.!?।])\s+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);

  if (sentences.length <= maxSentences) return sentences.join(' ');
  return sentences.slice(0, maxSentences).join(' ');
}

export function spokenTurnSentenceCount(text: string): number {
  return text
    .trim()
    .split(/(?<=[.!?।])\s+/u)
    .filter((sentence) => sentence.trim().length > 0).length;
}

/** The keypad offered at an approval decision point. */
export function approvalDtmfOptions(context: {
  readonly language: Language;
  readonly advisorName: string;
}): readonly DtmfOption[] {
  return [
    { digit: '1', action: 'APPROVE', label: t(context.language, 'voice.ask') },
    {
      digit: '2',
      action: 'HANDOFF',
      label: t(context.language, 'voice.handoff_offer', { advisorName: context.advisorName }),
    },
    { digit: '9', action: 'REPEAT', label: t(context.language, 'voice.repeat_intro') },
  ];
}

export function voiceMaxSentences(config: ShopConfig): number {
  return config.voice.maxSentencesPerTurn;
}
