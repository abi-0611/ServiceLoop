import { systemClock, t, type Clock, type Language } from '@serviceloop/shared';
import type { Actor } from '../job-card/context';
import type { ShopDirectory, UnitOfWork } from '../ports';
import type { OutboundGate } from '../messaging/outbound-gate';
import type {
  ApprovalReplyInput,
  ApprovalReplyPort,
  ApprovalReplyResult,
  ConversationStore,
} from '../messaging/ports';
import type { AdvisorTaskService } from './advisor-tasks';
import type { ApprovalService } from './approval-service';
import type { ApprovalStore, JobCardContextReader } from './ports';

/**
 * What the three approval buttons actually do (phase 3.6).
 *
 * The split from `ApprovalService` is deliberate: that class knows how to record
 * a decision, and this one knows what a *button* means. Which matters because
 * the same three outcomes are reachable by other routes — an advisor recording a
 * decision at the counter, the agent recording one from a typed reply — and all
 * of them must land in the same service rather than in three near-identical
 * copies of this logic.
 *
 * Each button is answered immediately. A customer who taps "Approve" and hears
 * nothing assumes it did not work and taps again, which is why the confirmation
 * is part of the same call rather than something a later run gets to.
 */

export interface ApprovalReplyDeps<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly approvals: ApprovalService<Tx>;
  readonly approvalStore: ApprovalStore<Tx>;
  readonly cards: JobCardContextReader<Tx>;
  readonly conversations: ConversationStore<Tx>;
  readonly tasks: AdvisorTaskService<Tx>;
  readonly directory: ShopDirectory<Tx>;
  readonly gate: OutboundGate<Tx>;
  /**
   * Starts a `resolve_partial_approval` run on the thread. Injected so the
   * domain never reaches for a language model: `apps/` supplies a function that
   * enqueues the run.
   */
  readonly openObjectionObjective: (input: {
    readonly shopId: string;
    readonly conversationId: string;
    readonly customerId: string | null;
    readonly jobCardId: string | null;
    readonly approvalId: string;
    readonly triggerMessageId: string | null;
    readonly traceId: string;
  }) => Promise<void>;
  readonly clock?: Clock;
}

const CUSTOMER_ACTOR = (customerId: string | null): Actor => ({
  type: 'CUSTOMER',
  id: customerId,
});

export class ApprovalReplyHandler<Tx> implements ApprovalReplyPort {
  private readonly clock: Clock;

  constructor(private readonly deps: ApprovalReplyDeps<Tx>) {
    this.clock = deps.clock ?? systemClock;
  }

  async approve(input: ApprovalReplyInput): Promise<ApprovalReplyResult> {
    const context = await this.open(input);
    if (context === null) return NOT_FOUND;

    const decision = await this.deps.approvals.recordCustomerDecision({
      shopId: input.shopId,
      approvalId: context.approvalId,
      decision: 'FULL',
      approvedWorkItemIds: [],
      note: input.replyTitle ?? 'Approved',
      decidedVia: 'button',
      actor: CUSTOMER_ACTOR(input.customerId),
      traceId: input.traceId,
    });

    // Confirm even when the decision was already recorded: the customer tapped
    // again because they were not sure the first tap worked, and answering that
    // is the whole job.
    await this.confirm(input, context.language, 'approval.granted_ack', {
      vehicle: context.vehicleLabel,
    });

    return {
      handled: true,
      detail: decision.applied
        ? `approved ${decision.approvedWorkItemIds.length} item(s)`
        : 'already decided; confirmation re-sent',
      approvalId: context.approvalId,
    };
  }

  /**
   * "Approve partially · ask a question".
   *
   * Nothing is decided here. The customer has said *something other than yes*,
   * and guessing which of "too expensive", "not now" and "is it really needed?"
   * they meant is exactly the error the objection objective exists to avoid. The
   * run reads their next message and works it out.
   */
  async openObjection(input: ApprovalReplyInput): Promise<ApprovalReplyResult> {
    const context = await this.open(input);
    if (context === null) return NOT_FOUND;

    await this.deps.openObjectionObjective({
      shopId: input.shopId,
      conversationId: input.conversationId,
      customerId: input.customerId,
      jobCardId: context.jobCardId,
      approvalId: context.approvalId,
      triggerMessageId: input.triggerMessageId,
      traceId: input.traceId,
    });

    return {
      handled: true,
      detail: 'opened resolve_partial_approval on the thread',
      approvalId: context.approvalId,
    };
  }

