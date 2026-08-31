import { migrateShopConfig, type ShopConfig } from '@serviceloop/config';
import {
  type ChannelType,
  type Clock,
  type ConversationKind,
  type EventEnvelope,
  type IntakeSource,
  type Language,
  matchKeyword,
  type MessageKind,
  systemClock,
  uuidv7,
} from '@serviceloop/shared';
import type { Actor } from '../job-card/context';
import type { AuditAppender, OutboxWriter, ShopConfigStore, UnitOfWork } from '../ports';
import { type ConsentService } from './consent';
import type { ConversationStore, CustomerLookup, MessageStore } from './ports';
import { type ConversationSessionService } from './session';
import type { ConversationSnapshot, InboundMessage } from './types';

/**
 * The inbound router.
 *
 * Every message entering ServiceLoop passes through here exactly once. Its job
 * is to answer three questions and then get out of the way:
 *
 *   1. Which line is this? (customer / staff evidence group / unknown number)
 *   2. Does it change the customer's standing instructions? (opt-out, opt-in)
 *   3. Is it an intake trigger the caller should act on?
 *
 * It never composes a reply. Deciding *what* to say belongs to the handlers
 * above it (and, from phase 3, to the agent); deciding whether that reply may
 * leave belongs to the `OutboundGate`.
 */

export type FollowUp =
  /** An unrecognised number: ask who they are. Never leave them in silence. */
  | { readonly kind: 'IDENTIFY_UNKNOWN_NUMBER' }
  /** The customer opted out. Confirm exactly once, then stop. */
  | { readonly kind: 'ACKNOWLEDGE_OPT_OUT' }
  | { readonly kind: 'ACKNOWLEDGE_OPT_IN' }
  /** They asked for a person (L6 — handoff is always one step away). */
  | { readonly kind: 'HUMAN_HANDOFF_REQUESTED' }
  /** A photo, forwarded text or voice note that should become a job-card draft. */
  | { readonly kind: 'RUN_INTAKE'; readonly source: IntakeSource }
  /** A tap on one of our interactive prompts. */
  | { readonly kind: 'INTERACTIVE_REPLY'; readonly replyId: string; readonly title: string }
  /** Ordinary conversation for the agent or an advisor to answer. */
  | { readonly kind: 'CONVERSATION' };

export interface RoutedMessage {
  readonly conversationId: string;
  readonly conversationKind: ConversationKind;
  readonly messageId: string;
  readonly customerId: string | null;
  readonly senderStaffId: string | null;
  readonly language: Language;
  readonly windowExpiresAt: Date | null;
  readonly followUps: readonly FollowUp[];
  /** True when this provider message had already been processed. */
  readonly duplicate: boolean;
}

export interface RouterDeps<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly conversations: ConversationStore<Tx>;
  readonly messages: MessageStore<Tx>;
  readonly customers: CustomerLookup<Tx>;
  readonly config: ShopConfigStore<Tx>;
  readonly sessions: ConversationSessionService<Tx>;
  readonly consents: ConsentService<Tx>;
  readonly audit: AuditAppender<Tx>;
  readonly outbox: OutboxWriter<Tx>;
  readonly clock?: Clock;
}

export interface RouteRequest {
  readonly shopId: string;
  readonly channel: ChannelType;
  readonly message: InboundMessage;
  readonly traceId: string;
  /** Set when the pipeline has already stored the media for this message. */
  readonly mediaId?: string | null;
}

const CUSTOMER_ACTOR: Actor = { type: 'CUSTOMER', id: null };

export class InboundRouter<Tx> {
  private readonly clock: Clock;

  constructor(private readonly deps: RouterDeps<Tx>) {
    this.clock = deps.clock ?? systemClock;
  }

  async route(request: RouteRequest): Promise<RoutedMessage> {
    return this.deps.uow.transaction(async (tx) => this.run(tx, request));
  }

