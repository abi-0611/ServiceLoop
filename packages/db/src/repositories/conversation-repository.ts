import { isWindowOpen } from '@serviceloop/domain';
import {
  type ConversationList,
  type ConversationSummary,
  type ConversationThread,
  maskPhone,
  type MessageDto,
  type MessageMediaDto,
} from '@serviceloop/shared';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { Database, Executor } from '../client';
import { consents, conversations, messages } from '../schema/comms';
import { customers, staff } from '../schema/core';
import { jobCardDrafts } from '../schema/intake';
import { mediaAssets } from '../schema/jobs';

/**
 * Read model for the Conversations inbox (phase 2.10).
 *
 * Shop-scoped on every query, like every other repository: a thread belonging
 * to another shop is absent from the result rather than forbidden, so the API
 * returns 404 and the endpoint cannot be used to discover that it exists.
 *
 * Nothing here writes. The inbox's one write — an advisor's reply — goes
 * through `OutboundGate`, because a message typed by a human still has to
 * respect an opt-out.
 */
export class ConversationRepository {
  constructor(private readonly db: Database) {}

  async list(
    shopId: string,
    options: { readonly limit?: number; readonly at?: Date } = {},
    executor: Executor = this.db,
  ): Promise<ConversationList> {
    const at = options.at ?? new Date();
    const rows = await executor
      .select({
        id: conversations.id,
        kind: conversations.kind,
        state: conversations.state,
        customerId: conversations.customerId,
        displayName: conversations.displayName,
        address: conversations.externalAddressEncrypted,
        language: conversations.language,
        unreadCount: conversations.unreadCount,
        lastInboundAt: conversations.lastInboundAt,
        lastOutboundAt: conversations.lastOutboundAt,
        windowExpiresAt: conversations.windowExpiresAt,
        humanOverrideAt: conversations.humanOverrideAt,
        customerName: customers.fullNameEncrypted,
      })
      .from(conversations)
      .leftJoin(customers, eq(customers.id, conversations.customerId))
      .where(eq(conversations.shopId, shopId))
      .orderBy(desc(conversations.updatedAt))
      .limit(options.limit ?? 100);

    if (rows.length === 0) return { threads: [], unreadTotal: 0 };

    const ids = rows.map((row) => row.id);
    const [previews, consentByCustomer] = await Promise.all([
      this.lastMessages(ids, executor),
      this.serviceConsent(
        shopId,
        rows.map((row) => row.customerId).filter((id): id is string => id !== null),
        executor,
      ),
    ]);

    const threads = rows.map((row): ConversationSummary => {
      const preview = previews.get(row.id);
      return {
        id: row.id,
        kind: row.kind,
        state: row.state,
        title: titleFor(row),
        customerId: row.customerId,
        addressMasked: maskAddress(row.address),
        language: row.language,
        unreadCount: row.unreadCount,
        lastMessageAt: (preview?.createdAt ?? row.lastInboundAt ?? row.lastOutboundAt)
          ? (preview?.createdAt ?? row.lastInboundAt ?? row.lastOutboundAt)?.toISOString() ?? null
          : null,
        lastMessagePreview: preview?.body ?? '',
        lastMessageDirection: preview?.direction ?? null,
        windowExpiresAt: row.windowExpiresAt?.toISOString() ?? null,
        // The staff group is internal and has no customer-service window; it is
        // always writable, and saying "closed" in the inbox would be a lie.
        windowOpen: row.kind === 'STAFF_GROUP' ? true : isWindowOpen(row.windowExpiresAt, at),
        humanOverrideAt: row.humanOverrideAt?.toISOString() ?? null,
        serviceConsent:
          row.customerId === null ? null : (consentByCustomer.get(row.customerId) ?? null),
      };
    });

    return {
      threads,
      unreadTotal: threads.reduce((total, thread) => total + thread.unreadCount, 0),
    };
  }

