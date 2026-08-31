import { PERSONAS, runPersona, type PersonaResult } from '../personas';

/**
 * `pnpm sim` — the conversation simulator (phase 3.10).
 *
 * Six personas against a seeded scenario, in scripted mode: `MockLlmAdapter`,
 * a fake clock, in-memory stores. Deterministic, credential-free, and required
 * in CI — which is the point. Agent behaviour that is only checked by a human
 * reading transcripts regresses the first week nobody reads them.
 *
 * A live-model mode is not implemented here; see the note at the bottom of this
 * file and PROGRESS.md, because a "nightly, report-only" harness that has never
 * been run against a model would be a claim rather than a capability.
 */

const GREEN = '[32m';
const RED = '[31m';
const DIM = '[2m';
const BOLD = '[1m';
const RESET = '[0m';

const colour = process.env['NO_COLOR'] === undefined && process.stdout.isTTY === true;
const paint = (code: string, text: string): string => (colour ? `${code}${text}${RESET}` : text);

async function main(): Promise<number> {
  const only = process.argv[2];
  const personas = only === undefined ? PERSONAS : PERSONAS.filter((p) => p.name === only);

  if (personas.length === 0) {
    process.stdout.write(`No persona named "${String(only)}".\n`);
    return 1;
  }

  process.stdout.write(`\n${paint(BOLD, 'ServiceLoop — conversation simulator')}\n`);
  process.stdout.write(
    `${paint(DIM, 'scripted mode · MockLlm · fake clock · no database')}\n\n`,
  );

  const results: PersonaResult[] = [];
  for (const persona of personas) {
    const result = await runOne(persona.name, () => runPersona(persona));
    results.push(result);
    report(result);
  }

  const failed = results.filter((result) => !result.ok);
  process.stdout.write('\n');
  process.stdout.write(
    failed.length === 0
      ? `${paint(GREEN, `PASSED — ${results.length}/${results.length} personas`)}\n\n`
      : `${paint(RED, `FAILED — ${results.length - failed.length}/${results.length} personas`)}\n\n`,
  );

  return failed.length === 0 ? 0 : 1;
}

/** Turns a thrown persona into a failed result, so one bad script cannot abort the suite. */
async function runOne(
  name: string,
  run: () => Promise<PersonaResult>,
): Promise<PersonaResult> {
  try {
    return await run();
  } catch (error) {
    return {
      persona: name,
      description: '',
      ok: false,
      outcome: {
        decision: null,
        approvedWorkItemIds: [],
        deferredWorkItemIds: [],
        handoffs: 0,
        turns: [],
        timeToDecisionMinutes: null,
      },
      messages: [],
      failures: [
        { kind: 'SCRIPT', detail: error instanceof Error ? error.message : String(error) },
      ],
      durationMs: 0,
    };
  }
}

function report(result: PersonaResult): void {
  const status = result.ok ? paint(GREEN, 'PASS') : paint(RED, 'FAIL');
  const decision = result.outcome.decision ?? 'no decision';
  const time =
    result.outcome.timeToDecisionMinutes === null
      ? 'no decision'
      : `${result.outcome.timeToDecisionMinutes}m to decision`;

  process.stdout.write(
    `  ${status} ${result.persona.padEnd(18)} ${paint(DIM, `${decision} · ${time} · ${result.messages.length} message(s) · ${result.durationMs}ms`)}\n`,
  );
  if (result.description.length > 0) {
    process.stdout.write(`       ${paint(DIM, result.description)}\n`);
  }

  for (const failure of result.failures) {
    process.stdout.write(`       ${paint(RED, `${failure.kind}: ${failure.detail}`)}\n`);
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error('[sim] failed to run');
    console.error(error);
    process.exit(1);
  },
);
