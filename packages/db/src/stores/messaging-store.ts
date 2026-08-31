import type {
  ConsentSnapshotRow,
  ConsentStore,
  ConversationSnapshot,
  ConversationStore,
  CreateConversationInput,
  CustomerLookup,
  InsertMessageInput,
  MessageSnapshot,
  MessageStore,
  ScheduledMessage,
} from '@serviceloop/domain';
import type {
  ChannelType,
  ConsentPurpose,
  ConversationCategory,
  Language,
  MessageKind,
  MessageStatus,
} from '@serviceloop/shared';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { blindIndex } from '../crypto/pii';
import { consents, conversations, messages } from '../schema/comms';
import { customers, staff, vehicles } from '../schema';

/**
 * Postgres implementations of the messaging ports (phase 2.1–2.10).
 *
 * The domain owns the rules — when a window is open, whether consent covers a
 * purpose, whether a send may happen at all. This file owns the SQL and nothing
 * else. Note in particular what is *not* here: no method sends anything, and
 * none of these stores can be used to bypass `OutboundGate`, because none of
 * them talks to a channel.
 */

const CONVERSATION_COLUMNS = {
  id: conversations.id,
  shopId: conversations.shopId,
  kind: conversations.kind,
  channel: conversations.channel,
  customerId: conversations.customerId,
  externalThreadId: conversations.externalThreadId,
  externalAddress: conversations.externalAddressEncrypted,
  displayName: conversations.displayName,
  state: conversations.state,
  language: conversations.language,
  lastInboundAt: conversations.lastInboundAt,
  lastOutboundAt: conversations.lastOutboundAt,
  windowExpiresAt: conversations.windowExpiresAt,
  unreadCount: conversations.unreadCount,
  humanOverrideAt: conversations.humanOverrideAt,
} as const;

export class PgConversationStore implements ConversationStore<Tx> {
  async findByThreadKey(
    tx: Tx,
    shopId: string,
    channel: ChannelType,
    externalThreadId: string,
  ): Promise<ConversationSnapshot | null> {
    const rows = await tx
      .select(CONVERSATION_COLUMNS)
      .from(conversations)
      .where(
        and(
          eq(conversations.shopId, shopId),
          eq(conversations.channel, channel),
          eq(conversations.externalThreadId, externalThreadId),
        ),
      )
      .limit(1);

    return rows[0] ?? null;
  }

