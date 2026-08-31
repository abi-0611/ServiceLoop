import { Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import {
  type ConversationRepository,
  PgConversationStore,
  type PgUnitOfWork,
  type Tx,
} from '@serviceloop/db';
import type { ConsentCaptureService, OutboundGate, GateOutcome } from '@serviceloop/domain';
import {
  type ConversationList,
  type ConversationThread,
  NotFoundError,
  type ReplyRequest,
  ReplyRequestSchema,
  type SendOutcome,
} from '@serviceloop/shared';
import { z } from 'zod';
import { CurrentStaff, type AuthenticatedStaff } from '../auth/auth.types';
import { currentTraceId } from '../common/request-context';
import { ZodBody, ZodParam } from '../common/zod';
import {
  CONSENT_CAPTURE,
  CONVERSATION_REPOSITORY,
  OUTBOUND_GATE,
  UNIT_OF_WORK,
} from '../infra/tokens';

/**
 * The Conversations inbox (phase 2.10).
 *
 * The one write here is an advisor's reply, and it goes through `OutboundGate`
 * like everything else. A human typing in the inbox bypasses the *autonomy*
 * check — a person has taken responsibility for the words — but not consent,
 * not the 24-hour window, not quiet hours and not the frequency cap. An advisor
 * cannot message someone who has opted out by opening the thread and typing.
 */
const UUID = z.string().uuid();

@Controller('conversations')
export class ConversationsController {
  private readonly conversationStore = new PgConversationStore();

  constructor(
    @Inject(CONVERSATION_REPOSITORY) private readonly repository: ConversationRepository,
    @Inject(OUTBOUND_GATE) private readonly gate: OutboundGate<Tx>,
    @Inject(CONSENT_CAPTURE) private readonly consentCapture: ConsentCaptureService<Tx>,
    @Inject(UNIT_OF_WORK) private readonly uow: PgUnitOfWork,
  ) {}

  @Get()
  async list(@CurrentStaff() staff: AuthenticatedStaff): Promise<ConversationList> {
    return this.repository.list(staff.shopId);
  }

  @Get(':id')
  async thread(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodParam('id', UUID) id: string,
  ): Promise<ConversationThread> {
    const thread = await this.repository.thread(staff.shopId, id);
    if (thread === null) throw new NotFoundError('Conversation', id);
    return thread;
  }

  /**
   * Marks a thread read.
   *
   * Deliberately explicit rather than a side effect of `GET :id`: an advisor
   * glancing at a thread from a list preview has not read it, and an unread
   * badge that clears itself on a page load is a badge nobody trusts.
   */
  @Post(':id/read')
  @HttpCode(204)
  async markRead(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodParam('id', UUID) id: string,
  ): Promise<void> {
    await this.uow.transaction(async (tx: Tx) => {
      const conversation = await this.conversationStore.findById(tx, staff.shopId, id);
      if (conversation === null) throw new NotFoundError('Conversation', id);
      await this.conversationStore.clearUnread(tx, staff.shopId, id);
    });
  }

  @Post(':id/reply')
  async reply(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodParam('id', UUID) id: string,
    @ZodBody(ReplyRequestSchema) body: ReplyRequest,
  ): Promise<SendOutcome> {
    const conversation = await this.uow.transaction(async (tx: Tx) =>
      this.conversationStore.findById(tx, staff.shopId, id),
    );
    if (conversation === null) throw new NotFoundError('Conversation', id);

    const outcome = await this.gate.send({
      shopId: staff.shopId,
      conversationId: id,
      customerId: conversation.customerId,
      purpose: 'SERVICE',
      content: { kind: 'text', body: body.body },
      actor: { type: 'STAFF', id: staff.staffId, displayName: staff.fullName },
      traceId: currentTraceId(),
      flow: 'status',
      language: conversation.language,
      // Bypasses autonomy and the AI-disclosure requirement — this is a person,
      // not the agent — and nothing else.
      isHumanReply: true,
      approvedByStaffId: staff.staffId,
    });

    // A human has taken the wheel. Phase 3 reads this to pause any running
    // agent objective on the thread rather than talking over the advisor.
    if (outcome.status === 'SENT') {
      await this.uow.transaction(async (tx: Tx) => {
        await this.conversationStore.markHumanOverride(tx, {
          conversationId: id,
          at: new Date(),
        });
      });
    }

    return toSendOutcome(outcome);
  }

  /**
   * Opens first contact on a thread: identification, AI disclosure and the
   * SERVICE consent ask, in one message (phase 2.9).
   */
  @Post(':id/consent-request')
  async requestConsent(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodParam('id', UUID) id: string,
  ): Promise<SendOutcome> {
    const conversation = await this.uow.transaction(async (tx: Tx) =>
      this.conversationStore.findById(tx, staff.shopId, id),
    );
    if (conversation === null) throw new NotFoundError('Conversation', id);
    if (conversation.customerId === null) {
      throw new NotFoundError('Customer on conversation', id);
    }

    const result = await this.consentCapture.openFirstContact({
      shopId: staff.shopId,
      customerId: conversation.customerId,
      conversationId: id,
      actor: { type: 'STAFF', id: staff.staffId, displayName: staff.fullName },
      traceId: currentTraceId(),
    });

    return toSendOutcome(result.outcome);
  }
}

/** One shape for every gate verdict, so the console never has to guess. */
export function toSendOutcome(outcome: GateOutcome): SendOutcome {
  switch (outcome.status) {
    case 'SENT':
      return {
        status: 'SENT',
        messageId: outcome.messageId,
        code: null,
        reason: null,
        deferUntil: null,
      };
    case 'BLOCKED':
    case 'FAILED':
      return {
        status: outcome.status,
        messageId: outcome.messageId,
        code: outcome.code,
        reason: outcome.reason,
        deferUntil: null,
      };
    case 'DEFERRED':
      return {
        status: 'DEFERRED',
        messageId: outcome.messageId,
        code: 'QUIET_HOURS',
        reason: outcome.reason,
        deferUntil: outcome.deferUntil.toISOString(),
      };
    case 'PENDING_APPROVAL':
      return {
        status: 'PENDING_APPROVAL',
        messageId: outcome.messageId,
        code: 'AUTONOMY_HITL',
        reason: outcome.reason,
        deferUntil: null,
      };
  }
}
