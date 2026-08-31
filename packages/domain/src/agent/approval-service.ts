import type { ShopConfig } from '@serviceloop/config';
import {
  formatPaise,
  systemClock,
  t,
  uuidv7,
  type Clock,
  type CustomerDecision,
  type EventEnvelope,
  type Language,
  type Paise,
} from '@serviceloop/shared';
import type { Actor } from '../job-card/context';
import type { JobCardTransitionService } from '../job-card/transition-service';
import type { AuditAppender, OutboxWriter, ShopDirectory, UnitOfWork } from '../ports';
import type { WorkItemTransitionService } from '../work-item/transition-service';
import type { OutboundGate } from '../messaging/outbound-gate';
import { APPROVAL_ACTION_IDS as ACTION_IDS } from '../messaging/approval-actions';
import type { MessageStore } from '../messaging/ports';
import type { OutboundButton, OutboundContent } from '../messaging/types';
import type { ApprovalStore, EvidenceBundleStore, JobCardContextReader } from './ports';
import { sourceId, type CustomerDecisionInput, type EvidenceBundle } from './types';

/**
 * Approval Autopilot (phase 3.6).
 *
 * `createApprovalRequest` puts an evidence bundle to a customer as an
 * interactive message with three buttons, and `recordCustomerDecision` turns
 * whatever comes back into state: work items transitioned, the job card moved,
 * the ledger written, the ladder cancelled, the ETA question asked.
 *
 * Two properties are load-bearing:
 *
 *   - **The send goes through `OutboundGate` like every other message.** At L0
 *     it lands in the HITL queue and never reaches the wire, and the approval
 *     row still exists — so an advisor approving the draft sends the *same*
 *     request rather than composing a second one.
 *   - **A decision is recorded once.** The approval row is locked before it is
 *     read, so two taps of Approve — which customers do — produce one decision
 *     and one confirmation, not two started jobs.
 */

/**
 * The button ids live in `messaging/approval-actions` — the inbound handler has
 * to recognise them and cannot import this module without closing a cycle.
 * Re-exported here so a caller reaching for the approval flow finds them.
 */
export {
  APPROVAL_ACTION_IDS,
  parseApprovalAction,
  type ApprovalAction,
} from '../messaging/approval-actions';

export interface CreateApprovalInput {
  readonly shopId: string;
  readonly jobCardId: string;
  readonly customerId: string;
  readonly conversationId: string;
  readonly bundle: EvidenceBundle;
  readonly ladderRef: string;
  readonly actor: Actor;
  readonly traceId: string;
  readonly agentRunId?: string | null;
  readonly deadlineAt?: Date | null;
}

export type CreateApprovalResult =
  | {
      readonly ok: true;
      readonly approvalId: string;
      readonly messageId: string;
      /** `SENT`, `PENDING_APPROVAL` at L0, `DEFERRED` in quiet hours, … */
      readonly gateStatus: string;
    }
  | { readonly ok: false; readonly code: string; readonly reason: string };

export interface DecisionResult {
  readonly approvalId: string;
  readonly decision: CustomerDecision;
  readonly approvedWorkItemIds: readonly string[];
  readonly deferredWorkItemIds: readonly string[];
  readonly approvedAmountPaise: Paise;
  /** True the first time; false when this decision had already been recorded. */
  readonly applied: boolean;
}

export interface ApprovalServiceDeps<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly approvals: ApprovalStore<Tx>;
  readonly bundles: EvidenceBundleStore<Tx>;
  readonly cards: JobCardContextReader<Tx>;
  readonly messages: MessageStore<Tx>;
  readonly gate: OutboundGate<Tx>;
  readonly jobCards: JobCardTransitionService<Tx>;
  readonly workItems: WorkItemTransitionService<Tx>;
  readonly directory: ShopDirectory<Tx>;
  readonly audit: AuditAppender<Tx>;
  readonly outbox: OutboxWriter<Tx>;
  /** Cancels the ladder the instant a decision lands. Injected to avoid a cycle. */
  readonly cancelLadder: (input: {
    readonly shopId: string;
    readonly approvalId: string;
    readonly reason: string;
    readonly actor: Actor;
    readonly traceId: string;
  }) => Promise<void>;
  readonly clock?: Clock;
}

