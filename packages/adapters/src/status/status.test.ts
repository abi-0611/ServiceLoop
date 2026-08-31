import { instantFromZonedParts } from '@serviceloop/shared';
import { describe, expect, it } from 'vitest';
import {
  classifySignal,
  detectLanguage,
  extractDay,
  extractJobCardCode,
  extractRegistrationFragment,
  extractTime,
  extractWorkDescriptions,
  parseStatusNoteHeuristically,
  scoreConfidence,
} from './heuristic-status';
import { HeuristicStatusSignalParser, resolveEtaHint, toParsedSignal } from './status-parser';
import { STATUS_FIXTURES } from './status-fixtures';
import type { ExtractedStatusSignal } from './status-prompt';

/**
 * Phase 4.2 — the technician status parser.
 *
 * The corpus is the test. Fifteen transcripts drawn from how mechanics actually
 * talk, each asserting what the *system* concludes rather than what a
 * particular model emits — so this suite survives a model swap and fails on a
 * behaviour change, which is the right way round.
 */

const IST = 'Asia/Kolkata';
const AUTO_APPLY = 0.85;

function ist(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return instantFromZonedParts({ year, month, day, hour, minute }, IST);
}

describe('the fifteen-transcript corpus', () => {
  it('has fifteen fixtures across three languages and all four signal types', () => {
    expect(STATUS_FIXTURES).toHaveLength(15);
    expect(new Set(STATUS_FIXTURES.map((f) => f.language))).toEqual(new Set(['en', 'ta', 'hi']));
    expect(new Set(STATUS_FIXTURES.map((f) => f.signalType))).toEqual(
      new Set(['progress', 'blocked_parts', 'done', 'issue_found']),
    );
  });

  it.each(STATUS_FIXTURES.map((fixture) => [fixture.id, fixture] as const))(
    'reads %s',
    (_id, fixture) => {
      const parsed = parseStatusNoteHeuristically(fixture.transcript);

      expect(parsed.signalType, fixture.note).toBe(fixture.signalType);
      expect(parsed.language).toBe(fixture.language);
      expect(parsed.registrationFragment).toBe(fixture.registrationFragment);
      expect(parsed.etaHintTime).toBe(fixture.etaHintTime);
      for (const description of fixture.workDescriptions) {
        expect(parsed.workDescriptions).toContain(description);
      }
    },
  );

  it.each(STATUS_FIXTURES.map((fixture) => [fixture.id, fixture] as const))(
    'routes %s to the right side of the auto-apply bar',
    (_id, fixture) => {
      const parsed = parseStatusNoteHeuristically(fixture.transcript);
      const wouldAutoApply = parsed.confidence >= AUTO_APPLY;

      // `issue_found` never auto-applies whatever the confidence — the routing
      // layer sends it to the evidence flow — so the bar only speaks to the
      // three status types.
      if (fixture.signalType !== 'issue_found') {
        expect(wouldAutoApply, `${fixture.id}: ${fixture.note}`).toBe(fixture.expectAutoApply);
      }
    },
  );

  it('never auto-applies a bare "Done." with no subject', () => {
    const parsed = parseStatusNoteHeuristically('Done.');
    expect(parsed.confidence).toBeLessThan(AUTO_APPLY);
  });

  it('reads a finding over a status when a note carries both', () => {
    const both = parseStatusNoteHeuristically(
      'Brake pad mudinjuchu, aana belt-um romba thenjirukku.',
    );
    // A finding read as a status is revenue the shop loses, so it wins.
    expect(both.signalType).toBe('issue_found');
  });
});

describe('language detection', () => {
  it.each([
    ['Caliper open irukku, part varum 4 maniku.', 'ta'],
    ['क्लच प्लेट का स्टॉक नहीं है', 'hi'],
    ['TN 09 BX 4432 brake pad mudinjidhu.', 'ta'],
    ['गाड़ी का काम हो गया है', 'hi'],
    ['Started work on 4432, brake pads coming off now.', 'en'],
  ])('reads %s as %s', (text, expected) => {
    expect(detectLanguage(text)).toBe(expected);
  });

  it('follows the grammar, not the vocabulary', () => {
    // Three English nouns and one Tamil verb: the verb carries the sentence.
    expect(detectLanguage('caliper brake disc irukku')).toBe('ta');
  });

  it('falls back to the hint when nothing marks the language', () => {
    expect(detectLanguage('4432', 'hi')).toBe('hi');
    expect(detectLanguage('4432')).toBe('en');
  });
});

