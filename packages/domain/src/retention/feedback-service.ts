import type { ShopConfig } from '@serviceloop/config';
import {
  addHours,
  systemClock,
  t,
  uuidv7,
  type Clock,
  type EventEnvelope,
  type FeedbackSentiment,
} from '@serviceloop/shared';
import type { AdvisorTaskCreator } from '../delivery/ports';
import type { Actor } from '../job-card/context';
import { SYSTEM_ACTOR } from '../job-card/context';
import type { OutboundGate } from '../messaging/outbound-gate';
import type { ConversationStore } from '../messaging/ports';
import { FEEDBACK_ACTION_IDS } from '../messaging/retention-actions';
import type { AuditAppender, OutboxWriter, ShopDirectory, UnitOfWork } from '../ports';
import type { FeedbackStore, RetentionDirectory, RetentionHoldStore } from './ports';
import type { FeedbackRecord } from './types';

/**
 * Post-service feedback, review routing and service recovery (phase 6.4).
 *
 * The three routes are the point of the whole feature, and they are genuinely
 * three different products:
 *
 *   - **Positive** → thank them, and *once* offer the review link. Once per
 *     visit, enforced by a column on the row and a database CHECK, because the
 *     difference between asking a happy customer for a review and nagging them
 *     is exactly one message.
 *   - **Neutral** → thank them and log it. No review ask: a shop that asks a
 *     lukewarm customer to go and write in public is asking for a three-star
 *     review, which is worse than none.
 *   - **Negative** → **interrupt the owner now**, raise a recovery task with the
 *     customer's own words on it, and freeze every retention touch for that
 *     customer until the task closes. The freeze is the part that is easy to
 *     skip and impossible to justify skipping: a shop that follows a complaint
 *     with a re-pitch has told the customer exactly how much the complaint
 *     mattered.
 *
 * Nothing here decides *whether* the alert goes out. It calls the alert service,
 * which owns dedup and quiet-hours override — one place that knows how to
 * interrupt an owner, rather than two that disagree about when.
 */

/** What raises the realtime owner alert. Injected, so 6.4 does not import 6.8. */
export interface NegativeFeedbackAlerter {
  raise(input: {
    readonly shopId: string;
    readonly incidentKey: string;
    readonly subjectId: string;
    readonly detail: string;
    readonly customerId: string;
    readonly jobCardId: string;
    readonly traceId: string;
  }): Promise<{ readonly alertId: string | null }>;
}

export interface FeedbackServiceDeps<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly feedback: FeedbackStore<Tx>;
  readonly holds: RetentionHoldStore<Tx>;
  readonly directory: RetentionDirectory<Tx>;
  readonly conversations: ConversationStore<Tx>;
  readonly shops: ShopDirectory<Tx>;
  readonly gate: OutboundGate<Tx>;
  readonly audit: AuditAppender<Tx>;
  readonly outbox: OutboxWriter<Tx>;
  readonly loadConfig: (tx: Tx, shopId: string) => Promise<ShopConfig>;
  /** The service-recovery task a negative answer raises (L6). */
  readonly tasks?: AdvisorTaskCreator;
  /** The realtime owner alert (6.8). Absent in a build with no alert stream. */
  readonly alerts?: NegativeFeedbackAlerter;
  readonly clock?: Clock;
}

export interface AskResult {
  readonly feedbackId: string;
  readonly sent: boolean;
  readonly detail: string;
}

export interface AnswerResult {
  readonly handled: boolean;
  readonly sentiment: FeedbackSentiment | null;
  readonly reviewAsked: boolean;
  readonly recoveryTaskId: string | null;
  readonly holdId: string | null;
  readonly detail: string;
}

/**
 * How long after a face a message still counts as the sentence explaining it.
 *
 * An hour, because that is the length of a conversation. See `attachComment`.
 */
const COMMENT_WINDOW_MINUTES = 60;

export class FeedbackService<Tx> {
  private readonly clock: Clock;

  constructor(private readonly deps: FeedbackServiceDeps<Tx>) {
    this.clock = deps.clock ?? systemClock;
  }

