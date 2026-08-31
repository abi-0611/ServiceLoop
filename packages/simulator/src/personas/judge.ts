import { SandboxLlmAdapter, type LlmRequest, type LlmResponder } from '@serviceloop/adapters';

/**
 * A deterministic claim judge, for the simulator and the phase-3 demo.
 *
 * The real judge is a `JUDGE`-class model reading {claim, source} pairs in
 * prose. Without a credential that is not available, and a judge that cleared
 * everything would make the checker's third layer decorative — so this one does
 * the two checks a model reliably gets right and a regex can also get right:
 *
 *   - a **number** in the claim that the source does not state;
 *   - a **part** the claim names that the source never mentions.
 *
 * Those are the two failure shapes the red-team suite exercises, and they are
 * the ones a fabricated diagnosis takes. Everything subtler is the live model's
 * job, and `post-checker.test.ts` covers the structural layers exhaustively.
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
