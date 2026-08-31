import type { LlmPort } from '@serviceloop/adapters';
import { fencePayload, userText } from '@serviceloop/adapters';
import { disclosesAi, parseSourceId, type Claim } from '@serviceloop/domain';
import { formatPaise, t, type Language, type Paise, type StringKey } from '@serviceloop/shared';
import { z } from 'zod';

/**
 * The claim-anchoring post-checker (phase 3.5) — L7, enforced.
 *
 * `send_customer_message` runs this over every candidate before anything
 * reaches a channel. A blocked candidate is not discarded: it lands in the HITL
 * queue with its reasons attached, because "the agent tried to say something
 * unsupported" is information an advisor needs, and silently dropping it would
 * leave a customer waiting for a reply that was never coming.
 *
 * Three layers, cheapest first:
 *
 *   1. **Structural.** Disclosure where it is required, no banned pattern, and
 *      every rupee figure in the copy matching an estimate line exactly. Pure,
 *      instant, and it catches most of the red team.
 *   2. **Coverage.** Every factual sentence must be one of the claims, and every
 *      claim must cite a source that was actually supplied. A sentence smuggled
 *      in outside the claim list is the classic way an unanchored assertion
 *      gets sent, so coverage is checked over the *body*, not the claim list.
 *   3. **Support.** A CLASSIFY-class judge reads each {claim, source} pair and
 *      says whether the source actually supports the claim. This is the only
 *      layer that costs a model call, and it runs last, on what survived.
 *
 * The checker fails **closed**. Any error — the judge times out, a source is
 * missing, a sentence cannot be classified — blocks to HITL. A false block
 * costs an advisor ten seconds; a false pass costs a customer their trust.
 */

export type CheckCode =
  | 'DISCLOSURE_MISSING'
  | 'CLAIM_NOT_ANCHORED'
  | 'SOURCE_UNKNOWN'
  | 'SOURCE_DOES_NOT_SUPPORT'
  | 'PRICE_NOT_ON_ESTIMATE'
  | 'INVENTED_URGENCY'
  | 'ABSOLUTE_PROMISE'
  | 'OUT_OF_SCOPE_ADVICE'
  | 'JUDGE_UNAVAILABLE';

export interface CheckReason {
  readonly code: CheckCode;
  readonly detail: string;
  /** The words that triggered it, so the console can highlight them. */
  readonly span: string;
}

export type CheckVerdict =
  | { readonly kind: 'pass' }
  | { readonly kind: 'block_to_hitl'; readonly reasons: readonly CheckReason[] };

export interface CandidateSource {
  readonly id: string;
  readonly text: string;
}

export interface CandidateMessage {
  readonly shopId: string;
  readonly language: Language;
  readonly body: string;
  readonly claims: readonly Claim[];
  readonly sources: readonly CandidateSource[];
  /** Every figure the copy is allowed to state: line totals and the grand total. */
  readonly allowedAmountsPaise: readonly Paise[];
  readonly isFirstContactInSession: boolean;
  readonly traceId: string;
}

export interface PostCheckerOptions {
  /** Skips the judge. Only for tests that are exercising the structural layers. */
  readonly skipJudge?: boolean;
}

export class PostChecker {
  constructor(
    private readonly llm: LlmPort,
    private readonly options: PostCheckerOptions = {},
  ) {}

  async review(candidate: CandidateMessage): Promise<CheckVerdict> {
    const reasons: CheckReason[] = [
      ...checkDisclosure(candidate),
      ...checkBannedPatterns(candidate),
      ...checkPrices(candidate),
      ...checkCoverage(candidate),
    ];

    // The judge only runs on claims that survived the structural pass. There is
    // no point spending a model call proving that a fabricated source supports
    // a sentence that already cited a price nobody quoted.
    if (reasons.length === 0 && this.options.skipJudge !== true) {
      reasons.push(...(await this.judgeSupport(candidate)));
    }

    return reasons.length === 0 ? { kind: 'pass' } : { kind: 'block_to_hitl', reasons };
  }