  async findById(
    tx: Tx,
    shopId: string,
    conversationId: string,
  ): Promise<ConversationSnapshot | null> {
    const rows = await tx
      .select(CONVERSATION_COLUMNS)
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.shopId, shopId)))
      .limit(1);

    return rows[0] ?? null;
  }

  /**
   * Row lock on the thread.
   *
   * Meta delivers webhooks concurrently and retries aggressively, so two
   * inbound messages on one thread can land at the same instant. Without this
   * they would race on the window expiry and the unread count.
   */
  async lockById(
    tx: Tx,
    shopId: string,
    conversationId: string,
  ): Promise<ConversationSnapshot | null> {
    const locked = await tx.execute<{ id: string }>(sql`
      select id from conversations
      where id = ${conversationId} and shop_id = ${shopId}
      for update
    `);
    if (locked.rows[0] === undefined) return null;
    return this.findById(tx, shopId, conversationId);
  }

  async findByCustomer(
    tx: Tx,
    shopId: string,
    customerId: string,
    channel: ChannelType,
  ): Promise<ConversationSnapshot | null> {
    const rows = await tx
      .select(CONVERSATION_COLUMNS)
      .from(conversations)
      .where(
        and(
          eq(conversations.shopId, shopId),
          eq(conversations.customerId, customerId),
          eq(conversations.channel, channel),
        ),
      )
      .orderBy(desc(conversations.updatedAt))
      .limit(1);

    return rows[0] ?? null;
  }

  async create(tx: Tx, input: CreateConversationInput): Promise<ConversationSnapshot> {
    const rows = await tx
      .insert(conversations)
      .values({
        shopId: input.shopId,
        kind: input.kind,
        channel: input.channel,
        customerId: input.customerId,
        externalThreadId: input.externalThreadId,
        externalAddressEncrypted: input.externalAddress,
        displayName: input.displayName,
        language: input.language,
      })
      .returning(CONVERSATION_COLUMNS);

    const row = rows[0];
    if (row === undefined) throw new Error('Failed to create the conversation row');
    return row;
  }

  async recordInbound(
    tx: Tx,
    input: {
      readonly conversationId: string;
      readonly at: Date;
      readonly windowExpiresAt: Date;
      readonly language?: Language;
    },
  ): Promise<void> {
    await tx
      .update(conversations)
      .set({
        lastInboundAt: input.at,
        windowExpiresAt: input.windowExpiresAt,
        unreadCount: sql`${conversations.unreadCount} + 1`,
        ...(input.language === undefined ? {} : { language: input.language }),
      })
      .where(eq(conversations.id, input.conversationId));
  }

  async recordOutbound(
    tx: Tx,
    input: { readonly conversationId: string; readonly at: Date },
  ): Promise<void> {
    await tx
      .update(conversations)
      .set({ lastOutboundAt: input.at })
      .where(eq(conversations.id, input.conversationId));
  }

  async markHumanOverride(
    tx: Tx,
    input: { readonly conversationId: string; readonly at: Date },
  ): Promise<void> {
    await tx
      .update(conversations)
      .set({ humanOverrideAt: input.at })
      .where(eq(conversations.id, input.conversationId));
  }

  async attachCustomer(
    tx: Tx,
    input: {
      readonly conversationId: string;
      readonly customerId: string;
      readonly displayName: string | null;
    },
  ): Promise<void> {
    await tx
      .update(conversations)
      .set({
        customerId: input.customerId,
        kind: 'CUSTOMER',
        ...(input.displayName === null ? {} : { displayName: input.displayName }),
      })
      .where(eq(conversations.id, input.conversationId));
  }

  async clearUnread(tx: Tx, shopId: string, conversationId: string): Promise<void> {
    await tx
      .update(conversations)
      .set({ unreadCount: 0 })
      .where(and(eq(conversations.id, conversationId), eq(conversations.shopId, shopId)));
  }

  async setLanguage(tx: Tx, conversationId: string, language: Language): Promise<void> {
    await tx.update(conversations).set({ language }).where(eq(conversations.id, conversationId));
  }
}

/* -------------------------------------------------------------------------- *
 * Messages
 * -------------------------------------------------------------------------- */

/**
 * Normalises a `timestamptz` read through `tx.execute`.
 *
 * Drizzle's typed selects hand back `Date`s; raw execute hands back whatever
 * the driver produced, which for a timestamp is a string under some pool
 * configurations. The domain does arithmetic on these values, so the conversion
 * belongs at this boundary rather than as a surprise three layers up.
 */
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** `tx.execute` types its rows as records, so the raw shape is declared as one. */
interface ScheduledRow extends Record<string, unknown> {
  readonly id: string;
  readonly shop_id: string;
  readonly conversation_id: string;
  readonly customer_id: string | null;
  readonly purpose: ConsentPurpose;
  readonly kind: MessageKind;
  readonly language: Language;
  readonly body: string;
  readonly template_name: string | null;
  readonly template_language: string | null;
  readonly template_variables: unknown;
  readonly conversation_category: ConversationCategory | null;
  readonly interactive: unknown;
  readonly media_id: string | null;
  readonly job_card_id: string | null;
  readonly created_by_agent: boolean;
  readonly is_human_reply: boolean;
  readonly agent_run_id: string | null;
  readonly approved_by_staff_id: string | null;
  readonly scheduled_for: Date | string;
}

export class PgMessageStore implements MessageStore<Tx> {
  async insert(tx: Tx, input: InsertMessageInput): Promise<void> {
    await tx.insert(messages).values({
      id: input.id,
      shopId: input.shopId,
      conversationId: input.conversationId,
      direction: input.direction,
      status: input.status,
      channel: input.channel,
      kind: input.kind,
      language: input.language,
      body: input.body,
      purpose: input.purpose,
      templateName: input.templateName ?? null,
      templateLanguage: input.templateLanguage ?? null,
      templateVariables:
        input.templateVariables === undefined || input.templateVariables === null
          ? null
          : [...input.templateVariables],
      interactive: input.interactive ?? null,
      conversationCategory: input.conversationCategory ?? null,
      providerMessageId: input.providerMessageId ?? null,
      providerConversationId: input.providerConversationId ?? null,
      mediaId: input.mediaId ?? null,
      jobCardId: input.jobCardId ?? null,
      senderStaffId: input.senderStaffId ?? null,
      replyToMessageId: input.replyToMessageId ?? null,
      evidenceRefs: input.evidenceRefs === undefined ? [] : [...input.evidenceRefs],
      createdByAgent: input.createdByAgent ?? false,
      isHumanReply: input.isHumanReply ?? false,
      agentRunId: input.agentRunId ?? null,
      approvedByStaffId: input.approvedByStaffId ?? null,
      scheduledFor: input.scheduledFor ?? null,
      blockedCode: input.blockedCode ?? null,
      blockedReason: input.blockedReason ?? null,
      sentAt: input.sentAt ?? null,
      createdAt: input.createdAt,
    });
  }

