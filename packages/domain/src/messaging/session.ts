import {
  type ChannelType,
  type Clock,
  type Language,
  systemClock,
  uuidv7,
  type EventEnvelope,
} from '@serviceloop/shared';
import type { AuditAppender, OutboxWriter, UnitOfWork } from '../ports';
import type { Actor } from '../job-card/context';
import type { ConversationStore, CustomerLookup } from './ports';
import type { ConversationSnapshot } from './types';

/**
 * The WhatsApp 24-hour customer-service window, as *product* logic.
 *
 * Master §7 makes this core, not adapter detail: it decides whether an
 * escalation rung can speak freely or must spend a template, so phase 3's
 * ladders and phase 4's status updates both read it. The adapter supplies the
 * timestamps; every rule about them lives here.
 */

export const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Each inbound message restarts the window from that message's timestamp. */
export function windowExpiryFrom(lastInboundAt: Date): Date {
  return new Date(lastInboundAt.getTime() + CUSTOMER_SERVICE_WINDOW_MS);
}

/**
 * The boundary is exclusive: at exactly 24 hours the window is closed. Meta is
 * the authority on the real edge and rounds against us, so a message sent on
 * the boundary would be refused with a 131047 — better to spend a template.
 */
export function isWindowOpen(windowExpiresAt: Date | null, at: Date): boolean {
  return windowExpiresAt !== null && at.getTime() < windowExpiresAt.getTime();
}

export function windowRemainingMs(windowExpiresAt: Date | null, at: Date): number {
  if (windowExpiresAt === null) return 0;
  return Math.max(0, windowExpiresAt.getTime() - at.getTime());
}

/* -------------------------------------------------------------------------- *
 * Thread addressing
 * -------------------------------------------------------------------------- */

/**
 * Builds the indexable thread key.
 *
 * A WhatsApp `wa_id` is the customer's phone number, so it may not be stored in
 * a plain, indexed column — the customers table encrypts exactly that value two
 * tables over. Person threads are therefore keyed on a blind index of the
 * number; group ids are not personal data and are stored verbatim.
 */
export function personThreadKey(blindIndexOfPhone: string): string {
  return `wa:${blindIndexOfPhone}`;
}

export function groupThreadKey(groupId: string): string {
  return `wag:${groupId}`;
}

export function isGroupThreadKey(threadKey: string): boolean {
  return threadKey.startsWith('wag:');
}

/* -------------------------------------------------------------------------- *
 * Service
 * -------------------------------------------------------------------------- */

export interface SessionServiceDeps<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly conversations: ConversationStore<Tx>;
  readonly customers: CustomerLookup<Tx>;
  readonly audit: AuditAppender<Tx>;
  readonly outbox: OutboxWriter<Tx>;
  /** Blind index over the shop's key — supplied by `packages/db`. */
  readonly blindIndex: (shopId: string, phoneE164: string) => string;
  readonly clock?: Clock;
}

export interface OpenThreadInput {
  readonly shopId: string;
  readonly channel: ChannelType;
  /** E.164 of the person, or null when the thread is a group. */
  readonly phoneE164: string | null;
  readonly groupId: string | null;
  /**
   * True only when `groupId` is the shop's *configured* staff group. An
   * unrecognised group is not the technicians' room and gets none of the
   * evidence-channel privileges — it is treated as an unidentified thread.
   */
  readonly isStaffGroup: boolean;
  readonly displayName: string | null;
  readonly defaultLanguage: Language;
  readonly traceId: string;
  readonly actor: Actor;
}

export interface WindowState {
  readonly open: boolean;
  readonly expiresAt: Date | null;
  readonly remainingMs: number;
}

export class ConversationSessionService<Tx> {
  private readonly clock: Clock;

  constructor(private readonly deps: SessionServiceDeps<Tx>) {
    this.clock = deps.clock ?? systemClock;
  }

  threadKeyFor(shopId: string, phoneE164: string | null, groupId: string | null): string {
    if (groupId !== null) return groupThreadKey(groupId);
    if (phoneE164 === null) {
      throw new Error('A conversation thread needs either a phone number or a group id');
    }
    return personThreadKey(this.deps.blindIndex(shopId, phoneE164));
  }