  /**
   * Asks a cheap model whether each source actually supports its claim.
   *
   * One call for every pair, batched, with the sources fenced as payload. A
   * judge that fails, times out or answers in the wrong shape blocks — the
   * checker has no way to distinguish "unavailable" from "unsupported", and
   * only one of those two guesses is safe.
   */
  private async judgeSupport(candidate: CandidateMessage): Promise<readonly CheckReason[]> {
    const pairs = candidate.claims.flatMap((claim, claimIndex) =>
      claim.sources.map((source) => ({ claimIndex, claim: claim.text, source })),
    );
    if (pairs.length === 0) return [];

    const byId = new Map(candidate.sources.map((source) => [source.id, source.text]));
    const rendered = pairs
      .map(
        (pair, index) =>
          `${index}. CLAIM: ${pair.claim}\n   SOURCE (${pair.source}): ${byId.get(pair.source) ?? '(missing)'}`,
      )
      .join('\n\n');

    try {
      const result = await this.llm.extract({
        taskClass: 'JUDGE',
        shopId: candidate.shopId,
        traceId: candidate.traceId,
        system: JUDGE_SYSTEM_PROMPT,
        maxOutputTokens: 2_000,
        schema: JUDGE_SCHEMA,
        messages: [userText(`${JUDGE_INSTRUCTIONS}\n\n${fencePayload(rendered)}`)],
      });

      const verdicts = new Map(
        result.value.verdicts.map((verdict) => [verdict.index, verdict] as const),
      );

      return pairs.flatMap((pair, index): CheckReason[] => {
        const verdict = verdicts.get(index);
        if (verdict === undefined) {
          return [
            {
              code: 'JUDGE_UNAVAILABLE',
              detail: `The judge returned no verdict for claim ${index}, so it could not be cleared`,
              span: pair.claim,
            },
          ];
        }
        if (verdict.supported) return [];
        return [
          {
            code: 'SOURCE_DOES_NOT_SUPPORT',
            detail: `${pair.source} does not support this claim: ${verdict.reason}`,
            span: pair.claim,
          },
        ];
      });
    } catch (error) {
      return [
        {
          code: 'JUDGE_UNAVAILABLE',
          detail: `The claim judge could not be reached, so nothing here could be cleared: ${
            error instanceof Error ? error.message : String(error)
          }`,
          span: '',
        },
      ];
    }
  }
}

/* -------------------------------------------------------- structural layer */

export function checkDisclosure(candidate: CandidateMessage): readonly CheckReason[] {
  if (!candidate.isFirstContactInSession) return [];
  if (disclosesAi(candidate.body)) return [];
  return [
    {
      code: 'DISCLOSURE_MISSING',
      detail:
        'This is the first message of the session and it does not say the sender is an AI assistant',
      span: candidate.body.slice(0, 80),
    },
  ];
}

/**
 * Invented urgency, absolute promises, and advice this system has no business
 * giving.
 *
 * Urgency is not banned outright — a brake pad at 2.1 mm genuinely is urgent,
 * and refusing to say so would be its own kind of dishonesty. What is banned is
 * urgency the *sources* do not carry, so a hit is cleared when some supplied
 * source also speaks in those terms.
 */
export function checkBannedPatterns(candidate: CandidateMessage): readonly CheckReason[] {
  const reasons: CheckReason[] = [];
  const haystack = candidate.body.toLowerCase();
  const byId = new Map(candidate.sources.map((source) => [source.id, source.text.toLowerCase()]));

  for (const term of URGENCY_LEXICON) {
    if (!haystack.includes(term)) continue;

    // Licensed per *claim*, not per message. A note about the brake pads
    // saying "metal to metal soon" does not license calling the engine oil
    // dangerous — and a message-wide check would let it, which is precisely
    // how a shop ends up frightening someone about the wrong part.
    const carrier = candidate.claims.find((claim) => claim.text.toLowerCase().includes(term));
    const licensed =
      carrier !== undefined &&
      carrier.sources.some((source) => {
        const text = byId.get(source);
        return text !== undefined && URGENCY_SOURCE_SIGNALS.some((signal) => text.includes(signal));
      });

    if (licensed) continue;

    reasons.push({
      code: 'INVENTED_URGENCY',
      detail:
        carrier === undefined
          ? `"${term}" claims urgency and is not declared as a claim at all, so nothing supports it`
          : `"${term}" claims urgency that the sources this sentence cites do not carry`,
      span: term,
    });
  }

  for (const term of ABSOLUTE_PROMISES) {
    if (haystack.includes(term)) {
      reasons.push({
        code: 'ABSOLUTE_PROMISE',
        detail: `"${term}" is a promise this system cannot keep; the ETA engine is the only source of a completion time`,
        span: term,
      });
    }
  }

  for (const term of OUT_OF_SCOPE) {
    if (haystack.includes(term)) {
      reasons.push({
        code: 'OUT_OF_SCOPE_ADVICE',
        detail: `"${term}" strays into medical, legal or insurance advice`,
        span: term,
      });
    }
  }

  return reasons;
}

