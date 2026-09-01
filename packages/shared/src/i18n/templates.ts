import { LANGUAGES, type Language } from '../enums';
import { CATALOGUES, type Catalogue, type StringKey } from './catalogue';

/**
 * The template manifest (phase 7.3).
 *
 * A WhatsApp template is the only way to open a conversation with somebody
 * whose 24-hour window has closed, and it takes Meta somewhere between an hour
 * and a fortnight to approve one. That makes the set of templates a shop needs
 * a *release artefact*, not a runtime detail: a build that starts using a new
 * one is a build that cannot talk to a third of its customers until a human has
 * submitted it and Meta has said yes.
 *
 * So the manifest is code. It says which templates exist, what each is for,
 * which catalogue key renders it, and which variables it takes — and CI lints
 * all four. The lint catches, before merge, the three failures that otherwise
 * surface in front of a customer:
 *
 *  1. a template whose Tamil variant takes different variables from its English
 *     one, so the Tamil send throws at substitution time;
 *  2. a template that exists in English only, so a Hindi-speaking customer
 *     silently gets English (or, worse, an unrendered `{vehicle}`);
 *  3. a template referenced by the code and registered with nobody.
 *
 * What lives in the *database* instead is the per-shop registration state —
 * Meta's template id, its approval status, the rejection reason. That changes
 * without a deploy and differs per WABA, so it cannot be here.
 */

export interface TemplateSpec {
  /** Stable key. Also the key of the per-shop DLT id map in shop config. */
  readonly key: string;
  /**
   * The name submitted to Meta. Lowercase with underscores, which is the only
   * shape the Cloud API accepts, and versioned by suffix because a template's
   * *content* cannot be edited after approval — a wording change is a new
   * template and a new approval.
   */
  readonly name: string;
  readonly category: 'UTILITY' | 'MARKETING' | 'AUTHENTICATION';
  /** The catalogue key each language variant renders from. */
  readonly bodyKey: StringKey;
  /**
   * Ordered body variables, as Meta numbers them ({{1}}, {{2}}, …).
   *
   * Named here even though WhatsApp only knows them positionally, because a
   * positional list is unreviewable: `['customerName','vehicle','eta']` can be
   * checked against the catalogue string by a machine and read by a person,
   * and `3` can be neither.
   */
  readonly variables: readonly string[];
  /**
   * Does a customer read this?
   *
   * Only customer-facing templates are required in every language. A staff
   * notice going out in English to a workshop's own WhatsApp group is a
   * different obligation from a message to somebody's customer, and pretending
   * otherwise would put three translations of an internal string in front of a
   * reviewer for no benefit.
   */
  readonly customerFacing: boolean;
  /** Why this template exists, for the ops screen and the approval submission. */
  readonly purpose: string;
}

/**
 * Every template this product sends.
 *
 * Adding one here without submitting it is caught by the ops screen (it shows
 * as `NOT_SUBMITTED` for every shop); removing one that a shop still has
 * registered is caught the same way, in the other direction.
 */
