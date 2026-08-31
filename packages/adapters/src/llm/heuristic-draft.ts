import {
  emptyJobCardDraft,
  JobCardDraftSchema,
  normalisePhone,
  normaliseRegistration,
  type ConfidentField,
  type JobCardDraft,
  type Language,
} from '@serviceloop/shared';

/**
 * A deterministic job-card parser for free text.
 *
 * This is what the sandbox LlmPort runs instead of calling a model, and it is
 * not a stub: it reads the registration, the phone number, the vehicle, the
 * work asked for and the promised time out of the kind of message an advisor
 * actually forwards — including the Tamil-English and Hindi-English registers
 * that are the norm in an Indian workshop (L4).
 *
 * It is also the honest baseline for the OCR eval. A vision model that cannot
 * beat a vocabulary lookup on clean text is not earning its cost.
 *
 * **Confidence is the point.** Every value carries how it was found: an exact
 * vocabulary hit scores high, an inference from context scores low, and a guess
 * scores lower still. The confirmation flow (2.6) puts everything below the
 * shop's threshold in front of a human, so a parser that admits doubt produces
 * a *better* job card than one that asserts.
 */

export interface HeuristicDraftOptions {
  /** Falls back to this when the text carries no language signal. */
  readonly defaultLanguage?: Language;
  /** Set for voice notes: transcripts lose punctuation and casing. */
  readonly source?: 'TEXT' | 'TRANSCRIPT';
}

const CONFIDENCE = {
  /** Parsed and validated against a real format (registration, phone). */
  parsed: 0.93,
  /** Exact hit in a closed vocabulary (model name, service keyword). */
  vocabulary: 0.85,
  /** Derived from another confident value (make, from a known model). */
  derived: 0.72,
  /** Read from position or shape rather than meaning (a leading name). */
  positional: 0.55,
  /** Present but ambiguous — one price for several items, a vague time. */
  ambiguous: 0.42,
  /** Repaired from a near-miss. Always shown to a human. */
  repaired: 0.35,
} as const;

/* -------------------------------------------------------------------------- *
 * Vocabularies
 * -------------------------------------------------------------------------- */

/** Model → make. Covers what actually rolls into an Indian independent shop. */
const MODEL_TO_MAKE: Readonly<Record<string, string>> = {
  swift: 'Maruti Suzuki',
  dzire: 'Maruti Suzuki',
  'swift dzire': 'Maruti Suzuki',
  baleno: 'Maruti Suzuki',
  alto: 'Maruti Suzuki',
  'alto k10': 'Maruti Suzuki',
  wagonr: 'Maruti Suzuki',
  'wagon r': 'Maruti Suzuki',
  celerio: 'Maruti Suzuki',
  ertiga: 'Maruti Suzuki',
  brezza: 'Maruti Suzuki',
  'vitara brezza': 'Maruti Suzuki',
  ciaz: 'Maruti Suzuki',
  ignis: 'Maruti Suzuki',
  's-presso': 'Maruti Suzuki',
  spresso: 'Maruti Suzuki',
  xl6: 'Maruti Suzuki',
  eeco: 'Maruti Suzuki',
  omni: 'Maruti Suzuki',
  ritz: 'Maruti Suzuki',
  'grand i10': 'Hyundai',
  i10: 'Hyundai',
  i20: 'Hyundai',
  creta: 'Hyundai',
  venue: 'Hyundai',
  verna: 'Hyundai',
  santro: 'Hyundai',
  aura: 'Hyundai',
  xcent: 'Hyundai',
  eon: 'Hyundai',
  nexon: 'Tata',
  altroz: 'Tata',
  tiago: 'Tata',
  tigor: 'Tata',
  punch: 'Tata',
  harrier: 'Tata',
  safari: 'Tata',
  indica: 'Tata',
  zest: 'Tata',
  scorpio: 'Mahindra',
  'scorpio n': 'Mahindra',
  xuv300: 'Mahindra',
  xuv500: 'Mahindra',
  xuv700: 'Mahindra',
  bolero: 'Mahindra',
  thar: 'Mahindra',
  marazzo: 'Mahindra',
  city: 'Honda',
  amaze: 'Honda',
  jazz: 'Honda',
  'wr-v': 'Honda',
  wrv: 'Honda',
  brio: 'Honda',
  innova: 'Toyota',
  'innova crysta': 'Toyota',
  fortuner: 'Toyota',
  glanza: 'Toyota',
  etios: 'Toyota',
  'etios liva': 'Toyota',
  corolla: 'Toyota',
  seltos: 'Kia',
  sonet: 'Kia',
  carens: 'Kia',
  hector: 'MG',
  astor: 'MG',
  kwid: 'Renault',
  triber: 'Renault',
  duster: 'Renault',
  magnite: 'Nissan',
  polo: 'Volkswagen',
  vento: 'Volkswagen',
  rapid: 'Skoda',
  kushaq: 'Skoda',
  figo: 'Ford',
  ecosport: 'Ford',
  compass: 'Jeep',
  activa: 'Honda',
  pulsar: 'Bajaj',
  splendor: 'Hero',
  apache: 'TVS',
  jupiter: 'TVS',
  access: 'Suzuki',
  classic: 'Royal Enfield',
  bullet: 'Royal Enfield',
};

