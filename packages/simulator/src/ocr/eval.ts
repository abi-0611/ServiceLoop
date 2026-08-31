import { join } from 'node:path';
import { createLlmPort, VisionLlmOcrAdapter, type OcrPort } from '@serviceloop/adapters';
import { loadEnv } from '@serviceloop/config';
import type { JobCardDraft } from '@serviceloop/shared';
import { buildFixtureImages, DEGRADED, type Degradation, type RenderedCard } from './capture';
import { CARD_FIXTURES, expectedFields, type CardFixture } from './fixtures';
import { groundTruthDraft, perturbDraft } from './ground-truth';
import {
  accuracyByField,
  aggregate,
  evaluateGates,
  PHASE2_GATES,
  scoreExtraction,
  type ExtractionScore,
} from './score';

/**
 * `pnpm eval:ocr` — the OCR accuracy and calibration harness (phase 2.5).
 *
 * Two modes, and it always says which one it ran:
 *
 * - **live** — a vision model is configured, so the fixtures are actually read
 *   and the phase-2 gates are enforced. This is the mode the acceptance gate
 *   means.
 * - **self-test** — no model is configured (the default, and what CI runs).
 *   The fixtures are still rendered and hashed, and the scoring is exercised
 *   against a synthetic reader whose error rate and honesty are known, so the
 *   gates are proven to fire and to pass for the right reasons. It reports no
 *   model accuracy, because it measured none.
 *
 * The distinction is the point. An eval that printed a green 100% because a
 * fixture adapter handed back the answer key would be worse than no eval.
 */

const GREEN = '[32m';
const RED = '[31m';
const YELLOW = '[33m';
const DIM = '[2m';
const BOLD = '[1m';
const RESET = '[0m';

const colour = process.env['NO_COLOR'] === undefined && process.stdout.isTTY === true;
const paint = (code: string, text: string): string => (colour ? `${code}${text}${RESET}` : text);

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;

interface Reader {
  readonly mode: 'live' | 'self-test';
  readonly label: string;
  read(card: RenderedCard): Promise<JobCardDraft>;
}

function liveReader(ocr: OcrPort, label: string): Reader {
  return {
    mode: 'live',
    label,
    read: async (card) => {
      const result = await ocr.extractJobCard({
        shopId: 'eval',
        bytes: card.bytes,
        contentType: card.contentType,
        languageHint: card.fixture.language,
      });
      return result.draft;
    },
  };
}

/**
 * The self-test reader.
 *
 * Degraded images are read worse than clean ones, and the reader is mostly
 * honest about its mistakes — the shape a real vision model has. The numbers
 * are chosen to land above the gates but not comfortably so, which is what
 * makes a broken scorer visible.
 */
function selfTestReader(): Reader {
  const errorRateFor = (variant: Degradation): number =>
    variant === 'clean' ? 0.06 : variant === 'lowlight' ? 0.18 : 0.13;

  return {
    mode: 'self-test',
    label: 'synthetic reader (no vision model configured)',
    read: async (card) =>
      perturbDraft(card.fixture, {
        errorRate: errorRateFor(card.variant),
        honesty: 0.92,
        seed: `${card.fixture.id}:${card.variant}`,
      }),
  };
}

function chooseReader(): Reader {
  const env = loadEnv(process.env as Record<string, string | undefined>);
  const llm = createLlmPort(env);

  if (llm.driver === 'anthropic') {
    return liveReader(new VisionLlmOcrAdapter(llm), `${llm.driver}:${llm.modelFor('EXTRACT')}`);
  }
  return selfTestReader();
}

function printScoreTable(title: string, score: ExtractionScore): void {
  process.stdout.write(`\n${paint(BOLD, title)}\n`);
  process.stdout.write(
    `  fields ${score.correct}/${score.scored}   accuracy ${paint(BOLD, percent(score.accuracy))}\n`,
  );
  const cal = score.calibration;
  process.stdout.write(
    `  confidence: correct ${cal.meanConfidenceCorrect.toFixed(2)}  wrong ${cal.meanConfidenceWrong.toFixed(2)}  split ${cal.split.toFixed(2)}\n`,
  );
  process.stdout.write(
    `  wrong-and-flagged ${percent(cal.wrongBelowThreshold)}   confidently wrong ${percent(cal.confidentlyWrongRate)}\n`,
  );
}