export const TEMPLATE_MANIFEST: readonly TemplateSpec[] = [
  {
    key: 'consent_request',
    name: 'sl_consent_request_v1',
    category: 'UTILITY',
    bodyKey: 'consent.request',
    variables: ['vehicle'],
    customerFacing: true,
    purpose:
      'Asks a customer for permission to send service updates. The only lawful way to open a thread with somebody who has not messaged first.',
  },
  {
    key: 'jobcard_opened',
    name: 'sl_jobcard_opened_v1',
    category: 'UTILITY',
    bodyKey: 'jobcard.opened',
    variables: ['code', 'vehicle', 'shopName'],
    customerFacing: true,
    purpose: 'Confirms that a job card has been opened for the vehicle left at the counter.',
  },
  {
    key: 'approval_request',
    name: 'sl_approval_request_v1',
    category: 'UTILITY',
    bodyKey: 'approval.request_intro',
    variables: ['vehicle', 'amount'],
    customerFacing: true,
    purpose:
      'Opens the approval conversation when extra work is found and the customer window has closed.',
  },
  {
    key: 'status_awaiting_parts',
    name: 'sl_status_awaiting_parts_v1',
    category: 'UTILITY',
    bodyKey: 'status.awaiting_parts',
    variables: ['vehicle', 'eta'],
    customerFacing: true,
    purpose: 'Proactive delay notice when a part has not arrived and the ETA has moved.',
  },
  {
    key: 'ready_for_delivery',
    name: 'sl_ready_for_delivery_v1',
    category: 'UTILITY',
    bodyKey: 'delivery.ready_intro',
    variables: ['vehicle', 'shopName'],
    customerFacing: true,
    purpose: 'Tells the customer their vehicle is ready and starts the pickup-slot conversation.',
  },
  {
    key: 'payment_balance_reminder',
    name: 'sl_payment_balance_v1',
    category: 'UTILITY',
    bodyKey: 'payment.balance_reminder',
    variables: ['vehicle', 'balance', 'url'],
    customerFacing: true,
    purpose: 'Reminds a customer of an outstanding balance with the payment link.',
  },
  {
    key: 'feedback_ask',
    name: 'sl_feedback_ask_v1',
    category: 'UTILITY',
    bodyKey: 'feedback.ask',
    variables: ['shopName', 'vehicle'],
    customerFacing: true,
    purpose: 'Asks how the visit went, a day or two after delivery.',
  },
  {
    key: 'service_due_reminder',
    name: 'sl_service_due_v1',
    category: 'MARKETING',
    bodyKey: 'reminder.service_due',
    variables: ['vehicle', 'when'],
    customerFacing: true,
    purpose:
      'Service-due reminder. MARKETING because it is business-initiated and unrelated to an open job; it therefore requires explicit marketing consent.',
  },
  {
    key: 'document_reminder',
    name: 'sl_document_reminder_v1',
    category: 'MARKETING',
    bodyKey: 'reminder.document',
    variables: ['vehicle', 'document', 'date', 'shopName'],
    customerFacing: true,
    purpose: 'Insurance or PUC expiry reminder for an enrolled vehicle.',
  },
  {
    key: 'winback',
    name: 'sl_winback_v1',
    category: 'MARKETING',
    bodyKey: 'winback.body',
    variables: ['customerName', 'shopName', 'vehicle', 'months', 'hook'],
    customerFacing: true,
    purpose: 'Win-back for a customer the shop has not seen in a long time.',
  },
  {
    key: 'staff_otp',
    name: 'sl_staff_otp_v1',
    category: 'AUTHENTICATION',
    bodyKey: 'auth.otp.body',
    variables: ['code', 'minutes'],
    customerFacing: false,
    purpose: 'Console sign-in code for a member of shop staff. Never sent to a customer.',
  },
];

export const TEMPLATE_KEYS: readonly string[] = TEMPLATE_MANIFEST.map((spec) => spec.key);

export function templateByKey(key: string): TemplateSpec | undefined {
  return TEMPLATE_MANIFEST.find((spec) => spec.key === key);
}

export function templateByName(name: string): TemplateSpec | undefined {
  return TEMPLATE_MANIFEST.find((spec) => spec.name === name);
}

export interface TemplateLintFinding {
  readonly templateKey: string;
  readonly language: Language | null;
  readonly rule:
    | 'MISSING_CATALOGUE_KEY'
    | 'MISSING_LANGUAGE'
    | 'VARIABLE_MISMATCH'
    | 'UNDECLARED_VARIABLE'
    | 'UNUSED_VARIABLE'
    | 'DUPLICATE_NAME'
    | 'BAD_NAME';
  readonly detail: string;
}

const PLACEHOLDER_RE = /\{(\w+)\}/g;
/** Meta's own constraint on template names: lowercase, digits, underscores. */
const META_NAME_RE = /^[a-z0-9_]{1,512}$/;

function placeholdersOf(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER_RE)].map((match) => match[1] ?? '');
}

/**
 * Lints the manifest against the catalogues.
 *
 * Pure, and returns findings rather than throwing, so the same function backs
 * the CI gate, the console's template-ops screen and a unit test — three
 * consumers that must agree about what "broken" means. A CI step that had its
 * own copy of these rules would drift from the screen an operator looks at, and
 * then the screen would be the one that was wrong.
 */
