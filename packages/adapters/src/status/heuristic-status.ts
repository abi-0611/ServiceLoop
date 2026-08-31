import type { Language, StatusSignalType } from '@serviceloop/shared';
import type { ExtractedStatusSignal } from './status-prompt';

/**
 * A deterministic technician-note parser (phase 4.2).
 *
 * This is what backs the sandbox LLM adapter, and it is a *real* parser rather
 * than a canned answer — for the same reason `extractDraftFromText` is
 * (deviation 12): a sandbox that returned a fixed signal would make every
 * status test vacuous, and the phase's fifteen transcript fixtures would prove
 * nothing except that a constant is constant.
 *
 * It also doubles as the honest baseline. A model that cannot beat keyword
 * matching plus a plate regex on a five-word sentence is not earning its cost.
 */

export interface HeuristicOptions {
  readonly languageHint?: Language;
}

/**
 * Vocabulary per signal type, across the three launch languages plus the
 * romanised registers people actually type.
 *
 * Two precedence rules, and both were earned by fixtures that failed without
 * them:
 *
 *   1. **`issue_found` wins outright.** A note that says both "done" and "but
 *      the belt is gone" is a finding. A finding read as a status is revenue
 *      the shop loses and a customer who is never asked.
 *   2. **Otherwise, the longest matching term wins.** "start pannitten" is
 *      progress and "pannitten" alone is done — the same nine characters mean
 *      different things depending on what precedes them, and a first-match scan
 *      would read every "I started it" as "I finished it".
 */
const LEXICON: readonly (readonly [StatusSignalType, readonly string[]])[] = [
  [
    'issue_found',
    [
      'also gone',
      'also bad',
      'also needs',
      'another problem',
      'extra work',
      'leaking',
      'leak irukku',
      'worn out',
      'needs replacing',
      'damage',
      'crack',
      // Romanised Tamil for "worn/rubbed away" — how a technician says it.
      'thenjirukku',
      'thenji',
      'romba thenj',
      'வேற',
      'இன்னொரு',
      'கசிவு',
      'தேய்ஞ்சிருக்கு',
      'aur bhi',
      'aur ek',
      'bhi kharab',
      'भी ख़राब',
      'भी खराब',
      'लीक',
      'और एक',
    ],
  ],
  [
    'blocked_parts',
    [
      'no stock',
      'out of stock',
      'part varum',
      'part vandhurum',
      'waiting for part',
      'part not',
      'parts not',
      'ordered',
      'order pannirukken',
      'stock illa',
      'illa',
      'பார்ட் வரும்',
      'ஸ்டாக் இல்ல',
      'part nahi',
      'part nahin',
      'stock nahi',
      'order kar diya',
      'पुर्ज़ा नहीं',
      'स्टॉक नहीं',
      // Both spellings are in daily use; only one of them was here first, and
      // the fixture that used the other read as "progress".
      'ऑर्डर',
      'आर्डर',
    ],
  ],
  [
    'done',
    [
      'done',
      'finished',
      'complete',
      'over',
      'mudinjidhu',
      'mudinjuchu',
      'mudinchu',
      'mudinj',
      'ready',
      // "I did it" — done. "start pannitten" is longer and wins for progress.
      'pannitten',
      'pannitten',
      'முடிஞ்சு',
      'முடிந்தது',
      'ho gaya',
      'ho gaya hai',
      'khatam',
      'हो गया',
      'ख़त्म',
      'तैयार',
    ],
  ],
  [
    'progress',
    [
      'started',
      'starting',
      'working',
      'in progress',
      'aarambichiten',
      'aarambich',
      'start pannitten',
      'start pannit',
      'work start',
      'pannitirukken',
      'ஆரம்பிச்சேன்',
      'செய்யறேன்',
      'shuru',
      'kar raha',
      'chal raha',
      'शुरू',
      'कर रहा',
      'चल रहा',
    ],
  ],
];

/** Script detection: which language's grammar is carrying the sentence. */
const TAMIL_RANGE = /[஀-௿]/;
const DEVANAGARI_RANGE = /[ऀ-ॿ]/;

