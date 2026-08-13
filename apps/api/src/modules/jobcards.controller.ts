import { Controller, Get, Inject, Param, Post } from '@nestjs/common';
import type { JobCardRepository, Tx } from '@serviceloop/db';
import type { JobCardTransitionService } from '@serviceloop/domain';
import {
  type BoardResponse,
  type JobCardDetail,
  NotFoundError,
  type TransitionRequest,
  TransitionRequestSchema,
  type TransitionResponse,
} from '@serviceloop/shared';
import { z } from 'zod';
import { CurrentStaff, type AuthenticatedStaff } from '../auth/auth.types';
import { currentTraceId } from '../common/request-context';
import { ZodBody } from '../common/zod';
import { JOB_CARD_REPOSITORY, JOB_CARD_TRANSITION_SERVICE } from '../infra/tokens';

/**
 * Job cards.
 *
 * Every read and write is scoped to `staff.shopId`, which comes from the access
 * token and never from the request. A card belonging to another shop is not
 * found — 404, not 403, so the endpoint cannot be used to discover that a card
 * id exists elsewhere.
 */
@Controller('jobcards')
export class JobCardsController {
  constructor(
    @Inject(JOB_CARD_REPOSITORY) private readonly repository: JobCardRepository,
    @Inject(JOB_CARD_TRANSITION_SERVICE)
    private readonly transitions: JobCardTransitionService<Tx>,
  ) {}

  @Get('board')
  async board(@CurrentStaff() staff: AuthenticatedStaff): Promise<BoardResponse> {
    return this.repository.board(staff.shopId);
  }

  @Get(':id')
  async detail(
    @CurrentStaff() staff: AuthenticatedStaff,
    @Param('id') id: string,
  ): Promise<JobCardDetail> {
    const parsed = z.string().uuid().safeParse(id);
    if (!parsed.success) throw new NotFoundError('JobCard', id);

    const detail = await this.repository.findDetail(staff.shopId, parsed.data);
    if (detail === null) throw new NotFoundError('JobCard', parsed.data);
    return detail;
  }

  /**
   * The only way the board changes state. Deliberately a command endpoint, not
   * a PATCH of `state`: the console cannot drag a card into a new state.
   */
  @Post(':id/transitions')
  async transition(
    @CurrentStaff() staff: AuthenticatedStaff,
    @Param('id') id: string,
    @ZodBody(TransitionRequestSchema) body: TransitionRequest,
  ): Promise<TransitionResponse> {
    const parsed = z.string().uuid().safeParse(id);
    if (!parsed.success) throw new NotFoundError('JobCard', id);

    const result = await this.transitions.transition({
      shopId: staff.shopId,
      jobCardId: parsed.data,
      event: body.event,
      actor: { type: 'STAFF', id: staff.staffId, displayName: staff.fullName },
      traceId: currentTraceId(),
      ...(body.meta === undefined ? {} : { meta: body.meta }),
    });

    return {
      jobCardId: result.jobCardId,
      from: result.from,
      to: result.to,
      auditEventId: result.auditEventId,
    };
  }
}
