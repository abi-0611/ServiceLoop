import { describe, expect, it } from 'vitest';
import { CARD_FIXTURES, expectedFields, fixtureIds } from './fixtures';
import { groundTruthDraft, perturbDraft } from './ground-truth';
import { cardHtmlHash, renderCardHtml } from './render';
import { aggregate, evaluateGates, scoreExtraction } from './score';

/**
 * The eval scores extractions, so the scorer itself has to be tested — an
 * unverified scorer is how an eval reports a comfortable number forever.
 */

describe('the fixture set', () => {
  it('has twelve cards with unique ids across five layouts and three languages', () => {
    expect(CARD_FIXTURES).toHaveLength(12);
    expect(new Set(fixtureIds()).size).toBe(12);
    expect(new Set(CARD_FIXTURES.map((fixture) => fixture.layout)).size).toBe(5);
    expect(new Set(CARD_FIXTURES.map((fixture) => fixture.language))).toEqual(
      new Set(['en', 'ta', 'hi']),
    );
  });

  it('covers the handwriting conventions the prompt names', () => {
    const lines = CARD_FIXTURES.flatMap((fixture) => fixture.data.lines);
    expect(lines.some((line) => line.ditto === true), 'a ditto mark').toBe(true);
    expect(lines.some((line) => line.struckThrough !== undefined), 'a correction').toBe(true);
    expect(lines.some((line) => line.rateRupees === null), 'an unpriced line').toBe(true);
    expect(
      CARD_FIXTURES.some((fixture) => fixture.data.registrationWritten.includes('BH')),
      'a BH-series plate',
    ).toBe(true);
    expect(
      CARD_FIXTURES.some((fixture) => fixture.data.phone === null),
      'a card with no phone number',
    ).toBe(true);
  });

  it('renders deterministically, so a fixture hash is a real signal', () => {
    for (const fixture of CARD_FIXTURES) {
      expect(renderCardHtml(fixture)).toBe(renderCardHtml(fixture));
      expect(cardHtmlHash(fixture)).toHaveLength(16);
    }
  });

  it('renders every ground-truth value into the HTML', () => {
    for (const fixture of CARD_FIXTURES) {
      const html = renderCardHtml(fixture);
      expect(html, fixture.id).toContain(fixture.data.customerName);
      expect(html, fixture.id).toContain(fixture.data.registrationWritten);
      for (const line of fixture.data.lines) {
        if (line.ditto === true) continue;
        expect(html, `${fixture.id}: ${line.description}`).toContain(line.description);
      }
    }
  });
});

describe('scoring', () => {
  const fixture = CARD_FIXTURES[0];
  if (fixture === undefined) throw new Error('fixture set is empty');

  it('scores a perfect extraction at 100%', () => {
    const score = scoreExtraction(groundTruthDraft(fixture), expectedFields(fixture));
    expect(score.accuracy).toBe(1);
    expect(score.correct).toBe(score.scored);
  });

  it('counts an invented value as wrong, not as a miss', () => {
    const noPhone = CARD_FIXTURES.find((entry) => entry.data.phone === null);
    if (noPhone === undefined) throw new Error('expected a fixture with no phone number');

    const draft = groundTruthDraft(noPhone);
    const invented = {
      ...draft,
      customer: {
        ...draft.customer,
        phone: { value: '9876543210', confidence: 0.95, region: null },
      },
    };

    const score = scoreExtraction(invented, expectedFields(noPhone));
    const phone = score.fields.find((field) => field.path === 'customer.phone');
    expect(phone?.correct).toBe(false);
    expect(phone?.invented).toBe(true);
    expect(phone?.missed).toBe(false);
    // And it is *confidently* wrong, which is the number that matters.
    expect(score.calibration.confidentlyWrongRate).toBeGreaterThan(0);
  });

  it('accepts a registration written with separators', () => {
    const draft = groundTruthDraft(fixture);
    const spaced = {
      ...draft,
      vehicle: {
        ...draft.vehicle,
        registration: { value: 'tn-09-bx-4432', confidence: 0.9, region: null },
      },
    };
    const score = scoreExtraction(spaced, expectedFields(fixture));
    expect(score.fields.find((field) => field.path === 'vehicle.registration')?.correct).toBe(true);
  });

  it('accepts a phone number written with a country code', () => {
    const draft = groundTruthDraft(fixture);
    const e164 = {
      ...draft,
      customer: {
        ...draft.customer,
        phone: { value: '+91 98400 12345', confidence: 0.9, region: null },
      },
    };
    const score = scoreExtraction(e164, expectedFields(fixture));
    expect(score.fields.find((field) => field.path === 'customer.phone')?.correct).toBe(true);
  });

  it('penalises estimate lines the card does not carry', () => {
    const draft = groundTruthDraft(fixture);
    const padded = {
      ...draft,
      estimateLines: [
        ...draft.estimateLines,
        {
          description: { value: 'Invented upsell', confidence: 0.9, region: null },
          quantityMilli: { value: 1000, confidence: 0.9, region: null },
          unitPricePaise: { value: 99_900, confidence: 0.9, region: null },
        },
      ],
    };

    const score = scoreExtraction(padded, expectedFields(fixture));
    expect(score.accuracy).toBeLessThan(1);
    expect(score.fields.some((field) => field.invented && field.actual === 'Invented upsell')).toBe(
      true,
    );
  });
});

describe('calibration gates', () => {
  function run(honesty: number, errorRate: number) {
    const clean = aggregate(
      CARD_FIXTURES.map((fixture) =>
        scoreExtraction(
          perturbDraft(fixture, { errorRate, honesty, seed: `${fixture.id}:clean` }),
          expectedFields(fixture),
        ),
      ),
    );
    const degraded = aggregate(
      CARD_FIXTURES.map((fixture) =>
        scoreExtraction(
          perturbDraft(fixture, { errorRate: errorRate * 2, honesty, seed: `${fixture.id}:deg` }),
          expectedFields(fixture),
        ),
      ),
    );
    return { clean, degraded, gates: evaluateGates(clean, degraded) };
  }

  it('passes an accurate, honest reader', () => {
    const { gates } = run(0.95, 0.05);
    expect(gates.filter((gate) => !gate.ok)).toEqual([]);
  });

  it('fails a reader that is confidently wrong, even when it is accurate', () => {
    // The failure mode the whole gate exists for: good accuracy, no humility.
    const { gates } = run(0, 0.08);
    const failed = gates.filter((gate) => !gate.ok).map((gate) => gate.name);
    expect(failed).toContain('calibration split (correct − wrong confidence)');
    expect(failed).toContain('confidently wrong rate');
  });

  it('fails a reader that is simply inaccurate', () => {
    const { gates } = run(0.95, 0.4);
    const failed = gates.filter((gate) => !gate.ok).map((gate) => gate.name);
    expect(failed).toContain('clean field accuracy');
  });
});