function printFieldBreakdown(scores: readonly ExtractionScore[]): void {
  const byField = [...accuracyByField(scores).entries()].sort(
    (left, right) => left[1] - right[1],
  );

  process.stdout.write(`\n${paint(BOLD, 'Per-field accuracy')}\n`);
  for (const [path, accuracy] of byField) {
    const bar = '█'.repeat(Math.round(accuracy * 24)).padEnd(24, '·');
    const tint = accuracy >= 0.9 ? GREEN : accuracy >= 0.75 ? YELLOW : RED;
    process.stdout.write(`  ${path.padEnd(34)} ${paint(tint, bar)} ${percent(accuracy)}\n`);
  }
}

async function main(): Promise<void> {
  const outputDir = join(process.cwd(), 'fixtures', 'ocr');
  const only = process.argv.find((argument) => argument.startsWith('--only='))?.slice('--only='.length);
  const force = process.argv.includes('--force');

  const fixtures: readonly CardFixture[] =
    only === undefined
      ? CARD_FIXTURES
      : CARD_FIXTURES.filter((fixture) => fixture.id.includes(only));

  if (fixtures.length === 0) {
    process.stdout.write(paint(RED, `No fixture matches "${only ?? ''}"\n`));
    process.exitCode = 1;
    return;
  }

  const reader = chooseReader();

  process.stdout.write(`${paint(BOLD, 'ServiceLoop — OCR eval')}\n`);
  process.stdout.write(`${paint(DIM, `mode: ${reader.mode}  ·  reader: ${reader.label}`)}\n`);

  process.stdout.write(`${paint(DIM, 'rendering fixtures…')}\n`);
  const cards = await buildFixtureImages({
    outputDir,
    fixtures,
    ...(force ? { force: true } : {}),
    onProgress: (message) => process.stdout.write(`${paint(DIM, `  ${message}`)}\n`),
  });
  process.stdout.write(
    `${paint(DIM, `  ${cards.length} images across ${fixtures.length} cards in ${outputDir}`)}\n`,
  );

  const cleanScores: ExtractionScore[] = [];
  const degradedScores: ExtractionScore[] = [];
  const failures: string[] = [];

  for (const card of cards) {
    const expected = expectedFields(card.fixture);
    try {
      const draft = await reader.read(card);
      const score = scoreExtraction(draft, expected);
      if (card.variant === 'clean') cleanScores.push(score);
      else degradedScores.push(score);
    } catch (error) {
      failures.push(
        `${card.fixture.id} (${card.variant}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (failures.length > 0) {
    process.stdout.write(`\n${paint(RED, `${failures.length} card(s) could not be read:`)}\n`);
    for (const failure of failures) process.stdout.write(`  ${failure}\n`);
  }

  const clean = aggregate(cleanScores);
  const degraded = aggregate(degradedScores);

  printScoreTable('Clean renders', clean);
  printScoreTable(`Degraded renders (${DEGRADED.join(', ')})`, degraded);
  printFieldBreakdown([...cleanScores, ...degradedScores]);

  const gates = evaluateGates(clean, degraded, PHASE2_GATES);

  process.stdout.write(`\n${paint(BOLD, 'Gates')}\n`);
  for (const gate of gates) {
    const mark = gate.ok ? paint(GREEN, 'PASS') : paint(RED, 'FAIL');
    const comparison = gate.comparison === 'at-least' ? '>=' : '<=';
    process.stdout.write(
      `  ${mark}  ${gate.name.padEnd(46)} ${percent(gate.actual)} ${comparison} ${percent(gate.required)}\n`,
    );
  }

  const allPassed = gates.every((gate) => gate.ok) && failures.length === 0;

  if (reader.mode === 'self-test') {
    process.stdout.write(
      `\n${paint(YELLOW, 'SELF-TEST ONLY')} — no vision model is configured, so no model accuracy was measured.\n`,
    );
    process.stdout.write(
      `${paint(DIM, 'The numbers above come from a synthetic reader with a known error rate; they prove the')}\n`,
    );
    process.stdout.write(
      `${paint(DIM, 'harness and the gates work. Set LLM_DRIVER=anthropic with ANTHROPIC_API_KEY and DEMO_MODE=false')}\n`,
    );
    process.stdout.write(`${paint(DIM, 'to run the real evaluation.')}\n`);
  }

  process.stdout.write(
    `\n${allPassed ? paint(GREEN, 'All gates passed.') : paint(RED, 'Gates failed.')}\n`,
  );
  process.exitCode = allPassed ? 0 : 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${paint(RED, 'eval:ocr crashed')}\n${String(error)}\n`);
  process.exitCode = 1;
});

export { groundTruthDraft };