const MAKES: readonly string[] = [
  'maruti suzuki',
  'maruti',
  'suzuki',
  'hyundai',
  'tata',
  'mahindra',
  'honda',
  'toyota',
  'kia',
  'mg',
  'renault',
  'nissan',
  'ford',
  'skoda',
  'volkswagen',
  'jeep',
  'fiat',
  'datsun',
  'chevrolet',
  'bajaj',
  'hero',
  'tvs',
  'royal enfield',
  'yamaha',
];

/**
 * Service vocabulary. Each entry maps every register a shop hears — English,
 * Tamil, Hindi, and the romanised forms people actually type — onto one
 * canonical line description.
 */
interface ServiceTerm {
  readonly label: string;
  readonly terms: readonly string[];
}

const SERVICES: readonly ServiceTerm[] = [
  { label: 'Brake pad replacement', terms: ['brake pad', 'brake pads', 'brakepad', 'பிரேக் பேட்', 'ब्रेक पैड'] },
  { label: 'Brake service', terms: ['brake', 'brakes', 'braking', 'பிரேக்', 'ब्रेक'] },
  { label: 'Engine oil change', terms: ['oil change', 'engine oil', 'oil service', 'ஆயில் மாற்று', 'ஆயில்', 'तेल बदल', 'इंजन ऑयल', 'oil maathu', 'oil change pannunga'] },
  { label: 'Oil filter replacement', terms: ['oil filter', 'ஆயில் ஃபில்டர்', 'ऑयल फिल्टर'] },
  { label: 'Air filter replacement', terms: ['air filter', 'ஏர் ஃபில்டர்', 'एयर फिल्टर'] },
  { label: 'Clutch repair', terms: ['clutch', 'கிளட்ச்', 'क्लच'] },
  { label: 'Battery replacement', terms: ['battery', 'பேட்டரி', 'बैटरी'] },
  { label: 'AC service', terms: ['ac service', 'a/c', 'air conditioning', 'ac cooling', 'ac not cooling', 'ஏசி', 'एसी'] },
  { label: 'Tyre replacement', terms: ['tyre', 'tire', 'tyres', 'டயர்', 'टायर'] },
  { label: 'Wheel alignment', terms: ['alignment', 'wheel alignment', 'அலைன்மென்ட்', 'अलाइनमेंट'] },
  { label: 'Wheel balancing', terms: ['balancing', 'wheel balancing', 'பேலன்சிங்'] },
  { label: 'Suspension repair', terms: ['suspension', 'shocker', 'shockers', 'strut', 'சஸ்பென்ஷன்', 'सस्पेंशन'] },
  { label: 'Periodic service', terms: ['general service', 'periodic service', 'full service', 'servicing', 'service', 'சர்வீஸ்', 'सर्विस'] },
  { label: 'Car wash and polish', terms: ['wash', 'washing', 'polish', 'cleaning', 'detailing', 'வாஷ்', 'धुलाई'] },
  { label: 'Denting and painting', terms: ['denting', 'dent', 'painting', 'paint', 'scratch', 'டெண்ட்', 'डेंट', 'पेंट'] },
  { label: 'Exhaust repair', terms: ['silencer', 'exhaust', 'சைலன்சர்', 'साइलेंसर'] },
  { label: 'Coolant / radiator service', terms: ['radiator', 'coolant', 'overheat', 'overheating', 'ரேடியேட்டர்', 'रेडिएटर'] },
  { label: 'Starting trouble diagnosis', terms: ['starting problem', 'not starting', 'self start', 'starter', 'ஸ்டார்ட்', 'स्टार्ट नहीं'] },
  { label: 'Headlight / lamp repair', terms: ['headlight', 'head light', 'tail light', 'indicator', 'ஹெட்லைட்', 'हेडलाइट'] },
  { label: 'Wiper replacement', terms: ['wiper', 'wipers', 'வைப்பர்', 'वाइपर'] },
  { label: 'Horn repair', terms: ['horn', 'ஹார்ன்', 'हॉर्न'] },
  { label: 'Noise diagnosis', terms: ['noise', 'sound', 'rattle', 'சத்தம்', 'आवाज', 'awaaz'] },
  { label: 'Puncture repair', terms: ['puncture', 'பஞ்சர்', 'पंचर'] },
];

