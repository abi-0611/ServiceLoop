import { Controller, Get, Inject, Post } from '@nestjs/common';
import { type IntakeRepository, type Tx } from '@serviceloop/db';
import type { IntakePipeline, IntakeService } from '@serviceloop/domain';
import {
  type ConfirmDraftResponse,
  type CorrectDraftRequest,
  CorrectDraftRequestSchema,
  type IntakeDraftDetail,
  type IntakeDraftList,
  type JobCardDraft,
  JobCardDraftSchema,
  type NewJobCardRequest,
  NewJobCardRequestSchema,
  NotFoundError,
  ValidationError,
} from '@serviceloop/shared';
import { z } from 'zod';
import { CurrentStaff, type AuthenticatedStaff } from '../auth/auth.types';
import { currentTraceId } from '../common/request-context';
import { ZodBody, ZodParam, ZodQuery } from '../common/zod';
import { INTAKE_PIPELINE, INTAKE_REPOSITORY, INTAKE_SERVICE } from '../infra/tokens';

/**
 * Zero-migration intake, from the console (phase 2.6/2.8).
 *
 * The same `IntakeService` the WhatsApp path uses. That is the point of the
 * design: an advisor correcting a field on this screen and a technician typing
 * `3 = TN 09 BX 4432` into WhatsApp take exactly the same code path, so the
 * audit trail cannot say two different things about how a card was made.
 */
const UUID = z.string().uuid();