export class ApprovalService<Tx> {
  private readonly clock: Clock;

  constructor(private readonly deps: ApprovalServiceDeps<Tx>) {
    this.clock = deps.clock ?? systemClock;
  }

  /**
   * Puts a bundle to the customer.
   *
   * The row is written *before* the send, so the request exists even when the
   * gate holds the message for HITL — which is the L0 default, and the case a
   * naive implementation gets wrong by treating "not sent" as "not requested".
   */
  async createApprovalRequest(input: CreateApprovalInput): Promise<CreateApprovalResult> {
    const now = this.clock.now();
    const approvalId = uuidv7();
    const bundle = input.bundle;

    if (bundle.workItemIds.length === 0) {
      return {
        ok: false,
        code: 'NO_WORK_ITEMS',
        reason: 'An approval request with no work items has nothing for the customer to decide',
      };
    }

    const context = await this.deps.uow.transaction(async (tx) => {
      const card = await this.deps.cards.load(tx, input.shopId, input.jobCardId);
      const shopName = await this.deps.directory.loadShopName(tx, input.shopId);
      const priorOutbound = await this.deps.messages.countOutbound(tx, input.conversationId);
      if (card === null) return null;

      await this.deps.approvals.insert(tx, {
        id: approvalId,
        shopId: input.shopId,
        jobCardId: input.jobCardId,
        customerId: input.customerId,
        conversationId: input.conversationId,
        evidenceBundleId: bundle.id,
        estimateId: bundle.estimateId,
        ladderRef: input.ladderRef,
        workItemIds: bundle.workItemIds,
        amountPaise: bundle.totalPaise,
        agentRunId: input.agentRunId ?? null,
        deadlineAt: input.deadlineAt ?? null,
        requestedAt: now,
      });

      await this.deps.audit.append(tx, {
        shopId: input.shopId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'approval.requested',
        entityType: 'ApprovalRequest',
        entityId: approvalId,
        payload: {
          jobCardId: input.jobCardId,
          evidenceBundleId: bundle.id,
          workItemIds: [...bundle.workItemIds],
          amountPaise: bundle.totalPaise,
          ladderRef: input.ladderRef,
        },
        traceId: input.traceId,
      });

      const envelope: EventEnvelope = {
        id: uuidv7(),
        type: 'approval.requested',
        occurredAt: now.toISOString(),
        shopId: input.shopId,
        traceId: input.traceId,
        payload: {
          approvalId,
          jobCardId: input.jobCardId,
          conversationId: input.conversationId,
          customerId: input.customerId,
          evidenceBundleId: bundle.id,
          workItemIds: [...bundle.workItemIds],
          amountPaise: bundle.totalPaise,
          ladderRef: asObjective(input.ladderRef),
          actor: { type: input.actor.type, id: input.actor.id },
        },
      };
      await this.deps.outbox.enqueue(tx, envelope);

      return { card, shopName: shopName ?? 'the workshop', priorOutbound };
    });

    if (context === null) {
      return {
        ok: false,
        code: 'NO_JOB_CARD',
        reason: `Job card ${input.jobCardId} does not exist in this shop`,
      };
    }

    const content = buildApprovalMessage({
      bundle,
      language: bundle.language,
      vehicleLabel: context.card.vehicleLabel,
      discloseAi:
        context.priorOutbound === 0
          ? { customerName: context.card.customerName, shopName: context.shopName }
          : null,
    });

    const outcome = await this.deps.gate.send({
      shopId: input.shopId,
      conversationId: input.conversationId,
      customerId: input.customerId,
      purpose: 'SERVICE',
      content,
      actor: input.actor,
      traceId: input.traceId,
      flow: 'approval',
      language: bundle.language,
      jobCardId: input.jobCardId,
      claims: bundle.claims.map((claim) => ({
        text: claim.text,
        evidence: claim.sources.flatMap((source) => {
          const ref = parseRef(source);
          return ref === null ? [] : [ref];
        }),
      })),
      evidenceRefs: bundle.claims.flatMap((claim) => [...claim.sources]),
      createdByAgent: true,
      agentRunId: input.agentRunId ?? null,
    });

    await this.deps.uow.transaction(async (tx) => {
      await this.deps.approvals.attachRequestMessage(tx, approvalId, outcome.messageId);
    });

    return {
      ok: true,
      approvalId,
      messageId: outcome.messageId,
      gateStatus: outcome.status,
    };
  }

