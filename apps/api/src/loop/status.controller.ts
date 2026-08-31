import { Controller, Get, Inject, Post } from '@nestjs/common';
import type { LoopRuntime } from '@serviceloop/agent-core';
import type { Tx } from '@serviceloop/db';
import { z } from 'zod';
import { CurrentStaff, Roles, type AuthenticatedStaff } from '../auth/auth.types';
import { currentTraceId } from '../common/request-context';
import { ZodBody, ZodQuery } from '../common/zod';
import { LOOP_RUNTIME } from '../infra/tokens';

/**
 * The status sentinel's console surface (phase 4.2 / 4.3).
 *
 * Two reads and two writes. The reads are what an advisor opens when a
 * customer rings: the card's ETA history, and the signals the parser was not
 * sure enough about to apply on its own. The writes are the one tap that
 * resolves them.
 *
 * `confirm` and `discard` are deliberately separate verbs rather than one
 * endpoint with a boolean. They mean different things to the graduation
 * question — "how often was the parser right?" — and collapsing them would
 * make that unanswerable.
 */

const PendingQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const HistoryQuery = z.object({
  jobCardId: z.string().uuid(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const ConfirmBody = z.object({
  signalId: z.string().uuid(),
  /**
   * Set only when the advisor is *choosing between* the cards the parser could
   * not decide between. Omitted, the signal applies to the card it matched.
   */
  jobCardId: z.string().uuid().optional(),
});

const DiscardBody = z.object({
  signalId: z.string().uuid(),
});

@Controller('status')
export class StatusController {
  constructor(@Inject(LOOP_RUNTIME) private readonly loop: LoopRuntime<Tx>) {}

  /** Signals waiting on a human, newest first. */
  @Get('signals/pending')
  @Roles('OWNER', 'ADVISOR')
  async pending(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodQuery(PendingQuery) query: z.infer<typeof PendingQuery>,
  ) {
    const { signals, cards } = await this.loop.signals.pendingWithCards(
      staff.shopId,
      query.limit,
    );

    const label = (jobCardId: string) => {
      const card = cards.get(jobCardId);
      return card === undefined
        ? null
        : {
            jobCardId,
            code: card.code,
            registration: card.registration,
            vehicle: card.vehicleLabel,
            state: card.state,
          };
    };

    return {
      signals: signals.map((signal) => ({
        signalId: signal.id,
        jobCardId: signal.jobCardId,
        signalType: signal.signalType,
        route: signal.route,
        confidence: signal.confidence,
        transcript: signal.transcript,
        language: signal.language,
        transcriptConfidence: signal.transcriptConfidence,
        workItemIds: signal.workItemIds,
        candidateJobCardIds: signal.candidateJobCardIds,
        etaHint: signal.etaHint?.toISOString() ?? null,
        matchBasis: signal.matchBasis,
        createdAt: signal.createdAt.toISOString(),
        // The vehicle, named. An advisor answers "did he mean TN09BX4432?",
        // never "did he mean 0193f2c1-…?".
        card: signal.jobCardId === null ? null : label(signal.jobCardId),
        candidates: signal.candidateJobCardIds
          .map(label)
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null),
      })),
    };
  }

  /**
   * The card's ETA history — every time the answer changed, and why.
   *
   * The whole history rather than the current value, because the question an
   * advisor is actually answering is "you said four o'clock", and only the
   * history contains the four o'clock.
   */
  @Get('eta')
  @Roles('OWNER', 'ADVISOR')
  async etaHistory(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodQuery(HistoryQuery) query: z.infer<typeof HistoryQuery>,
  ) {
    const history = await this.loop.eta.history(staff.shopId, query.jobCardId, query.limit);

    return {
      jobCardId: query.jobCardId,
      currentEta: history[0]?.eta.toISOString() ?? null,
      promisedAt: history[0]?.promisedAt?.toISOString() ?? null,
      entries: history.map((entry) => ({
        version: entry.version,
        eta: entry.eta.toISOString(),
        previousEta: entry.previousEta?.toISOString() ?? null,
        reason: entry.reason,
        materiality: entry.materiality,
        deltaMinutes: entry.deltaMinutes,
        detail: entry.detail,
        customerWasTold: entry.notifiedAt !== null,
        changedAt: entry.createdAt.toISOString(),
      })),
    };
  }

  @Post('signals/confirm')
  @Roles('OWNER', 'ADVISOR')
  async confirm(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodBody(ConfirmBody) body: z.infer<typeof ConfirmBody>,
  ) {
    const outcome = await this.loop.signals.confirm({
      shopId: staff.shopId,
      signalId: body.signalId,
      staffId: staff.staffId,
      ...(body.jobCardId === undefined ? {} : { jobCardId: body.jobCardId }),
      actor: { type: 'STAFF', id: staff.staffId },
      traceId: currentTraceId(),
    });

    return {
      signalId: outcome.signalId,
      route: outcome.route,
      jobCardId: outcome.jobCardId,
      workItemIds: outcome.workItemIds,
      detail: outcome.detail,
      alreadyActioned: outcome.duplicate,
    };
  }

  @Post('signals/discard')
  @Roles('OWNER', 'ADVISOR')
  async discard(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodBody(DiscardBody) body: z.infer<typeof DiscardBody>,
  ) {
    const outcome = await this.loop.signals.discard({
      shopId: staff.shopId,
      signalId: body.signalId,
      staffId: staff.staffId,
      actor: { type: 'STAFF', id: staff.staffId },
      traceId: currentTraceId(),
    });

    return { signalId: outcome.signalId, route: outcome.route, detail: outcome.detail };
  }
}