  /**
   * Finds the thread for an address, creating it when this is the first
   * contact. A thread exists from the first inbound byte even when we have no
   * idea who is on the other end — an unidentified caller still gets a record,
   * and therefore still gets an answer rather than silence.
   */
  async openOrGet(tx: Tx, input: OpenThreadInput): Promise<ConversationSnapshot> {
    const threadKey = this.threadKeyFor(input.shopId, input.phoneE164, input.groupId);

    const existing = await this.deps.conversations.findByThreadKey(
      tx,
      input.shopId,
      input.channel,
      threadKey,
    );
    if (existing !== null) return existing;

    const customerId =
      input.phoneE164 === null || input.groupId !== null
        ? null
        : await this.deps.customers.findCustomerIdByPhone(tx, input.shopId, input.phoneE164);

    const language =
      customerId === null
        ? input.defaultLanguage
        : ((await this.deps.customers.loadCustomerLanguage(tx, input.shopId, customerId)) ??
          input.defaultLanguage);

    const kind: ConversationSnapshot['kind'] =
      input.groupId !== null
        ? input.isStaffGroup
          ? 'STAFF_GROUP'
          : 'UNKNOWN'
        : customerId === null
          ? 'UNKNOWN'
          : 'CUSTOMER';

    const created = await this.deps.conversations.create(tx, {
      shopId: input.shopId,
      kind,
      channel: input.channel,
      customerId,
      externalThreadId: threadKey,
      externalAddress: input.groupId === null ? input.phoneE164 : `group:${input.groupId}`,
      displayName: input.displayName,
      language,
    });

    await this.deps.audit.append(tx, {
      shopId: input.shopId,
      actorType: input.actor.type,
      actorId: input.actor.id,
      action: 'conversation.opened',
      entityType: 'Conversation',
      entityId: created.id,
      // The address itself is PII and never lands in the audit payload; the
      // thread key is a blind index and is safe to record.
      payload: { kind, channel: input.channel, threadKey, customerId },
      traceId: input.traceId,
    });

    const envelope: EventEnvelope = {
      id: uuidv7(),
      type: 'conversation.opened',
      occurredAt: this.clock.now().toISOString(),
      shopId: input.shopId,
      traceId: input.traceId,
      payload: {
        conversationId: created.id,
        kind,
        channel: input.channel,
        customerId,
        actor: { type: input.actor.type, id: input.actor.id },
      },
    };
    await this.deps.outbox.enqueue(tx, envelope);

    return created;
  }

  /** Restarts the 24-hour window. Called for every inbound customer message. */
  async recordInbound(
    tx: Tx,
    conversationId: string,
    at: Date,
    language?: Language,
  ): Promise<Date> {
    const windowExpiresAt = windowExpiryFrom(at);
    await this.deps.conversations.recordInbound(tx, {
      conversationId,
      at,
      windowExpiresAt,
      ...(language === undefined ? {} : { language }),
    });
    return windowExpiresAt;
  }

  async recordOutbound(tx: Tx, conversationId: string, at: Date): Promise<void> {
    await this.deps.conversations.recordOutbound(tx, { conversationId, at });
  }

  windowState(conversation: ConversationSnapshot, at: Date = this.clock.now()): WindowState {
    return {
      open: isWindowOpen(conversation.windowExpiresAt, at),
      expiresAt: conversation.windowExpiresAt,
      remainingMs: windowRemainingMs(conversation.windowExpiresAt, at),
    };
  }

  /**
   * The question every sender must ask before composing free-form copy. When
   * this is false the only legal business-initiated message is an approved
   * template — or another channel entirely.
   */
  async canSendSessionMessage(shopId: string, conversationId: string): Promise<boolean> {
    return this.deps.uow.transaction(async (tx) => {
      const conversation = await this.deps.conversations.findById(tx, shopId, conversationId);
      if (conversation === null) return false;
      // The staff group is an internal channel; the customer-service window is
      // a customer-protection rule and does not apply to it.
      if (conversation.kind === 'STAFF_GROUP') return true;
      return isWindowOpen(conversation.windowExpiresAt, this.clock.now());
    });
  }
}
