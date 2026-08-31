import { draftFields, type JobCardDraft } from '@serviceloop/shared';

/**
 * Scoring an extraction against the answer key.
 *
 * Two numbers matter, and only one of them is accuracy.
 *
 * The second is **calibration**: whether the fields the extractor got wrong
 * admitted they might be wrong. An extractor that is 85% accurate and flags
 * every one of its mistakes is *usable* — the confirmation flow puts those
 * fields in front of an advisor and the card comes out right. An extractor
 * that is 92% accurate and confident about all of it is dangerous, because the
 * 8% goes onto job cards unread. So the eval gates on both, and the
 * confidently-wrong rate is the number to watch.
 */

export interface FieldScore {
  readonly path: string;
  readonly expected: string | null;
  readonly actual: string | null;
  readonly confidence: number;
  readonly correct: boolean;
  /** The extractor supplied a value the card does not carry. */
  readonly invented: boolean;
  /** The card carries a value and the extractor left it empty. */
  readonly missed: boolean;
}

export interface Calibration {
  readonly meanConfidenceCorrect: number;
  readonly meanConfidenceWrong: number;
  /** Correct minus wrong. A well-calibrated extractor separates these. */
  readonly split: number;
  /** Share of wrong fields that scored below the confirmation threshold. */
  readonly wrongBelowThreshold: number;
  /** Share of *all* fields that are wrong AND confident. The dangerous ones. */
  readonly confidentlyWrongRate: number;
}

export interface ExtractionScore {
  readonly fields: readonly FieldScore[];
  readonly scored: number;
  readonly correct: number;
  readonly accuracy: number;
  readonly calibration: Calibration;
}

/** `draftFields()` renders a null value as an em dash; undo that here. */
function actualValue(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed === '' || trimmed === '—' ? null : trimmed;
}

/**
 * Comparison is per-field-kind, because "correct" means different things.
 * A registration matches on its normalised form, money on its numeric value,
 * and prose on its words rather than its punctuation.
 */
function matches(path: string, expected: string, actual: string): boolean {
  if (path === 'vehicle.registration') {
    return normaliseAlnum(expected) === normaliseAlnum(actual);
  }

  if (path === 'customer.phone') {
    // Both sides reduce to their last ten digits: `+91 98400 12345` and
    // `9840012345` are the same number written two ways.
    return lastTenDigits(expected) === lastTenDigits(actual);
  }

  if (path.endsWith('unitPricePaise') || path === 'vehicle.odometerKm') {
    const left = Number(expected.replace(/[^\d.-]/g, ''));
    const right = Number(actual.replace(/[^\d.-]/g, ''));
    return Number.isFinite(left) && Number.isFinite(right) && left === right;
  }

  return normaliseText(expected) === normaliseText(actual);
}

function normaliseText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[.,;:!?'"()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normaliseAlnum(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function lastTenDigits(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits.slice(-10);
}

export interface ScoreOptions {
  /** The shop's confirmation threshold; fields below it reach a human. */
  readonly confirmationThreshold?: number;
}

export function scoreExtraction(
  draft: JobCardDraft,
  expected: ReadonlyMap<string, string | null>,
  options: ScoreOptions = {},
): ExtractionScore {
  const threshold = options.confirmationThreshold ?? 0.8;
  const extracted = new Map(draftFields(draft).map((field) => [field.path, field]));

  const fields: FieldScore[] = [];

  for (const [path, expectedValue] of expected) {
    const field = extracted.get(path);
    // A line the extractor never produced is a miss with no confidence to
    // speak of. Scoring it at confidence 0 is right: it did not claim it.
    const actual = field === undefined ? null : actualValue(field.value);
    const confidence = field?.confidence ?? 0;

    const correct =
      expectedValue === null
        ? actual === null
        : actual !== null && matches(path, expectedValue, actual);

    fields.push({
      path,
      expected: expectedValue,
      actual,
      confidence,
      correct,
      invented: expectedValue === null && actual !== null,
      missed: expectedValue !== null && actual === null,
    });
  }

  // Extra lines the extractor hallucinated beyond the card's own rows are
  // scored too — otherwise an extractor could pad its accuracy by inventing
  // estimate lines that nothing checks.
  for (const [path, field] of extracted) {
    if (expected.has(path)) continue;
    if (!path.startsWith('estimateLines.') && !path.startsWith('complaints.')) continue;
    const actual = actualValue(field.value);
    if (actual === null) continue;
    fields.push({
      path,
      expected: null,
      actual,
      confidence: field.confidence,
      correct: false,
      invented: true,
      missed: false,
    });
  }

  const correctFields = fields.filter((field) => field.correct);
  const wrongFields = fields.filter((field) => !field.correct);

  const calibration: Calibration = {
    meanConfidenceCorrect: mean(correctFields.map((field) => field.confidence)),
    meanConfidenceWrong: mean(wrongFields.map((field) => field.confidence)),
    split:
      mean(correctFields.map((field) => field.confidence)) -
      mean(wrongFields.map((field) => field.confidence)),
    wrongBelowThreshold:
      wrongFields.length === 0
        ? 1
        : wrongFields.filter((field) => field.confidence < threshold).length / wrongFields.length,
    confidentlyWrongRate:
      fields.length === 0
        ? 0
        : wrongFields.filter((field) => field.confidence >= threshold).length / fields.length,
  };

  return {
    fields,
    scored: fields.length,
    correct: correctFields.length,
    accuracy: fields.length === 0 ? 0 : correctFields.length / fields.length,
    calibration,
  };
}

