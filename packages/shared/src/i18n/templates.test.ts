import { describe, expect, it } from 'vitest';
import type { Language } from '../enums';
import { CATALOGUES, type Catalogue } from './catalogue';
import {
  formatLintFindings,
  lintTemplates,
  smsCoverage,
  TEMPLATE_MANIFEST,
  templateByKey,
  templateByName,
  type TemplateSpec,
} from './templates';

/**
 * The template lint (phase 7.3: "variable lint — mismatched placeholders fail
 * CI; language variants coverage check").
 *
 * The first test is the gate. The rest exist because a lint nobody has seen
 * fail is a lint nobody trusts: each feeds it a deliberately broken fixture and
 * asserts it catches exactly the right thing.
 */

describe('the shipped manifest', () => {
  it('is clean', () => {
    const findings = lintTemplates();
    expect(findings, `Template lint failures:\n${formatLintFindings(findings)}`).toEqual([]);
  });

  it('has a unique key and name for every template', () => {
    const keys = TEMPLATE_MANIFEST.map((spec) => spec.key);
    const names = TEMPLATE_MANIFEST.map((spec) => spec.name);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(names).size).toBe(names.length);
  });

  it('covers every customer-facing template in all three languages', () => {
    for (const spec of TEMPLATE_MANIFEST.filter((entry) => entry.customerFacing)) {
      for (const language of ['en', 'ta', 'hi'] as const) {
        const copy = CATALOGUES[language][spec.bodyKey];
        expect(copy, `${spec.key} has no ${language} copy`).toBeTruthy();
      }
    }
  });

  it('is resolvable by key and by the name submitted to Meta', () => {
    const first = TEMPLATE_MANIFEST[0] as TemplateSpec;
    expect(templateByKey(first.key)).toBe(first);
    expect(templateByName(first.name)).toBe(first);
    expect(templateByKey('no_such_template')).toBeUndefined();
  });
});

describe('the lint catches a broken fixture', () => {
  const base = TEMPLATE_MANIFEST[1] as TemplateSpec;

  it('flags a variable the copy uses but the manifest does not declare', () => {
    // `jobcard.opened` uses {code}, {vehicle} and {shopName}. Dropping one from
    // the manifest means the submitted template has too few parameters, and the
    // send fails at Meta with a parameter-count error.
    const findings = lintTemplates([{ ...base, variables: ['code', 'vehicle'] }]);
    expect(findings.map((finding) => finding.rule)).toContain('UNDECLARED_VARIABLE');
  });

  it('flags a variable the manifest declares but the copy never uses', () => {
    const findings = lintTemplates([
      { ...base, variables: [...base.variables, 'technicianName'] },
    ]);
    expect(findings.map((finding) => finding.rule)).toContain('UNUSED_VARIABLE');
  });

  it('flags a catalogue key that does not exist', () => {
    const findings = lintTemplates([
      { ...base, bodyKey: 'jobcard.does_not_exist' as TemplateSpec['bodyKey'] },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('MISSING_CATALOGUE_KEY');
  });

  it('flags a template name Meta would reject', () => {
    const findings = lintTemplates([{ ...base, name: 'SL Ready Alert!' }]);
    expect(findings.map((finding) => finding.rule)).toContain('BAD_NAME');
  });

  it('flags two templates registered under one name', () => {
    const findings = lintTemplates([base, { ...base, key: 'clone' }]);
    expect(findings.map((finding) => finding.rule)).toContain('DUPLICATE_NAME');
  });

  /**
   * The mismatch that matters most: an English template with three variables
   * and a Tamil one with two. The English send works, the Tamil send throws at
   * substitution — and it throws for exactly the customers least able to read
   * an English fallback.
   */
  it('flags a language variant that drops a placeholder', () => {
    const findings = lintTemplates([base], brokenCatalogues({
      ta: 'Job card opened for your vehicle at {shopName}.',
    }));

    const mismatch = findings.filter((finding) => finding.rule === 'VARIABLE_MISMATCH');
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]?.language).toBe('ta');
    expect(mismatch[0]?.detail).toContain('{code}');
    expect(mismatch[0]?.detail).toContain('{vehicle}');
    // Hindi is untouched, so exactly one language is reported. A lint that
    // blamed every translation for one broken one would be ignored.
    expect(findings.filter((finding) => finding.language === 'hi')).toEqual([]);
  });

  it('flags a language variant that invents a placeholder', () => {
    const findings = lintTemplates([base], brokenCatalogues({
      hi: '{code} {vehicle} {shopName} {advisorName}',
    }));
    const mismatch = findings.find((finding) => finding.rule === 'VARIABLE_MISMATCH');
    expect(mismatch?.language).toBe('hi');
    expect(mismatch?.detail).toContain('unexpected {advisorName}');
  });

  it('flags a customer-facing template that exists only in English', () => {
    const findings = lintTemplates([base], brokenCatalogues({ ta: undefined, hi: undefined }));
    expect(findings.map((finding) => finding.rule)).toEqual([
      'MISSING_LANGUAGE',
      'MISSING_LANGUAGE',
    ]);
  });

  it('does not require translations of a staff-only template', () => {
    const staffOnly: TemplateSpec = { ...base, customerFacing: false };
    const findings = lintTemplates([staffOnly], brokenCatalogues({ ta: undefined, hi: undefined }));
    expect(findings).toEqual([]);
  });
});

/**
 * A copy of the shipped catalogues with one template's body overridden per
 * language. `undefined` removes it, which is how a missing translation is
 * modelled. Nothing shared is mutated.
 */
function brokenCatalogues(
  overrides: Partial<Record<Language, string | undefined>>,
): Record<Language, Partial<Catalogue>> {
  const bodyKey = (TEMPLATE_MANIFEST[1] as TemplateSpec).bodyKey;
  const result = {} as Record<Language, Partial<Catalogue>>;

  for (const language of ['en', 'ta', 'hi'] as const) {
    const copy: Partial<Catalogue> = { ...CATALOGUES[language] };
    if (language in overrides) {
      const replacement = overrides[language];
      if (replacement === undefined) delete copy[bodyKey];
      else (copy as Record<string, string>)[bodyKey] = replacement;
    }
    result[language] = copy;
  }
  return result;
}

describe('smsCoverage', () => {
  it('reports every customer-facing template with no registered DLT id', () => {
    const { covered, missing } = smsCoverage({ ready_for_delivery: 'DLT-1007' });
    expect(covered).toEqual(['ready_for_delivery']);
    expect(missing).toContain('approval_request');
    // A staff template is not a customer-facing obligation, so it is neither.
    expect([...covered, ...missing]).not.toContain('staff_otp');
  });

  it('treats a blank id as missing', () => {
    const { missing } = smsCoverage({ ready_for_delivery: '   ' });
    expect(missing).toContain('ready_for_delivery');
  });
});