  private async run(tx: Tx, request: RouteRequest): Promise<RoutedMessage> {
    const { shopId, channel, message } = request;
    const config = await this.loadConfig(tx, shopId);

    // Idempotency first. Meta retries a webhook it did not see a 200 for, and a
    // redelivered photo must not produce a second job-card draft.
    const seen = await this.deps.messages.findByProviderMessageId(
      tx,
      shopId,
      message.providerMessageId,
    );
    if (seen !== null) {
      const conversation = await this.deps.conversations.findById(tx, shopId, seen.conversationId);
      return {
        conversationId: seen.conversationId,
        conversationKind: conversation?.kind ?? 'UNKNOWN',
        messageId: seen.id,
        customerId: conversation?.customerId ?? null,
        senderStaffId: null,
        language: conversation?.language ?? config.languages.default,
        windowExpiresAt: conversation?.windowExpiresAt ?? null,
        followUps: [],
        duplicate: true,
      };
    }

    const groupId = message.groupId;
    const conversation = await this.deps.sessions.openOrGet(tx, {
      shopId,
      channel,
      phoneE164: groupId === null ? message.from : null,
      groupId,
      isStaffGroup: groupId !== null && groupId === config.messaging.staffGroupId,
      displayName: message.fromDisplayName,
      defaultLanguage: config.languages.default,
      traceId: request.traceId,
      actor: CUSTOMER_ACTOR,
    });

    // Attribute the line in the staff group to the technician who wrote it, so
    // a technician note keeps its author all the way to the evidence bundle.
    const senderStaffId =
      conversation.kind === 'STAFF_GROUP'
        ? await this.deps.customers.findStaffIdByPhone(tx, shopId, message.from)
        : null;

    const windowExpiresAt =
      conversation.kind === 'STAFF_GROUP'
        ? conversation.windowExpiresAt
        : await this.deps.sessions.recordInbound(tx, conversation.id, message.timestamp);

    const messageId = uuidv7();
    await this.deps.messages.insert(tx, {
      id: messageId,
      shopId,
      conversationId: conversation.id,
      direction: 'INBOUND',
      status: 'DELIVERED',
      channel,
      kind: message.kind,
      language: conversation.language,
      body: textOf(message),
      purpose: 'SERVICE',
      providerMessageId: message.providerMessageId,
      mediaId: request.mediaId ?? null,
      senderStaffId,
      interactive:
        message.replyId === null
          ? null
          : { replyId: message.replyId, title: message.replyTitle ?? '' },
      createdAt: message.timestamp,
    });

    const followUps = await this.deriveFollowUps(tx, request, conversation, config, messageId);

    await this.deps.audit.append(tx, {
      shopId,
      actorType: senderStaffId === null ? 'CUSTOMER' : 'STAFF',
      actorId: senderStaffId,
      action: 'message.received',
      entityType: 'Message',
      entityId: messageId,
      payload: {
        conversationId: conversation.id,
        conversationKind: conversation.kind,
        kind: message.kind,
        providerMessageId: message.providerMessageId,
        followUps: followUps.map((followUp) => followUp.kind),
      },
      traceId: request.traceId,
    });

    const intakeHint = followUps.find(
      (followUp): followUp is Extract<FollowUp, { kind: 'RUN_INTAKE' }> =>
        followUp.kind === 'RUN_INTAKE',
    );

    const envelope: EventEnvelope = {
      id: uuidv7(),
      type: 'message.received',
      occurredAt: message.timestamp.toISOString(),
      shopId,
      traceId: request.traceId,
      payload: {
        messageId,
        conversationId: conversation.id,
        conversationKind: conversation.kind,
        channel,
        messageKind: message.kind,
        customerId: conversation.customerId,
        senderStaffId,
        mediaId: request.mediaId ?? null,
        intakeHint: intakeHint?.source ?? null,
        actor: senderStaffId === null ? { type: 'CUSTOMER', id: null } : { type: 'STAFF', id: senderStaffId },
      },
    };
    await this.deps.outbox.enqueue(tx, envelope);

    return {
      conversationId: conversation.id,
      conversationKind: conversation.kind,
      messageId,
      customerId: conversation.customerId,
      senderStaffId,
      language: conversation.language,
      windowExpiresAt,
      followUps,
      duplicate: false,
    };
  }

