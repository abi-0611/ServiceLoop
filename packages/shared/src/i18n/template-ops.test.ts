import { describe, expect, it } from 'vitest';
import {
  buildTemplateOpsView,
  toSubmissionBody,
  type RegistrationInput,
} from './template-ops';
import { TEMPLATE_MANIFEST, type TemplateSpec } from './templates';

/**
 * The template ops fold (phase 7.3: "catalog, submission status tracking").
 *
 * Every test here is a state an operator will actually be in during a shop's
 * first fortnight, and each one is a way the screen could lie to them.
 */

const CUSTOMER_FACING = TEMPLATE_MANIFEST.find((spec) => spec.customerFacing) as TemplateSpec;
const STAFF_FACING = TEMPLATE_MANIFEST.find((spec) => !spec.customerFacing);

function registration(over: Partial<RegistrationInput> & Pick<RegistrationInput, 'templateKey'>) {
  return {
    language: 'en',
    status: 'APPROVED',
    providerTemplateId: null,
    rejectionReason: null,
    submittedAt: null,
    reviewedAt: null,
    submittedBody: null,
    ...over,
  } satisfies RegistrationInput;
}

describe('the fold is driven by the manifest', () => {
  it('reports every manifest template even when nothing is registered', () => {
    const view = buildTemplateOpsView([]);

    expect(view.rows).toHaveLength(TEMPLATE_MANIFEST.length);
    expect(view.summary.notSubmitted).toBe(TEMPLATE_MANIFEST.length);
    expect(view.summary.ready).toBe(0);
  });

  it('shows a customer-facing template in all three languages, a staff one in English only', () => {
    const view = buildTemplateOpsView([]);

    const customer = view.rows.find((row) => row.key === CUSTOMER_FACING.key);
    expect(customer?.languages.map((state) => state.language)).toEqual(['en', 'ta', 'hi']);

    if (STAFF_FACING !== undefined) {
      const staff = view.rows.find((row) => row.key === STAFF_FACING.key);
      expect(staff?.languages.map((state) => state.language)).toEqual(['en']);
    }
  });
});

describe('readiness', () => {
  /**
   * The single most important assertion in this file.
   *
   * A shop live in English with Tamil still pending is the ordinary state two
   * days into onboarding. A screen that called that template ready would tell
   * the operator the work was finished while a third of the shop's customers
   * were unreachable.
   */
  it('is not ready when one language of a customer-facing template is outstanding', () => {
    const view = buildTemplateOpsView([
      registration({ templateKey: CUSTOMER_FACING.key, language: 'en', status: 'APPROVED' }),
      registration({ templateKey: CUSTOMER_FACING.key, language: 'ta', status: 'PENDING' }),
    ]);

    const row = view.rows.find((entry) => entry.key === CUSTOMER_FACING.key);
    expect(row?.ready).toBe(false);
    expect(row?.blockedOn).toEqual(['ta', 'hi']);
  });

  it('is ready only when every required language is approved', () => {
    const view = buildTemplateOpsView(
      (['en', 'ta', 'hi'] as const).map((language) =>
        registration({ templateKey: CUSTOMER_FACING.key, language, status: 'APPROVED' }),
      ),
    );

    const row = view.rows.find((entry) => entry.key === CUSTOMER_FACING.key);
    expect(row?.ready).toBe(true);
    expect(row?.blockedOn).toEqual([]);
    expect(view.summary.ready).toBe(1);
  });
});

