import type { CardCandidate } from './ports';

/**
 * Which car is Suresh talking about? (phase 4.2)
 *
 * The bar for a technician is a five-second voice note (master L2). Requiring a
 * job-card id would mean requiring them to stop, find one, and read it out —
 * which means the note never gets sent and the whole status loop is a feature
 * nobody uses. So the resolver works from what a technician actually says and
 * what the system already knows about them, in that order of trust.
 *
 * The rule that matters more than the ordering: **when two cards match, ask.**
 * Guessing between two vehicles is how a customer is told their brakes are done
 * when it was someone else's, and there is no cheaper way back from that than
 * one extra tap.
 */

export type MatchOutcome =
  | { readonly kind: 'matched'; readonly card: CardCandidate }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly CardCandidate[] }
  | { readonly kind: 'none' };

export interface MatchInput {
  /** Whatever the parser heard that looked like a plate — "09 BX 4432", "4432". */
  readonly registrationFragment: string | null;
  readonly jobCardCode: string | null;
  /** The card a reply-to message was about, when the note was a reply. */
  readonly replyContext: CardCandidate | null;
  /** Cards currently assigned to whoever sent the note. */
  readonly assigned: readonly CardCandidate[];
  /** Cards whose registration matched the fragment. */
  readonly byRegistration: readonly CardCandidate[];
  /** Resolved from an explicit `JC-…` code, when one was spoken. */
  readonly byCode: CardCandidate | null;
}

/**
 * Resolve, in descending order of how much the technician actually told us.
 *
 * 1. **An explicit code.** They read it off the card; there is nothing to infer.
 * 2. **A registration fragment.** They named the vehicle. Narrowed by
 *    assignment when the fragment alone is ambiguous — two Swifts ending 4432
 *    is rare, but one of them being *theirs* settles it.
 * 3. **Reply context.** They replied to the message about a specific card.
 * 4. **A single assigned card.** They have one car open; it is that one.
 *
 * Assignment is deliberately last among the inferences and only decides when it
 * is *unique*. A technician with three cars open who says "done" has not told
 * anyone which, and picking the most recently touched would be a guess dressed
 * up as a heuristic.
 */
export function resolveCard(input: MatchInput): MatchOutcome {
  if (input.byCode !== null) return { kind: 'matched', card: input.byCode };

  if (input.registrationFragment !== null && input.byRegistration.length > 0) {
    if (input.byRegistration.length === 1) {
      return { kind: 'matched', card: input.byRegistration[0] as CardCandidate };
    }
    const assignedIds = new Set(input.assigned.map((card) => card.jobCardId));
    const mine = input.byRegistration.filter((card) => assignedIds.has(card.jobCardId));
    if (mine.length === 1) return { kind: 'matched', card: mine[0] as CardCandidate };
    return { kind: 'ambiguous', candidates: input.byRegistration };
  }

  // A fragment that matched nothing is a fact, not an absence: the technician
  // named a vehicle this shop does not have open. Falling through to "their one
  // assigned card" would apply the signal to a car they did not mention.
  if (input.registrationFragment !== null) return { kind: 'none' };

  if (input.replyContext !== null) return { kind: 'matched', card: input.replyContext };

  if (input.assigned.length === 1) {
    return { kind: 'matched', card: input.assigned[0] as CardCandidate };
  }
  if (input.assigned.length > 1) return { kind: 'ambiguous', candidates: input.assigned };

  return { kind: 'none' };
}

/**
 * Strips a spoken plate fragment to comparable characters.
 *
 * Deliberately *not* `normaliseRegistration` from `@serviceloop/shared`: that
 * function validates a whole Indian registration and repairs OCR lookalikes,
 * and a fragment like "4432" is not a registration and must not be repaired
 * into one. Here the only job is to make "09 BX 4432", "09bx4432" and
 * "09-BX-4432" the same string.
 */
export function normaliseFragment(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** The shortest fragment allowed to identify a vehicle. */
export const MIN_FRAGMENT_LENGTH = 4;

/**
 * Does a spoken fragment identify this registration?
 *
 * Suffix match on the plate, because that is what people say: a technician
 * shouts "4432" across a workshop, never "TN zero nine bravo x-ray four four
 * three two". Four characters is the floor — three would make "432" match half
 * the yard, and a match that broad is worse than no match, because it produces
 * a confident wrong answer instead of a question.
 */
export function registrationMatches(fragment: string, registration: string): boolean {
  const needle = normaliseFragment(fragment);
  const plate = normaliseFragment(registration);
  if (needle.length < MIN_FRAGMENT_LENGTH || plate.length === 0) return false;
  return plate === needle || plate.endsWith(needle);
}

/**
 * The confidence at or above which a signal applies itself (phase 4.2).
 *
 * Not configurable, and that is deliberate. It is the line between "the system
 * changed a customer's job card because it was sure" and "a human looked" — a
 * shop lowering it to reduce taps would be trading its customers' accuracy for
 * its own convenience, which is exactly the kind of guardrail §10 says not to
 * weaken. A shop that finds the confirmations tiresome should fix the audio.
 */
export const AUTO_APPLY_CONFIDENCE = 0.85;

export function shouldAutoApply(confidence: number, outcome: MatchOutcome): boolean {
  return confidence >= AUTO_APPLY_CONFIDENCE && outcome.kind === 'matched';
}