/** Rolls several per-card scores into one. */
export function aggregate(scores: readonly ExtractionScore[]): ExtractionScore {
  const fields = scores.flatMap((score) => score.fields);
  const correctFields = fields.filter((field) => field.correct);
  const wrongFields = fields.filter((field) => !field.correct);
  const threshold = 0.8;

  return {
    fields,
    scored: fields.length,
    correct: correctFields.length,
    accuracy: fields.length === 0 ? 0 : correctFields.length / fields.length,
    calibration: {
      meanConfidenceCorrect: mean(correctFields.map((field) => field.confidence)),
      meanConfidenceWrong: mean(wrongFields.map((field) => field.confidence)),
      split:
        mean(correctFields.map((field) => field.confidence)) -
        mean(wrongFields.map((field) => field.confidence)),
      wrongBelowThreshold:
        wrongFields.length === 0
          ? 1
          : wrongFields.filter((field) => field.confidence < threshold).length / wrongFields.length,
      confidentlyWrongRate:
        fields.length === 0
          ? 0
          : wrongFields.filter((field) => field.confidence >= threshold).length / fields.length,
    },
  };
}

/** Per-field-path accuracy, for the eval's breakdown table. */
export function accuracyByField(scores: readonly ExtractionScore[]): Map<string, number> {
  const totals = new Map<string, { correct: number; total: number }>();

  for (const score of scores) {
    for (const field of score.fields) {
      // `estimateLines.3.description` rolls up to `estimateLines.description`,
      // so the table stays readable on a card with nine rows.
      const key = field.path.replace(/\.\d+/g, '');
      const entry = totals.get(key) ?? { correct: 0, total: 0 };
      entry.total += 1;
      if (field.correct) entry.correct += 1;
      totals.set(key, entry);
    }
  }

  return new Map(
    [...totals.entries()].map(([key, entry]) => [key, entry.total === 0 ? 0 : entry.correct / entry.total]),
  );
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/* -------------------------------------------------------------------------- *
 * Gates
 * -------------------------------------------------------------------------- */

export interface EvalGates {
  readonly cleanAccuracy: number;
  readonly degradedAccuracy: number;
  readonly calibrationSplit: number;
  readonly wrongBelowThreshold: number;
  readonly maxConfidentlyWrongRate: number;
}

/** Phase 2.5's acceptance thresholds. */
export const PHASE2_GATES: EvalGates = {
  cleanAccuracy: 0.9,
  degradedAccuracy: 0.75,
  calibrationSplit: 0.15,
  wrongBelowThreshold: 0.7,
  maxConfidentlyWrongRate: 0.05,
};

export interface GateResult {
  readonly name: string;
  readonly ok: boolean;
  readonly actual: number;
  readonly required: number;
  readonly comparison: 'at-least' | 'at-most';
}

export function evaluateGates(
  clean: ExtractionScore,
  degraded: ExtractionScore,
  gates: EvalGates = PHASE2_GATES,
): GateResult[] {
  const all = aggregate([clean, degraded]);

  return [
    {
      name: 'clean field accuracy',
      ok: clean.accuracy >= gates.cleanAccuracy,
      actual: clean.accuracy,
      required: gates.cleanAccuracy,
      comparison: 'at-least',
    },
    {
      name: 'degraded field accuracy',
      ok: degraded.accuracy >= gates.degradedAccuracy,
      actual: degraded.accuracy,
      required: gates.degradedAccuracy,
      comparison: 'at-least',
    },
    {
      name: 'calibration split (correct − wrong confidence)',
      ok: all.calibration.split >= gates.calibrationSplit,
      actual: all.calibration.split,
      required: gates.calibrationSplit,
      comparison: 'at-least',
    },
    {
      name: 'wrong fields below the confirmation threshold',
      ok: all.calibration.wrongBelowThreshold >= gates.wrongBelowThreshold,
      actual: all.calibration.wrongBelowThreshold,
      required: gates.wrongBelowThreshold,
      comparison: 'at-least',
    },
    {
      name: 'confidently wrong rate',
      ok: all.calibration.confidentlyWrongRate <= gates.maxConfidentlyWrongRate,
      actual: all.calibration.confidentlyWrongRate,
      required: gates.maxConfidentlyWrongRate,
      comparison: 'at-most',
    },
  ];
}