  private async deriveFollowUps(
    tx: Tx,
    request: RouteRequest,
    conversation: ConversationSnapshot,
    config: ShopConfig,
    messageId: string,
  ): Promise<FollowUp[]> {
    const { message } = request;

    // The staff group is an internal channel: no consent semantics, no
    // identification prompts. A captioned photo there is an intake trigger,
    // and a button tap is one of *our* prompts coming back — the Confirm and
    // Discard buttons on a draft summary are tapped here more than anywhere.
    if (conversation.kind === 'STAFF_GROUP') {
      if (message.replyId !== null) {
        return [
          {
            kind: 'INTERACTIVE_REPLY',
            replyId: message.replyId,
            title: message.replyTitle ?? '',
          },
        ];
      }
      const intake = this.intakeSourceFor(message, config, true);
      return intake === null ? [{ kind: 'CONVERSATION' }] : [{ kind: 'RUN_INTAKE', source: intake }];
    }

    // A group that is not the configured staff group gets no automated reply at
    // all: it lands in the inbox for a human to look at. Auto-answering an
    // unknown group would broadcast to strangers.
    if (message.groupId !== null) return [{ kind: 'CONVERSATION' }];

    const followUps: FollowUp[] = [];
    const body = textOf(message);

    // Opt-out beats everything, including an intake trigger in the same
    // message. A customer who typed STOP has stopped.
    const keyword = message.kind === 'TEXT' ? matchKeyword(body) : null;

    if (keyword === 'OPT_OUT') {
      if (conversation.customerId !== null) {
        await this.deps.consents.recordIn(tx, {
          shopId: request.shopId,
          customerId: conversation.customerId,
          purpose: 'SERVICE',
          status: 'REVOKED',
          channel: request.channel,
          source: 'KEYWORD',
          evidence: body.slice(0, 200),
          messageId,
          actor: CUSTOMER_ACTOR,
          traceId: request.traceId,
        });
        // Purpose limitation cuts both ways: a blanket STOP revokes marketing
        // too, because nobody typing STOP means "only the service ones".
        await this.deps.consents.recordIn(tx, {
          shopId: request.shopId,
          customerId: conversation.customerId,
          purpose: 'MARKETING',
          status: 'REVOKED',
          channel: request.channel,
          source: 'KEYWORD',
          evidence: body.slice(0, 200),
          messageId,
          actor: CUSTOMER_ACTOR,
          traceId: request.traceId,
        });
      }
      return [{ kind: 'ACKNOWLEDGE_OPT_OUT' }];
    }

    if (keyword === 'OPT_IN' && conversation.customerId !== null) {
      await this.deps.consents.recordIn(tx, {
        shopId: request.shopId,
        customerId: conversation.customerId,
        purpose: 'SERVICE',
        status: 'GRANTED',
        channel: request.channel,
        source: 'KEYWORD',
        evidence: body.slice(0, 200),
        messageId,
        actor: CUSTOMER_ACTOR,
        traceId: request.traceId,
      });
      return [{ kind: 'ACKNOWLEDGE_OPT_IN' }];
    }

    if (keyword === 'HUMAN') followUps.push({ kind: 'HUMAN_HANDOFF_REQUESTED' });

    if (conversation.kind === 'UNKNOWN') {
      followUps.push({ kind: 'IDENTIFY_UNKNOWN_NUMBER' });
      return followUps;
    }

    if (message.replyId !== null) {
      followUps.push({
        kind: 'INTERACTIVE_REPLY',
        replyId: message.replyId,
        title: message.replyTitle ?? '',
      });
      return followUps;
    }

    const intake = this.intakeSourceFor(message, config, false);
    if (intake !== null) {
      followUps.push({ kind: 'RUN_INTAKE', source: intake });
      return followUps;
    }

    if (followUps.length === 0) followUps.push({ kind: 'CONVERSATION' });
    return followUps;
  }

  /**
   * Decides whether a message is a job-card intake.
   *
   * Photos need the trigger caption from a customer, because a customer sending
   * a photo of a scratch is not filing a job card. From the staff group a photo
   * *is* the workflow, so the trigger is optional there. Voice notes from staff
   * are intake; from a customer they are conversation for the agent.
   */
  private intakeSourceFor(
    message: InboundMessage,
    config: ShopConfig,
    fromStaff: boolean,
  ): IntakeSource | null {
    const trigger = config.intake.photoTrigger.toLowerCase();
    const haystack = `${message.text} ${message.caption ?? ''}`.toLowerCase();
    const triggered = haystack.includes(trigger);

    if (message.media !== null && message.media.kind === 'PHOTO') {
      if (fromStaff || triggered) return 'PHOTO';
      return null;
    }

    if (message.media !== null && message.media.kind === 'AUDIO') {
      return fromStaff ? 'VOICE_NOTE' : null;
    }

    if (message.kind === 'TEXT' && triggered) return 'FORWARDED_TEXT';
    return null;
  }

  private async loadConfig(tx: Tx, shopId: string): Promise<ShopConfig> {
    const stored = await this.deps.config.load(tx, shopId);
    const timezone = (await this.deps.config.loadShopTimezone(tx, shopId)) ?? 'Asia/Kolkata';
    return migrateShopConfig(stored?.raw ?? {}, timezone).config;
  }
}

function textOf(message: InboundMessage): string {
  if (message.text.length > 0) return message.text;
  if (message.caption !== null && message.caption.length > 0) return message.caption;
  if (message.replyTitle !== null) return message.replyTitle;
  if (message.reaction !== null) return message.reaction.emoji ?? '';
  if (message.location !== null) {
    return `📍 ${message.location.latitude.toFixed(5)}, ${message.location.longitude.toFixed(5)}`;
  }
  return '';
}

/** Exported for the pipeline that maps a channel event into the domain shape. */
export function inboundMessageKind(message: InboundMessage): MessageKind {
  return message.kind;
}
