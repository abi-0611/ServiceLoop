import type { Language } from '../enums';

/**
 * Command keywords a customer can type in any of the launch languages.
 *
 * These are compliance surface, not convenience: WhatsApp Business policy and
 * the DPDP Act both require an opt-out that works the instant it is typed, and
 * a customer typing "நிறுத்து" has opted out exactly as much as one typing
 * "STOP". L4 says language handling is architecture, so the keyword table lives
 * beside the catalogue rather than inside a handler.
 *
 * Matching is deliberately whole-message: "STOP" opts out, but "stop the AC
 * work please" is a service instruction and must reach an advisor, not silence
 * the thread. Latin-script transliterations are included because that is how
 * most Tamil and Hindi speakers actually type on a phone keyboard.
 */

export type KeywordIntent = 'OPT_OUT' | 'OPT_IN' | 'HUMAN' | 'AFFIRMATIVE' | 'NEGATIVE';

type KeywordTable = Readonly<Record<KeywordIntent, readonly string[]>>;

const en: KeywordTable = {
  OPT_OUT: ['stop', 'unsubscribe', 'opt out', 'optout', 'cancel messages', 'no messages'],
  OPT_IN: ['start', 'subscribe', 'resume', 'yes start'],
  HUMAN: ['human', 'agent', 'advisor', 'talk to a person', 'representative'],
  AFFIRMATIVE: ['yes', 'y', 'ok', 'okay', 'approve', 'approved', 'go ahead', 'confirm', 'sure'],
  NEGATIVE: ['no', 'n', 'not now', 'decline', 'later', 'skip'],
};

const ta: KeywordTable = {
  // "வேண்டாம்" (don't want) is deliberately *not* here: answering "approve
  // this work?" with it means decline, not unsubscribe. Silencing a customer
  // who was answering a question is the worse error, so only unambiguous
  // stop-words opt out.
  OPT_OUT: ['நிறுத்து', 'நிறுத்தவும்', 'niruthu', 'nirutthu', 'niruthungal'],
  OPT_IN: ['தொடங்கு', 'ஆரம்பி', 'thodangu', 'aarambi'],
  HUMAN: ['மனிதர்', 'ஆலோசகர்', 'நபர்', 'manithar', 'aalosagar'],
  AFFIRMATIVE: ['ஆம்', 'சரி', 'ஒப்புதல்', 'aam', 'sari', 'seri', 'ok pannunga'],
  NEGATIVE: ['இல்லை', 'வேண்டாம்', 'illai', 'ille'],
};

const hi: KeywordTable = {
  OPT_OUT: ['बंद', 'बंद करो', 'रोको', 'मत भेजो', 'band', 'band karo', 'roko', 'mat bhejo'],
  OPT_IN: ['शुरू', 'चालू', 'shuru', 'chalu'],
  HUMAN: ['इंसान', 'व्यक्ति', 'सलाहकार', 'insaan', 'vyakti', 'salahkar'],
  AFFIRMATIVE: ['हाँ', 'हां', 'ठीक', 'मंजूर', 'haan', 'thik hai', 'theek', 'manjoor'],
  NEGATIVE: ['नहीं', 'ना', 'अभी नहीं', 'nahi', 'nahin', 'abhi nahi'],
};

export const KEYWORDS: Readonly<Record<Language, KeywordTable>> = { en, ta, hi };

/**
 * Strips punctuation, emoji and repeated whitespace so "STOP!!" and "stop."
 * both match. Unicode letters are preserved, so Tamil and Devanagari survive.
 */
export function normaliseKeywordText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Classifies a whole message as a command, or returns null when it is ordinary
 * conversation. Every language's table is consulted regardless of the thread's
 * declared language: a Tamil-preference customer who types "STOP" still opts
 * out, and code-switching is the norm, not the exception (L4).
 */
export function matchKeyword(input: string, intents?: readonly KeywordIntent[]): KeywordIntent | null {
  const normalised = normaliseKeywordText(input);
  if (normalised.length === 0) return null;

  // Longest phrase first, so "not now" beats "no" and "opt out" beats "out".
  const candidates: Array<{ intent: KeywordIntent; phrase: string }> = [];
  for (const table of Object.values(KEYWORDS)) {
    for (const [intent, phrases] of Object.entries(table) as Array<
      [KeywordIntent, readonly string[]]
    >) {
      if (intents !== undefined && !intents.includes(intent)) continue;
      for (const phrase of phrases) candidates.push({ intent, phrase: normaliseKeywordText(phrase) });
    }
  }
  candidates.sort((left, right) => right.phrase.length - left.phrase.length);

  for (const candidate of candidates) {
    if (normalised === candidate.phrase) return candidate.intent;
  }
  return null;
}

/** True when the message is an opt-out in any launch language. */
export function isOptOut(input: string): boolean {
  return matchKeyword(input, ['OPT_OUT']) === 'OPT_OUT';
}

export function isOptIn(input: string): boolean {
  return matchKeyword(input, ['OPT_IN']) === 'OPT_IN';
}
