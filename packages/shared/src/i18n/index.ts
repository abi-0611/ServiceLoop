import type { Language } from '../enums';
import { CATALOGUES, type StringKey } from './catalogue';

export { CATALOGUES } from './catalogue';
export * from './templates';
export * from './template-ops';
export type { StringKey, Catalogue } from './catalogue';
export {
  isOptIn,
  isOptOut,
  KEYWORDS,
  matchKeyword,
  normaliseKeywordText,
  type KeywordIntent,
} from './keywords';

export type TemplateParams = Readonly<Record<string, string | number>>;

export const FALLBACK_LANGUAGE: Language = 'en';

const PLACEHOLDER_RE = /\{(\w+)\}/g;

export class MissingTemplateParamError extends Error {
  constructor(
    readonly key: StringKey,
    readonly param: string,
  ) {
    super(`i18n: missing parameter "${param}" for key "${key}"`);
    this.name = 'MissingTemplateParamError';
  }
}

/**
 * Resolves a catalogue string. Missing placeholders throw rather than emitting
 * a literal `{name}` to a customer (L7 — no half-rendered claims go out).
 */
export function t(language: Language, key: StringKey, params: TemplateParams = {}): string {
  const catalogue = CATALOGUES[language] ?? CATALOGUES[FALLBACK_LANGUAGE];
  const template = catalogue[key] ?? CATALOGUES[FALLBACK_LANGUAGE][key];

  return template.replace(PLACEHOLDER_RE, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) throw new MissingTemplateParamError(key, name);
    return String(value);
  });
}

/** Placeholders a template requires — used by tests and template linting. */
export function requiredParams(key: StringKey, language: Language = FALLBACK_LANGUAGE): string[] {
  const template = CATALOGUES[language][key];
  return [...template.matchAll(PLACEHOLDER_RE)].map((match) => match[1] ?? '');
}

export function catalogueKeys(): StringKey[] {
  return Object.keys(CATALOGUES[FALLBACK_LANGUAGE]) as StringKey[];
}