  /**
   * Records what the customer decided, and everything that follows from it.
   *
   * One transaction for the approval row and the work-item transitions; the
   * ladder cancellation runs immediately after, because a customer who has
   * decided must never receive the next reminder. The confirmation message is
   * the caller's job — an advisor sending it by hand and the agent sending it
   * through a tool must land in the same place.
   */
  async recordCustomerDecision(
    input: CustomerDecisionInput & {
      readonly shopId: string;
      readonly actor: Actor;
      readonly traceId: string;
    },
  ): Promise<DecisionResult> {
    const now = this.clock.now();

    const prepared = await this.deps.uow.transaction(async (tx) => {
      const approval = await this.deps.approvals.lockById(tx, input.shopId, input.approvalId);
      if (approval === null) {
        throw new Error(`Approval request ${input.approvalId} does not exist in this shop`);
      }

      // Already decided: two taps of Approve is a customer being unsure the
      // first one worked, not a second decision.
      if (approval.decidedAt !== null) {
        return { approval, alreadyDecided: true as const };
      }

      const requested = new Set(approval.workItemIds);
      const approved =
        input.decision === 'FULL'
          ? [...approval.workItemIds]
          : input.approvedWorkItemIds.filter((id) => requested.has(id));
      const remainder = approval.workItemIds.filter((id) => !approved.includes(id));

      const approvedAmount = await this.approvedAmount(tx, approval.shopId, approval, approved);

      await this.deps.approvals.recordDecision(tx, {
        approvalId: approval.id,
        status: statusFor(input.decision, approved.length, approval.workItemIds.length),
        decision: input.decision,
        approvedWorkItemIds: approved,
        approvedAmountPaise: approvedAmount,
        decisionChannel: input.decidedVia,
        decisionNote: input.note,
        decidedAt: now,
      });

      await this.deps.audit.append(tx, {
        shopId: input.shopId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'approval.decided',
        entityType: 'ApprovalRequest',
        entityId: approval.id,
        payload: {
          jobCardId: approval.jobCardId,
          decision: input.decision,
          approvedWorkItemIds: approved,
          deferredWorkItemIds: remainder,
          approvedAmountPaise: approvedAmount,
          decidedVia: input.decidedVia,
          note: input.note,
        },
        traceId: input.traceId,
      });

      return { approval, alreadyDecided: false as const, approved, remainder, approvedAmount };
    });

    if (prepared.alreadyDecided) {
      return {
        approvalId: prepared.approval.id,
        decision: prepared.approval.decision ?? 'FULL',
        approvedWorkItemIds: prepared.approval.approvedWorkItemIds,
        deferredWorkItemIds: prepared.approval.workItemIds.filter(
          (id) => !prepared.approval.approvedWorkItemIds.includes(id),
        ),
        approvedAmountPaise: prepared.approval.approvedAmountPaise,
        applied: false,
      };
    }

    const { approval, approved, remainder, approvedAmount } = prepared;

    // Work-item transitions run through their own service, one at a time, so
    // each writes its own audit row, its own outbox event and — for the
    // remainder — its own DeclinedWorkLedger entry. Batching them into one
    // update would save a round trip and lose the ledger, which is the part
    // phase 6 turns back into revenue.
    for (const workItemId of approved) {
      await this.deps.workItems.transition({
        shopId: input.shopId,
        workItemId,
        event: 'APPROVE',
        actor: input.actor,
        traceId: input.traceId,
        meta: { approvalId: approval.id, decidedVia: input.decidedVia },
      });
    }

    for (const workItemId of remainder) {
      await this.deps.workItems.transition({
        shopId: input.shopId,
        workItemId,
        event: input.decision === 'DECLINED' ? 'DECLINE' : 'DEFER',
        actor: input.actor,
        traceId: input.traceId,
        reason: reasonFor(input.decision),
        ...(input.followUpAfter === undefined ? {} : { followUpAfter: input.followUpAfter }),
        meta: { approvalId: approval.id, decidedVia: input.decidedVia },
      });
    }

    // Any approval at all unblocks the bay; a total decline does not.
    if (approved.length > 0) {
      await this.deps.jobCards.transition({
        shopId: input.shopId,
        jobCardId: approval.jobCardId,
        event: 'APPROVAL_GRANTED',
        actor: input.actor,
        traceId: input.traceId,
        meta: { approvalId: approval.id, approvedCount: approved.length },
      });
    }

    await this.deps.cancelLadder({
      shopId: input.shopId,
      approvalId: approval.id,
      reason: `Customer decided (${input.decision}) via ${input.decidedVia}`,
      actor: input.actor,
      traceId: input.traceId,
    });

    await this.deps.uow.transaction(async (tx) => {
      const decided: EventEnvelope = {
        id: uuidv7(),
        type: 'approval.decided',
        occurredAt: now.toISOString(),
        shopId: input.shopId,
        traceId: input.traceId,
        payload: {
          approvalId: approval.id,
          jobCardId: approval.jobCardId,
          decision: input.decision,
          approvedWorkItemIds: approved,
          deferredWorkItemIds: input.decision === 'DECLINED' ? [] : remainder,
          declinedWorkItemIds: input.decision === 'DECLINED' ? remainder : [],
          approvedAmountPaise: approvedAmount,
          decidedVia: input.decidedVia,
          actor: { type: input.actor.type, id: input.actor.id },
        },
      };
      await this.deps.outbox.enqueue(tx, decided);

      if (approved.length > 0) {
        // The ETA hook (phase 3.6). Approved work changes when the vehicle is
        // ready, and phase 4 owns the engine that answers that; asking the
        // question now means this flow is complete on its own terms and phase 4
        // adds a consumer rather than a call site.
        const eta: EventEnvelope = {
          id: uuidv7(),
          type: 'eta.requested',
          occurredAt: now.toISOString(),
          shopId: input.shopId,
          traceId: input.traceId,
          payload: {
            jobCardId: approval.jobCardId,
            reason: 'APPROVAL_GRANTED',
            approvalId: approval.id,
            conversationId: approval.conversationId,
            actor: { type: input.actor.type, id: input.actor.id },
          },
        };
        await this.deps.outbox.enqueue(tx, eta);
      }
    });

    return {
      approvalId: approval.id,
      decision: input.decision,
      approvedWorkItemIds: approved,
      deferredWorkItemIds: remainder,
      approvedAmountPaise: approvedAmount,
      applied: true,
    };
  }

