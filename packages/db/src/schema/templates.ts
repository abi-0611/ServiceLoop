import { index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, primaryId, timestamptz, updatedAt } from './columns';
import { shops } from './core';
import { languageEnum, templateApprovalStatusEnum } from './enums';

/**
 * Per-shop WhatsApp template registration state (phase 7.3).
 *
 * The split between this table and `TEMPLATE_MANIFEST` in `@serviceloop/shared`
 * is the whole design, and it follows from one fact: *the manifest is the same
 * for every shop and the registration is not.*
 *
 * The manifest says a template exists, what it is for, which catalogue key
 * renders it, and which variables it takes. That is a release artefact — CI
 * lints it, a diff shows a reviewer when it changes, and a build cannot use a
 * template that is not in it.
 *
 * This table says what Meta has done about that template *for this shop's
 * WABA*: the id they assigned, whether they approved it, and if they refused,
 * why. None of that is knowable at build time, none of it is the same across
 * two shops, and all of it changes without a deploy — a template approved on
 * Tuesday can be paused on Friday for a quality signal nobody controls. Putting
 * it in code would mean a deploy to record a fact Meta decided, and putting the
 * manifest in the database would mean a shop could start sending a template the
 * lint has never seen.
 *
 * **One row per (shop, template, language).** Meta approves per language
 * variant, not per template: a shop can be live in English and still waiting on
 * Tamil, and that is the single most common real state during onboarding. A
 * table keyed only by template would have to pick one of those to report, and
 * whichever it picked would be wrong for somebody's customer.
 *
 * The absence of a row is meaningful and is not an error: it means
 * `NOT_SUBMITTED`. The ops screen derives that by folding the manifest against
 * whatever rows exist, so a template added to the manifest this morning shows
 * up as unsubmitted for every shop without anyone backfilling anything.
 */
export const templateRegistrations = pgTable(
  'template_registrations',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    /**
     * The manifest key, not the Meta name.
     *
     * Deliberately a plain `text` with no foreign key, because the thing it
     * references is code. A template retired from the manifest leaves its rows
     * behind, and the ops screen reports them as `ORPHANED` — which is the
     * warning an operator needs, since Meta is still holding an approval for a
     * template this build will never send. A cascade delete here would destroy
     * exactly that evidence.
     */
    templateKey: text('template_key').notNull(),
    language: languageEnum('language').notNull(),

    /** Meta's id for the approved template. Null until they assign one. */
    providerTemplateId: text('provider_template_id'),
    status: templateApprovalStatusEnum('status').notNull().default('NOT_SUBMITTED'),
    /**
     * Meta's rejection reason, verbatim.
     *
     * Verbatim matters: their categories are coarse ("INVALID_FORMAT") and the
     * useful detail is in the prose. Paraphrasing it into our own vocabulary
     * would lose the one string an operator can search their support forum for.
     */
    rejectionReason: text('rejection_reason'),

    submittedAt: timestamptz('submitted_at'),
    /** When Meta last told us something. Not when we last looked. */
    reviewedAt: timestamptz('reviewed_at'),

    /**
     * The body text as submitted, with `{{1}}`-style positional placeholders.
     *
     * Kept because a template's content **cannot be edited after approval** —
     * a wording change is a new template and a new approval — so this is the
     * only record of what a shop's approved template actually says once the
     * catalogue moves on. Without it, a catalogue edit silently desynchronises
     * from what Meta will render, and the first symptom is a customer receiving
     * last quarter's wording.
     */
    submittedBody: text('submitted_body'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('template_registrations_shop_key_language_key').on(
      table.shopId,
      table.templateKey,
      table.language,
    ),
    index('template_registrations_shop_status_idx').on(table.shopId, table.status),
  ],
);