  /**
   * Schedules the ask when a vehicle is delivered.
   *
   * Called from the DELIVERED transition rather than polled for, because "the
   * customer has their car back" is an event the system already has and
   * re-deriving it from a state scan would be a second answer to a question
   * with one. One row per job card, so a redelivered transition is a no-op.
   */
  async scheduleForDelivery(input: {
    readonly shopId: string;
    readonly jobCardId: string;
    readonly customerId: string;
    readonly conversationId: string | null;
    readonly deliveredAt: Date;
    readonly traceId: string;
  }): Promise<string | null> {
    return this.deps.uow.transaction(async (tx) => {
      const config = await this.deps.loadConfig(tx, input.shopId);
      if (!config.feedback.enabled) return null;

      const id = uuidv7();
      const claimed = await this.deps.feedback.schedule(tx, {
        id,
        shopId: input.shopId,
        jobCardId: input.jobCardId,
        customerId: input.customerId,
        conversationId: input.conversationId,
        deliveredAt: input.deliveredAt,
        dueAt: addHours(input.deliveredAt, config.feedback.askAfterHours),
        expiresAt: addHours(input.deliveredAt, config.feedback.expireAfterHours),
        traceId: input.traceId,
      });
      return claimed;
    });
  }

  /** Claims and sends every ask whose time has come. One pass, per shop. */
  async sendDue(input: {
    readonly shopId: string;
    readonly limit?: number;
    readonly traceId: string;
    readonly actor?: Actor;
  }): Promise<readonly AskResult[]> {
    const now = this.clock.now();
    const due = await this.deps.uow.transaction(async (tx) => {
      const config = await this.deps.loadConfig(tx, input.shopId);
      if (!config.feedback.enabled) return [];
      return this.deps.feedback.claimDue(tx, {
        shopId: input.shopId,
        dueBefore: now,
        limit: input.limit ?? 50,
      });
    });

    const results: AskResult[] = [];
    for (const record of due) {
      results.push(
        await this.ask({
          shopId: input.shopId,
          record,
          reminder: record.askedAt !== null,
          traceId: input.traceId,
          ...(input.actor === undefined ? {} : { actor: input.actor }),
        }),
      );
    }
    return results;
  }

