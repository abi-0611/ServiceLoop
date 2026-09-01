import { describe, expect, it } from 'vitest';
import { categoryFor, classifyReason } from './retention';

/**
 * The two pieces of inference the phase-6 ledger handler does (6.1).
 *
 * Both are keyword tables rather than models, and both are tested here rather
 * than trusted, because they sit *upstream* of everything else in the phase: the
 * category picks the follow-up horizon and the season tags, and the reason picks
 * which of four follow-ups a customer eventually gets. A misclassification is
 * not a wrong label in a database — it is a message aimed at an objection the
 * customer never made, months later, about a car.
 *
 * The property that matters in both is the *shape of the failure*. Neither
 * guesses: an uncategorised item gets `null`, which the shop's default horizon
 * turns into "never re-pitch on a timer", and an unreadable reason gets `other`,
 * which does the same. Silence is the failure mode, and these tests exist to
 * keep it that way.
 */

describe('6.1 the shop-KB category of a work item', () => {
  it('recognises the categories the shipped horizons and seasons are written for', () => {
    expect(categoryFor('Front brake pad replacement')).toBe('brakes');
    expect(categoryFor('Replace rear discs and rotors')).toBe('brakes');
    expect(categoryFor('Tyre rotation and wheel alignment')).toBe('tyres');
    expect(categoryFor('Front suspension bush kit')).toBe('suspension');
    expect(categoryFor('Battery replacement')).toBe('battery');
    expect(categoryFor('Wiper blade set')).toBe('wipers');
    expect(categoryFor('Underbody anti-rust coating')).toBe('underbody');
    expect(categoryFor('A/C cooling coil')).toBe('ac');
    expect(categoryFor('Bumper scratch polish')).toBe('cosmetic');
  });

  it('is not case-sensitive, because nobody types titles consistently', () => {
    expect(categoryFor('FRONT BRAKE PADS')).toBe('brakes');
    expect(categoryFor('front brake pads')).toBe('brakes');
  });

  it('answers null rather than guessing, and null means no timed re-pitch', () => {
    expect(categoryFor('Engine oil and filter')).toBeNull();
    expect(categoryFor('General inspection')).toBeNull();
    expect(categoryFor('')).toBeNull();
  });

  it('does not read "ac" out of the middle of an unrelated word', () => {
    // The failure this guards: a substring match on "ac" would file
    // "Replace the radiator" and "Track rod end" as air-conditioning, and put
    // cooling work on a season the shop never meant.
    expect(categoryFor('Radiator replacement')).not.toBe('ac');
    expect(categoryFor('Clutch cable')).not.toBe('ac');
  });
});

describe('6.1 the reason a customer said no', () => {
  it('reads the four objections that need four different follow-ups', () => {
    expect(classifyReason('Too expensive right now')).toBe('price');
    expect(classifyReason('Customer asked to do it next visit')).toBe('customer_deferred');
    expect(classifyReason('Only the oil change for now')).toBe('customer_partial');
    expect(classifyReason('Not sure it really needs doing')).toBe('distrust');
  });

  it('falls back to `other` rather than to the nearest guess', () => {
    expect(classifyReason('')).toBe('other');
    expect(classifyReason('Declined')).toBe('other');
    expect(classifyReason('¯\\_(ツ)_/¯')).toBe('other');
  });

  it('reads price before deferral when the customer said both', () => {
    // "Too expensive, maybe later" is a price objection with a polite ending.
    // Filing it as a deferral would re-pitch the identical quote in ninety
    // days, which is the shop failing to hear the only thing that was said.
    expect(classifyReason('Too expensive, maybe later')).toBe('price');
  });
});
