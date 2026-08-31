import { APPROVAL_SUBJECT_TYPE, type EscalationLadderEngine } from '@serviceloop/domain';
import type { Tx } from '@serviceloop/db';
import type { Objective } from '@serviceloop/shared';
import type { EventHandler } from './registry';

/**
 * The ladder is scheduled *from* `approval.requested`, not commanded by it.
 *
 * That is the whole reason the outbox exists: the request was written and the
 * event enqueued in one transaction, so a ladder scheduled from the event
 * cannot exist for a request that was rolled back. And because rungs are unique
 * on `(subject_type, subject_id, rung)`, a redelivered event — which the outbox
 * guarantees is possible — schedules nothing rather than doubling the chase.
 *
 * Rung 0 is skipped: the caller that created the request already sent the
 * bundle, and firing rung 0 would send it twice.
 */
export function createApprovalLadderHandler(ladder: EscalationLadderEngine<Tx>): EventHandler {
  return {
    name: 'approval-ladder',
    handles: ['approval.requested', 'approval.decided'],

    async handle({ envelope, logger }) {
      // Narrowed explicitly rather than by an `else`: the handler is registered
      // for two types and the union has twenty-odd members, so "not requested"
      // is not the same statement as "decided".
      if (envelope.type !== 'approval.requested' && envelope.type !== 'approval.decided') {
        return { ignored: envelope.type };
      }

      if (envelope.type === 'approval.requested') {
        const scheduled = await ladder.scheduleLadder({
          shopId: envelope.shopId,
          objective: envelope.payload.ladderRef as Objective,
          subjectType: APPROVAL_SUBJECT_TYPE,
          subjectId: envelope.payload.approvalId,
          openedAt: new Date(envelope.occurredAt),
          actor: envelope.payload.actor,
          traceId: envelope.traceId,
          skipRungs: [0],
        });

        logger.info(
          { approvalId: envelope.payload.approvalId, rungs: scheduled.length },
          'approval ladder scheduled',
        );
        return { scheduled: scheduled.length };
      }

      // A decision cancels the chase. `ApprovalService` already cancels
      // synchronously — a customer who says yes must not receive the next
      // reminder because a queue was busy — so this is the belt to that
      // braces: it makes the cancellation survive a process that died between
      // the decision and the cancel.
      const cancelled = await ladder.cancelForSubject({
        shopId: envelope.shopId,
        subjectType: APPROVAL_SUBJECT_TYPE,
        subjectId: envelope.payload.approvalId,
        reason: `Customer decided (${envelope.payload.decision})`,
        actor: envelope.payload.actor,
        traceId: envelope.traceId,
      });

      logger.info(
        { approvalId: envelope.payload.approvalId, cancelled: cancelled.length },
        'approval ladder cancelled',
      );
      return { cancelled: cancelled.length };
    },
  };
}