describe('the summary', () => {
  /**
   * A rejection outranks a pending. Reporting a half-rejected template as
   * pending leaves it in a queue nobody works: "pending" means Meta is thinking
   * about it, and the correct action is to wait.
   */
  it('counts a template with a rejected variant as rejected, not pending', () => {
    const view = buildTemplateOpsView([
      registration({
        templateKey: CUSTOMER_FACING.key,
        language: 'en',
        status: 'REJECTED',
        rejectionReason: 'INVALID_FORMAT',
      }),
      registration({ templateKey: CUSTOMER_FACING.key, language: 'ta', status: 'PENDING' }),
    ]);

    expect(view.summary.rejected).toBe(1);
    expect(view.summary.pending).toBe(0);
  });

  it('counts a template as not-submitted only when no variant has been submitted', () => {
    const view = buildTemplateOpsView([
      registration({ templateKey: CUSTOMER_FACING.key, language: 'en', status: 'PENDING' }),
    ]);

    const row = view.rows.find((entry) => entry.key === CUSTOMER_FACING.key);
    expect(row?.languages.map((state) => state.status)).toEqual([
      'PENDING',
      'NOT_SUBMITTED',
      'NOT_SUBMITTED',
    ]);
    expect(view.summary.pending).toBe(1);
    expect(view.summary.notSubmitted).toBe(TEMPLATE_MANIFEST.length - 1);
  });
});

describe('orphans', () => {
  it('reports a registration whose template has left the manifest', () => {
    const view = buildTemplateOpsView([
      registration({
        templateKey: 'sl_retired_thing',
        language: 'en',
        status: 'APPROVED',
        providerTemplateId: '1234567890',
      }),
    ]);

    expect(view.orphaned).toEqual([
      {
        templateKey: 'sl_retired_thing',
        language: 'en',
        status: 'APPROVED',
        providerTemplateId: '1234567890',
      },
    ]);
    // And it does not contaminate the counts, which are about the manifest.
    expect(view.summary.total).toBe(TEMPLATE_MANIFEST.length);
  });
});

describe('the submission body', () => {
  /**
   * The reason `toSubmissionBody` numbers by the manifest's variable order
   * rather than by order of appearance. A Tamil sentence may put the vehicle
   * where the English puts the date; numbering each language independently
   * would fill `{{1}}` with a registration in one language and a date in
   * another, and Meta would approve both.
   */
  it('numbers placeholders by the manifest order, identically in every language', () => {
    for (const spec of TEMPLATE_MANIFEST.filter((entry) => entry.customerFacing)) {
      const positional = spec.variables.map((_, index) => `{{${index + 1}}}`);

      for (const language of ['en', 'ta', 'hi'] as const) {
        const body = toSubmissionBody(spec, language);
        expect(body, `${spec.key} [${language}] still has a named placeholder`).not.toMatch(
          /\{[a-zA-Z]\w*\}/,
        );
        for (const token of positional) {
          expect(body, `${spec.key} [${language}] is missing ${token}`).toContain(token);
        }
      }
    }
  });

  it('flags drift when the catalogue has moved on since submission', () => {
    const current = toSubmissionBody(CUSTOMER_FACING, 'en');

    const drifted = buildTemplateOpsView([
      registration({
        templateKey: CUSTOMER_FACING.key,
        language: 'en',
        status: 'APPROVED',
        submittedBody: `${current} (old wording)`,
      }),
    ]);
    expect(
      drifted.rows.find((row) => row.key === CUSTOMER_FACING.key)?.languages[0]
        ?.driftedFromSubmission,
    ).toBe(true);

    const matching = buildTemplateOpsView([
      registration({
        templateKey: CUSTOMER_FACING.key,
        language: 'en',
        status: 'APPROVED',
        submittedBody: current,
      }),
    ]);
    expect(
      matching.rows.find((row) => row.key === CUSTOMER_FACING.key)?.languages[0]
        ?.driftedFromSubmission,
    ).toBe(false);
  });

  /** "We have not asked yet" is not drift, and drawing it as drift is a nag. */
  it('reports drift as null when nothing was ever submitted', () => {
    const view = buildTemplateOpsView([]);
    for (const row of view.rows) {
      for (const state of row.languages) {
        expect(state.driftedFromSubmission).toBeNull();
      }
    }
  });
});