  /** Sends one ask (or its single reminder). */
  async ask(input: {
    readonly shopId: string;
    readonly record: FeedbackRecord;
    readonly reminder: boolean;
    readonly traceId: string;
    readonly actor?: Actor;
  }): Promise<AskResult> {
    const actor = input.actor ?? SYSTEM_ACTOR;
    const now = this.clock.now();
    const { record } = input;

    const context = await this.deps.uow.transaction(async (tx) => {
      const customer = await this.deps.directory.loadCustomer(tx, input.shopId, record.customerId);
      const conversation =
        record.conversationId === null
          ? await this.deps.conversations.findByCustomer(
              tx,
              input.shopId,
              record.customerId,
              'WHATSAPP',
            )
          : await this.deps.conversations.findById(tx, input.shopId, record.conversationId);
      const vehicleId = await this.deps.directory.vehicleForJobCard(
        tx,
        input.shopId,
        record.jobCardId,
      );
      const vehicle =
        vehicleId === null
          ? null
          : await this.deps.directory.loadVehicle(tx, input.shopId, vehicleId);
      const shopName = (await this.deps.shops.loadShopName(tx, input.shopId)) ?? 'the workshop';
      return { customer, conversation, vehicle, shopName };
    });

    if (context.conversation === null || context.customer === null) {
      return {
        feedbackId: record.id,
        sent: false,
        detail: 'NO_THREAD: this customer has no thread to ask on',
      };
    }

    const language = context.customer.language;
    const body = input.reminder
      ? t(language, 'feedback.reminder', {
          vehicle: context.vehicle?.label ?? 'your vehicle',
          shopName: context.shopName,
        })
      : t(language, 'feedback.ask', {
          shopName: context.shopName,
          vehicle: context.vehicle?.label ?? 'your vehicle',
        });

    const outcome = await this.deps.gate.send({
      shopId: input.shopId,
      conversationId: context.conversation.id,
      customerId: record.customerId,
      // SERVICE, and deliberately so. Asking somebody how the work went is part
      // of the work, not marketing — and a shop that could only ask its
      // MARKETING-consented customers would have a satisfaction figure drawn
      // from a self-selected half of its book.
      purpose: 'SERVICE',
      content: {
        kind: 'interactive',
        body,
        buttons: [
          {
            id: FEEDBACK_ACTION_IDS.positive(record.id),
            title: t(language, 'feedback.option.positive'),
          },
          {
            id: FEEDBACK_ACTION_IDS.neutral(record.id),
            title: t(language, 'feedback.option.neutral'),
          },
          {
            id: FEEDBACK_ACTION_IDS.negative(record.id),
            title: t(language, 'feedback.option.negative'),
          },
        ],
      },
      actor,
      traceId: input.traceId,
      flow: 'retention',
      language,
      jobCardId: record.jobCardId,
      templated: true,
    });

    await this.deps.uow.transaction(async (tx) => {
      await this.deps.feedback.markAsked(tx, {
        shopId: input.shopId,
        feedbackId: record.id,
        messageId: outcome.status === 'SENT' ? outcome.messageId : null,
        reminder: input.reminder,
        at: now,
      });

      if (outcome.status === 'SENT' && !input.reminder) {
        const envelope: EventEnvelope = {
          id: uuidv7(),
          type: 'feedback.requested',
          occurredAt: now.toISOString(),
          shopId: input.shopId,
          traceId: input.traceId,
          payload: {
            feedbackId: record.id,
            jobCardId: record.jobCardId,
            customerId: record.customerId,
            conversationId: context.conversation?.id ?? null,
            deliveredAt: record.deliveredAt.toISOString(),
            messageId: outcome.messageId,
            actor: { type: actor.type, id: actor.id },
          },
        };
        await this.deps.outbox.enqueue(tx, envelope);
      }
    });

    return {
      feedbackId: record.id,
      sent: outcome.status === 'SENT',
      detail:
        outcome.status === 'SENT'
          ? `message ${outcome.messageId}`
          : `${outcome.status}: ${'reason' in outcome ? outcome.reason : ''}`,
    };
  }