/**
 * Romanised Tamil and Hindi markers.
 *
 * Grammar words, not vocabulary: "irukku", "pannitten" and "hai" carry the
 * sentence, whereas "caliper" and "brake" are loanwords that appear in all
 * three. Matching on the grammar is what makes "caliper open irukku" come out
 * as Tamil rather than as English with two odd words.
 */
const ROMANISED_TAMIL = [
  'irukku',
  'illa',
  'pannit',
  'panniten',
  'aacha',
  'aachu',
  'varum',
  'maniku',
  'mudinj',
  'vandhu',
  'enna',
  'seri',
];
const ROMANISED_HINDI = [
  'hai',
  'gaya',
  'karna',
  'kar diya',
  'nahi',
  'nahin',
  'kitna',
  'baje',
  'raha',
  'hoga',
];

export function detectLanguage(text: string, fallback: Language = 'en'): Language {
  if (TAMIL_RANGE.test(text)) return 'ta';
  if (DEVANAGARI_RANGE.test(text)) return 'hi';

  const lower = text.toLowerCase();
  const tamilHits = ROMANISED_TAMIL.filter((marker) => lower.includes(marker)).length;
  const hindiHits = ROMANISED_HINDI.filter((marker) => lower.includes(marker)).length;

  if (tamilHits === 0 && hindiHits === 0) return fallback;
  return tamilHits >= hindiHits ? 'ta' : 'hi';
}

/**
 * Whatever in the note looks like a plate fragment.
 *
 * Three shapes, most specific first: a whole registration, a
 * `<rto><series><digits>` chunk, and a bare four-or-five-digit run. The bare
 * run is last and is *only* accepted when it is not obviously a time or a
 * quantity — "4 maniku" and "2 litre" must not become vehicle identifiers.
 */
export function extractRegistrationFragment(text: string): string | null {
  // A job-card code contains a four-digit year, and a technician who reads one
  // out has identified the card far more precisely than a plate would. Removing
  // it first stops `JC-2026-0042` becoming the vehicle "2026".
  const upper = text.toUpperCase().replace(/\bJC-\d{4}-\d{3,6}\b/g, ' ');

  const full = /\b([A-Z]{2}[\s-]?\d{1,2}[\s-]?[A-Z]{1,3}[\s-]?\d{3,4})\b/.exec(upper);
  if (full?.[1] !== undefined) return full[1].replace(/[\s-]/g, '');

  const partial = /\b(\d{1,2}[\s-]?[A-Z]{2}[\s-]?\d{3,4})\b/.exec(upper);
  if (partial?.[1] !== undefined) return partial[1].replace(/[\s-]/g, '');

  for (const match of upper.matchAll(/\b(\d{4,5})\b/g)) {
    const digits = match[1];
    if (digits === undefined) continue;
    const at = match.index ?? 0;
    const after = upper.slice(at + digits.length, at + digits.length + 12);
    // A four-digit run followed by a time or unit word is not a plate.
    if (/^\s*(MANIKU|BAJE|HRS?|HOURS?|AM|PM|RUPEES?|RS|KM|ML|LITRE|LITER)/.test(after)) continue;
    return digits;
  }

  return null;
}

export function extractJobCardCode(text: string): string | null {
  const match = /\b(JC-\d{4}-\d{3,6})\b/i.exec(text);
  return match?.[1]?.toUpperCase() ?? null;
}

/**
 * A stated clock time, normalised to `HH:MM`.
 *
 * Handles the forms people use out loud: "4 maniku", "4 baje", "by 6",
 * "साढ़े पाँच" (half past five), "4:30", "4 pm". A bare number with no marker is
 * *not* a time — that is what stops "4432" being read as half past four.
 */
