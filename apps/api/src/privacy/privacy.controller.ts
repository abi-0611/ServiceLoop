import { Controller, Get, Inject, Post } from '@nestjs/common';
import type { Tx } from '@serviceloop/db';
import type { DataPrincipalService } from '@serviceloop/domain';
import { DataRequestVerificationSchema, ForbiddenError } from '@serviceloop/shared';
import { z } from 'zod';
import { CurrentStaff, Roles, type AuthenticatedStaff } from '../auth/auth.types';
import { currentTraceId } from '../common/request-context';
import { ZodBody, ZodParam, ZodQuery } from '../common/zod';
import { DATA_PRINCIPAL_SERVICE } from './privacy.tokens';

/**
 * The console's DPDP surface (phase 7.2).
 *
 * Every endpoint here is an *act by a member of staff on behalf of a data
 * principal*, which is why none of them is public and why the role split is
 * what it is: an advisor may lodge and verify a request, and only the owner may
 * approve a deletion or execute one. The person who takes the request at the
 * counter and the person who authorises destroying the shop's records should
 * not have to be the same person, and in a shop where they are, the audit still
 * records two acts.
 *
 * The endpoint that is *not* here is a `DELETE /customers/:id`. There is no
 * such thing in this system, deliberately: erasure has one path, it goes
 * through the workflow, and it produces a report.
 */

const RaiseBody = z.object({
  customerId: z.string().uuid(),
  kind: z.enum(['EXPORT', 'DELETION']),
  /** What the customer actually asked for, in their words. */
  detail: z.string().max(2000).optional(),
});

const VerifyBody = z.object({
  verification: DataRequestVerificationSchema,
});

const ApproveBody = z.object({
  /**
   * Waives the grace window. Requires a reason, which is audited.
   *
   * Deliberately awkward rather than absent: a customer standing at the counter
   * who wants it done before they leave is a real case, and refusing it outright
   * would get the shop's grace window set to zero for every request instead of
   * for the one that needed it.
   */
  skipGraceReason: z.string().min(10).max(500).optional(),
});

const ReasonBody = z.object({ reason: z.string().min(3).max(500) });

