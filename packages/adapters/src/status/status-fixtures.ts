import type { Language, StatusSignalType } from '@serviceloop/shared';

/**
 * The technician transcript corpus (phase 4.2 — "15 transcript fixtures").
 *
 * Written from how mechanics in an Indian workshop actually talk, not from how
 * a spec would like them to. Almost none of these contain a job-card number,
 * several contain no verb, two contain both a status and a finding, and one is
 * a single word — because a technician who says "done" and walks away is the
 * common case, not an edge case.
 *
 * Each fixture asserts what the *system* should conclude, not what a particular
 * model should emit. `expectAutoApply` is the load-bearing column: it is the
 * difference between a note that moves a customer's job card by itself and one
 * that costs an advisor a tap.
 */

export interface StatusFixture {
  readonly id: string;
  readonly transcript: string;
  readonly language: Language;
  readonly signalType: StatusSignalType;
  readonly registrationFragment: string | null;
  readonly workDescriptions: readonly string[];
  /** Local `HH:MM` the note names, when it names one. */
  readonly etaHintTime: string | null;
  /** Whether a correct parse should be confident enough to apply itself. */
  readonly expectAutoApply: boolean;
  readonly note: string;
}

export const STATUS_FIXTURES: readonly StatusFixture[] = [
  {
    id: 'ta-caliper-blocked',
    transcript: 'Caliper open irukku, part varum 4 maniku. 4432.',
    language: 'ta',
    signalType: 'blocked_parts',
    registrationFragment: '4432',
    workDescriptions: ['caliper'],
    etaHintTime: '16:00',
    expectAutoApply: true,
    note: 'The phase names this one. Tamil grammar, English nouns, a plate fragment and a stated time.',
  },
  {
    id: 'ta-brake-done',
    transcript: 'TN 09 BX 4432 brake pad mudinjidhu.',
    language: 'ta',
    signalType: 'done',
    registrationFragment: 'TN09BX4432',
    workDescriptions: ['brake pad'],
    etaHintTime: null,
    expectAutoApply: true,
    note: 'A full plate and a named job — nothing to interpret.',
  },
  {
    id: 'hi-oil-done',
    transcript: '7781 का इंजन तेल और फ़िल्टर हो गया।',
    language: 'hi',
    signalType: 'done',
    registrationFragment: '7781',
    workDescriptions: ['engine oil', 'oil filter'],
    etaHintTime: null,
    expectAutoApply: true,
    note: 'Devanagari with a numeric plate fragment; two work items in one note.',
  },
  {
    id: 'hi-part-blocked',
    transcript: 'क्लच प्लेट का स्टॉक नहीं है, कल साढ़े पाँच बजे आएगा।',
    language: 'hi',
    signalType: 'blocked_parts',
    registrationFragment: null,
    workDescriptions: ['clutch'],
    etaHintTime: '17:30',
    expectAutoApply: false,
    note: 'No plate at all — must resolve by assignment, and asks when the technician has two cars open.',
  },
  {
    id: 'en-progress',
    transcript: 'Started work on 4432, brake pads coming off now.',
    language: 'en',
    signalType: 'progress',
    registrationFragment: '4432',
    workDescriptions: ['brake pad'],
    etaHintTime: null,
    expectAutoApply: true,
    note: 'Plain English with a plate fragment.',
  },
  {
    id: 'en-bare-done',
    transcript: 'Done.',
    language: 'en',
    signalType: 'done',
    registrationFragment: null,
    workDescriptions: [],
    etaHintTime: null,
    expectAutoApply: false,
    note: 'A single word with no subject. Must ask — this is the fixture that stops "done" closing the wrong job.',
  },
  {
    id: 'ta-issue-found',
    transcript: 'Brake pad mudinjuchu, aana belt-um romba thenjirukku.',
    language: 'ta',
    signalType: 'issue_found',
    registrationFragment: null,
    workDescriptions: ['brake pad', 'belt'],
    etaHintTime: null,
    expectAutoApply: false,
    note: 'A status AND a finding in one sentence. The finding must win and route to an evidence bundle, never to a transition.',
  },
  {
    id: 'en-issue-found',
    transcript: 'Oil change done on 4432 but the radiator hose is leaking, needs replacing.',
    language: 'en',
    signalType: 'issue_found',
    registrationFragment: '4432',
    workDescriptions: ['engine oil', 'coolant'],
    etaHintTime: null,
    expectAutoApply: false,
    note: 'Same shape in English. New work needs the customer’s money, so it needs their consent.',
  },
  {
    id: 'ta-parts-arrived',
    transcript: 'Part vandhurichu, work start pannitten. 4432.',
    language: 'ta',
    signalType: 'progress',
    registrationFragment: '4432',
    workDescriptions: [],
    etaHintTime: null,
    expectAutoApply: true,
    note: 'Progress on a blocked card means the part landed — the card must leave AWAITING_PARTS.',
  },
  {
    id: 'hi-progress',
    transcript: 'सस्पेंशन का काम चल रहा है, शाम तक हो जाएगा।',
    language: 'hi',
    signalType: 'progress',
    registrationFragment: null,
    workDescriptions: ['suspension'],
    etaHintTime: null,
    expectAutoApply: false,
    note: '"By evening" is not a time. It belongs in the summary, not in an ETA a customer will plan around.',
  },
  {
    id: 'en-noisy-fragment',
    transcript: 'yeah so uh 7781 the... the AC gas top up over',
    language: 'en',
    signalType: 'done',
    registrationFragment: '7781',
    workDescriptions: ['ac'],
    etaHintTime: null,
    expectAutoApply: true,
    note: 'Disfluent speech from a noisy bay. The signal survives the "uh" and the false start.',
  },
  {
    id: 'ambiguous-no-subject',
    transcript: 'Pad change pannitten.',
    language: 'ta',
    signalType: 'done',
    registrationFragment: null,
    workDescriptions: ['brake pad'],
    etaHintTime: null,
    expectAutoApply: false,
    note: 'THE ambiguity fixture: named work, no vehicle. With two cars assigned, this must produce a disambiguation ask.',
  },
  {
    id: 'en-explicit-code',
    transcript: 'JC-2026-0042 quality check passed, ready.',
    language: 'en',
    signalType: 'done',
    registrationFragment: null,
    workDescriptions: [],
    etaHintTime: null,
    expectAutoApply: true,
    note: 'They read the code off the card. Nothing to infer at all.',
  },
  {
    id: 'ta-time-tomorrow',
    transcript: 'Battery stock illa, naalaikku kaalaila 10 maniku varum.',
    language: 'ta',
    signalType: 'blocked_parts',
    registrationFragment: null,
    workDescriptions: ['battery'],
    etaHintTime: '10:00',
    expectAutoApply: false,
    note: 'An explicit "tomorrow" plus a morning hour — the one case where the afternoon default must not apply.',
  },
  {
    id: 'hi-plate-and-time',
    transcript: '4432 का ब्रेक पैड ऑर्डर कर दिया, 4 बजे तक आ जाएगा।',
    language: 'hi',
    signalType: 'blocked_parts',
    registrationFragment: '4432',
    workDescriptions: ['brake pad'],
    etaHintTime: '16:00',
    expectAutoApply: true,
    note: 'Hindi with a plate, a part and a time — the fully-specified case, in the third language.',
  },
];