  async thread(
    shopId: string,
    conversationId: string,
    options: { readonly limit?: number; readonly at?: Date } = {},
    executor: Executor = this.db,
  ): Promise<ConversationThread | null> {
    const list = await this.list(shopId, { limit: 500, ...options }, executor);
    const conversation = list.threads.find((thread) => thread.id === conversationId);
    if (conversation === undefined) return null;

    const rows = await executor
      .select({
        message: messages,
        senderName: staff.fullName,
        mediaId: mediaAssets.id,
        mediaKind: mediaAssets.kind,
        mediaContentType: mediaAssets.contentType,
        mediaSize: mediaAssets.sizeBytes,
        mediaDuration: mediaAssets.durationMs,
        mediaThumbnail: mediaAssets.thumbnailKey,
      })
      .from(messages)
      .leftJoin(staff, eq(staff.id, messages.senderStaffId))
      .leftJoin(mediaAssets, eq(mediaAssets.id, messages.mediaId))
      .where(and(eq(messages.shopId, shopId), eq(messages.conversationId, conversationId)))
      .orderBy(asc(messages.createdAt))
      .limit(options.limit ?? 200);

    const openDrafts = await executor
      .select({ id: jobCardDrafts.id })
      .from(jobCardDrafts)
      .where(
        and(
          eq(jobCardDrafts.shopId, shopId),
          eq(jobCardDrafts.conversationId, conversationId),
          eq(jobCardDrafts.status, 'AWAITING_CONFIRMATION'),
        ),
      )
      .orderBy(desc(jobCardDrafts.createdAt));

    return {
      conversation,
      messages: rows.map((row): MessageDto => {
        const message = row.message;
        return {
          id: message.id,
          direction: message.direction,
          status: message.status,
          kind: message.kind,
          purpose: message.purpose,
          language: message.language,
          body: message.body,
          templateName: message.templateName,
          interactive: message.interactive ?? null,
          media:
            row.mediaId === null
              ? null
              : ({
                  id: row.mediaId,
                  kind: row.mediaKind ?? 'DOCUMENT',
                  contentType: row.mediaContentType ?? 'application/octet-stream',
                  sizeBytes: Number(row.mediaSize ?? 0),
                  durationMs: row.mediaDuration,
                  url: `/media/${row.mediaId}`,
                  thumbnailUrl:
                    row.mediaThumbnail === null ? null : `/media/${row.mediaId}/thumbnail`,
                } satisfies MessageMediaDto),
          senderName: row.senderName,
          isHumanReply: message.isHumanReply,
          createdByAgent: message.createdByAgent,
          blockedCode: message.blockedCode,
          blockedReason: message.blockedReason,
          scheduledFor: message.scheduledFor?.toISOString() ?? null,
          sentAt: message.sentAt?.toISOString() ?? null,
          deliveredAt: message.deliveredAt?.toISOString() ?? null,
          readAt: message.readAt?.toISOString() ?? null,
          createdAt: message.createdAt.toISOString(),
        };
      }),
      openDraftIds: openDrafts.map((row) => row.id),
    };
  }

  /**
   * The customer thread for a WhatsApp number, if this shop has one.
   *
   * The console's "message this customer" action needs it, and so does the
   * demo: an outbound flow has to have somewhere to send.
   */
  async findCustomerThreadId(
    shopId: string,
    customerId: string,
    executor: Executor = this.db,
  ): Promise<string | null> {
    const rows = await executor
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.shopId, shopId),
          eq(conversations.customerId, customerId),
          eq(conversations.channel, 'WHATSAPP'),
        ),
      )
      .orderBy(desc(conversations.updatedAt))
      .limit(1);

    return rows[0]?.id ?? null;
  }

  private async lastMessages(
    conversationIds: readonly string[],
    executor: Executor,
  ): Promise<
    Map<string, { body: string; direction: 'INBOUND' | 'OUTBOUND'; createdAt: Date }>
  > {
    const rows = await executor
      .select({
        conversationId: messages.conversationId,
        body: messages.body,
        direction: messages.direction,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(inArray(messages.conversationId, [...conversationIds]))
      .orderBy(desc(messages.createdAt));

    const latest = new Map<
      string,
      { body: string; direction: 'INBOUND' | 'OUTBOUND'; createdAt: Date }
    >();
    for (const row of rows) {
      if (latest.has(row.conversationId)) continue;
      latest.set(row.conversationId, {
        body: row.body.slice(0, 160),
        direction: row.direction,
        createdAt: row.createdAt,
      });
    }
    return latest;
  }

  /** Latest SERVICE row per customer — the badge the inbox shows on a thread. */
  private async serviceConsent(
    shopId: string,
    customerIds: readonly string[],
    executor: Executor,
  ): Promise<Map<string, 'PENDING' | 'GRANTED' | 'REVOKED'>> {
    if (customerIds.length === 0) return new Map();

    const rows = await executor
      .select({
        customerId: consents.customerId,
        status: consents.status,
        createdAt: consents.createdAt,
      })
      .from(consents)
      .where(
        and(
          eq(consents.shopId, shopId),
          eq(consents.purpose, 'SERVICE'),
          inArray(consents.customerId, [...customerIds]),
        ),
      )
      .orderBy(desc(consents.createdAt));

    const latest = new Map<string, 'PENDING' | 'GRANTED' | 'REVOKED'>();
    for (const row of rows) {
      if (!latest.has(row.customerId)) latest.set(row.customerId, row.status);
    }
    return latest;
  }
}

function titleFor(row: {
  kind: string;
  displayName: string | null;
  customerName: string | null;
}): string {
  if (row.kind === 'STAFF_GROUP') return 'Workshop floor (staff group)';
  return row.customerName ?? row.displayName ?? 'Unknown number';
}

/**
 * The address column is decrypted on read, so it must never reach the console
 * whole — an inbox open on a counter screen is a list of customer phone numbers.
 */
function maskAddress(address: string | null): string {
  if (address === null) return '—';
  if (address.startsWith('group:')) return 'group';
  return maskPhone(address);
}