  /**
   * The customer answered (phase 6.4).
   *
   * The whole routing decision is here, and the ordering inside it is chosen so
   * that the customer-visible reply is never what a failure delays: the answer
   * is persisted first, the negative route's alert and task and freeze are
   * raised second, and the thank-you goes out last. A shop whose alert stream
   * is down still records the complaint and still freezes retention.
   */
  async recordAnswer(input: {
    readonly shopId: string;
    readonly feedbackId: string;
    readonly sentiment: FeedbackSentiment;
    readonly comment: string | null;
    readonly viaVoiceNote?: boolean;
    readonly mediaId?: string | null;
    readonly conversationId: string | null;
    readonly traceId: string;
    readonly actor?: Actor;
  }): Promise<AnswerResult> {
    const actor = input.actor ?? SYSTEM_ACTOR;
    const now = this.clock.now();

    const stored = await this.deps.uow.transaction(async (tx) => {
      const record = await this.deps.feedback.lockById(tx, input.shopId, input.feedbackId);
      if (record === null) return null;
      // Already answered. A second tap on an old card is not an error, and
      // re-running the negative route would raise a second recovery task for
      // one complaint.
      if (record.answeredAt !== null) return { record, fresh: false as const };

      await this.deps.feedback.recordAnswer(tx, {
        shopId: input.shopId,
        feedbackId: input.feedbackId,
        sentiment: input.sentiment,
        comment: input.comment,
        viaVoiceNote: input.viaVoiceNote ?? false,
        mediaId: input.mediaId ?? null,
        at: now,
      });

      const config = await this.deps.loadConfig(tx, input.shopId);
      const customer = await this.deps.directory.loadCustomer(
        tx,
        input.shopId,
        record.customerId,
      );
      const vehicleId = await this.deps.directory.vehicleForJobCard(
        tx,
        input.shopId,
        record.jobCardId,
      );
      const vehicle =
        vehicleId === null
          ? null
          : await this.deps.directory.loadVehicle(tx, input.shopId, vehicleId);
      const advisor = await this.deps.shops.loadHandoffAdvisor(tx, input.shopId);

      return { record, fresh: true as const, config, customer, vehicle, advisor };
    });

    if (stored === null) {
      return {
        handled: false,
        sentiment: null,
        reviewAsked: false,
        recoveryTaskId: null,
        holdId: null,
        detail: 'No such feedback request',
      };
    }
    if (!stored.fresh) {
      return {
        handled: false,
        sentiment: stored.record.sentiment,
        reviewAsked: stored.record.reviewAskedAt !== null,
        recoveryTaskId: stored.record.recoveryTaskId,
        holdId: stored.record.holdId,
        detail: 'This visit has already been rated',
      };
    }

    const config = stored.config;
    const language = stored.customer?.language ?? 'en';
    const vehicleLabel = stored.vehicle?.label ?? 'your vehicle';
    const advisorName = stored.advisor?.fullName ?? 'our advisor';
    const conversationId = input.conversationId ?? stored.record.conversationId;

    let recoveryTaskId: string | null = null;
    let holdId: string | null = null;

    if (input.sentiment === 'NEGATIVE') {
      const raised = await this.raiseRecovery({
        shopId: input.shopId,
        record: stored.record,
        comment: input.comment,
        vehicleLabel,
        customerName: stored.customer?.name ?? 'the customer',
        config,
        traceId: input.traceId,
        actor,
      });
      recoveryTaskId = raised.taskId;
      holdId = raised.holdId;
    }

    let reviewAsked = false;
    if (conversationId !== null) {
      const thanks =
        input.sentiment === 'POSITIVE'
          ? t(language, 'feedback.thanks_positive')
          : input.sentiment === 'NEUTRAL'
            ? t(language, 'feedback.thanks_neutral')
            : t(language, 'feedback.thanks_negative', { advisorName });

      await this.deps.gate.send({
        shopId: input.shopId,
        conversationId,
        customerId: stored.record.customerId,
        purpose: 'SERVICE',
        content: { kind: 'text', body: thanks },
        actor,
        traceId: input.traceId,
        flow: 'retention',
        language,
        jobCardId: stored.record.jobCardId,
        isAcknowledgement: true,
        templated: true,
      });

      reviewAsked = await this.maybeAskForReview({
        shopId: input.shopId,
        record: stored.record,
        sentiment: input.sentiment,
        conversationId,
        language,
        config,
        traceId: input.traceId,
        actor,
      });
    }

    await this.deps.uow.transaction(async (tx) => {
      await this.deps.audit.append(tx, {
        shopId: input.shopId,
        actorType: actor.type,
        actorId: actor.id,
        action: 'feedback.recorded',
        entityType: 'FeedbackRequest',
        entityId: stored.record.id,
        payload: {
          jobCardId: stored.record.jobCardId,
          sentiment: input.sentiment,
          hasComment: input.comment !== null && input.comment.trim().length > 0,
          viaVoiceNote: input.viaVoiceNote ?? false,
          reviewAsked,
          recoveryTaskId,
          retentionFrozen: holdId !== null,
        },
        traceId: input.traceId,
      });

      const envelope: EventEnvelope = {
        id: uuidv7(),
        type: 'feedback.recorded',
        occurredAt: now.toISOString(),
        shopId: input.shopId,
        traceId: input.traceId,
        payload: {
          feedbackId: stored.record.id,
          jobCardId: stored.record.jobCardId,
          customerId: stored.record.customerId,
          sentiment: input.sentiment,
          hasComment: input.comment !== null && input.comment.trim().length > 0,
          viaVoiceNote: input.viaVoiceNote ?? false,
          reviewAsked,
          recoveryTaskId,
          retentionFrozen: holdId !== null,
          actor: { type: actor.type, id: actor.id },
        },
      };
      await this.deps.outbox.enqueue(tx, envelope);
    });

    return {
      handled: true,
      sentiment: input.sentiment,
      reviewAsked,
      recoveryTaskId,
      holdId,
      detail: `Recorded ${input.sentiment}`,
    };
  }