  /**
   * Webhook idempotency. Meta redelivers on any non-2xx and on timeouts, so a
   * duplicate inbound is routine — and a duplicate that got through would
   * produce a second job-card draft from one photograph.
   */
  async findByProviderMessageId(
    tx: Tx,
    shopId: string,
    providerMessageId: string,
  ): Promise<{ readonly id: string; readonly conversationId: string } | null> {
    const rows = await tx
      .select({ id: messages.id, conversationId: messages.conversationId })
      .from(messages)
      .where(
        and(eq(messages.shopId, shopId), eq(messages.providerMessageId, providerMessageId)),
      )
      .limit(1);

    return rows[0] ?? null;
  }

  async markSent(
    tx: Tx,
    input: {
      readonly messageId: string;
      readonly providerMessageId: string;
      readonly providerConversationId: string | null;
      readonly conversationCategory: ConversationCategory | null;
      readonly sentAt: Date;
    },
  ): Promise<void> {
    await tx
      .update(messages)
      .set({
        status: 'SENT',
        providerMessageId: input.providerMessageId,
        providerConversationId: input.providerConversationId,
        conversationCategory: input.conversationCategory,
        sentAt: input.sentAt,
      })
      .where(eq(messages.id, input.messageId));
  }

  async reschedule(
    tx: Tx,
    input: { readonly messageId: string; readonly scheduledFor: Date },
  ): Promise<void> {
    await tx
      .update(messages)
      .set({ status: 'QUEUED', scheduledFor: input.scheduledFor, updatedAt: new Date() })
      .where(eq(messages.id, input.messageId));
  }

  async markFailed(
    tx: Tx,
    input: {
      readonly messageId: string;
      readonly errorCode: string | null;
      readonly failureReason: string;
    },
  ): Promise<void> {
    await tx
      .update(messages)
      .set({
        status: 'FAILED',
        errorCode: input.errorCode,
        failureReason: input.failureReason,
      })
      .where(eq(messages.id, input.messageId));
  }

  /**
   * Delivery receipts arrive out of order — a `read` can overtake its own
   * `delivered`. The status is therefore only ever moved *forward* through the
   * lifecycle, so a late receipt cannot un-read a message in the inbox.
   */
  async updateDeliveryState(
    tx: Tx,
    input: {
      readonly shopId: string;
      readonly providerMessageId: string;
      readonly status: MessageStatus;
      readonly at: Date;
      readonly errorCode?: string | null;
      readonly failureReason?: string | null;
    },
  ): Promise<boolean> {
    const rank: Readonly<Record<string, number>> = {
      DRAFT: 0,
      QUEUED: 1,
      SENT: 2,
      DELIVERED: 3,
      READ: 4,
    };
    const incoming = rank[input.status];

    const updated = await tx.execute<{ id: string }>(sql`
      update messages set
        status = case
          when ${incoming === undefined ? -1 : incoming} > coalesce(
            case status
              when 'DRAFT' then 0 when 'QUEUED' then 1 when 'SENT' then 2
              when 'DELIVERED' then 3 when 'READ' then 4 else -1 end, -1)
          then ${input.status}::message_status
          else status
        end,
        delivered_at = case when ${input.status} in ('DELIVERED', 'READ')
          then coalesce(delivered_at, ${input.at}) else delivered_at end,
        read_at = case when ${input.status} = 'READ'
          then coalesce(read_at, ${input.at}) else read_at end,
        error_code = coalesce(${input.errorCode ?? null}, error_code),
        failure_reason = coalesce(${input.failureReason ?? null}, failure_reason),
        updated_at = now()
      where shop_id = ${input.shopId} and provider_message_id = ${input.providerMessageId}
      returning id
    `);

    return updated.rows.length > 0;
  }