const HONORIFICS: readonly string[] = [
  'anna',
  'anne',
  'akka',
  'thambi',
  'ayya',
  'sir',
  'madam',
  'maam',
  "ma'am",
  'ji',
  'bhai',
  'bhaiya',
  'saab',
  'sahab',
  'uncle',
  'aunty',
  'garu',
  'mr',
  'mrs',
  'ms',
  'dr',
  // The same honorifics as they are actually typed on a Tamil or Hindi
  // keyboard. Without these the name in a Devanagari or Tamil message falls
  // through to positional guesswork, because neither script has case for the
  // "leading capitalised word" heuristic to find.
  'जी',
  'भाई',
  'साहब',
  'सर',
  'मैडम',
  'अंकल',
  'அண்ணா',
  'அக்கா',
  'தம்பி',
  'ஐயா',
  'சார்',
  'மேடம்',
];

interface TimeTerm {
  readonly label: string;
  readonly terms: readonly string[];
}

const TIME_TERMS: readonly TimeTerm[] = [
  { label: 'tomorrow morning', terms: ['tomorrow morning', 'naalaikku kaalai', 'kal subah'] },
  { label: 'tomorrow evening', terms: ['tomorrow evening', 'naalaikku saayangalam', 'kal shaam'] },
  { label: 'tomorrow', terms: ['tomorrow', 'நாளை', 'naalaikku', 'naalai', 'kal', 'कल'] },
  { label: 'this evening', terms: ['evening', 'tonight', 'மாலை', 'saayangalam', 'shaam', 'शाम'] },
  { label: 'this morning', terms: ['morning', 'காலை', 'kaalai', 'subah', 'सुबह'] },
  { label: 'this afternoon', terms: ['afternoon', 'மதியம்', 'mathiyam', 'dopahar', 'दोपहर'] },
  { label: 'today', terms: ['today', 'இன்று', 'inniku', 'indru', 'aaj', 'आज'] },
  { label: 'day after tomorrow', terms: ['day after tomorrow', 'naalaikku aduthu', 'parso', 'परसों'] },
];

/** Romanised markers that reveal the speaker's language without any script. */
const ROMANISED_TAMIL: readonly string[] = [
  'pannunga',
  'panunga',
  'irukku',
  'illa',
  'illai',
  'naalaikku',
  'inniku',
  'seri',
  'venum',
  'kudunga',
  'saayangalam',
  'anna',
  'thambi',
  'vandi',
];
const ROMANISED_HINDI: readonly string[] = [
  'karo',
  'karna',
  'kardo',
  'chahiye',
  'hai',
  'nahi',
  'nahin',
  'kal',
  'shaam',
  'subah',
  'thik',
  'theek',
  'bhai',
  'gaadi',
  'kitna',
];

/* -------------------------------------------------------------------------- *
 * Extraction
 * -------------------------------------------------------------------------- */