export function lintTemplates(
  manifest: readonly TemplateSpec[] = TEMPLATE_MANIFEST,
  /**
   * The catalogues to lint against. Overridable so a test can feed it a
   * deliberately broken translation without mutating the shipped one — a lint
   * whose failure paths are only reachable by editing shared global state is a
   * lint whose failure paths are never tested.
   */
  catalogues: Readonly<Record<Language, Partial<Catalogue>>> = CATALOGUES,
): readonly TemplateLintFinding[] {
  const findings: TemplateLintFinding[] = [];
  const seenNames = new Map<string, string>();

  for (const spec of manifest) {
    if (!META_NAME_RE.test(spec.name)) {
      findings.push({
        templateKey: spec.key,
        language: null,
        rule: 'BAD_NAME',
        detail: `"${spec.name}" is not a name the Cloud API accepts (lowercase letters, digits and underscores only)`,
      });
    }

    const previous = seenNames.get(spec.name);
    if (previous !== undefined) {
      findings.push({
        templateKey: spec.key,
        language: null,
        rule: 'DUPLICATE_NAME',
        detail: `template name "${spec.name}" is already used by "${previous}"; Meta keys registrations on (name, language)`,
      });
    }
    seenNames.set(spec.name, spec.key);

    const english = catalogues.en[spec.bodyKey] as string | undefined;
    if (english === undefined) {
      findings.push({
        templateKey: spec.key,
        language: 'en',
        rule: 'MISSING_CATALOGUE_KEY',
        detail: `catalogue key "${spec.bodyKey}" does not exist`,
      });
      continue;
    }

    const declared = new Set(spec.variables);
    const englishPlaceholders = placeholdersOf(english);

    for (const placeholder of englishPlaceholders) {
      if (!declared.has(placeholder)) {
        findings.push({
          templateKey: spec.key,
          language: 'en',
          rule: 'UNDECLARED_VARIABLE',
          detail: `the copy uses {${placeholder}} but the manifest does not declare it, so the submitted template would have too few variables`,
        });
      }
    }
    for (const variable of spec.variables) {
      if (!englishPlaceholders.includes(variable)) {
        findings.push({
          templateKey: spec.key,
          language: 'en',
          rule: 'UNUSED_VARIABLE',
          detail: `the manifest declares {${variable}} but the copy never uses it, so Meta would reject the submission for an unused parameter`,
        });
      }
    }

    // Only customer-facing templates owe every language. See `customerFacing`.
    const required: readonly Language[] = spec.customerFacing ? LANGUAGES : ['en'];
    for (const language of required) {
      const translated = catalogues[language][spec.bodyKey] as string | undefined;
      if (translated === undefined || translated.trim() === '') {
        findings.push({
          templateKey: spec.key,
          language,
          rule: 'MISSING_LANGUAGE',
          detail: `no ${language} copy for "${spec.bodyKey}"; a customer who has chosen ${language} would receive English`,
        });
        continue;
      }

      const mine = new Set(placeholdersOf(translated));
      const theirs = new Set(englishPlaceholders);
      const missing = [...theirs].filter((name) => !mine.has(name));
      const extra = [...mine].filter((name) => !theirs.has(name));

      if (missing.length > 0 || extra.length > 0) {
        findings.push({
          templateKey: spec.key,
          language,
          rule: 'VARIABLE_MISMATCH',
          detail: [
            missing.length > 0 ? `missing {${missing.join('}, {')}}` : '',
            extra.length > 0 ? `unexpected {${extra.join('}, {')}}` : '',
          ]
            .filter((part) => part !== '')
            .join('; '),
        });
      }
    }
  }

  return findings;
}

export function formatLintFindings(findings: readonly TemplateLintFinding[]): string {
  return findings
    .map(
      (finding) =>
        `  ${finding.rule}  ${finding.templateKey}${finding.language === null ? '' : ` [${finding.language}]`}: ${finding.detail}`,
    )
    .join('\n');
}

/**
 * Which manifest templates a shop can actually fall back to over SMS.
 *
 * Reported rather than enforced at send time only, because the two failures are
 * different: a *missing* DLT id is a rung that will not fire (the gate raises
 * an advisor task instead, which is safe), and an operator finds out about it
 * from this report during onboarding rather than during an outage.
 */
export function smsCoverage(dltTemplateIds: Readonly<Record<string, string>>): {
  readonly covered: readonly string[];
  readonly missing: readonly string[];
} {
  const customerFacing = TEMPLATE_MANIFEST.filter((spec) => spec.customerFacing);
  const covered: string[] = [];
  const missing: string[] = [];
  for (const spec of customerFacing) {
    const id = dltTemplateIds[spec.key];
    if (id === undefined || id.trim() === '') missing.push(spec.key);
    else covered.push(spec.key);
  }
  return { covered, missing };
}
