/**
 * The three approval buttons, as channel vocabulary.
 *
 * They live in `messaging` rather than in `agent` for a dependency reason that
 * is worth stating: the agent module imports `OutboundGate` from here, so the
 * inbound handler cannot import the agent without closing a cycle. A button id
 * is not agent logic anyway — it is a string the channel carries back, and
 * whoever reads inbound messages has to recognise it.
 *
 * `agent/approval-service` re-exports these so a caller reaching for the
 * approval flow finds them in the obvious place.
 */

export const APPROVAL_ACTION_IDS = {
  approve: 'approval:approve',
  partial: 'approval:partial',
  call: 'approval:call',
} as const;

export type ApprovalAction = 'APPROVE' | 'PARTIAL' | 'CALL';

/**
 * A reply id → the action it means, or null.
 *
 * Exact match only. A prefix match would let `approval:approve_everything` —
 * an id nobody sent — be read as consent to spend a customer's money.
 */
export function parseApprovalAction(replyId: string | null): ApprovalAction | null {
  switch (replyId) {
    case APPROVAL_ACTION_IDS.approve:
      return 'APPROVE';
    case APPROVAL_ACTION_IDS.partial:
      return 'PARTIAL';
    case APPROVAL_ACTION_IDS.call:
      return 'CALL';
    default:
      return null;
  }
}
