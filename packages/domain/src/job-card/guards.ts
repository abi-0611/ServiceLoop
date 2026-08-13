import type { JobCardEvent, JobCardState } from '@serviceloop/shared';
import { ALLOWED, type GuardResult, type JobCardGuardContext, refuse } from './context';

/**
 * Business guards layered over the pure edge table.
 *
 * A guard may only refuse an edge that already exists; it can never create one.
 * Keys are `STATE:EVENT`; a pair with no guard is allowed once the edge exists.
 */

export type Guard = (context: JobCardGuardContext) => GuardResult;

type GuardKey = `${JobCardState}:${JobCardEvent}`;

const WORK_ITEM_BLOCKING_APPROVAL: ReadonlySet<string> = new Set(['PROPOSED', 'PENDING_APPROVAL']);

function unapprovedRequiredItems(context: JobCardGuardContext) {
  return context.workItems.filter(
    (item) => item.requiresApproval && WORK_ITEM_BLOCKING_APPROVAL.has(item.state),
  );
}

function unfinishedApprovedItems(context: JobCardGuardContext) {
  return context.workItems.filter(
    (item) => item.state === 'APPROVED' || item.state === 'IN_PROGRESS',
  );
}

/** Nothing to approve means nothing to ask the customer about (L7, L1). */
const requiresSomethingToApprove: Guard = (context) => {
  const pending = context.workItems.filter(
    (item) => item.state === 'PROPOSED' || item.state === 'PENDING_APPROVAL',
  );
  return pending.length > 0
    ? ALLOWED
    : refuse(
        'NO_WORK_TO_APPROVE',
        'Cannot request approval: the job card has no proposed or pending work items',
      );
};

/** Quality check is only meaningful once the approved work is actually done. */
const allApprovedWorkDone: Guard = (context) => {
  const unfinished = unfinishedApprovedItems(context);
  return unfinished.length === 0
    ? ALLOWED
    : refuse(
        'APPROVED_WORK_UNFINISHED',
        `Cannot complete work: ${unfinished.length} approved work item(s) are not DONE`,
      );
};

/**
 * Phase 1.4: a card cannot enter AWAITING_PAYMENT while required work is still
 * unapproved — billing a customer for work they never authorised is exactly the
 * failure mode the approval loop exists to prevent.
 */
const noUnapprovedRequiredWork: Guard = (context) => {
  const unapproved = unapprovedRequiredItems(context);
  return unapproved.length === 0
    ? ALLOWED
    : refuse(
        'UNAPPROVED_REQUIRED_WORK',
        `Cannot request payment: ${unapproved.length} required work item(s) are still awaiting approval`,
      );
};

/**
 * Handing the vehicle back before payment is only permitted for shops
 * configured that way, or once the balance is actually clear.
 */
const deliveryBeforePaymentAllowed: Guard = (context) => {
  if (!context.config.payments.paymentBeforeDelivery) return ALLOWED;
  if (context.outstandingBalancePaise <= 0) return ALLOWED;
  return refuse(
    'PAYMENT_REQUIRED_BEFORE_DELIVERY',
    'This shop collects payment before delivery and the balance is not settled',
  );
};

/** The DELIVERED → AWAITING_PAYMENT edge only exists for pay-after-delivery shops. */
const paymentAfterDeliveryAllowed: Guard = (context) =>
  context.config.payments.paymentBeforeDelivery
    ? refuse(
        'PAYMENT_ORDERING_MISMATCH',
        'This shop collects payment before delivery, so a delivered card cannot re-enter AWAITING_PAYMENT',
      )
    : ALLOWED;

const balanceSettled: Guard = (context) =>
  context.outstandingBalancePaise <= 0
    ? ALLOWED
    : refuse(
        'OUTSTANDING_BALANCE',
        `Cannot close the job card with an outstanding balance of ${context.outstandingBalancePaise} paise`,
      );

const notAlreadyDelivered: Guard = (context) =>
  context.card.state === 'DELIVERED' || context.card.state === 'CLOSED'
    ? refuse('ALREADY_DELIVERED', 'A delivered job card cannot be cancelled')
    : ALLOWED;

export const JOB_CARD_GUARDS: Readonly<Partial<Record<GuardKey, Guard>>> = {
  'IN_DIAGNOSIS:REQUEST_APPROVAL': requiresSomethingToApprove,
  'IN_PROGRESS:REQUEST_APPROVAL': requiresSomethingToApprove,
  'IN_PROGRESS:WORK_COMPLETED': allApprovedWorkDone,
  'READY_FOR_DELIVERY:PAYMENT_REQUESTED': noUnapprovedRequiredWork,
  'READY_FOR_DELIVERY:VEHICLE_DELIVERED': deliveryBeforePaymentAllowed,
  'DELIVERED:PAYMENT_REQUESTED': paymentAfterDeliveryAllowed,
  'DELIVERED:CLOSE': balanceSettled,
  'DRAFT:CANCEL': notAlreadyDelivered,
  'OPEN:CANCEL': notAlreadyDelivered,
  'IN_DIAGNOSIS:CANCEL': notAlreadyDelivered,
  'AWAITING_APPROVAL:CANCEL': notAlreadyDelivered,
  'IN_PROGRESS:CANCEL': notAlreadyDelivered,
  'AWAITING_PARTS:CANCEL': notAlreadyDelivered,
  'QUALITY_CHECK:CANCEL': notAlreadyDelivered,
  'READY_FOR_DELIVERY:CANCEL': notAlreadyDelivered,
  'AWAITING_PAYMENT:CANCEL': notAlreadyDelivered,
};

export function evaluateJobCardGuard(
  state: JobCardState,
  event: JobCardEvent,
  context: JobCardGuardContext,
): GuardResult {
  const guard = JOB_CARD_GUARDS[`${state}:${event}` as GuardKey];
  return guard === undefined ? ALLOWED : guard(context);
}