const ListQuerySchema = z.object({
  status: z.enum(['AWAITING_CONFIRMATION', 'CONFIRMED', 'DISCARDED']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

@Controller('intake')
export class IntakeController {
  constructor(
    @Inject(INTAKE_REPOSITORY) private readonly repository: IntakeRepository,
    @Inject(INTAKE_SERVICE) private readonly intake: IntakeService<Tx>,
    @Inject(INTAKE_PIPELINE) private readonly pipeline: IntakePipeline<Tx>,
  ) {}

  @Get('drafts')
  async list(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodQuery(ListQuerySchema) query: z.infer<typeof ListQuerySchema>,
  ): Promise<IntakeDraftList> {
    return this.repository.list(staff.shopId, {
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
  }

  @Get('drafts/:id')
  async detail(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodParam('id', UUID) id: string,
  ): Promise<IntakeDraftDetail> {
    const detail = await this.repository.detail(staff.shopId, id);
    if (detail === null) throw new NotFoundError('JobCardDraft', id);
    return detail;
  }

  @Post('drafts/:id/corrections')
  async correct(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodParam('id', UUID) id: string,
    @ZodBody(CorrectDraftRequestSchema) body: CorrectDraftRequest,
  ): Promise<IntakeDraftDetail> {
    await this.intake.correct({
      shopId: staff.shopId,
      draftId: id,
      path: body.path,
      value: body.value,
      actor: { type: 'STAFF', id: staff.staffId, displayName: staff.fullName },
      traceId: currentTraceId(),
    });

    const detail = await this.repository.detail(staff.shopId, id);
    if (detail === null) throw new NotFoundError('JobCardDraft', id);
    return detail;
  }

  @Post('drafts/:id/confirm')
  async confirm(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodParam('id', UUID) id: string,
  ): Promise<ConfirmDraftResponse> {
    const result = await this.intake.confirm({
      shopId: staff.shopId,
      draftId: id,
      actor: { type: 'STAFF', id: staff.staffId, displayName: staff.fullName },
      traceId: currentTraceId(),
      assignedAdvisorId: staff.staffId,
    });

    return {
      draftId: result.draftId,
      jobCardId: result.jobCardId,
      code: result.code,
      customerId: result.customerId,
      vehicleId: result.vehicleId,
      workItemCount: result.workItemIds.length,
      correctedFields: [...result.correctedFields],
      mergeSuggestions: result.suggestions.length,
      openFailure: result.openFailure,
    };
  }

  @Post('drafts/:id/discard')
  async discard(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodParam('id', UUID) id: string,
  ): Promise<{ discarded: true }> {
    await this.intake.discard({
      shopId: staff.shopId,
      draftId: id,
      actor: { type: 'STAFF', id: staff.staffId, displayName: staff.fullName },
      traceId: currentTraceId(),
    });
    return { discarded: true };
  }

  /**
   * The minimal digital job card (phase 2.8).
   *
   * Never the pitch, always available: a shop with no paper still needs a way
   * in. It produces the same `JobCardDraft` the photo path does and confirms it
   * through the same service, so entity resolution, the audit chain and the
   * outbox all behave identically — the only difference is that every field
   * arrives at confidence 1, because a person typed it.
   */
  @Post('job-cards')
  async create(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodBody(NewJobCardRequestSchema) body: NewJobCardRequest,
  ): Promise<ConfirmDraftResponse | IntakeDraftDetail> {
    const draft = draftFromForm(body);
    const traceId = currentTraceId();
    const actor = { type: 'STAFF' as const, id: staff.staffId, displayName: staff.fullName };

    const recorded = await this.intake.recordDraft({
      shopId: staff.shopId,
      source: 'CONSOLE_FORM',
      draft,
      submittedByStaffId: staff.staffId,
      extractorModel: 'console-form',
      actor,
      traceId,
    });

    if (!body.confirmImmediately) {
      const detail = await this.repository.detail(staff.shopId, recorded.draftId);
      if (detail === null) throw new NotFoundError('JobCardDraft', recorded.draftId);
      return detail;
    }

    const result = await this.intake.confirm({
      shopId: staff.shopId,
      draftId: recorded.draftId,
      actor,
      traceId,
      assignedAdvisorId: staff.staffId,
    });

    return {
      draftId: result.draftId,
      jobCardId: result.jobCardId,
      code: result.code,
      customerId: result.customerId,
      vehicleId: result.vehicleId,
      workItemCount: result.workItemIds.length,
      correctedFields: [...result.correctedFields],
      mergeSuggestions: result.suggestions.length,
      openFailure: result.openFailure,
    };
  }

  /** Re-renders a draft's WhatsApp summary — what the console preview shows. */
  @Get('drafts/:id/summary')
  async summary(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodParam('id', UUID) id: string,
  ): Promise<{ body: string; uncertainCount: number }> {
    const summary = await this.pipeline.summarise(staff.shopId, id, 'en');
    if (summary === null) throw new NotFoundError('JobCardDraft', id);
    return {
      body: summary.summary.body,
      uncertainCount: summary.summary.uncertainCount,
    };
  }
}

/**
 * A typed form becomes a `JobCardDraft` with every field at confidence 1.
 *
 * That is not a shortcut around the confirmation flow — it is the honest
 * confidence. A human looked at the vehicle and typed its number; there is no
 * higher-quality signal available anywhere in the system, and marking it lower
 * would put ⚠ against a field nobody needs to check.
 */
function draftFromForm(body: NewJobCardRequest): JobCardDraft {
  const certain = <T>(value: T) => ({ value, confidence: 1, region: null });

  const parsed = JobCardDraftSchema.safeParse({
    customer: { name: certain(body.customerName), phone: certain(body.phone) },
    vehicle: {
      registration: certain(body.registration),
      make: certain(body.make ?? null),
      model: certain(body.model ?? null),
      odometerKm: certain(body.odometerKm ?? null),
    },
    complaints: body.complaints.map((complaint) => certain(complaint)),
    estimateLines: body.estimateLines.map((line) => ({
      description: certain(line.description),
      quantityMilli: certain(Math.round(line.quantity * 1000)),
      unitPricePaise: certain(
        line.unitPriceRupees === undefined ? null : Math.round(line.unitPriceRupees * 100),
      ),
    })),
    advisorName: certain(null),
    promisedAt: certain(body.promisedAt ?? null),
    language: body.language,
    notes: '',
  });

  if (!parsed.success) {
    throw new ValidationError('The job card form does not produce a valid draft', {
      fieldErrors: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
        code: issue.code,
      })),
    });
  }

  return parsed.data;
}
