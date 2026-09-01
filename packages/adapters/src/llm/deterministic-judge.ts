import type { LlmRequest } from './port';
import { SandboxLlmAdapter, type LlmResponder } from './sandbox-adapter';

/**
 * A deterministic claim judge, for every deployment without a model key.
 *
 * The real judge is a `JUDGE`-class model reading {claim, source} pairs in
 * prose. Without a credential that is not available, and the checker fails
 * closed — so a sandbox with no judge at all is a sandbox where nothing can
 * ever be said, which is not a useful thing to develop against. A judge that
 * cleared everything would be worse: it would make the checker's third layer
 * decorative. So this one does the two checks a model reliably gets right and a
 * regex can also get right:
 *
 *   - a **number** in the claim that the source does not state;
 *   - a **part** the claim names that the source never mentions.
 *
 * Those are the two failure shapes the red-team suite exercises, and they are
 * the ones a fabricated diagnosis takes. Everything subtler is the live model's
 * job, and `post-checker.test.ts` covers the structural layers exhaustively.
 *
 * It lives here rather than beside the persona suite because four things now
 * need it — the persona suite, the phase-3 and phase-4 demos, the voice tests
 * and `sim:voice` — and a judge that differs between the suite that proves a
 * flow and the demo that shows it is a judge proving nothing.
 */

const PARTS = [
  'caliper',
  'clutch',
  'radiator',
  'suspension',
  'bush',
  'tyre',
  'tire',
  'battery',
  'belt',
  'coolant',
] as const;

interface Pair {
  readonly index: number;
  readonly claim: string;
  readonly source: string;
}

export function deterministicJudgeResponder(): LlmResponder {
  return {
    name: 'deterministic-judge',
    matches: (_request, schemaName) => schemaName === 'claim_support_verdicts',
    extract: (request) => ({
      verdicts: parsePairs(request).map((pair) => {
        const reason = unsupportedReason(pair);
        return {
          index: pair.index,
          supported: reason === null,
          reason: reason ?? 'a plain restatement of the source',
        };
      }),
    }),
  };
}

/** A sandbox adapter that answers judge calls and nothing else of note. */
export function deterministicJudge(): SandboxLlmAdapter {
  return new SandboxLlmAdapter({ responders: [deterministicJudgeResponder()] });
}

function unsupportedReason(pair: Pair): string | null {
  const claim = pair.claim.toLowerCase();
  const source = pair.source.toLowerCase();

  const numbers = [...claim.matchAll(/\d+(?:[.,]\d+)*/g)].map((hit) =>
    hit[0].replace(/,/g, ''),
  );
  const strippedSource = source.replace(/,/g, '');
  const missingNumber = numbers.find((value) => !strippedSource.includes(value));
  if (missingNumber !== undefined) {
    return `the source states no figure ${missingNumber}`;
  }

  const missingPart = PARTS.find((part) => claim.includes(part) && !source.includes(part));
  if (missingPart !== undefined) {
    return `the source never mentions the ${missingPart}`;
  }

  return null;
}

/** The numbered pairs a judge prompt carries. */
function parsePairs(request: LlmRequest): readonly Pair[] {
  const text = request.messages
    .flatMap((message) => message.content)
    .flatMap((block) => (block.kind === 'text' ? [block.text] : []))
    .join('\n');

  return [...text.matchAll(/^(\d+)\. CLAIM: (.*)\n\s+SOURCE \((?:.*)\): (.*)$/gm)].map(
    (match) => ({
      index: Number(match[1]),
      claim: match[2] ?? '',
      source: match[3] ?? '',
    }),
  );
}