  /** Outbound send times for a customer, newest first — the frequency-cap input. */
  async recentOutboundAt(
    tx: Tx,
    shopId: string,
    customerId: string,
    since: Date,
  ): Promise<readonly Date[]> {
    const rows = await tx.execute<{ sent_at: Date | string }>(sql`
      select m.sent_at
      from messages m
      join conversations c on c.id = m.conversation_id
      where m.shop_id = ${shopId}
        and c.customer_id = ${customerId}
        and m.direction = 'OUTBOUND'
        and m.sent_at is not null
        and m.sent_at >= ${since}
      order by m.sent_at desc
    `);

    // `tx.execute` returns raw driver rows rather than Drizzle-typed ones, so a
    // `timestamptz` arrives as whatever node-postgres hands back — which is not
    // always a `Date`. The domain does arithmetic on these, and a string here
    // fails inside the frequency-cap check rather than at the boundary.
    return rows.rows.map((row) => toDate(row.sent_at));
  }

  /**
   * Claims quiet-hours holds whose time has come.
   *
   * `FOR UPDATE SKIP LOCKED` is the whole point: two workers draining this
   * queue take disjoint batches instead of racing to release the same message,
   * and a message a peer is already working on is skipped rather than waited
   * for. The status flips to `SENT` only once the channel accepts it — the row
   * stays `QUEUED` here so a worker that dies mid-batch loses nothing.
   */
  async claimDueScheduled(
    tx: Tx,
    input: {
      readonly shopId: string | null;
      readonly dueBefore: Date;
      readonly limit: number;
    },
  ): Promise<readonly ScheduledMessage[]> {
    const rows = await tx.execute<ScheduledRow>(sql`
      select id, shop_id, conversation_id, purpose, kind, language, body,
             template_name, template_language, template_variables,
             conversation_category, interactive, media_id, job_card_id,
             created_by_agent, is_human_reply, agent_run_id, approved_by_staff_id,
             scheduled_for,
             (select customer_id from conversations c where c.id = m.conversation_id) as customer_id
      from messages m
      where m.direction = 'OUTBOUND'
        and m.status = 'QUEUED'
        and m.scheduled_for is not null
        and m.scheduled_for <= ${input.dueBefore}
        ${input.shopId === null ? sql`` : sql`and m.shop_id = ${input.shopId}`}
      order by m.scheduled_for
      limit ${input.limit}
      for update skip locked
    `);

    return rows.rows.map((row) => ({
      id: row.id,
      shopId: row.shop_id,
      conversationId: row.conversation_id,
      customerId: row.customer_id,
      purpose: row.purpose,
      kind: row.kind,
      language: row.language,
      body: row.body,
      templateName: row.template_name,
      templateLanguage: row.template_language,
      templateVariables: Array.isArray(row.template_variables)
        ? (row.template_variables as string[])
        : null,
      conversationCategory: row.conversation_category,
      interactive: row.interactive,
      mediaId: row.media_id,
      jobCardId: row.job_card_id,
      createdByAgent: row.created_by_agent,
      isHumanReply: row.is_human_reply,
      agentRunId: row.agent_run_id,
      approvedByStaffId: row.approved_by_staff_id,
      scheduledFor: toDate(row.scheduled_for),
    }));
  }

