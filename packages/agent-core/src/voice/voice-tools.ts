import type { ShopConfig } from '@serviceloop/config';
import {
  formatPaise,
  type AgentObjective,
  type CustomerDecision,
  type Language,
} from '@serviceloop/shared';
import { trimToSpokenTurn } from '@serviceloop/domain';
import { z } from 'zod';
import { objectiveSpec, type ObjectiveSpec } from '../objectives';
import type { PostChecker } from '../post-checker';
import { buildToolRegistry, sourcesFor, allowedAmounts, type ToolDeps } from '../tools';
import type { ToolRegistry } from '../tool-registry';

/**
 * The voice tool surface (phase 5.3).
 *
 * "Same tools, same guardrails, same post-checker" — with exactly one
 * substitution and exactly one addition, both of which exist because a
 * telephone is not a chat thread.
 *
 * **The substitution.** `send_customer_message` is replaced by
 * `speak_to_caller`. Everything before the send is identical: the agent
 * composes, declares its claims, and the same `PostChecker` decides whether the
 * copy is anchored (L7). What differs is the last step — the words go to a
 * synthesiser rather than to WhatsApp — and two policies that only make sense
 * out loud: a turn is trimmed to the shop's sentence limit, and a decision may
 * not be recorded until it has been read back.
 *
 * The guardrails the outbound gate would otherwise have applied are not lost;
 * they moved *earlier*. Consent, quiet hours, frequency and the daily caps were
 * all decided by `evaluateCallGate` before the phone rang, and the AI
 * disclosure is a non-removable script segment rather than a prefix on a
 * message. Applying a per-message frequency cap inside a live conversation
 * would be meaningless — the customer is on the line.
 *
 * **The addition.** A `ToolInvariant` refuses `record_customer_decision` unless
 * the readback has been confirmed. It reads call-scoped state rather than
 * run-scoped state, because a call is several runs — one per customer turn —
 * and a guardrail that reset every turn would be no guardrail at all.
 */

/**
 * What the runtime knows about a call that a single agent run cannot.
 *
 * Owned by `VoiceAgentRunner`, closed over by the registry. One per call.
 */
export class VoiceCallState {
  /** Turns the agent has approved for synthesis, in order, not yet spoken. */
  private readonly queued: string[] = [];

  /**
   * The shop's voice settings, as they were when this call was authorised.
   *
   * Carried on the call rather than loaded per tool invocation because a tool
   * runs *inside* a call and has no transaction of its own — and because a
   * sentence limit that changed halfway through a phone call would be a
   * stranger thing than one that is fixed for its duration.
   */
  constructor(readonly voiceConfig: ShopConfig['voice']) {}

  /** The exact words of the last readback the caller was offered. */
  readbackText: string | null = null;
  /** Set by the runtime when the caller agreed to *that* readback. */
  readbackConfirmed = false;
  /** Set by `record_customer_decision`, read by the call's terminal report. */
  decision: CustomerDecision | null = null;
  /** The caller asked for a person, in words or by pressing a key. */
  handoffRequested = false;
  /** The checker refused a turn. The call exits gracefully rather than lying. */
  blockedReasons: string[] = [];

  queueTurn(text: string): void {
    this.queued.push(text);
  }

  takeQueued(): string[] {
    return this.queued.splice(0);
  }

  get pendingTurns(): number {
    return this.queued.length;
  }

  /**
   * A readback is spent when it is confirmed.
   *
   * Cleared here rather than left set, so a second decision in the same call —
   * a customer who approves one line and then asks about another — has to be
   * read back again. A confirmation is for the thing that was read back, not a
   * standing permission for the rest of the call.
   */
  consumeReadback(): boolean {
    if (!this.readbackConfirmed) return false;
    this.readbackConfirmed = false;
    this.readbackText = null;
    return true;
  }
}

export const SpeakArgs = z.object({
  candidateId: z
    .string()
    .min(1)
    .describe('The candidate returned by compose_customer_message'),
  /**
   * Marks this turn as the confirm-by-readback.
   *
   * The runtime uses it to decide whether the caller's next "yes" may unlock a
   * decision. A turn that is not marked cannot become a readback afterwards,
   * which is what stops an agent describing the work and then treating an
   * unrelated "mm-hm" as consent to spend money.
   */
  isReadback: z.boolean().default(false),
});

export interface SpeakResult {
  readonly spoken: boolean;
  readonly text: string;
  readonly sentences: number;
  readonly trimmed: boolean;
  readonly refused?: true;
  readonly code?: string;
  readonly reason?: string;
  readonly checkerReasons?: readonly string[];
}

export interface VoiceToolDeps<Tx> extends ToolDeps<Tx> {
  readonly checker: PostChecker;
  readonly callState: VoiceCallState;
  readonly voiceConfig: () => ShopConfig['voice'];
}

/**
 * The phase-3 registry, plus voice.
 *
 * Built per call rather than per process, because `callState` is per call. That
 * is a real cost — a registry object for every phone call — and it buys the one
 * thing that matters: the readback invariant cannot be satisfied by a different
 * customer's confirmation.
 */