  private async approvedAmount(
    tx: Tx,
    shopId: string,
    approval: { readonly evidenceBundleId: string | null; readonly amountPaise: Paise },
    approvedWorkItemIds: readonly string[],
  ): Promise<Paise> {
    if (approval.evidenceBundleId === null) return approval.amountPaise;
    const bundle = await this.deps.bundles.load(tx, shopId, approval.evidenceBundleId);
    if (bundle === null) return approval.amountPaise;

    const approvedSet = new Set(approvedWorkItemIds);
    return bundle.lines
      .filter((line) => line.workItemId !== null && approvedSet.has(line.workItemId))
      .reduce((sum, line) => sum + line.lineTotalPaise, 0);
  }
}

/* ---------------------------------------------------------------- message -- */

export interface ApprovalMessageInput {
  readonly bundle: EvidenceBundle;
  readonly language: Language;
  readonly vehicleLabel: string;
  /**
   * Set when nothing has been sent on this thread yet.
   *
   * The approval request is very often the shop's *first* message to a
   * customer — they handed the keys over at the counter and heard nothing since
   * — so it is the message that must carry the AI disclosure (master §6). The
   * gate blocks it otherwise, which is correct and is also why the composer has
   * to know: a message that is built without the line and then refused is a
   * customer left waiting while an advisor works out why.
   */
  readonly discloseAi?: { readonly customerName: string; readonly shopName: string } | null;
}

/**
 * The interactive approval message.
 *
 * Three buttons, in the order a customer's eye scans them: yes, a question, a
 * person. "Call me" is deliberately last and deliberately present — L6 says the
 * human is always one step away, and on an estimate involving money that step
 * has to be visible rather than discoverable.
 */