export interface HeuristicDraftResult {
  readonly draft: JobCardDraft;
  /** Human-readable account of what matched, for the sandbox trace panel. */
  readonly notes: readonly string[];
}

export function extractDraftFromText(
  input: string,
  options: HeuristicDraftOptions = {},
): HeuristicDraftResult {
  const text = input.replace(/\s+/g, ' ').trim();
  const lower = text.toLowerCase();
  const notes: string[] = [];

  const language = detectLanguage(text, lower, options.defaultLanguage ?? 'en');
  const registration = findRegistration(text, notes);
  const phone = findPhone(text, notes);
  const vehicle = findVehicle(lower, notes);
  const amounts = findAmounts(text, registration.matchedText);
  const services = findServices(lower, notes);
  const promisedAt = findPromisedAt(lower, notes);
  const name = findCustomerName(text, registration.matchedText, vehicle.matchedText, notes);

  const draft = emptyJobCardDraft();

  const estimateLines = buildEstimateLines(services, amounts, notes);

  const composed: JobCardDraft = {
    ...draft,
    customer: {
      // Clamped to the schema's own limits. A parser that hands the validator a
      // value it will reject turns a low-quality extraction into a thrown
      // error three layers up, which is a much worse failure than a truncated
      // name an advisor can correct.
      name: field(clamp(name.value ?? '', 120), name.value === null ? 0 : name.confidence),
      phone: field(phone.value, phone.value === null ? 0 : CONFIDENCE.parsed),
    },
    vehicle: {
      registration: field(
        clamp(registration.value ?? '', 24),
        registration.value === null ? 0 : registration.confidence,
      ),
      make: field(clampOrNull(vehicle.make, 60), vehicle.make === null ? 0 : vehicle.makeConfidence),
      model: field(
        clampOrNull(vehicle.model, 60),
        vehicle.model === null ? 0 : CONFIDENCE.vocabulary,
      ),
      odometerKm: field(null, 0),
    },
    complaints: services.map((service) => field(clamp(service.label, 400), CONFIDENCE.vocabulary)),
    estimateLines,
    advisorName: field(null, 0),
    promisedAt: field(
      clampOrNull(promisedAt.value, 64),
      promisedAt.value === null ? 0 : promisedAt.confidence,
    ),
    language,
    notes: clamp(notes.join('\n'), 2000),
  };

  return { draft: JobCardDraftSchema.parse(composed), notes };
}

function field<T>(value: T, confidence: number): ConfidentField<T> {
  return { value, confidence, region: null };
}

