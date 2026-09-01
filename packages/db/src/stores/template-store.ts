import { uuidv7, type Language, type TemplateApprovalStatus } from '@serviceloop/shared';
import { and, eq } from 'drizzle-orm';
import type { Tx } from '../client';
import { templateRegistrations } from '../schema/templates';

export interface TemplateRegistrationRecord {
  readonly id: string;
  readonly shopId: string;
  readonly templateKey: string;
  readonly language: Language;
  readonly providerTemplateId: string | null;
  readonly status: TemplateApprovalStatus;
  readonly rejectionReason: string | null;
  readonly submittedAt: Date | null;
  readonly reviewedAt: Date | null;
  readonly submittedBody: string | null;
  readonly updatedAt: Date;
}

/**
 * Per-shop template registration state (phase 7.3).
 *
 * All SQL, no policy. What counts as *covered*, what an orphan is, and which
 * languages a customer-facing template must exist in are decided by
 * `lintTemplates` and the ops service, which fold this table against the
 * manifest. This only reads and writes rows.
 *
 * There is no `delete`. A registration that no longer corresponds to a manifest
 * entry is the evidence that Meta still holds an approval for something this
 * build will never send, and deleting it would remove the only place that fact
 * is visible. Retiring one is `markStatus(..., 'DISABLED')`, which says what
 * actually happened.
 */
export class PgTemplateRegistrationStore {
  async listForShop(tx: Tx, shopId: string): Promise<readonly TemplateRegistrationRecord[]> {
    const rows = await tx
      .select()
      .from(templateRegistrations)
      .where(eq(templateRegistrations.shopId, shopId));
    return rows.map(toRecord);
  }

  async find(
    tx: Tx,
    shopId: string,
    templateKey: string,
    language: Language,
  ): Promise<TemplateRegistrationRecord | null> {
    const [row] = await tx
      .select()
      .from(templateRegistrations)
      .where(
        and(
          eq(templateRegistrations.shopId, shopId),
          eq(templateRegistrations.templateKey, templateKey),
          eq(templateRegistrations.language, language),
        ),
      )
      .limit(1);
    return row === undefined ? null : toRecord(row);
  }

  /**
   * Records what we know about one (shop, template, language).
   *
   * An upsert rather than an insert-or-update pair, because the two writers
   * race by construction: an operator pressing "record submission" on the ops
   * screen and a status poll from Meta's API can land in the same second, and
   * a read-then-write would lose one of them.
   *
   * `rejectionReason` is cleared on any status that is not `REJECTED`. A
   * resubmitted template that still displayed last month's refusal beside a
   * `PENDING` badge would be read as "rejected again" by every operator who saw
   * it, and the screen exists to be read quickly.
   */
  async upsert(
    tx: Tx,
    input: {
      readonly shopId: string;
      readonly templateKey: string;
      readonly language: Language;
      readonly status: TemplateApprovalStatus;
      readonly providerTemplateId?: string | null;
      readonly rejectionReason?: string | null;
      readonly submittedAt?: Date | null;
      readonly reviewedAt?: Date | null;
      readonly submittedBody?: string | null;
    },
  ): Promise<TemplateRegistrationRecord> {
    const rejection = input.status === 'REJECTED' ? (input.rejectionReason ?? null) : null;

    const values = {
      status: input.status,
      rejectionReason: rejection,
      ...(input.providerTemplateId === undefined
        ? {}
        : { providerTemplateId: input.providerTemplateId }),
      ...(input.submittedAt === undefined ? {} : { submittedAt: input.submittedAt }),
      ...(input.reviewedAt === undefined ? {} : { reviewedAt: input.reviewedAt }),
      ...(input.submittedBody === undefined ? {} : { submittedBody: input.submittedBody }),
    };

    const [row] = await tx
      .insert(templateRegistrations)
      .values({
        id: uuidv7(),
        shopId: input.shopId,
        templateKey: input.templateKey,
        language: input.language,
        ...values,
      })
      .onConflictDoUpdate({
        target: [
          templateRegistrations.shopId,
          templateRegistrations.templateKey,
          templateRegistrations.language,
        ],
        set: { ...values, updatedAt: new Date() },
      })
      .returning();

    if (row === undefined) throw new Error('Failed to record the template registration');
    return toRecord(row);
  }
}

function toRecord(row: typeof templateRegistrations.$inferSelect): TemplateRegistrationRecord {
  return {
    id: row.id,
    shopId: row.shopId,
    templateKey: row.templateKey,
    language: row.language,
    providerTemplateId: row.providerTemplateId,
    status: row.status,
    rejectionReason: row.rejectionReason,
    submittedAt: row.submittedAt,
    reviewedAt: row.reviewedAt,
    submittedBody: row.submittedBody,
    updatedAt: row.updatedAt,
  };
}