  /**
   * A comment that arrived **just** after the face was tapped.
   *
   * A customer frequently taps 😞 and then types (or records) what went wrong,
   * which is the part an advisor actually needs. Attaching it to the open
   * feedback row keeps the complaint and its evidence in one place; it does not
   * re-run the routing, because the alert and the task have already gone out
   * and a second one would be noise.
   *
   * The window is why this is safe to call on every inbound customer message.
   * `findOpenForCustomer` returns the newest record that has not expired, which
   * for an answered one is *for ever* — so without a bound, the next "is my car
   * ready?" a fortnight later would silently overwrite a complaint an advisor
   * is still working through, and the recovery task would lose the sentence it
   * exists because of. An hour is the length of a conversation; anything after
   * that is a new conversation and is left alone.
   */
  async attachComment(input: {
    readonly shopId: string;
    readonly customerId: string;
    readonly comment: string;
    readonly viaVoiceNote: boolean;
    readonly mediaId: string | null;
    readonly traceId: string;
  }): Promise<boolean> {
    const now = this.clock.now();
    return this.deps.uow.transaction(async (tx) => {
      const record = await this.deps.feedback.findOpenForCustomer(
        tx,
        input.shopId,
        input.customerId,
      );
      if (record === null || record.sentiment === null) return false;

      const answeredAt = record.answeredAt;
      if (
        answeredAt === null ||
        now.getTime() - answeredAt.getTime() > COMMENT_WINDOW_MINUTES * 60_000
      ) {
        return false;
      }

      await this.deps.feedback.recordAnswer(tx, {
        shopId: input.shopId,
        feedbackId: record.id,
        sentiment: record.sentiment,
        comment: input.comment,
        viaVoiceNote: input.viaVoiceNote,
        mediaId: input.mediaId,
        at: answeredAt,
      });
      return true;
    });
  }

  /** Expires asks nobody answered. Silence is an answer worth recording as one. */
  async expireStale(input: { readonly shopId: string; readonly limit?: number }): Promise<number> {
    const now = this.clock.now();
    return this.deps.uow.transaction((tx) =>
      this.deps.feedback.expire(tx, {
        shopId: input.shopId,
        before: now,
        limit: input.limit ?? 200,
      }),
    );
  }

  /** Lifts the freeze when the advisor closes the recovery task. */
  async releaseHoldsForTask(input: {
    readonly shopId: string;
    readonly taskId: string;
    readonly traceId: string;
    readonly actor?: Actor;
  }): Promise<number> {
    const actor = input.actor ?? SYSTEM_ACTOR;
    const now = this.clock.now();
    return this.deps.uow.transaction(async (tx) => {
      const released = await this.deps.holds.releaseForTask(tx, input.shopId, input.taskId, now);
      if (released > 0) {
        await this.deps.audit.append(tx, {
          shopId: input.shopId,
          actorType: actor.type,
          actorId: actor.id,
          action: 'retention.hold_released',
          entityType: 'AdvisorTask',
          entityId: input.taskId,
          payload: { released },
          traceId: input.traceId,
        });
      }
      return released;
    });
  }

  /* --------------------------------------------------------------- private */