export function buildVoiceToolRegistry<Tx>(deps: VoiceToolDeps<Tx>): ToolRegistry {
  const registry = buildToolRegistry(deps);

  registry.register({
    name: 'speak_to_caller',
    description:
      'Say a composed candidate to the caller. This is the only tool that reaches them on the phone. It runs the claim checker and trims the turn to the shop’s spoken-sentence limit. Set isReadback when the turn reads a decision back for confirmation.',
    args: SpeakArgs,
    customerFacing: true,
    handler: async (args, context): Promise<SpeakResult> => {
      const candidate = context.state.candidate(args.candidateId) as
        | {
            body: string;
            claims: readonly { text: string; sources: readonly string[] }[];
            language: Language;
          }
        | undefined;

      if (candidate === undefined) {
        return {
          spoken: false,
          text: '',
          sentences: 0,
          trimmed: false,
          refused: true,
          code: 'UNKNOWN_CANDIDATE',
          reason: 'That candidate id was never composed. Call compose_customer_message first.',
        };
      }

      const loaded = await deps.uow.transaction(async (tx) => {
        const bundle =
          context.jobCardId === null
            ? null
            : await deps.activeBundle(tx, context.shopId, context.jobCardId);
        const tail = await deps.conversationTail(tx, context.shopId, context.conversationId, 50);
        return { bundle, tail };
      });

      const agreed = [...context.state.agreedPrices().entries()].map(([id, concession]) => ({
        id,
        text: `Agreed price for ${concession.description} — ${formatPaise(concession.newPaise)}`,
      }));

      const verdict = await deps.checker.review({
        shopId: context.shopId,
        language: candidate.language,
        body: candidate.body,
        claims: candidate.claims,
        sources: [...sourcesFor(loaded.bundle), ...agreed],
        allowedAmountsPaise: [
          ...allowedAmounts(loaded.bundle),
          ...[...context.state.agreedPrices().values()].map((concession) => concession.newPaise),
        ],
        // A call opens with the non-removable disclosure segment, which is
        // played before the agent is asked to say anything. Declaring first
        // contact here would demand a second disclosure inside the first
        // sentence of every turn.
        isFirstContactInSession: false,
        traceId: context.traceId,
      });

      if (verdict.kind === 'block_to_hitl') {
        // Nothing is said. On a phone there is no "held for review" — the
        // customer is on the line — so the call exits gracefully and an advisor
        // task carries the draft, which is the same destination the chat path
        // reaches by a different route.
        const reasons = verdict.reasons.map((entry) => `${entry.code}: ${entry.detail}`);
        deps.callState.blockedReasons.push(...reasons);
        return {
          spoken: false,
          text: candidate.body,
          sentences: 0,
          trimmed: false,
          refused: true,
          code: 'BLOCKED_TO_HITL',
          reason: `The checker refused this turn: ${reasons.join('; ')}`,
          checkerReasons: reasons,
        };
      }

      const maxSentences = deps.voiceConfig().maxSentencesPerTurn;
      const spoken = trimToSpokenTurn(candidate.body, maxSentences);

      deps.callState.queueTurn(spoken);
      if (args.isReadback) deps.callState.readbackText = spoken;

      return {
        spoken: true,
        text: spoken,
        sentences: Math.min(maxSentences, countSentences(candidate.body)),
        trimmed: spoken.length < candidate.body.trim().length,
      };
    },
  });

  /**
   * The readback guardrail (phase 5.3).
   *
   * A phone line mis-hears. "Seri" and "cheri" and a lorry going past are one
   * transcription apart, and the difference is ₹2,400 of somebody's money. So a
   * decision may only be recorded after the agent has read the work and the
   * amount back and the caller agreed to *that* — and `voice.
   * requireReadbackBeforeDecision` is a literal `true` in the schema so no shop
   * configuration can switch it off.
   */
  registry.addInvariant({
    name: 'voice-readback',
    check: (input) => {
      if (input.tool !== 'record_customer_decision') return { ok: true };
      if (!deps.voiceConfig().requireReadbackBeforeDecision) return { ok: true };
      if (deps.callState.consumeReadback()) return { ok: true };

      return {
        ok: false,
        code: 'READBACK_NOT_CONFIRMED',
        reason:
          'A decision may not be recorded from a call until the work and the amount have been read back and the caller has confirmed them. Compose the readback and call speak_to_caller with isReadback true.',
      };
    },
  });

  registry.addInvariant({
    name: 'voice-decision-capture',
    check: (input) => {
      if (input.tool !== 'record_customer_decision') return { ok: true };
      const args = input.args as { decision?: CustomerDecision };
      if (args.decision !== undefined) deps.callState.decision = args.decision;
      return { ok: true };
    },
  });

  return registry;
}

/**
 * The voice variant of an objective spec.
 *
 * Identical to phase 3's in every respect except the tool that reaches the
 * customer. Derived rather than duplicated, so a change to the approval
 * objective's instructions reaches the phone as well as the thread — the
 * alternative is two prompts that drift and one shop wondering why the agent
 * says different things on each channel.
 */
export function voiceObjectiveSpec(objective: AgentObjective): ObjectiveSpec {
  const base = objectiveSpec(objective);
  const swap = (name: string): string =>
    name === 'send_customer_message' ? 'speak_to_caller' : name;

  return {
    ...base,
    instructions: `${base.instructions}

## You are on a telephone

The customer is listening right now. That changes four things:

  - **Two sentences per turn, at most.** They remember the last thing they
    heard and nothing before it. Say one idea, then stop.
  - **No lists, no brackets, no message formatting.** If you would have sent
    three bullet points, say the most important one and offer the rest.
  - **Read a decision back before you record it.** Compose the readback —
    "so I'll go ahead with the brake pads at two thousand four hundred rupees,
    shall I confirm?" — and call speak_to_caller with isReadback true. Only
    after they agree may you call record_customer_decision.
  - **Offer the keypad every time you ask for something.** Say it in words and
    give the key: "say yes, or press 1".

Use speak_to_caller instead of send_customer_message. Nothing else changes.`,
    metWhen: base.metWhen.map(swap),
    tools: base.tools.map(swap),
  };
}

function countSentences(text: string): number {
  return text
    .trim()
    .split(/(?<=[.!?।])\s+/u)
    .filter((sentence) => sentence.trim().length > 0).length;
}