function clamp(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function clampOrNull(value: string | null, max: number): string | null {
  return value === null ? null : clamp(value, max);
}

/* --- language ------------------------------------------------------------- */

function detectLanguage(text: string, lower: string, fallback: Language): Language {
  if (/[஀-௿]/.test(text)) return 'ta';
  if (/[ऀ-ॿ]/.test(text)) return 'hi';

  const words = new Set(lower.split(/[^a-z]+/).filter((word) => word.length > 0));
  const tamilHits = ROMANISED_TAMIL.filter((marker) => words.has(marker)).length;
  const hindiHits = ROMANISED_HINDI.filter((marker) => words.has(marker)).length;

  // A single shared word ("hai" appears in plenty of English sentences too) is
  // not evidence. Two independent markers is.
  if (tamilHits >= 2 && tamilHits > hindiHits) return 'ta';
  if (hindiHits >= 2 && hindiHits > tamilHits) return 'hi';
  return fallback;
}

/* --- registration --------------------------------------------------------- */

interface RegistrationHit {
  readonly value: string | null;
  readonly confidence: number;
  readonly matchedText: string | null;
}

/**
 * Registrations are written every possible way — `TN09BX4432`, `TN 09 BX 4432`,
 * `MH12`, `KA-05-MG-1234`. Candidate windows of 2–4 adjacent tokens are tried
 * longest-first, so the fullest plate wins over its own prefix.
 */
function findRegistration(text: string, notes: string[]): RegistrationHit {
  const tokens = text.split(' ').filter((token) => token.length > 0);

  for (const width of [4, 3, 2, 1]) {
    for (let start = 0; start + width <= tokens.length; start += 1) {
      const window = tokens.slice(start, start + width);
      const joined = window.join(' ');
      const candidate = joined.replace(/[^A-Za-z0-9]/g, '');
      // A plate is 6–13 alphanumerics carrying both letters and digits. The
      // test is on *shape*, not on the leading characters, because the whole
      // point of the shared normaliser is repairing `1N09BX4432` back to
      // `TN09BX4432` — a guard that demanded two leading letters would reject
      // exactly the input that repair exists for. A bare price or a phone
      // number still cannot qualify: neither has two letters.
      if (candidate.length < 6 || candidate.length > 13) continue;
      if ((candidate.match(/[A-Za-z]/g) ?? []).length < 2) continue;
      if ((candidate.match(/\d/g) ?? []).length < 4) continue;

      const result = normaliseRegistration(candidate);
      if (result.ok) {
        const exact = result.value.normalised === candidate.toUpperCase();
        notes.push(
          exact
            ? `Registration "${joined}" read as ${result.value.normalised}.`
            : `Registration "${joined}" repaired to ${result.value.normalised} — please confirm.`,
        );
        return {
          value: result.value.normalised,
          confidence: exact ? CONFIDENCE.parsed : CONFIDENCE.repaired,
          matchedText: joined,
        };
      }
    }
  }

  // A partial plate ("MH12") is worth surfacing: the advisor knows the rest.
  const partial = /\b([A-Z]{2})[\s-]?(\d{1,2})\b/.exec(text.toUpperCase());
  if (partial !== null) {
    const stateCode = partial[1] ?? '';
    const rto = partial[2] ?? '';
    if (normaliseRegistration(`${stateCode}${rto}AA0000`).ok) {
      notes.push(`Only a partial registration ("${partial[0]}") was in the message.`);
      return {
        value: `${stateCode}${rto.padStart(2, '0')}`,
        confidence: CONFIDENCE.ambiguous,
        matchedText: partial[0],
      };
    }
  }

  return { value: null, confidence: 0, matchedText: null };
}

/* --- phone ---------------------------------------------------------------- */

function findPhone(text: string, notes: string[]): { readonly value: string | null } {
  const candidates = text.match(/(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}/g) ?? [];
  for (const candidate of candidates) {
    const result = normalisePhone(candidate);
    if (result.ok) {
      notes.push('Phone number read from the message.');
      return { value: result.value };
    }
  }
  return { value: null };
}

/* --- vehicle -------------------------------------------------------------- */

interface VehicleHit {
  readonly make: string | null;
  readonly makeConfidence: number;
  readonly model: string | null;
  readonly matchedText: string | null;
}

function findVehicle(lower: string, notes: string[]): VehicleHit {
  // Longest model name first: "swift dzire" must beat "swift".
  const models = Object.keys(MODEL_TO_MAKE).sort((left, right) => right.length - left.length);

  let model: string | null = null;
  let matchedText: string | null = null;
  for (const candidate of models) {
    if (containsWord(lower, candidate)) {
      model = titleCase(candidate);
      matchedText = candidate;
      break;
    }
  }

  let make: string | null = null;
  let makeConfidence = 0;
  for (const candidate of [...MAKES].sort((left, right) => right.length - left.length)) {
    if (containsWord(lower, candidate)) {
      make = titleCase(candidate);
      makeConfidence = CONFIDENCE.vocabulary;
      break;
    }
  }

  if (make === null && matchedText !== null) {
    // The make was not written down; a Swift is a Maruti, but the *card* does
    // not say so, so this is an inference and is scored as one.
    make = MODEL_TO_MAKE[matchedText] ?? null;
    makeConfidence = make === null ? 0 : CONFIDENCE.derived;
    if (make !== null) notes.push(`Make "${make}" inferred from the model "${model ?? ''}".`);
  }

  if (model !== null) notes.push(`Vehicle model "${model}" matched.`);
  return { make, makeConfidence, model, matchedText };
}

/* --- money ---------------------------------------------------------------- */

interface Amount {
  readonly paise: number;
  readonly index: number;
}

/**
 * Rupee amounts. Anything under ₹100 is ignored: it is far more likely to be a
 * quantity, an RTO code or a time than a price for workshop labour.
 */
function findAmounts(text: string, registrationText: string | null): Amount[] {
  const scrubbed =
    registrationText === null ? text : text.split(registrationText).join(' ');

  const amounts: Amount[] = [];
  const pattern = /(?:₹|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d{1,2})?)\s*(k\b|thousand\b)?/gi;

  for (const match of scrubbed.matchAll(pattern)) {
    const raw = match[1];
    if (raw === undefined) continue;
    const hasCurrency = /₹|rs|inr/i.test(match[0]);
    const multiplier = match[2] === undefined ? 1 : 1000;
    const rupees = Number(raw.replace(/,/g, '')) * multiplier;

    if (!Number.isFinite(rupees)) continue;
    if (rupees < 100 && !hasCurrency) continue;
    if (rupees > 1_000_000) continue;

    amounts.push({ paise: Math.round(rupees * 100), index: match.index ?? 0 });
  }

  return amounts;
}