export function extractTime(text: string): string | null {
  const lower = text.toLowerCase();

  const explicit = /\b([01]?\d|2[0-3]):([0-5]\d)\s*(am|pm)?/.exec(lower);
  if (explicit !== null) {
    const hour = Number(explicit[1]);
    const minute = explicit[2] ?? '00';
    return `${String(applyMeridiem(hour, explicit[3])).padStart(2, '0')}:${minute}`;
  }

  // "साढ़े पाँच" — half past. Checked before the plain-hour forms, since the
  // hour word it contains would otherwise match on its own.
  const half = /साढ़े\s*(पाँच|पांच|छह|चार|तीन|सात|आठ|नौ|दस)/.exec(lower);
  if (half?.[1] !== undefined) {
    const hour = HINDI_NUMERALS[half[1]];
    if (hour !== undefined) return `${String(afternoonise(hour)).padStart(2, '0')}:30`;
  }

  // `बजे` and `மணிக்கு` are matched without `\b`: JavaScript's word boundary is
  // ASCII-only, so a Devanagari or Tamil term wrapped in `\b` can never match.
  const marker =
    /(\d{1,2})\s*(बजे|மணிக்கு)/.exec(lower) ??
    /\b(\d{1,2})\s*(maniku|mani|baje|bajey|o'?clock|am|pm)\b/.exec(lower) ??
    /\bby\s+(\d{1,2})\b/.exec(lower);
  if (marker?.[1] !== undefined) {
    const hour = Number(marker[1]);
    const meridiem = marker[2];
    if (meridiem === 'am' || meridiem === 'pm') {
      return `${String(applyMeridiem(hour, meridiem)).padStart(2, '0')}:00`;
    }
    // A workshop that says "four" means the afternoon. Nobody promises a part
    // at four in the morning.
    return `${String(afternoonise(hour)).padStart(2, '0')}:00`;
  }

  return null;
}

const HINDI_NUMERALS: Readonly<Record<string, number>> = {
  तीन: 3,
  चार: 4,
  पाँच: 5,
  पांच: 5,
  छह: 6,
  सात: 7,
  आठ: 8,
  नौ: 9,
  दस: 10,
};

function applyMeridiem(hour: number, meridiem: string | undefined): number {
  if (meridiem === 'pm') return hour === 12 ? 12 : hour + 12;
  if (meridiem === 'am') return hour === 12 ? 0 : hour;
  return hour;
}

function afternoonise(hour: number): number {
  return hour >= 1 && hour <= 7 ? hour + 12 : hour;
}

/**
 * Was a day named?
 *
 * The ASCII words are matched on a word boundary so "kal" does not fire inside
 * "calibrate"; the Devanagari and Tamil ones are matched by containment,
 * because JavaScript's `\b` is ASCII-only and would never match them at all.
 */
export function extractDay(text: string): 'today' | 'tomorrow' | null {
  const lower = text.toLowerCase();
  if (/\b(tomorrow|naalaikku|kal)\b/.test(lower)) return 'tomorrow';
  if (['நாளைக்கு', 'कल'].some((term) => lower.includes(term))) return 'tomorrow';
  if (/\b(today|innaikku|aaj)\b/.test(lower)) return 'today';
  if (['இன்னைக்கு', 'आज'].some((term) => lower.includes(term))) return 'today';
  return null;
}

/**
 * Part and job vocabulary, for `workDescriptions`.
 *
 * Kept explicit rather than derived, so adding a term is a reviewable diff. The
 * English word is the key because that is what the estimate line says, and the
 * matcher in the domain compares against work-item titles.
 */
const WORK_TERMS: readonly (readonly [string, readonly string[]])[] = [
  ['brake pad', ['brake pad', 'brake pads', 'pad', 'பிரேக்', 'ब्रेक', 'brake']],
  ['caliper', ['caliper', 'calliper', 'காலிபர்', 'कैलिपर']],
  ['disc', ['disc', 'rotor', 'டிஸ்க்']],
  ['engine oil', ['engine oil', 'oil change', 'oil', 'எண்ணெய்', 'तेल']],
  ['oil filter', ['oil filter', 'filter', 'பில்டர்', 'फ़िल्टर']],
  ['clutch', ['clutch', 'கிளட்ச்', 'क्लच']],
  ['battery', ['battery', 'பேட்டரி', 'बैटरी']],
  ['tyre', ['tyre', 'tire', 'டயர்', 'टायर']],
  ['suspension', ['suspension', 'shocker', 'shock absorber', 'சஸ்பென்ஷன்', 'सस्पेंशन']],
  ['belt', ['belt', 'timing belt', 'பெல்ட்', 'बेल्ट']],
  ['coolant', ['coolant', 'radiator', 'ரேடியேட்டர்', 'रेडिएटर']],
  ['alignment', ['alignment', 'wheel alignment', 'அலைன்மென்ட்']],
  ['ac', ['ac', 'a/c', 'air con', 'ஏசி', 'एसी']],
];

export function extractWorkDescriptions(text: string): readonly string[] {
  const lower = text.toLowerCase();
  const found: string[] = [];
  for (const [canonical, variants] of WORK_TERMS) {
    if (variants.some((variant) => lower.includes(variant.toLowerCase()))) found.push(canonical);
  }
  return found.slice(0, 6);
}

export function classifySignal(text: string): { type: StatusSignalType; matched: string | null } {
  const lower = text.toLowerCase();

  let best: { type: StatusSignalType; matched: string } | null = null;

  for (const [type, terms] of LEXICON) {
    for (const term of terms) {
      if (!lower.includes(term.toLowerCase())) continue;

      // New work wins outright, however short the phrase that revealed it.
      if (type === 'issue_found') return { type, matched: term };

      if (best === null || term.length > best.matched.length) {
        best = { type, matched: term };
      }
    }
  }

  // A note that names work and nothing else is a technician saying "I'm on it".
  return best ?? { type: 'progress', matched: null };
}

/**
 * Confidence, assigned by *how* the reading was arrived at — not tuned to look
 * good.
 *
 * The same principle as the OCR extractor's rubric (deviation 13), and it is
 * what makes the auto-apply threshold meaningful rather than circular: a note
 * with an explicit keyword and an explicit plate earns 0.92 and applies itself;
 * a note whose type was inferred from silence earns 0.5 and asks.
 */
export function scoreConfidence(input: {
  readonly matchedKeyword: string | null;
  readonly hasRegistration: boolean;
  readonly hasWorkDescription: boolean;
  readonly wordCount: number;
}): number {
  let score = input.matchedKeyword === null ? 0.5 : 0.82;

  if (input.hasRegistration) {
    score += 0.1;
  } else {
    // A note that never says which vehicle is a note whose *subject* is a
    // guess, however clearly it stated the verb. The penalty is what keeps
    // "clutch plate is out of stock" below the auto-apply bar: the parse is
    // sure what happened and has no idea what it happened to.
    score -= 0.08;
  }

  if (input.hasWorkDescription) score += 0.05;

  // A one-word note is a fragment, whatever it matched. "Done." with no subject
  // is exactly the case that must ask a human rather than close something.
  if (input.wordCount <= 1) score -= 0.25;

  return Math.max(0, Math.min(1, Number(score.toFixed(2))));
}

/** The whole parse, deterministically. */
export function parseStatusNoteHeuristically(
  transcript: string,
  options: HeuristicOptions = {},
): ExtractedStatusSignal {
  const classified = classifySignal(transcript);
  const registrationFragment = extractRegistrationFragment(transcript);
  const jobCardCode = extractJobCardCode(transcript);
  const workDescriptions = extractWorkDescriptions(transcript);

  return {
    signalType: classified.type,
    confidence: scoreConfidence({
      matchedKeyword: classified.matched,
      // A spoken job-card code identifies the vehicle more precisely than a
      // plate fragment does, so it counts the same way.
      hasRegistration: registrationFragment !== null || jobCardCode !== null,
      hasWorkDescription: workDescriptions.length > 0,
      wordCount: transcript.trim().split(/\s+/).filter((word) => word.length > 0).length,
    }),
    registrationFragment,
    jobCardCode,
    workDescriptions: [...workDescriptions],
    etaHintTime: extractTime(transcript),
    etaHintDay: extractDay(transcript),
    summary: transcript.trim().slice(0, 200),
    language: detectLanguage(transcript, options.languageHint ?? 'en'),
  };
}
