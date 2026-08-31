import type { LoopRuntime } from '@serviceloop/agent-core';
import type { Tx } from '@serviceloop/db';
import type { JobCardState } from '@serviceloop/shared';
import type { EventHandler, HandlerContext } from './registry';

/**
 * Proactive status comms (phase 4.4).
 *
 * Two handlers, both consuming facts the domain already committed:
 *
 *   - `eta.changed` → tell the customer, when the change is worth telling them
 *     about. The materiality verdict travels on the event rather than being
 *     re-derived here, so there is exactly one definition of "worth
 *     interrupting someone for".
 *   - `job_card.state_changed` → the handful of transitions a customer can act
 *     on, plus the one that opens the end of the loop.
 *
 * Both run inside the consumer's transaction next to the idempotency claim, so
 * "we told them" and "we have seen this event" commit together. A redelivered
 * event finds its claim already taken and sends nothing.
 */

export function createEtaCommsHandler(loop: LoopRuntime<Tx>): EventHandler {
  return {
    name: 'eta-comms',
    handles: ['eta.changed'],
    async handle(context: HandlerContext): Promise<Record<string, unknown>> {
      const { envelope } = context;
      if (envelope.type !== 'eta.changed') return { skipped: 'wrong type' };

      const entry = await loop.eta.latest(envelope.shopId, envelope.payload.jobCardId);

      // The event carries the version; the row carries everything else. If the
      // card has already moved past this version, a newer entry has superseded
      // it and announcing the stale one would tell a customer a time that is
      // no longer true.
      if (entry === null || entry.version !== envelope.payload.version) {
        return {
          announced: false,
          reason: 'superseded by a newer ETA before this event was consumed',
          eventVersion: envelope.payload.version,
          currentVersion: entry?.version ?? null,
        };
      }

      const result = await loop.comms.announceEtaChange({
        shopId: envelope.shopId,
        entry,
        actor: { type: 'SYSTEM', id: null },
        traceId: envelope.traceId,
      });

      return {
        announced: result.sent,
        status: result.status,
        messageId: result.messageId,
        reason: result.reason,
        materiality: entry.materiality,
      };
    },
  };
}

/**
 * States that open the end of the loop.
 *
 * `READY_FOR_DELIVERY` is the one that does real work: it sends the ready
 * message with pickup slots (4.7). The others are announcements.
 */
const READY = 'READY_FOR_DELIVERY' satisfies JobCardState;

export function createStateCommsHandler(loop: LoopRuntime<Tx>): EventHandler {
  return {
    name: 'state-comms',
    handles: ['job_card.state_changed'],
    async handle(context: HandlerContext): Promise<Record<string, unknown>> {
      const { envelope } = context;
      if (envelope.type !== 'job_card.state_changed') return { skipped: 'wrong type' };

      const { jobCardId, to } = envelope.payload;
      const actor = { type: 'SYSTEM' as const, id: null };

      if (to === READY) {
        // The ready alert *is* the slot offer: one message that says what was
        // done, what is owed, and when they may come. `announceReady` refuses a
        // second offer for the same card, so a redelivered event that somehow
        // escapes the idempotency claim still cannot double-book.
        const result = await loop.delivery.announceReady({
          shopId: envelope.shopId,
          jobCardId,
          actor,
          traceId: envelope.traceId,
        });

        return result.ok
          ? {
              announced: true,
              bookingId: result.bookingId,
              gateStatus: result.gateStatus,
              slots: result.offeredSlots.length,
              amountDuePaise: result.amountDuePaise,
            }
          : { announced: false, code: result.code, reason: result.reason };
      }

      const result = await loop.comms.announceStateChange({
        shopId: envelope.shopId,
        jobCardId,
        to,
        actor,
        traceId: envelope.traceId,
      });

      return {
        announced: result.sent,
        status: result.status,
        messageId: result.messageId,
        reason: result.reason,
      };
    },
  };
}

/**
 * The phase-3 hook, finally consumed (phase 4.3).
 *
 * `approval.decided` emits `eta.requested` because the approval flow knew the
 * ETA had to move and had no engine to move it. This is that engine.
 */
export function createEtaRequestHandler(loop: LoopRuntime<Tx>): EventHandler {
  return {
    name: 'eta-recalculate',
    handles: ['eta.requested'],
    async handle(context: HandlerContext): Promise<Record<string, unknown>> {
      const { envelope } = context;
      if (envelope.type !== 'eta.requested') return { skipped: 'wrong type' };

      const reason =
        envelope.payload.reason === 'PARTS_AWAITED' ? 'BLOCKED_PARTS' : 'WORK_APPROVED';

      const result = await loop.eta.recalculate({
        shopId: envelope.shopId,
        jobCardId: envelope.payload.jobCardId,
        reason,
        actor: { type: 'SYSTEM', id: null },
        traceId: envelope.traceId,
      });

      return result.ok
        ? {
            recalculated: true,
            version: result.entry.version,
            eta: result.entry.eta.toISOString(),
            materiality: result.entry.materiality,
            unchanged: result.unchanged,
          }
        : { recalculated: false, code: result.code, reason: result.reason };
    },
  };
}