/* --- services ------------------------------------------------------------- */

interface ServiceHit {
  readonly label: string;
  readonly index: number;
}

function findServices(lower: string, notes: string[]): ServiceHit[] {
  const hits: ServiceHit[] = [];
  const claimed: Array<[number, number]> = [];

  // Longest term first so "brake pad" is not consumed by "brake".
  const flattened = SERVICES.flatMap((service) =>
    service.terms.map((term) => ({ label: service.label, term })),
  ).sort((left, right) => right.term.length - left.term.length);

  for (const { label, term } of flattened) {
    const index = indexOfWord(lower, term);
    if (index < 0) continue;
    const span: [number, number] = [index, index + term.length];
    if (claimed.some(([from, to]) => span[0] < to && from < span[1])) continue;
    if (hits.some((hit) => hit.label === label)) continue;
    claimed.push(span);
    hits.push({ label, index });
  }

  hits.sort((left, right) => left.index - right.index);
  if (hits.length > 0) notes.push(`Work items matched: ${hits.map((h) => h.label).join(', ')}.`);
  return hits.slice(0, 20);
}

/* --- promised time -------------------------------------------------------- */

function findPromisedAt(
  lower: string,
  notes: string[],
): { readonly value: string | null; readonly confidence: number } {
  const clock = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/.exec(lower);
  const phrase = TIME_TERMS.find((entry) => entry.terms.some((term) => containsWord(lower, term)));

  if (clock !== null && phrase !== undefined) {
    const value = `${phrase.label} ${clock[0]}`;
    notes.push(`Promised time read as "${value}".`);
    return { value, confidence: CONFIDENCE.vocabulary };
  }
  if (clock !== null) {
    notes.push(`Promised time read as "${clock[0]}" — the day was not stated.`);
    return { value: clock[0], confidence: CONFIDENCE.ambiguous };
  }
  if (phrase !== undefined) {
    notes.push(`Promised time read as "${phrase.label}".`);
    // "evening" is a real commitment but not a timestamp; the ETA engine
    // (phase 4) must not be handed this as though it were one.
    return { value: phrase.label, confidence: CONFIDENCE.ambiguous };
  }
  return { value: null, confidence: 0 };
}

/* --- customer name -------------------------------------------------------- */

interface NameHit {
  readonly value: string | null;
  readonly confidence: number;
}

/**
 * Names come first in these messages, usually followed by an honorific:
 * "Ravi anna", "Sharma ji", "Kumar sir". The honorific is the strong signal;
 * position alone is much weaker, and scored accordingly.
 */