  /**
   * "Call me" — a handoff at high urgency, immediately.
   *
   * The ladder is *not* cancelled: the customer asked for a call, not for the
   * request to go away, and a shop that fails to call them should still send the
   * reminder. What is cancelled is nothing; what is added is a person.
   */
  async requestCall(input: ApprovalReplyInput): Promise<ApprovalReplyResult> {
    const context = await this.open(input);
    if (context === null) return NOT_FOUND;

    const taskId = await this.deps.tasks.create({
      shopId: input.shopId,
      kind: 'CALL_CUSTOMER',
      urgency: 'HIGH',
      brief: `${context.customerName} asked to be called about ${context.vehicleLabel} (${context.code}) — they tapped "Call me" on the estimate.`,
      context: {
        approvalId: context.approvalId,
        jobCardId: context.jobCardId,
        requestedVia: 'approval-button',
      },
      jobCardId: context.jobCardId,
      conversationId: input.conversationId,
      customerId: input.customerId,
      approvalRequestId: context.approvalId,
      // One task per request, however many times they tap.
      dedupeKey: `callback:${context.approvalId}`,
      actor: CUSTOMER_ACTOR(input.customerId),
      traceId: input.traceId,
    });

    await this.confirm(input, context.language, 'approval.callback_ack', {
      shopName: context.shopName,
    });

    return { handled: true, detail: `advisor task ${taskId}`, approvalId: context.approvalId };
  }

  /* ------------------------------------------------------------- internals */

  private async open(input: ApprovalReplyInput): Promise<ReplyContext | null> {
    return this.deps.uow.transaction(async (tx) => {
      const approval = await this.deps.approvalStore.findOpenByConversation(
        tx,
        input.shopId,
        input.conversationId,
      );
      if (approval === null) return null;

      const card = await this.deps.cards.load(tx, input.shopId, approval.jobCardId);
      const conversation = await this.deps.conversations.findById(
        tx,
        input.shopId,
        input.conversationId,
      );
      // The shop's real name: "An advisor from the workshop will call you" is
      // the kind of copy that tells a customer nobody read it.
      const shopName = await this.deps.directory.loadShopName(tx, input.shopId);

      return {
        approvalId: approval.id,
        jobCardId: approval.jobCardId,
        code: card?.code ?? '',
        customerName: card?.customerName ?? 'the customer',
        vehicleLabel: card?.vehicleLabel ?? 'your vehicle',
        language: card?.customerLanguage ?? conversation?.language ?? 'en',
        shopName: shopName ?? 'the workshop',
      };
    });
  }

  /**
   * The acknowledgement.
   *
   * `systemReply` because it is copy the shop has no discretion over — a
   * customer who taps a button is owed an answer whether or not the agent has
   * been let off its leash. Every customer protection still applies.
   */
  private async confirm(
    input: ApprovalReplyInput,
    language: Language,
    key: 'approval.granted_ack' | 'approval.callback_ack',
    params: Readonly<Record<string, string>>,
  ): Promise<void> {
    await this.deps.gate.send({
      shopId: input.shopId,
      conversationId: input.conversationId,
      customerId: input.customerId,
      purpose: 'SERVICE',
      content: { kind: 'text', body: t(language, key, params) },
      actor: CUSTOMER_ACTOR(input.customerId),
      traceId: input.traceId,
      flow: 'approval',
      language,
      systemReply: true,
      isAcknowledgement: true,
    });
  }
}

interface ReplyContext {
  readonly approvalId: string;
  readonly jobCardId: string;
  readonly code: string;
  readonly customerName: string;
  readonly vehicleLabel: string;
  readonly language: Language;
  readonly shopName: string;
}

/**
 * A tap with no open request behind it.
 *
 * Silent on purpose: it means the customer scrolled up and pressed a button on
 * an estimate that has already been decided, and telling them "there is nothing
 * to approve" would be confusing where saying nothing is merely quiet. The trace
 * step records it either way.
 */
const NOT_FOUND: ApprovalReplyResult = {
  handled: false,
  detail: 'no open approval request on this thread',
  approvalId: null,
};