const ListQuery = z.object({
  status: z
    .enum([
      'RECEIVED',
      'VERIFIED',
      'APPROVED',
      'SCHEDULED',
      'RUNNING',
      'COMPLETED',
      'REJECTED',
      'CANCELLED',
      'FAILED',
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

@Controller('privacy/requests')
export class PrivacyController {
  constructor(
    @Inject(DATA_PRINCIPAL_SERVICE) private readonly service: DataPrincipalService<Tx>,
  ) {}

  @Get()
  @Roles('OWNER', 'ADVISOR')
  async list(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodQuery(ListQuery) query: z.infer<typeof ListQuery>,
  ) {
    const requests = await this.service.list(staff.shopId, {
      ...(query.status === undefined ? {} : { status: query.status }),
      limit: query.limit,
    });
    return { requests: requests.map(toDto) };
  }

  @Get(':requestId')
  @Roles('OWNER', 'ADVISOR')
  async detail(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodParam('requestId', z.string().uuid()) requestId: string,
  ) {
    const record = await this.service.get(staff.shopId, requestId);
    return { request: toDto(record), report: record.report };
  }

  @Post()
  @Roles('OWNER', 'ADVISOR')
  async raise(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodBody(RaiseBody) body: z.infer<typeof RaiseBody>,
  ) {
    const record = await this.service.raise({
      shopId: staff.shopId,
      customerId: body.customerId,
      kind: body.kind,
      detail: body.detail ?? null,
      actor: { type: 'STAFF', id: staff.staffId },
      requestedByStaffId: staff.staffId,
      traceId: currentTraceId(),
    });
    return { request: toDto(record) };
  }

  @Post(':requestId/verify')
  @Roles('OWNER', 'ADVISOR')
  async verify(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodParam('requestId', z.string().uuid()) requestId: string,
    @ZodBody(VerifyBody) body: z.infer<typeof VerifyBody>,
  ) {
    const record = await this.service.verify({
      shopId: staff.shopId,
      requestId,
      verification: body.verification,
      actor: { type: 'STAFF', id: staff.staffId },
      traceId: currentTraceId(),
    });
    return { request: toDto(record) };
  }

  /**
   * Authorises the cascade. **Owner only.**
   *
   * Not because an advisor is untrusted, but because this is the point of no
   * return and the shop should have exactly one person who can reach it. The
   * RBAC matrix asserts this endpoint is owner-only, so loosening it is a diff
   * a reviewer sees.
   */
  @Post(':requestId/approve')
  @Roles('OWNER')
  async approve(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodParam('requestId', z.string().uuid()) requestId: string,
    @ZodBody(ApproveBody) body: z.infer<typeof ApproveBody>,
  ) {
    const record = await this.service.approve({
      shopId: staff.shopId,
      requestId,
      approvedByStaffId: staff.staffId,
      actor: { type: 'STAFF', id: staff.staffId },
      traceId: currentTraceId(),
      ...(body.skipGraceReason === undefined
        ? {}
        : { skipGrace: { reason: body.skipGraceReason } }),
    });
    return { request: toDto(record) };
  }

  /**
   * Runs an approved request now.
   *
   * The worker sentinel does this on its own once the grace window elapses;
   * this endpoint exists for the case where somebody is waiting, and for the
   * demo. It refuses a request still inside its window, so it is not a way
   * round the grace period — waiving that is `approve`'s business, and audited.
   */
  @Post(':requestId/execute')
  @Roles('OWNER')
  async execute(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodParam('requestId', z.string().uuid()) requestId: string,
  ) {
    const report = await this.service.execute({
      shopId: staff.shopId,
      requestId,
      actor: { type: 'STAFF', id: staff.staffId },
      traceId: currentTraceId(),
    });
    return { report };
  }

  @Post(':requestId/cancel')
  @Roles('OWNER', 'ADVISOR')
  async cancel(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodParam('requestId', z.string().uuid()) requestId: string,
    @ZodBody(ReasonBody) body: z.infer<typeof ReasonBody>,
  ) {
    await this.service.cancel({
      shopId: staff.shopId,
      requestId,
      reason: body.reason,
      actor: { type: 'STAFF', id: staff.staffId },
      traceId: currentTraceId(),
    });
    return { cancelled: true };
  }

  @Post(':requestId/reject')
  @Roles('OWNER')
  async reject(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodParam('requestId', z.string().uuid()) requestId: string,
    @ZodBody(ReasonBody) body: z.infer<typeof ReasonBody>,
  ) {
    if (body.reason.trim().length < 10) {
      // A refusal the customer is entitled to be given a reason for. Three
      // characters is not a reason.
      throw new ForbiddenError('A rejection must carry a reason the customer can be told');
    }
    await this.service.reject({
      shopId: staff.shopId,
      requestId,
      reason: body.reason,
      actor: { type: 'STAFF', id: staff.staffId },
      traceId: currentTraceId(),
    });
    return { rejected: true };
  }
}

type Record_ = Awaited<ReturnType<DataPrincipalService<Tx>['get']>>;

/**
 * The console's view of a request.
 *
 * Note what is absent: `customerId` is included (the console needs to link to
 * the customer while one still exists) but the *pseudonym* is what identifies a
 * completed deletion, and after one runs the customer id is null. A console
 * row for a completed erasure therefore names nobody, which is correct — the
 * console is a screen in a workshop, and the erasure is meant to have happened.
 */
function toDto(record: Record_) {
  return {
    id: record.id,
    kind: record.kind,
    status: record.status,
    customerId: record.customerId,
    subjectPseudonym: record.subjectPseudonym,
    detail: record.requestDetail,
    verification: record.verification,
    verifiedAt: record.verifiedAt?.toISOString() ?? null,
    approvedAt: record.approvedAt?.toISOString() ?? null,
    scheduledFor: record.scheduledFor?.toISOString() ?? null,
    completedAt: record.completedAt?.toISOString() ?? null,
    outcomeReason: record.outcomeReason,
    archiveBytes: record.artifactBytes,
    downloadExpiresAt: record.downloadExpiresAt?.toISOString() ?? null,
    downloadedAt: record.downloadedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
  };
}