function findCustomerName(
  text: string,
  registrationText: string | null,
  vehicleText: string | null,
  notes: string[],
): NameHit {
  const stopAt = [registrationText, vehicleText]
    .filter((value): value is string => value !== null)
    .map((value) => text.toLowerCase().indexOf(value.toLowerCase()))
    .filter((index) => index > 0);

  const boundary = stopAt.length === 0 ? text.length : Math.min(...stopAt);
  const head = text.slice(0, boundary).trim();
  if (head.length === 0) return { value: null, confidence: 0 };

  // Combining marks are part of the word, not separators. Splitting on
  // `\p{L}` alone shreds every Tamil and Devanagari name — "முருகன்" becomes
  // three fragments and "जी" stops matching the honorific list entirely.
  const words = head.split(/[^\p{L}\p{M}]+/u).filter((word) => word.length > 0);
  if (words.length === 0) return { value: null, confidence: 0 };

  const honorificAt = words.findIndex((word) => HONORIFICS.includes(word.toLowerCase()));

  if (honorificAt > 0) {
    const name = words.slice(0, honorificAt).join(' ');
    notes.push(`Customer name "${name}" read from the honorific that follows it.`);
    return { value: name, confidence: CONFIDENCE.vocabulary };
  }
  if (honorificAt === 0 && words.length > 1) {
    const name = words.slice(1, Math.min(3, words.length)).join(' ');
    notes.push(`Customer name "${name}" read after the honorific.`);
    return { value: name, confidence: CONFIDENCE.vocabulary };
  }

  // No honorific: take the leading capitalised run, and say plainly that this
  // is positional guesswork so the advisor checks it.
  const leading = words.filter((word) => /^\p{Lu}/u.test(word)).slice(0, 2);
  if (leading.length === 0) return { value: null, confidence: 0 };

  const name = leading.join(' ');
  notes.push(`Customer name "${name}" guessed from the start of the message — please confirm.`);
  return { value: name, confidence: CONFIDENCE.positional };
}

/* --- estimate lines ------------------------------------------------------- */

function buildEstimateLines(
  services: readonly ServiceHit[],
  amounts: readonly Amount[],
  notes: string[],
): JobCardDraft['estimateLines'] {
  if (services.length === 0 && amounts.length === 0) return [];

  const lines: JobCardDraft['estimateLines'] = [];

  if (services.length === 0) {
    // A bare number with no work attached. Keep it, flagged hard.
    for (const amount of amounts.slice(0, 40)) {
      lines.push({
        description: field('Work to be confirmed', CONFIDENCE.ambiguous),
        quantityMilli: field(1000, CONFIDENCE.derived),
        unitPricePaise: field(amount.paise, CONFIDENCE.ambiguous),
      });
    }
    notes.push('An amount was quoted with no work described against it.');
    return lines;
  }

  const perService = amounts.length === services.length;
  if (!perService && amounts.length > 0) {
    notes.push(
      `${amounts.length} amount(s) for ${services.length} item(s) — the split across items is a guess.`,
    );
  }

  for (const [index, service] of services.entries()) {
    // One price per item is a real attribution; one price for the whole job is
    // not, so only the first line carries it and it is scored as ambiguous.
    const price = perService
      ? (amounts[index]?.paise ?? null)
      : index === 0
        ? (amounts[0]?.paise ?? null)
        : null;

    lines.push({
      description: field(service.label, CONFIDENCE.vocabulary),
      quantityMilli: field(1000, CONFIDENCE.derived),
      unitPricePaise: field(
        price,
        price === null ? 0 : perService ? CONFIDENCE.vocabulary : CONFIDENCE.ambiguous,
      ),
    });
  }

  return lines.slice(0, 40);
}

/* --- text utilities ------------------------------------------------------- */

/** Word-boundary search that also works for Tamil and Devanagari. */
function indexOfWord(haystack: string, needle: string): number {
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) return -1;

    const before = index === 0 ? ' ' : haystack[index - 1];
    const afterIndex = index + needle.length;
    const after = afterIndex >= haystack.length ? ' ' : haystack[afterIndex];

    // Combining marks count as word characters here too: without them,
    // searching for "மாற" inside "மாற்று" would look like a whole-word hit
    // because the virama that follows is not a letter.
    const boundedBefore = before === undefined || !/[\p{L}\p{M}\p{N}]/u.test(before);
    const boundedAfter = after === undefined || !/[\p{L}\p{M}\p{N}]/u.test(after);
    if (boundedBefore && boundedAfter) return index;

    from = index + 1;
  }
}

function containsWord(haystack: string, needle: string): boolean {
  return indexOfWord(haystack, needle) >= 0;
}

function titleCase(value: string): string {
  return value
    .split(' ')
    .map((word) => (word.length === 0 ? word : word[0]?.toUpperCase() + word.slice(1)))
    .join(' ');
}