  private async raiseRecovery(input: {
    readonly shopId: string;
    readonly record: FeedbackRecord;
    readonly comment: string | null;
    readonly vehicleLabel: string;
    readonly customerName: string;
    readonly config: ShopConfig;
    readonly traceId: string;
    readonly actor: Actor;
  }): Promise<{ readonly taskId: string | null; readonly holdId: string | null }> {
    const now = this.clock.now();
    const detail = `${input.customerName} rated their ${input.vehicleLabel} visit poorly${
      input.comment === null ? '' : `: "${input.comment}"`
    }`;

    // The freeze first. It is the one part of this route that must survive a
    // task store or an alert stream being unavailable — a shop that cannot
    // raise the task must still not sell to this customer tomorrow morning.
    const holdId = await this.deps.uow.transaction(async (tx) => {
      if (!input.config.feedback.freezeRetentionOnNegative) return null;
      const id = uuidv7();
      return this.deps.holds.open(tx, {
        id,
        shopId: input.shopId,
        customerId: input.record.customerId,
        reason: 'Negative post-service feedback; awaiting service recovery',
        sourceType: 'FeedbackRequest',
        sourceId: input.record.id,
        taskId: null,
        at: now,
      });
    });

    let taskId: string | null = null;
    const tasks = this.deps.tasks;
    if (tasks !== undefined) {
      taskId = await tasks.create({
        shopId: input.shopId,
        kind: 'CALL_CUSTOMER',
        urgency: 'HIGH',
        brief: detail,
        context: {
          feedbackId: input.record.id,
          jobCardId: input.record.jobCardId,
          sentiment: 'NEGATIVE',
          comment: input.comment,
          holdId,
          // Says in words what the advisor's own action will do, so the person
          // closing it knows they are also lifting a freeze.
          note: 'Closing this task releases the retention hold on this customer.',
        },
        jobCardId: input.record.jobCardId,
        conversationId: input.record.conversationId,
        customerId: input.record.customerId,
        dedupeKey: `feedback-recovery:${input.record.id}`,
        actor: { type: input.actor.type, id: input.actor.id },
        traceId: input.traceId,
      });
    }

    await this.deps.uow.transaction(async (tx) => {
      await this.deps.feedback.attachRecovery(tx, {
        shopId: input.shopId,
        feedbackId: input.record.id,
        taskId,
        holdId,
      });
    });

    const alerts = this.deps.alerts;
    if (alerts !== undefined) {
      await alerts.raise({
        shopId: input.shopId,
        incidentKey: `negative_feedback:${input.record.id}`,
        subjectId: input.record.id,
        detail,
        customerId: input.record.customerId,
        jobCardId: input.record.jobCardId,
        traceId: input.traceId,
      });
    }

    return { taskId, holdId };
  }

  /**
   * The review ask — once, only on a positive answer, and only when the shop
   * has actually configured a link.
   *
   * Three conditions rather than one, and each rules out a different way of
   * annoying somebody: asking a lukewarm customer, asking the same customer
   * twice, and asking anybody at all to leave a review at a URL that does not
   * exist.
   */
  private async maybeAskForReview(input: {
    readonly shopId: string;
    readonly record: FeedbackRecord;
    readonly sentiment: FeedbackSentiment;
    readonly conversationId: string;
    readonly language: 'en' | 'ta' | 'hi';
    readonly config: ShopConfig;
    readonly traceId: string;
    readonly actor: Actor;
  }): Promise<boolean> {
    if (input.sentiment !== 'POSITIVE') return false;
    if (!input.config.feedback.askForReviewOnPositive) return false;
    if (input.record.reviewAskedAt !== null) return false;

    const link = input.config.feedback.reviewLink;
    if (link === null) return false;

    const outcome = await this.deps.gate.send({
      shopId: input.shopId,
      conversationId: input.conversationId,
      customerId: input.record.customerId,
      purpose: 'SERVICE',
      content: {
        kind: 'text',
        body: t(input.language, 'feedback.review_ask', { link }),
      },
      actor: input.actor,
      traceId: input.traceId,
      flow: 'retention',
      language: input.language,
      jobCardId: input.record.jobCardId,
      isAcknowledgement: true,
      templated: true,
    });

    if (outcome.status !== 'SENT') return false;

    await this.deps.uow.transaction(async (tx) => {
      await this.deps.feedback.recordReviewAsk(tx, {
        shopId: input.shopId,
        feedbackId: input.record.id,
        messageId: outcome.messageId,
        at: this.clock.now(),
      });
    });
    return true;
  }
}