describe('registration extraction', () => {
  it.each([
    ['TN 09 BX 4432 brake pad done', 'TN09BX4432'],
    ['09 BX 4432 done', '09BX4432'],
    ['4432 done', '4432'],
    ['77812 ready', '77812'],
    ['no plate here', null],
  ])('reads %s as %s', (text, expected) => {
    expect(extractRegistrationFragment(text)).toBe(expected);
  });

  it('does not mistake a time or a quantity for a vehicle', () => {
    // The single most damaging confusion available: "4 maniku" becoming a car.
    expect(extractRegistrationFragment('part varum 4 maniku')).toBeNull();
    expect(extractRegistrationFragment('2000 rupees for the pads')).toBeNull();
    expect(extractRegistrationFragment('did 1200 km since service')).toBeNull();
  });

  it('reads an explicit job-card code', () => {
    expect(extractJobCardCode('JC-2026-0042 quality check passed')).toBe('JC-2026-0042');
    expect(extractJobCardCode('nothing here')).toBeNull();
  });
});

describe('time extraction', () => {
  it.each([
    ['part varum 4 maniku', '16:00'],
    ['4 बजे तक आ जाएगा', '16:00'],
    ['by 6', '18:00'],
    ['at 4:30 pm', '16:30'],
    ['at 09:15', '09:15'],
    ['साढ़े पाँच बजे आएगा', '17:30'],
    ['naalaikku kaalaila 10 maniku varum', '10:00'],
    ['tomorrow morning', null],
    ['by evening', null],
  ])('reads %s as %s', (text, expected) => {
    expect(extractTime(text)).toBe(expected);
  });

  it('reads a bare workshop hour as the afternoon', () => {
    // Nobody promises a part at four in the morning.
    expect(extractTime('4 maniku')).toBe('16:00');
    expect(extractTime('10 maniku')).toBe('10:00');
  });

  it('reads an explicit day when one was given', () => {
    expect(extractDay('naalaikku 10 maniku')).toBe('tomorrow');
    expect(extractDay('कल आएगा')).toBe('tomorrow');
    expect(extractDay('innaikku mudinjidum')).toBe('today');
    expect(extractDay('part varum')).toBeNull();
  });
});

describe('work-description extraction', () => {
  it('recognises parts across all three scripts', () => {
    expect(extractWorkDescriptions('brake pad and caliper')).toEqual(
      expect.arrayContaining(['brake pad', 'caliper']),
    );
    expect(extractWorkDescriptions('எண்ணெய் மாற்றம்')).toContain('engine oil');
    expect(extractWorkDescriptions('क्लच प्लेट')).toContain('clutch');
  });
});

