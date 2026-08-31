import type { AgentRuntime } from '@serviceloop/agent-core';
import type { Tx } from '@serviceloop/db';
import {
  AdvisorTaskListSchema,
  GraduationReportSchema,
  ReviewDecisionRequestSchema,
  ReviewDecisionResponseSchema,
  ReviewQueueSchema,
  type AdvisorTaskList,
  type GraduationReportDto,
  type ReviewDecisionResponse,
  type ReviewQueue,
} from '@serviceloop/shared';
import { BadRequestException, Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentStaff, Roles, type AuthenticatedStaff } from '../auth/auth.types';
import { currentTraceId } from '../common/request-context';
import { ZodBody, ZodParam, ZodQuery } from '../common/zod';
import { AGENT_RUNTIME } from '../infra/tokens';

/**
 * The HITL review queue (phase 3.9).
 *
 * Every shop starts at L0 SHADOW and stays there until an owner decides
 * otherwise, so this is the surface the product runs on in its first weeks: an
 * advisor sees what the agent wanted to say, why the checker held it, and has
 * three actions.
 *
 * Both roles that speak to customers may review — an advisor is exactly who
 * this is for — but only an OWNER sees the graduation report, because raising
 * autonomy is an owner's decision (master §6).
 */

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const UUID = z.string().uuid();

const GraduationQuery = z.object({
  objective: z
    .enum(['request_approval', 'resolve_partial_approval', 'explain_evidence'])
    .default('request_approval'),
  flow: z.enum(['approval', 'status', 'delivery', 'retention', 'voice']).default('approval'),
});

@Controller('review')
export class ReviewController {
  constructor(@Inject(AGENT_RUNTIME) private readonly agent: AgentRuntime<Tx>) {}

  @Get('queue')
  @Roles('OWNER', 'ADVISOR')
  async queue(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodQuery(ListQuery) query: z.infer<typeof ListQuery>,
  ): Promise<ReviewQueue> {
    const pending = await this.agent.reviews.pending(staff.shopId, query.limit);
    // Parsed on the way out, with the same schema the console parses on the way
    // in: a drift between the two becomes a test failure here rather than a
    // blank panel in a workshop.
    return ReviewQueueSchema.parse({
      candidates: pending.map((candidate) => ({
        messageId: candidate.messageId,
        conversationId: candidate.conversationId,
        customerLabel: candidate.customerLabel,
        jobCardId: candidate.jobCardId,
        agentRunId: candidate.agentRunId,
        body: candidate.body,
        language: candidate.language,
        checkerReasons: candidate.checkerReasons,
        evidenceRefs: candidate.evidenceRefs,
        createdAt: candidate.createdAt.toISOString(),
        waitedMs: Date.now() - candidate.createdAt.getTime(),
      })),
    });
  }

  @Post(':messageId/decide')
  @Roles('OWNER', 'ADVISOR')
  async decide(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodParam('messageId', UUID) messageId: string,
    @ZodBody(ReviewDecisionRequestSchema) body: z.infer<typeof ReviewDecisionRequestSchema>,
  ): Promise<ReviewDecisionResponse> {
    const outcome = await this.agent.reviews.decide({
      shopId: staff.shopId,
      messageId,
      action: body.action,
      reviewerStaffId: staff.staffId,
      ...(body.body === undefined ? {} : { editedBody: body.body }),
      ...(body.reason === undefined ? {} : { rejectionReason: body.reason }),
      traceId: currentTraceId(),
    });

    if (!outcome.ok) {
      // A 400 rather than a 404 even for NOT_PENDING: the message exists, it is
      // just no longer waiting — usually because another advisor got there
      // first, which is a thing to say plainly rather than a missing resource.
      throw new BadRequestException({ code: outcome.code, detail: outcome.reason });
    }

    if (outcome.action === 'REJECTED') {
      return ReviewDecisionResponseSchema.parse({ action: 'REJECTED' });
    }

    return ReviewDecisionResponseSchema.parse({
      action: 'SENT',
      edited: outcome.edited,
      status: outcome.gate.status,
      messageId: outcome.gate.messageId,
    });
  }

  /**
   * The graduation report.
   *
   * OWNER only: the system recommends and the owner decides (master §6), and
   * showing an advisor a recommendation they cannot act on would only invite
   * them to ask for it.
   */
  @Get('graduation')
  @Roles('OWNER')
  async graduation(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodQuery(GraduationQuery) query: z.infer<typeof GraduationQuery>,
  ): Promise<GraduationReportDto> {
    const report = await this.agent.reviews.graduationReport({
      shopId: staff.shopId,
      objective: query.objective,
      flow: query.flow,
    });
    return GraduationReportSchema.parse(report);
  }

  @Get('tasks')
  @Roles('OWNER', 'ADVISOR')
  async tasks(@CurrentStaff() staff: AuthenticatedStaff): Promise<AdvisorTaskList> {
    const open = await this.agent.tasks.list(staff.shopId, 'OPEN', 50);
    return AdvisorTaskListSchema.parse({
      tasks: open.map((task) => ({
        id: task.id,
        kind: task.kind,
        urgency: task.urgency,
        brief: task.brief,
        jobCardId: task.jobCardId,
        conversationId: task.conversationId,
        createdAt: task.createdAt.toISOString(),
      })),
    });
  }

  @Post('tasks/:taskId/resolve')
  @Roles('OWNER', 'ADVISOR')
  async resolveTask(
    @CurrentStaff() staff: AuthenticatedStaff,
    @Param('taskId') taskId: string,
    @Body() body: { note?: string },
  ) {
    await this.agent.tasks.resolve({
      shopId: staff.shopId,
      taskId,
      status: 'DONE',
      staffId: staff.staffId,
      note: body.note ?? '',
      traceId: currentTraceId(),
    });
    return { resolved: true };
  }
}
