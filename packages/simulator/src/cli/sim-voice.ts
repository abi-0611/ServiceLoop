import { VOICE_PERSONAS, runVoicePersona, type VoicePersonaResult } from '../voice';

/**
 * `pnpm sim:voice` — the voice simulation suite (phase 5.8).
 *
 * Five personas, each a whole telephone call: a loopback line, fixture audio
 * through the real streaming speech port, a scripted agent where one is needed,
 * a fake calendar on a clock that really ticks, and no credentials of any kind.
 * Required in CI, for the reason the chat suite is: a voice flow checked only by
 * a person listening to a demo regresses the first week nobody listens.
 *
 * Every call is judged twice — on what its persona was for, and on the four
 * things the phase demands of *every* call: the disclosure was heard first, a
 * decision was read back before it was recorded, the latency markers stayed
 * inside the budget, and a usage row was written. Those live in the runner
 * rather than in the personas, because a property four fixtures happen to
 * satisfy is not a guarantee.
 *
 * A live-model / live-speech mode is not implemented, and is deliberately
 * absent rather than stubbed. See PROGRESS.md.
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
  const personas =
    only === undefined ? VOICE_PERSONAS : VOICE_PERSONAS.filter((one) => one.name === only);

  if (personas.length === 0) {
    process.stdout.write(`No voice persona named "${String(only)}".\n`);
    return 1;
  }

  process.stdout.write(`\n${paint(BOLD, 'ServiceLoop — voice simulator')}\n`);
  process.stdout.write(
    `${paint(DIM, 'scripted mode · loopback line · MockStreamingSpeech · MockLlm · no telco')}\n\n`,
  );

  const results: VoicePersonaResult[] = [];
  for (const persona of personas) {
    const result = await runOne(persona.name, persona.description, () =>
      runVoicePersona(persona),
    );
    results.push(result);
    report(result);
  }

  const failed = results.filter((result) => !result.ok);
  process.stdout.write('\n');
  process.stdout.write(
    failed.length === 0
      ? `${paint(GREEN, `PASSED — ${results.length}/${results.length} voice personas`)}\n\n`
      : `${paint(RED, `FAILED — ${results.length - failed.length}/${results.length} voice personas`)}\n\n`,
  );

  return failed.length === 0 ? 0 : 1;
}

/** A thrown persona is a failed persona, not an aborted suite. */
async function runOne(
  name: string,
  description: string,
  run: () => Promise<VoicePersonaResult>,
): Promise<VoicePersonaResult> {
  try {
    return await run();
  } catch (error) {
    return {
      persona: name,
      description,
      ok: false,
      failures: [
        { kind: 'SCRIPT', detail: error instanceof Error ? error.message : String(error) },
      ],
      heard: [],
      did: [],
      decision: null,
      turns: 0,
      maxLatencyMs: 0,
      costPaise: 0,
      durationMs: 0,
    };
  }
}

function report(result: VoicePersonaResult): void {
  const badge = result.ok ? paint(GREEN, 'PASS') : paint(RED, 'FAIL');
  process.stdout.write(`${badge}  ${paint(BOLD, result.persona)}\n`);
  process.stdout.write(`      ${paint(DIM, result.description)}\n`);
  process.stdout.write(
    `      ${paint(
      DIM,
      `decision ${String(result.decision)} · ${result.turns} turns · ${result.maxLatencyMs}ms worst turn · ${(
        result.costPaise / 100
      ).toFixed(2)} rupees · ${result.durationMs}ms`,
    )}\n`,
  );

  for (const action of result.did) {
    process.stdout.write(`      ${paint(DIM, `caller: ${action}`)}\n`);
  }

  for (const failure of result.failures) {
    process.stdout.write(`      ${paint(RED, `${failure.kind}: ${failure.detail}`)}\n`);
  }

  process.stdout.write('\n');
}

void main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  },
);