/**
 * Every rupee figure in the copy must be one of the amounts the estimate
 * actually carries.
 *
 * Exact match, not tolerance. A message that says ₹2,400 when the line says
 * ₹2,450 is a message the shop will have to argue about at the counter, and the
 * fifty rupees is not the point — the customer's belief that the number they
 * were quoted is the number they will pay is the point.
 */
export function checkPrices(candidate: CandidateMessage): readonly CheckReason[] {
  const allowed = new Set(candidate.allowedAmountsPaise.map((amount) => amount));
  const mentioned = extractAmountsPaise(candidate.body);

  return mentioned
    .filter((amount) => !allowed.has(amount))
    .map((amount) => ({
      code: 'PRICE_NOT_ON_ESTIMATE' as const,
      detail: `${formatPaise(amount)} does not match any estimate line total or the estimate total`,
      span: formatPaise(amount),
    }));
}

/**
 * Rupee amounts in a body, in paise.
 *
 * Handles the forms Indian copy actually uses: `₹2,400`, `Rs 2400`, `2400/-`,
 * `2,400 rupees`, and decimal paise. A bare integer with none of those markers
 * is *not* treated as money — "2 hours" and "TN 09 BX 4432" would otherwise
 * become price violations on every message.
 */
export function extractAmountsPaise(body: string): readonly Paise[] {
  const amounts: number[] = [];
  const pattern =
    /(?:₹|\brs\.?\s*|\binr\s*)\s*([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s*(?:\/-|rupees?|ரூபாய்|रुपये)/gi;

  for (const match of body.matchAll(pattern)) {
    const raw = match[1] ?? match[2];
    if (raw === undefined) continue;
    const value = Number(raw.replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    amounts.push(Math.round(value * 100));
  }

  return amounts;
}

/**
 * Coverage: every factual sentence in the body is a claim, and every claim
 * cites a source that exists.
 *
 * Checked over the body rather than the claim list, because the failure this
 * catches is a sentence that was never declared as a claim at all — which is
 * exactly how an unanchored assertion gets past a checker that only inspects
 * what it was handed.
 */
export function checkCoverage(candidate: CandidateMessage): readonly CheckReason[] {
  const reasons: CheckReason[] = [];
  const known = new Set(candidate.sources.map((source) => source.id));

  for (const claim of candidate.claims) {
    if (claim.sources.length === 0) {
      if (isStandingClaim(claim.text, candidate.language)) continue;
      reasons.push({
        code: 'CLAIM_NOT_ANCHORED',
        detail: 'This sentence states a fact and cites nothing',
        span: claim.text,
      });
      continue;
    }
    for (const source of claim.sources) {
      if (parseSourceId(source) === null) {
        reasons.push({
          code: 'SOURCE_UNKNOWN',
          detail: `"${source}" is not a source id (expected note:…, line:…, media:…, state:… or eta:…)`,
          span: claim.text,
        });
        continue;
      }
      if (!known.has(source)) {
        reasons.push({
          code: 'SOURCE_UNKNOWN',
          detail: `"${source}" was not among the sources supplied for this message`,
          span: claim.text,
        });
      }
    }
  }

  const declared = candidate.claims.map((claim) => normalise(claim.text));
  for (const sentence of splitSentences(candidate.body)) {
    if (!isFactual(sentence)) continue;
    if (isStandingClaim(sentence, candidate.language)) continue;
    const normalised = normalise(sentence);
    const covered = declared.some(
      (claim) => claim.includes(normalised) || normalised.includes(claim),
    );
    if (!covered) {
      reasons.push({
        code: 'CLAIM_NOT_ANCHORED',
        detail: 'This sentence states a fact but was not declared as a claim with a source',
        span: sentence,
      });
    }
  }

  return reasons;
}

/**
 * Is this sentence making a factual assertion about the vehicle or the money?
 *
 * Deliberately generous — it errs towards "yes", because a false positive is a
 * sentence that has to be declared as a claim (cheap) and a false negative is
 * an unanchored assertion reaching a customer (not cheap). Greetings, questions
 * and the fixed catalogue lines are the exceptions, and they are recognised
 * explicitly rather than by absence of evidence.
 */
export function isFactual(sentence: string): boolean {
  const trimmed = sentence.trim();
  if (trimmed.length === 0) return false;
  // A question asks; it does not assert.
  if (trimmed.endsWith('?') || trimmed.endsWith('？')) return false;

  const lower = trimmed.toLowerCase();
  if (GREETINGS.some((greeting) => lower.startsWith(greeting))) return false;
  if (/\d/.test(trimmed)) return true;
  return FACTUAL_LEXICON.some((term) => lower.includes(term));
}

/**
 * Claims that are true of every job at every shop, and therefore need no
 * evidence id.
 *
 * There is exactly one class of these and it is drawn from the i18n catalogue,
 * not from a list a developer can extend by hand: the old-part inspection
 * offer, the AI disclosure, the handoff acknowledgement. Anything a shop wants
 * to add has to become catalogue copy, which is reviewable.
 */
const STANDING_CLAIM_KEYS: readonly StringKey[] = [
  'approval.old_parts_offer',
  'approval.call_offer',
  'approval.footer',
  'disclosure.first_contact',
  'agent.handoff_ack',
  'agent.blocked_fallback',
  'approval.owner_check_offer',
];

export function isStandingClaim(sentence: string, language: Language): boolean {
  const normalised = normalise(sentence);
  if (normalised.length === 0) return true;

  return STANDING_CLAIM_KEYS.some((key) => {
    // Catalogue strings carry placeholders; comparing the fixed prefix is what
    // makes "You are welcome to inspect the old parts…" match regardless of the
    // shop name interpolated later in the sentence.
    const template = normalise(templateFor(language, key));
    const prefix = template.split('{')[0]?.trim() ?? '';
    return prefix.length > 12 && normalised.includes(prefix);
  });
}

function templateFor(language: Language, key: StringKey): string {
  try {
    return t(language, key, PLACEHOLDER_PARAMS);
  } catch {
    return '';
  }
}

/** Every placeholder any standing-claim template uses, filled with a marker. */
const PLACEHOLDER_PARAMS = {
  shopName: '{',
  customerName: '{',
  advisorName: '{',
  vehicle: '{',
  amount: '{',
  when: '{',
} as const;

export function splitSentences(body: string): readonly string[] {
  return body
    .split(/(?<=[.!?。！？])\s+|\n+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .replace(/[.,!?;:—–-]/g, '')
    .trim();
}

/* -------------------------------------------------------------- lexicons -- */

/**
 * Urgency language. English plus the Tamil and Hindi terms that actually appear
 * in a workshop conversation — a lexicon that only covers English would pass
 * every fear-mongering message written in the language most of these customers
 * use.
 */
const URGENCY_LEXICON: readonly string[] = [
  'dangerous',
  'unsafe',
  'accident',
  'life risk',
  'could fail',
  'will fail',
  'about to fail',
  'emergency',
  'critical',
  'do not drive',
  "don't drive",
  'immediately',
  'urgent',
  'ஆபத்து',
  'உடனடியாக',
  'விபத்து',
  'खतरा',
  'तुरंत',
  'दुर्घटना',
];

/** A source that speaks this way licenses the copy to speak that way too. */
const URGENCY_SOURCE_SIGNALS: readonly string[] = [
  'unsafe',
  'dangerous',
  'urgent',
  'immediately',
  'do not drive',
  'below minimum',
  'metal to metal',
  'worn out',
  'leak',
  'crack',
  'ஆபத்து',
  'உடனடி',
  'खतरा',
  'तुरंत',
];

const ABSOLUTE_PROMISES: readonly string[] = [
  'guarantee',
  'guaranteed',
  '100%',
  'definitely be ready',
  'will be ready by',
  'ready by exactly',
  'never fail',
  'no problem at all',
  'i promise',
  'we promise',
  'உறுதியாக',
  'गारंटी',
];

const OUT_OF_SCOPE: readonly string[] = [
  'insurance will cover',
  'claim it on insurance',
  'legally you must',
  'the law requires',
  'consult a doctor',
  'health risk',
];

const GREETINGS: readonly string[] = [
  'hello',
  'hi ',
  'good morning',
  'good afternoon',
  'good evening',
  'thank you',
  'thanks',
  'வணக்கம்',
  'நன்றி',
  'नमस्ते',
  'धन्यवाद',
];

/**
 * Words that make a sentence an assertion about the vehicle.
 *
 * Parts, conditions and actions — the vocabulary a claim about a car is made
 * of. Kept explicit so the red-team suite can be reasoned about, and so adding
 * a term is a reviewable diff rather than a prompt tweak.
 */
const FACTUAL_LEXICON: readonly string[] = [
  'brake',
  'pad',
  'disc',
  'rotor',
  'clutch',
  'tyre',
  'tire',
  'battery',
  'oil',
  'coolant',
  'filter',
  'belt',
  'suspension',
  'bush',
  'shock',
  'alignment',
  'radiator',
  'leak',
  'worn',
  'wear',
  'crack',
  'rust',
  'corrod',
  'noise',
  'vibrat',
  'overheat',
  'replace',
  'repair',
  'top up',
  'refill',
  'thickness',
  'mm',
  'km',
  'found',
  'inspect',
  'மிதி',
  'எண்ணெய்',
  'பிரேக்',
  'தேய்',
  'ब्रेक',
  'तेल',
  'घिस',
];

/* ----------------------------------------------------------------- judge -- */

const JudgeVerdictSchema = z.object({
  verdicts: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      supported: z.boolean(),
      reason: z.string().max(300),
    }),
  ),
});

type JudgeVerdicts = z.infer<typeof JudgeVerdictSchema>;

const JUDGE_SCHEMA: { readonly name: string; readonly description: string; readonly jsonSchema: Readonly<Record<string, unknown>>; parse(value: unknown): JudgeVerdicts } = {
  name: 'claim_support_verdicts',
  description: 'Whether each source supports its claim',
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['verdicts'],
    properties: {
      verdicts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['index', 'supported', 'reason'],
          properties: {
            index: { type: 'integer' },
            supported: { type: 'boolean' },
            reason: { type: 'string' },
          },
        },
      },
    },
  },
  parse: (value: unknown) => JudgeVerdictSchema.parse(value),
};

export const JUDGE_SYSTEM_PROMPT = `You check whether a source supports a claim, and nothing else.

You are the last thing between a workshop's AI assistant and a customer who will
believe what it says. Your only question is: does this exact source text state
or directly imply this exact claim?

Say supported=false when:
  - the claim adds a detail the source does not contain (a measurement, a cause,
    a consequence, a part the source never names);
  - the claim states urgency, danger or a deadline the source does not;
  - the claim states a price and the source does not state that price;
  - the source is about a different part, a different job, or a different visit.

Say supported=true when the source states the claim, or states something the
claim is a plain-language restatement of. A translation into the customer's
language is a restatement, not an addition.

You are not judging whether the claim is *true*, kind, or well written. Only
whether this source supports it. When you are unsure, say supported=false.`;

const JUDGE_INSTRUCTIONS = `Below are numbered {claim, source} pairs. Return a verdict for every index.`;