  /**
   * The last `limit` turns of a thread, oldest first.
   *
   * Not part of `MessageStore` — that port is what the *gate* needs, and this is
   * what a reader needs. The agent takes it as an injected function so the
   * console and the runtime can shape the tail differently without the domain
   * growing a query surface.
   */
  async recentForConversation(
    tx: Tx,
    shopId: string,
    conversationId: string,
    limit: number,
  ): Promise<readonly MessageSnapshot[]> {
    const rows = await tx.execute<{
      id: string;
      conversation_id: string;
      direction: 'INBOUND' | 'OUTBOUND';
      status: MessageStatus;
      kind: MessageKind;
      purpose: ConsentPurpose;
      body: string;
      sent_at: Date | string | null;
      created_at: Date | string;
    }>(sql`
      select id, conversation_id, direction, status, kind, purpose, body, sent_at, created_at
      from messages
      where shop_id = ${shopId} and conversation_id = ${conversationId}
      order by created_at desc
      limit ${limit}
    `);

    // Newest-first from SQL (so the limit takes the *recent* turns), reversed
    // here because a conversation reads in the order it happened.
    return rows.rows.reverse().map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      direction: row.direction,
      status: row.status,
      kind: row.kind,
      purpose: row.purpose,
      body: row.body,
      sentAt: row.sent_at === null ? null : toDate(row.sent_at),
      createdAt: toDate(row.created_at),
    }));
  }

  /**
   * A single held message, in the shape `release` needs.
   *
   * Shares `ScheduledMessage` with the quiet-hours drain deliberately: a
   * candidate an advisor approves and a message whose hold elapsed are the same
   * row taking the same path back through the gate.
   */
  async loadHeld(tx: Tx, shopId: string, messageId: string): Promise<ScheduledMessage | null> {
    const rows = await tx.execute<ScheduledRow>(sql`
      select id, shop_id, conversation_id, purpose, kind, language, body,
             template_name, template_language, template_variables,
             conversation_category, interactive, media_id, job_card_id,
             created_by_agent, is_human_reply, agent_run_id, approved_by_staff_id,
             scheduled_for,
             (select customer_id from conversations c where c.id = m.conversation_id) as customer_id
      from messages m
      where m.id = ${messageId} and m.shop_id = ${shopId} and m.direction = 'OUTBOUND'
    `);

    const row = rows.rows[0];
    if (row === undefined) return null;

    return {
      id: row.id,
      shopId: row.shop_id,
      conversationId: row.conversation_id,
      customerId: row.customer_id,
      purpose: row.purpose,
      kind: row.kind,
      language: row.language,
      body: row.body,
      templateName: row.template_name,
      templateLanguage: row.template_language,
      templateVariables: Array.isArray(row.template_variables)
        ? (row.template_variables as string[])
        : null,
      conversationCategory: row.conversation_category,
      interactive: row.interactive,
      mediaId: row.media_id,
      jobCardId: row.job_card_id,
      createdByAgent: row.created_by_agent,
      isHumanReply: row.is_human_reply,
      agentRunId: row.agent_run_id,
      approvedByStaffId: row.approved_by_staff_id,
      scheduledFor: row.scheduled_for === null ? new Date() : toDate(row.scheduled_for),
    };
  }

  /**
   * The job card a message was pinned against.
   *
   * This is how a technician's reply-to anchors evidence: they answer the
   * message the shop posted about a card, and the card comes back from the
   * message row rather than from anything they had to type.
   */
  async jobCardForMessage(tx: Tx, shopId: string, messageId: string): Promise<string | null> {
    const rows = await tx.execute<{ job_card_id: string | null }>(sql`
      select job_card_id from messages where id = ${messageId} and shop_id = ${shopId}
    `);
    return rows.rows[0]?.job_card_id ?? null;
  }

  async countOutbound(tx: Tx, conversationId: string): Promise<number> {
    const rows = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(messages)
      .where(
        and(eq(messages.conversationId, conversationId), eq(messages.direction, 'OUTBOUND')),
      );

    return Number(rows[0]?.total ?? 0);
  }
}

/* -------------------------------------------------------------------------- *
 * Consent
 * -------------------------------------------------------------------------- */

export class PgConsentStore implements ConsentStore<Tx> {
  /**
   * The latest row per purpose.
   *
   * The registry is append-oriented — a revocation is a new row, never an
   * update — so the history of what a customer agreed to and when survives
   * intact for a regulator, while the gate only ever reads the newest.
   */
  async current(
    tx: Tx,
    shopId: string,
    customerId: string,
  ): Promise<readonly ConsentSnapshotRow[]> {
    const rows = await tx.execute<{
      purpose: ConsentPurpose;
      status: ConsentSnapshotRow['status'];
      granted_at: Date | string | null;
      revoked_at: Date | string | null;
    }>(sql`
      select distinct on (purpose) purpose, status, granted_at, revoked_at
      from consents
      where shop_id = ${shopId} and customer_id = ${customerId}
      order by purpose, created_at desc
    `);

    return rows.rows.map((row) => ({
      purpose: row.purpose,
      status: row.status,
      grantedAt: row.granted_at === null ? null : toDate(row.granted_at),
      revokedAt: row.revoked_at === null ? null : toDate(row.revoked_at),
    }));
  }

