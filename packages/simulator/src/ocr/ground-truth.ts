import { JobCardDraftSchema, type ConfidentField, type JobCardDraft } from '@serviceloop/shared';
import { createHash } from 'node:crypto';
import type { CardFixture } from './fixtures';

/**
 * The ground-truth draft for a fixture card — what a perfect reader returns.
 *
 * Used two ways. The `FixtureOcrAdapter` serves it so the demo and CI can run
 * the whole photo-intake path with no model, and the eval's self-test perturbs
 * it to manufacture a *known-bad* extraction, which is how the scoring and the
 * gates get tested without a vision model in the loop.
 */

function truth<T>(value: T): ConfidentField<T> {
  return { value, confidence: 1, region: null };
}

export function groundTruthDraft(fixture: CardFixture): JobCardDraft {
  const { data } = fixture;

  return JobCardDraftSchema.parse({
    customer: {
      name: truth(data.customerName),
      phone: truth(data.phone),
    },
    vehicle: {
      // What is written on the card, not its normalised form: normalisation is
      // entity resolution's job, and an extractor that silently normalises has
      // hidden the evidence of what the card actually said.
      registration: truth(data.registrationWritten),
      make: truth(data.make),
      model: truth(data.model),
      odometerKm: truth(data.odometerKm),
    },
    complaints: data.complaints.map((complaint) => truth(complaint)),
    estimateLines: data.lines.map((line) => ({
      description: truth(line.description),
      quantityMilli: truth((line.qty ?? 1) * 1000),
      unitPricePaise: truth(line.rateRupees === null ? null : line.rateRupees * 100),
    })),
    advisorName: truth(data.advisorName),
    promisedAt: truth(data.promisedAt),
    language: fixture.language,
    notes: '',
  });
}

/* -------------------------------------------------------------------------- *
 * A synthetic imperfect reader
 * -------------------------------------------------------------------------- */

export interface PerturbOptions {
  /** Roughly what share of fields to corrupt. */
  readonly errorRate: number;
  /**
   * How honest the reader is about its mistakes, 0–1.
   *
   * At 1 every corrupted field is scored low and every correct one high — a
   * perfectly calibrated reader. At 0 the confidences are unrelated to
   * correctness, which is what the calibration gate must catch.
   */
  readonly honesty: number;
  readonly seed: string;
}

function seeded(seed: string): () => number {
  const digest = createHash('sha256').update(seed).digest();
  let state = digest.readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A plausible misreading: the character confusions OCR actually makes. */
function corruptText(value: string, random: () => number): string {
  const swaps: Readonly<Record<string, string>> = {
    O: '0',
    '0': 'O',
    '1': 'I',
    I: '1',
    '5': 'S',
    S: '5',
    B: '8',
    '8': 'B',
    a: 'o',
    e: 'c',
    n: 'r',
  };

  const positions = [...value].map((character, index) => ({ character, index }));
  const candidates = positions.filter((entry) => swaps[entry.character] !== undefined);
  if (candidates.length === 0) return `${value}x`;

  const chosen = candidates[Math.floor(random() * candidates.length)];
  if (chosen === undefined) return `${value}x`;

  const characters = [...value];
  characters[chosen.index] = swaps[chosen.character] as string;
  return characters.join('');
}

/**
 * Produces a deliberately imperfect extraction from a fixture.
 *
 * This is the eval's control arm. Without a vision model in the loop the
 * scoring maths is untested code, and untested scoring is how an eval quietly
 * reports 100% forever. Running the gates against a reader with a known error
 * rate and known honesty proves they fire when they should.
 */
export function perturbDraft(fixture: CardFixture, options: PerturbOptions): JobCardDraft {
  const random = seeded(options.seed);
  const base = groundTruthDraft(fixture);

  const score = (wrong: boolean): number => {
    const honest = random() < options.honesty;
    if (wrong) return honest ? 0.25 + random() * 0.35 : 0.85 + random() * 0.14;
    return honest ? 0.86 + random() * 0.13 : 0.3 + random() * 0.5;
  };

  const maybe = <T>(field: ConfidentField<T>, corrupt: (value: T) => T): ConfidentField<T> => {
    const wrong = field.value !== null && random() < options.errorRate;
    return {
      value: wrong ? corrupt(field.value) : field.value,
      confidence: score(wrong),
      region: null,
    };
  };

  const text = (value: string | null): string | null =>
    value === null ? null : corruptText(value, random);
  const number = (value: number | null): number | null =>
    value === null ? null : value + (random() < 0.5 ? 100 : -100);

  return JobCardDraftSchema.parse({
    customer: {
      name: maybe(base.customer.name, (value) => corruptText(value, random)),
      phone: maybe(base.customer.phone, text),
    },
    vehicle: {
      registration: maybe(base.vehicle.registration, (value) => corruptText(value, random)),
      make: maybe(base.vehicle.make, text),
      model: maybe(base.vehicle.model, text),
      odometerKm: maybe(base.vehicle.odometerKm, number),
    },
    complaints: base.complaints.map((complaint) =>
      maybe(complaint, (value) => corruptText(value, random)),
    ),
    estimateLines: base.estimateLines.map((line) => ({
      description: maybe(line.description, (value) => corruptText(value, random)),
      quantityMilli: line.quantityMilli,
      unitPricePaise: maybe(line.unitPricePaise, number),
    })),
    advisorName: maybe(base.advisorName, text),
    promisedAt: maybe(base.promisedAt, text),
    language: base.language,
    notes: base.notes,
  });
}