export function buildApprovalMessage(input: ApprovalMessageInput): OutboundContent {
  const { bundle, language } = input;

  const itemised = bundle.lines
    .map((line, index) =>
      t(language, 'approval.line_item', {
        index: index + 1,
        description: line.description,
        amount: formatPaise(line.lineTotalPaise),
      }),
    )
    .join('\n');

  const disclosure =
    input.discloseAi == null
      ? null
      : t(language, 'disclosure.first_contact', {
          customerName: input.discloseAi.customerName,
          shopName: input.discloseAi.shopName,
        });

  const body = [
    ...(disclosure === null ? [] : [disclosure, '']),
    bundle.summaryText.trim(),
    '',
    itemised,
    '',
    t(language, 'approval.new_total', { amount: formatPaise(bundle.totalPaise) }),
  ].join('\n');

  const buttons: OutboundButton[] = [
    { id: ACTION_IDS.approve, title: t(language, 'approval.button.approve') },
    { id: ACTION_IDS.partial, title: t(language, 'approval.button.partial') },
    { id: ACTION_IDS.call, title: t(language, 'approval.button.call') },
  ];

  return {
    kind: 'interactive',
    body,
    header: input.vehicleLabel,
    footer: t(language, 'approval.footer'),
    buttons,
  };
}

/** Every source id the bundle's claims cite, as evidence refs for the gate. */
export function bundleEvidenceIds(bundle: EvidenceBundle): readonly string[] {
  return [
    ...bundle.sourceNotes.map((note) => sourceId({ kind: 'TECHNICIAN_NOTE', id: note.id })),
    ...bundle.lines.map((line) => sourceId({ kind: 'ESTIMATE_LINE', id: line.id })),
    ...bundle.media.map((asset) => sourceId({ kind: 'MEDIA', id: asset.id })),
  ];
}

/* ---------------------------------------------------------------- helpers -- */

function statusFor(
  decision: CustomerDecision,
  approvedCount: number,
  requestedCount: number,
): 'APPROVED' | 'PARTIAL' | 'DECLINED' {
  if (decision === 'DECLINED' || approvedCount === 0) return 'DECLINED';
  return approvedCount === requestedCount ? 'APPROVED' : 'PARTIAL';
}

function reasonFor(decision: CustomerDecision): string {
  switch (decision) {
    case 'PARTIAL':
      return 'customer_partial';
    case 'DEFERRED':
      return 'customer_deferred';
    case 'DECLINED':
      return 'customer_declined';
    case 'FULL':
      return 'customer_partial';
  }
}

/** The ladder key, narrowed to the objective enum the event envelope carries. */
function asObjective(
  ladderRef: string,
): 'APPROVAL' | 'STATUS' | 'DELIVERY' | 'PAYMENT' | 'RETENTION' | 'FEEDBACK' {
  switch (ladderRef) {
    case 'STATUS':
    case 'DELIVERY':
    case 'PAYMENT':
    case 'RETENTION':
    case 'FEEDBACK':
      return ladderRef;
    default:
      return 'APPROVAL';
  }
}

function parseRef(
  source: string,
): { readonly kind: 'MEDIA' | 'ESTIMATE_LINE' | 'TECHNICIAN_NOTE'; readonly id: string } | null {
  const separator = source.indexOf(':');
  if (separator <= 0) return null;
  const id = source.slice(separator + 1);
  switch (source.slice(0, separator)) {
    case 'media':
      return { kind: 'MEDIA', id };
    case 'line':
      return { kind: 'ESTIMATE_LINE', id };
    case 'note':
      return { kind: 'TECHNICIAN_NOTE', id };
    default:
      return null;
  }
}

/** Exposed so the console can render the same summary the customer received. */
export function approvalSummaryLines(bundle: EvidenceBundle, config: ShopConfig): string[] {
  const language = bundle.language ?? config.languages.default;
  return bundle.lines.map((line, index) =>
    t(language, 'approval.line_item', {
      index: index + 1,
      description: line.description,
      amount: formatPaise(line.lineTotalPaise),
    }),
  );
}