  async record(
    tx: Tx,
    input: {
      readonly id: string;
      readonly shopId: string;
      readonly customerId: string;
      readonly purpose: ConsentPurpose;
      readonly status: ConsentSnapshotRow['status'];
      readonly channel: ChannelType;
      readonly source: Parameters<ConsentStore<Tx>['record']>[1]['source'];
      readonly evidence: string | null;
      readonly messageId: string | null;
      readonly capturedByStaffId: string | null;
      readonly at: Date;
    },
  ): Promise<void> {
    await tx.insert(consents).values({
      id: input.id,
      shopId: input.shopId,
      customerId: input.customerId,
      purpose: input.purpose,
      status: input.status,
      channel: input.channel,
      source: input.source,
      evidence: input.evidence,
      messageId: input.messageId,
      capturedByStaffId: input.capturedByStaffId,
      grantedAt: input.status === 'GRANTED' ? input.at : null,
      revokedAt: input.status === 'REVOKED' ? input.at : null,
      createdAt: input.at,
    });
  }
}

/* -------------------------------------------------------------------------- *
 * Caller identification
 * -------------------------------------------------------------------------- */

export class PgCustomerLookup implements CustomerLookup<Tx> {
  async findCustomerIdByPhone(
    tx: Tx,
    shopId: string,
    phoneE164: string,
  ): Promise<string | null> {
    const rows = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(
        and(
          eq(customers.shopId, shopId),
          eq(customers.phoneHash, blindIndex(shopId, phoneE164)),
          sql`${customers.deletedAt} is null`,
        ),
      )
      .limit(1);

    return rows[0]?.id ?? null;
  }

  /**
   * Staff are matched on the same number, which is what lets a message in the
   * technician group be attributed to the person who sent it — the evidence
   * channel is worthless if a photo cannot be traced to a technician.
   */
  async findStaffIdByPhone(tx: Tx, shopId: string, phoneE164: string): Promise<string | null> {
    const rows = await tx
      .select({ id: staff.id })
      .from(staff)
      .where(
        and(
          eq(staff.shopId, shopId),
          eq(staff.phoneHash, blindIndex(shopId, phoneE164)),
          eq(staff.isActive, true),
          sql`${staff.deletedAt} is null`,
        ),
      )
      .limit(1);

    return rows[0]?.id ?? null;
  }

  async loadCustomerLanguage(
    tx: Tx,
    shopId: string,
    customerId: string,
  ): Promise<Language | null> {
    const rows = await tx
      .select({ language: customers.preferredLanguage })
      .from(customers)
      .where(and(eq(customers.id, customerId), eq(customers.shopId, shopId)))
      .limit(1);

    return rows[0]?.language ?? null;
  }

  /**
   * The vehicle a consent ask names.
   *
   * Most recent first, because a customer who has owned two cars is asking
   * about the one they just dropped off. A registration is not personal data
   * on its own and is stored unencrypted, so this is a plain read.
   */
  async loadCustomerVehicleLabel(
    tx: Tx,
    shopId: string,
    customerId: string,
  ): Promise<string | null> {
    const rows = await tx
      .select({
        registration: vehicles.registrationRaw,
        make: vehicles.make,
        model: vehicles.model,
      })
      .from(vehicles)
      .where(
        and(
          eq(vehicles.shopId, shopId),
          eq(vehicles.customerId, customerId),
          sql`${vehicles.deletedAt} is null`,
        ),
      )
      .orderBy(desc(vehicles.createdAt))
      .limit(1);

    const row = rows[0];
    if (row === undefined) return null;

    const model = [row.make, row.model].filter((part) => part !== null && part.length > 0).join(' ');
    return model.length === 0 ? row.registration : `${model} ${row.registration}`;
  }
}

/** Re-exported so a composition root can build the whole set in one import. */
export function createMessagingStores(): {
  conversations: PgConversationStore;
  messages: PgMessageStore;
  consents: PgConsentStore;
  lookup: PgCustomerLookup;
} {
  return {
    conversations: new PgConversationStore(),
    messages: new PgMessageStore(),
    consents: new PgConsentStore(),
    lookup: new PgCustomerLookup(),
  };
}

/** Kept for the frequency-cap query's `since` bound in callers. */
export { gte };
