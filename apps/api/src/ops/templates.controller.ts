import { Controller, Get, Inject, Post } from '@nestjs/common';
import { migrateShopConfig } from '@serviceloop/config';
import {
  PgShopConfigStore,
  PgTemplateRegistrationStore,
  type PgUnitOfWork,
} from '@serviceloop/db';
import {
  buildTemplateOpsView,
  formatLintFindings,
  lintTemplates,
  LanguageSchema,
  smsCoverage,
  TemplateApprovalStatusSchema,
} from '@serviceloop/shared';
import { z } from 'zod';
import { CurrentStaff, Roles, type AuthenticatedStaff } from '../auth/auth.types';
import { ZodBody } from '../common/zod';
import { UNIT_OF_WORK } from '../infra/tokens';

/**
 * The template operations screen's data (phase 7.3).
 *
 * Three things an operator needs in one place, because during onboarding they
 * are one question — *can this shop actually talk to its customers?*
 *
 *  1. **The catalog and its submission status**, folded from the manifest
 *     against this shop's registrations. Driven by the manifest, so a template
 *     added in the last deploy appears as `NOT_SUBMITTED` rather than not
 *     appearing at all.
 *  2. **The lint**, which is the same `lintTemplates()` the CI gate runs. It is
 *     served rather than assumed clean because a deploy can only prove the lint
 *     passed *at build time*, and an operator staring at a template that will
 *     not render deserves to be told the reason is in our catalogue and not in
 *     their Business Manager.
 *  3. **SMS coverage**, because the fallback rung is only as good as the DLT
 *     registration behind it, and a missing DLT id is invisible until the day
 *     WhatsApp is down.
 *
 * What this controller deliberately does **not** do is submit templates to
 * Meta. Submission is a Business Manager action with a legal entity behind it,
 * and a button here that appeared to do it would either be a lie or a
 * credential this service should not hold. `recordSubmission` records what a
 * person did over there, which is the honest shape.
 */

const RecordBody = z.object({
  templateKey: z.string().min(1).max(200),
  language: LanguageSchema,
  status: TemplateApprovalStatusSchema,
  providerTemplateId: z.string().min(1).max(200).nullable().optional(),
  rejectionReason: z.string().max(2000).nullable().optional(),
});

@Controller('ops/templates')
export class TemplatesController {
  private readonly registrations = new PgTemplateRegistrationStore();
  private readonly config = new PgShopConfigStore();

  constructor(@Inject(UNIT_OF_WORK) private readonly uow: PgUnitOfWork) {}

  @Get()
  @Roles('OWNER', 'ADVISOR')
  async catalog(@CurrentStaff() staff: AuthenticatedStaff) {
    const { rows, shopConfig } = await this.uow.transaction(async (tx) => {
      const stored = await this.config.load(tx, staff.shopId);
      const timezone = (await this.config.loadShopTimezone(tx, staff.shopId)) ?? 'Asia/Kolkata';
      return {
        rows: await this.registrations.listForShop(tx, staff.shopId),
        shopConfig: migrateShopConfig(stored?.raw ?? {}, timezone).config,
      };
    });

    const view = buildTemplateOpsView(
      rows.map((row) => ({
        templateKey: row.templateKey,
        language: row.language,
        status: row.status,
        providerTemplateId: row.providerTemplateId,
        rejectionReason: row.rejectionReason,
        submittedAt: row.submittedAt,
        reviewedAt: row.reviewedAt,
        submittedBody: row.submittedBody,
      })),
    );

    const findings = lintTemplates();
    const sms = smsCoverage(shopConfig.smsFallback.dltTemplateIds);

    return {
      ...view,
      lint: {
        clean: findings.length === 0,
        findings,
        // The formatted block as well as the structured findings: the screen
        // renders the structure, and an operator pasting a support ticket wants
        // the same text CI printed.
        formatted: findings.length === 0 ? '' : formatLintFindings(findings),
      },
      sms: {
        enabled: shopConfig.smsFallback.enabled,
        senderId: shopConfig.smsFallback.senderId,
        dltEntityId: shopConfig.smsFallback.dltEntityId,
        covered: sms.covered,
        missing: sms.missing,
      },
    };
  }

  /**
   * Records what Meta has said about one template variant.
   *
   * Owner-only, because it is the shop's own compliance record: an advisor
   * marking a template `APPROVED` because they believe it ought to be would
   * turn this screen from a record into an opinion, and the next person to read
   * it would have no way to tell which it was.
   *
   * `submittedBody` is captured from the *current* catalogue at the moment of
   * recording rather than supplied by the caller. Meta will render whatever was
   * submitted for ever — the content of an approved template cannot be edited —
   * so this snapshot is the only later evidence of what the shop's customers
   * actually receive, and a caller-supplied one could disagree with what was
   * really sent.
   */
  @Post('registrations')
  @Roles('OWNER')
  async recordSubmission(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodBody(RecordBody) body: z.infer<typeof RecordBody>,
  ) {
    const now = new Date();
    const spec = buildTemplateOpsView([]).rows.find((row) => row.key === body.templateKey);
    const submissionBody = spec?.languages.find(
      (state) => state.language === body.language,
    )?.submissionBody;

    const record = await this.uow.transaction(async (tx) =>
      this.registrations.upsert(tx, {
        shopId: staff.shopId,
        templateKey: body.templateKey,
        language: body.language,
        status: body.status,
        providerTemplateId: body.providerTemplateId ?? null,
        rejectionReason: body.rejectionReason ?? null,
        // Only the transitions that mean something get a timestamp. Stamping
        // `submittedAt` on a `REJECTED` update would rewrite the submission
        // date to the day of the refusal, and the interval between those two is
        // the number an operator uses to decide whether to chase Meta.
        ...(body.status === 'PENDING' ? { submittedAt: now } : {}),
        ...(body.status === 'PENDING' ? {} : { reviewedAt: now }),
        ...(submissionBody === undefined ? {} : { submittedBody: submissionBody }),
      }),
    );

    return {
      registration: {
        templateKey: record.templateKey,
        language: record.language,
        status: record.status,
        providerTemplateId: record.providerTemplateId,
        rejectionReason: record.rejectionReason,
        submittedAt: record.submittedAt?.toISOString() ?? null,
        reviewedAt: record.reviewedAt?.toISOString() ?? null,
      },
    };
  }
}