describe('confidence scoring', () => {
  it('is assigned by how the reading was arrived at', () => {
    const fullySpecified = scoreConfidence({
      matchedKeyword: 'done',
      hasRegistration: true,
      hasWorkDescription: true,
      wordCount: 6,
    });
    const noKeyword = scoreConfidence({
      matchedKeyword: null,
      hasRegistration: true,
      hasWorkDescription: true,
      wordCount: 6,
    });
    const oneWord = scoreConfidence({
      matchedKeyword: 'done',
      hasRegistration: false,
      hasWorkDescription: false,
      wordCount: 1,
    });

    expect(fullySpecified).toBeGreaterThanOrEqual(AUTO_APPLY);
    expect(noKeyword).toBeLessThan(AUTO_APPLY);
    expect(oneWord).toBeLessThan(AUTO_APPLY);
  });

  it('never leaves the 0–1 range', () => {
    for (const wordCount of [0, 1, 20]) {
      for (const matchedKeyword of [null, 'done']) {
        const score = scoreConfidence({
          matchedKeyword,
          hasRegistration: true,
          hasWorkDescription: true,
          wordCount,
        });
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('signal classification precedence', () => {
  it('checks for a finding before a status', () => {
    expect(classifySignal('oil change done but the hose is leaking').type).toBe('issue_found');
    expect(classifySignal('oil change done').type).toBe('done');
  });

  it('reads a note that only names work as progress', () => {
    expect(classifySignal('brake pad').type).toBe('progress');
  });
});

describe('ETA hint resolution', () => {
  function extracted(partial: Partial<ExtractedStatusSignal>): ExtractedStatusSignal {
    return {
      signalType: 'blocked_parts',
      confidence: 0.9,
      registrationFragment: null,
      jobCardCode: null,
      workDescriptions: [],
      etaHintTime: null,
      etaHintDay: null,
      summary: '',
      language: 'ta',
      ...partial,
    };
  }

  it('resolves a later time today', () => {
    const now = ist(2026, 8, 17, 11, 0);
    const resolved = resolveEtaHint(extracted({ etaHintTime: '16:00' }), now, IST);
    expect(resolved?.toISOString()).toBe(ist(2026, 8, 17, 16, 0).toISOString());
  });

  it('rolls an already-passed time to tomorrow', () => {
    // "part varum 4 maniku" said at 17:00 means tomorrow afternoon. Resolving
    // it to an hour ago would produce an ETA in the past that the engine would
    // dutifully quote to a customer.
    const now = ist(2026, 8, 17, 17, 0);
    const resolved = resolveEtaHint(extracted({ etaHintTime: '16:00' }), now, IST);
    expect(resolved?.toISOString()).toBe(ist(2026, 8, 18, 16, 0).toISOString());
  });

  it('honours an explicit day over the default', () => {
    const now = ist(2026, 8, 17, 8, 0);
    const tomorrow = resolveEtaHint(
      extracted({ etaHintTime: '10:00', etaHintDay: 'tomorrow' }),
      now,
      IST,
    );
    expect(tomorrow?.toISOString()).toBe(ist(2026, 8, 18, 10, 0).toISOString());

    const today = resolveEtaHint(extracted({ etaHintTime: '10:00', etaHintDay: 'today' }), now, IST);
    expect(today?.toISOString()).toBe(ist(2026, 8, 17, 10, 0).toISOString());
  });

  it('resolves nothing when no time was named', () => {
    expect(resolveEtaHint(extracted({}), ist(2026, 8, 17, 11, 0), IST)).toBeNull();
    expect(resolveEtaHint(extracted({ etaHintTime: 'later' }), ist(2026, 8, 17, 11), IST)).toBeNull();
  });
});

describe('transcript confidence propagation', () => {
  it('cannot produce a confident signal from a shaky transcript', () => {
    const extracted: ExtractedStatusSignal = {
      signalType: 'done',
      confidence: 0.95,
      registrationFragment: '4432',
      jobCardCode: null,
      workDescriptions: ['brake pad'],
      etaHintTime: null,
      etaHintDay: null,
      summary: 'done',
      language: 'ta',
    };

    const clean = toParsedSignal(extracted, {
      now: new Date(),
      timezone: IST,
      transcriptConfidence: 1,
    });
    const shaky = toParsedSignal(extracted, {
      now: new Date(),
      timezone: IST,
      transcriptConfidence: 0.6,
    });

    expect(clean.confidence).toBeGreaterThanOrEqual(AUTO_APPLY);
    // Bad audio must ask a human, however sure the parse was of the words it
    // was given.
    expect(shaky.confidence).toBeLessThan(AUTO_APPLY);
    expect(shaky.confidence).toBeCloseTo(0.57, 2);
  });
});

describe('HeuristicStatusSignalParser', () => {
  it('implements the domain port end to end', async () => {
    const parser = new HeuristicStatusSignalParser();
    const parsed = await parser.parse({
      shopId: 'shop-1',
      transcript: 'Caliper open irukku, part varum 4 maniku. 4432.',
      languageHint: 'ta',
      now: ist(2026, 8, 17, 11, 0),
      timezone: IST,
      traceId: 'trace-1',
    });

    expect(parsed.signalType).toBe('blocked_parts');
    expect(parsed.registrationFragment).toBe('4432');
    expect(parsed.language).toBe('ta');
    expect(parsed.etaHint?.toISOString()).toBe(ist(2026, 8, 17, 16, 0).toISOString());
    expect(parsed.confidence).toBeGreaterThanOrEqual(AUTO_APPLY);
  });
});
