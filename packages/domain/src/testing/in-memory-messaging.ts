import { createHmac } from 'node:crypto';
import type { ChannelType, ConversationCategory, Language, MessageStatus } from '@serviceloop/shared';
import { uuidv7 } from '@serviceloop/shared';
import type {
  ChannelSendRequest,
  ChannelSendResult,
  ChannelSender,
  ConsentStore,
  ConversationStore,
  CreateConversationInput,
  CustomerLookup,
  InsertMessageInput,
  MessageStore,
  ScheduledMessage,
} from '../messaging/ports';
import type {
  InsertMediaAssetInput,
  MediaAssetRecord,
  MediaStore,
} from '../messaging/media';
import type {
  ConsentSnapshotRow,
  ConversationSnapshot,
  MessageSnapshot,
  OutboundContent,
} from '../messaging/types';
import type { ConversationRow, InMemoryWorld, MemoryTx } from './in-memory';

/**
 * In-memory messaging ports.
 *
 * Same standard as the job-card stores next door: these are real
 * implementations of the contracts, not mocks that return whatever a test
 * wants. `packages/db` runs the same scenarios against Postgres, so a rule that
 * holds here is a rule that holds in production.
 */

function toSnapshot(row: ConversationRow): ConversationSnapshot {
  return { ...row };
}

export class InMemoryConversationStore implements ConversationStore<MemoryTx> {
  constructor(private readonly world: InMemoryWorld) {}

  async findByThreadKey(
    _tx: MemoryTx,
    shopId: string,
    channel: ChannelType,
    externalThreadId: string,
  ): Promise<ConversationSnapshot | null> {
    const row = [...this.world.conversations.values()].find(
      (candidate) =>
        candidate.shopId === shopId &&
        candidate.channel === channel &&
        candidate.externalThreadId === externalThreadId,
    );
    return row === undefined ? null : toSnapshot(row);
  }

  async findById(
    _tx: MemoryTx,
    shopId: string,
    conversationId: string,
  ): Promise<ConversationSnapshot | null> {
    const row = this.world.conversations.get(conversationId);
    return row === undefined || row.shopId !== shopId ? null : toSnapshot(row);
  }

  async lockById(
    tx: MemoryTx,
    shopId: string,
    conversationId: string,
  ): Promise<ConversationSnapshot | null> {
    // Single-threaded by construction; the Postgres store takes a real row lock.
    return this.findById(tx, shopId, conversationId);
  }

  async findByCustomer(
    _tx: MemoryTx,
    shopId: string,
    customerId: string,
    channel: ChannelType,
  ): Promise<ConversationSnapshot | null> {
    const row = [...this.world.conversations.values()].find(
      (candidate) =>
        candidate.shopId === shopId &&
        candidate.customerId === customerId &&
        candidate.channel === channel,
    );
    return row === undefined ? null : toSnapshot(row);
  }

  async create(_tx: MemoryTx, input: CreateConversationInput): Promise<ConversationSnapshot> {
    const duplicate = [...this.world.conversations.values()].some(
      (candidate) =>
        candidate.shopId === input.shopId &&
        candidate.channel === input.channel &&
        candidate.externalThreadId === input.externalThreadId,
    );
    if (duplicate) {
      throw new Error(
        `conversations_shop_channel_thread_key: ${input.channel}/${input.externalThreadId} already exists`,
      );
    }

    const row: ConversationRow = {
      id: uuidv7(),
      shopId: input.shopId,
      kind: input.kind,
      channel: input.channel,
      customerId: input.customerId,
      externalThreadId: input.externalThreadId,
      externalAddress: input.externalAddress,
      displayName: input.displayName,
      state: 'OPEN',
      language: input.language,
      lastInboundAt: null,
      lastOutboundAt: null,
      windowExpiresAt: null,
      unreadCount: 0,
      humanOverrideAt: null,
    };
    this.world.conversations.set(row.id, row);
    return toSnapshot(row);
  }

  async recordInbound(
    _tx: MemoryTx,
    input: {
      conversationId: string;
      at: Date;
      windowExpiresAt: Date;
      language?: Language;
    },
  ): Promise<void> {
    const row = this.world.conversations.get(input.conversationId);
    if (row === undefined) throw new Error(`No such conversation ${input.conversationId}`);
    row.lastInboundAt = input.at;
    row.windowExpiresAt = input.windowExpiresAt;
    row.unreadCount += 1;
    if (input.language !== undefined) row.language = input.language;
  }

  async recordOutbound(_tx: MemoryTx, input: { conversationId: string; at: Date }): Promise<void> {
    const row = this.world.conversations.get(input.conversationId);
    if (row === undefined) throw new Error(`No such conversation ${input.conversationId}`);
    row.lastOutboundAt = input.at;
  }

  async markHumanOverride(
    _tx: MemoryTx,
    input: { conversationId: string; at: Date },
  ): Promise<void> {
    const row = this.world.conversations.get(input.conversationId);
    if (row === undefined) throw new Error(`No such conversation ${input.conversationId}`);
    row.humanOverrideAt = input.at;
  }

  async attachCustomer(
    _tx: MemoryTx,
    input: { conversationId: string; customerId: string; displayName: string | null },
  ): Promise<void> {
    const row = this.world.conversations.get(input.conversationId);
    if (row === undefined) throw new Error(`No such conversation ${input.conversationId}`);
    row.customerId = input.customerId;
    row.kind = 'CUSTOMER';
    if (input.displayName !== null) row.displayName = input.displayName;
  }

  async clearUnread(_tx: MemoryTx, shopId: string, conversationId: string): Promise<void> {
    const row = this.world.conversations.get(conversationId);
    if (row !== undefined && row.shopId === shopId) row.unreadCount = 0;
  }

  async setLanguage(_tx: MemoryTx, conversationId: string, language: Language): Promise<void> {
    const row = this.world.conversations.get(conversationId);
    if (row !== undefined) row.language = language;
  }
}

export class InMemoryMessageStore implements MessageStore<MemoryTx> {
  constructor(private readonly world: InMemoryWorld) {}

  /**
   * The last `limit` turns of a thread, oldest first.
   *
   * Not part of `MessageStore` — the port is what the *gate* needs, and this is
   * what a reader needs. Phase 3's agent takes it as an injected function, so
   * the console and the runtime can shape the tail differently without the
   * domain growing a query surface.
   */
  async recentForConversation(
    _tx: MemoryTx,
    shopId: string,
    conversationId: string,
    limit: number,
  ): Promise<readonly MessageSnapshot[]> {
    return this.world.messages
      .filter((row) => row.shopId === shopId && row.conversationId === conversationId)
      .slice(-limit)
      .map((row) => ({
        id: row.id,
        conversationId: row.conversationId,
        direction: row.direction,
        status: row.status as MessageSnapshot['status'],
        kind: row.kind as MessageSnapshot['kind'],
        purpose: row.purpose,
        body: row.body,
        sentAt: row.sentAt,
        createdAt: row.createdAt,
      }));
  }

  async insert(_tx: MemoryTx, input: InsertMessageInput): Promise<void> {
    if (input.status === 'BLOCKED' && (input.blockedCode == null || input.blockedReason == null)) {
      // Mirrors the `messages_blocked_carries_reason` database constraint: a
      // refusal that does not say why is a silent drop.
      throw new Error('messages_blocked_carries_reason: a BLOCKED message needs a code and reason');
    }
    if (input.providerMessageId != null) {
      const clash = this.world.messages.some(
        (row) => row.shopId === input.shopId && row.providerMessageId === input.providerMessageId,
      );
      if (clash) throw new Error(`messages_provider_id_key: ${input.providerMessageId} already seen`);
    }

    this.world.messages.push({
      id: input.id,
      shopId: input.shopId,
      conversationId: input.conversationId,
      direction: input.direction,
      status: input.status,
      kind: input.kind,
      purpose: input.purpose,
      body: input.body,
      templateName: input.templateName ?? null,
      templateLanguage: input.templateLanguage ?? null,
      templateVariables: input.templateVariables ?? null,
      conversationCategory: input.conversationCategory ?? null,
      interactive: input.interactive ?? null,
      language: input.language,
      providerMessageId: input.providerMessageId ?? null,
      mediaId: input.mediaId ?? null,
      jobCardId: input.jobCardId ?? null,
      senderStaffId: input.senderStaffId ?? null,
      createdByAgent: input.createdByAgent ?? false,
      isHumanReply: input.isHumanReply ?? false,
      agentRunId: input.agentRunId ?? null,
      approvedByStaffId: input.approvedByStaffId ?? null,
      scheduledFor: input.scheduledFor ?? null,
      blockedCode: input.blockedCode ?? null,
      blockedReason: input.blockedReason ?? null,
      errorCode: null,
      failureReason: null,
      sentAt: input.sentAt ?? null,
      createdAt: input.createdAt,
    });
  }

  async findByProviderMessageId(
    _tx: MemoryTx,
    shopId: string,
    providerMessageId: string,
  ): Promise<{ id: string; conversationId: string } | null> {
    const row = this.world.messages.find(
      (candidate) =>
        candidate.shopId === shopId && candidate.providerMessageId === providerMessageId,
    );
    return row === undefined ? null : { id: row.id, conversationId: row.conversationId };
  }

  async markSent(
    _tx: MemoryTx,
    input: {
      messageId: string;
      providerMessageId: string;
      providerConversationId: string | null;
      conversationCategory: ConversationCategory | null;
      sentAt: Date;
    },
  ): Promise<void> {
    const row = this.world.messages.find((candidate) => candidate.id === input.messageId);
    if (row === undefined) throw new Error(`No such message ${input.messageId}`);
    row.status = 'SENT';
    row.providerMessageId = input.providerMessageId;
    row.sentAt = input.sentAt;
  }

  async reschedule(
    _tx: MemoryTx,
    input: { readonly messageId: string; readonly scheduledFor: Date },
  ): Promise<void> {
    const message = this.world.messages.find((row) => row.id === input.messageId);
    if (message === undefined) return;
    message.status = 'QUEUED';
    message.scheduledFor = input.scheduledFor;
  }

  async markFailed(
    _tx: MemoryTx,
    input: { messageId: string; errorCode: string | null; failureReason: string },
  ): Promise<void> {
    const row = this.world.messages.find((candidate) => candidate.id === input.messageId);
    if (row === undefined) throw new Error(`No such message ${input.messageId}`);
    row.status = 'FAILED';
    row.errorCode = input.errorCode;
    row.failureReason = input.failureReason;
  }

  async updateDeliveryState(
    _tx: MemoryTx,
    input: {
      shopId: string;
      providerMessageId: string;
      status: MessageStatus;
      at: Date;
      errorCode?: string | null;
      failureReason?: string | null;
    },
  ): Promise<boolean> {
    const row = this.world.messages.find(
      (candidate) =>
        candidate.shopId === input.shopId &&
        candidate.providerMessageId === input.providerMessageId,
    );
    if (row === undefined) return false;
    row.status = input.status;
    if (input.errorCode !== undefined) row.errorCode = input.errorCode;
    if (input.failureReason !== undefined) row.failureReason = input.failureReason;
    return true;
  }

  async recentOutboundAt(
    _tx: MemoryTx,
    shopId: string,
    customerId: string,
    since: Date,
  ): Promise<readonly Date[]> {
    const conversationIds = new Set(
      [...this.world.conversations.values()]
        .filter((row) => row.shopId === shopId && row.customerId === customerId)
        .map((row) => row.id),
    );

    return this.world.messages
      .filter(
        (row) =>
          conversationIds.has(row.conversationId) &&
          row.direction === 'OUTBOUND' &&
          row.sentAt !== null &&
          row.sentAt.getTime() >= since.getTime(),
      )
      .map((row) => row.sentAt as Date)
      .sort((left, right) => right.getTime() - left.getTime());
  }

  async countOutbound(_tx: MemoryTx, conversationId: string): Promise<number> {
    return this.world.messages.filter(
      (row) =>
        row.conversationId === conversationId &&
        row.direction === 'OUTBOUND' &&
        row.status !== 'BLOCKED',
    ).length;
  }

  async claimDueScheduled(
    _tx: MemoryTx,
    input: { readonly shopId: string | null; readonly dueBefore: Date; readonly limit: number },
  ): Promise<readonly ScheduledMessage[]> {
    return this.world.messages
      .filter(
        (row) =>
          row.direction === 'OUTBOUND' &&
          row.status === 'QUEUED' &&
          row.scheduledFor !== null &&
          row.scheduledFor.getTime() <= input.dueBefore.getTime() &&
          (input.shopId === null || row.shopId === input.shopId),
      )
      .sort((left, right) => (left.scheduledFor?.getTime() ?? 0) - (right.scheduledFor?.getTime() ?? 0))
      .slice(0, input.limit)
      .map((row) => ({
        id: row.id,
        shopId: row.shopId,
        conversationId: row.conversationId,
        customerId: this.world.conversations.get(row.conversationId)?.customerId ?? null,
        purpose: row.purpose,
        kind: row.kind as ScheduledMessage['kind'],
        language: row.language,
        body: row.body,
        templateName: row.templateName,
        templateLanguage: row.templateLanguage,
        templateVariables: row.templateVariables,
        conversationCategory:
          row.conversationCategory as ScheduledMessage['conversationCategory'],
        interactive: row.interactive,
        mediaId: row.mediaId,
        jobCardId: row.jobCardId,
        createdByAgent: row.createdByAgent,
        isHumanReply: row.isHumanReply,
        agentRunId: row.agentRunId,
        approvedByStaffId: row.approvedByStaffId,
        scheduledFor: row.scheduledFor as Date,
      }));
  }
}

export class InMemoryConsentStore implements ConsentStore<MemoryTx> {
  constructor(private readonly world: InMemoryWorld) {}

  async current(
    _tx: MemoryTx,
    shopId: string,
    customerId: string,
  ): Promise<readonly ConsentSnapshotRow[]> {
    const latest = new Map<string, ConsentSnapshotRow>();
    // Append-oriented: iterate in insertion order so the newest row per purpose
    // wins, exactly as the SQL `distinct on … order by created_at desc` does.
    for (const row of this.world.consents) {
      if (row.shopId !== shopId || row.customerId !== customerId) continue;
      latest.set(row.purpose, {
        purpose: row.purpose,
        status: row.status,
        grantedAt: row.grantedAt,
        revokedAt: row.revokedAt,
      });
    }
    return [...latest.values()];
  }

  async record(
    _tx: MemoryTx,
    input: {
      id: string;
      shopId: string;
      customerId: string;
      purpose: 'SERVICE' | 'MARKETING';
      status: 'PENDING' | 'GRANTED' | 'REVOKED';
      channel: ChannelType;
      source: string;
      evidence: string | null;
      messageId: string | null;
      capturedByStaffId: string | null;
      at: Date;
    },
  ): Promise<void> {
    this.world.consents.push({
      id: input.id,
      shopId: input.shopId,
      customerId: input.customerId,
      purpose: input.purpose,
      status: input.status,
      channel: input.channel,
      source: input.source,
      evidence: input.evidence,
      grantedAt: input.status === 'GRANTED' ? input.at : null,
      revokedAt: input.status === 'REVOKED' ? input.at : null,
      createdAt: input.at,
    });
  }
}

export class InMemoryCustomerLookup implements CustomerLookup<MemoryTx> {
  constructor(private readonly world: InMemoryWorld) {}

  async findCustomerIdByPhone(
    _tx: MemoryTx,
    shopId: string,
    phoneE164: string,
  ): Promise<string | null> {
    return this.world.customers.get(`${shopId}:${phoneE164}`)?.id ?? null;
  }

  async findStaffIdByPhone(
    _tx: MemoryTx,
    shopId: string,
    phoneE164: string,
  ): Promise<string | null> {
    return this.world.staffByPhone.get(`${shopId}:${phoneE164}`) ?? null;
  }

  async loadCustomerLanguage(
    _tx: MemoryTx,
    shopId: string,
    customerId: string,
  ): Promise<Language | null> {
    for (const [key, value] of this.world.customers) {
      if (key.startsWith(`${shopId}:`) && value.id === customerId) return value.language;
    }
    return null;
  }

  async loadCustomerVehicleLabel(
    _tx: MemoryTx,
    shopId: string,
    customerId: string,
  ): Promise<string | null> {
    for (const [key, value] of this.world.customers) {
      if (key.startsWith(`${shopId}:`) && value.id === customerId) return value.vehicleLabel;
    }
    return null;
  }
}

/* -------------------------------------------------------------------------- *
 * Media
 * -------------------------------------------------------------------------- */

export class InMemoryMediaStore implements MediaStore<MemoryTx> {
  constructor(private readonly world: InMemoryWorld) {}

  async insert(_tx: MemoryTx, input: InsertMediaAssetInput): Promise<void> {
    this.world.media.set(input.id, {
      id: input.id,
      shopId: input.shopId,
      jobCardId: input.jobCardId,
      kind: input.kind,
      origin: input.origin,
      bucket: input.bucket,
      storageKey: input.storageKey,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      checksumSha256: input.checksumSha256,
      caption: input.caption,
      thumbnailKey: input.thumbnailKey,
      widthPx: input.widthPx,
      heightPx: input.heightPx,
      durationMs: input.durationMs,
      derivedKey: input.derivedKey,
      derivedContentType: input.derivedContentType,
      providerMediaId: input.providerMediaId,
      createdAt: input.capturedAt,
    });
  }

  async findById(
    _tx: MemoryTx,
    shopId: string,
    mediaId: string,
  ): Promise<MediaAssetRecord | null> {
    const row = this.world.media.get(mediaId);
    return row === undefined || row.shopId !== shopId ? null : row;
  }

  async findByProviderMediaId(
    _tx: MemoryTx,
    shopId: string,
    providerMediaId: string,
  ): Promise<MediaAssetRecord | null> {
    for (const row of this.world.media.values()) {
      if (row.shopId === shopId && row.providerMediaId === providerMediaId) return row;
    }
    return null;
  }

  async attachDerivative(
    _tx: MemoryTx,
    input: {
      readonly shopId: string;
      readonly mediaId: string;
      readonly derivedKey: string;
      readonly derivedContentType: string;
      readonly durationMs: number | null;
    },
  ): Promise<void> {
    const row = this.world.media.get(input.mediaId);
    if (row === undefined || row.shopId !== input.shopId) return;
    row.derivedKey = input.derivedKey;
    row.derivedContentType = input.derivedContentType;
    if (input.durationMs !== null) row.durationMs = input.durationMs;
  }
}

export interface RecordedSend extends ChannelSendRequest {
  readonly providerMessageId: string;
}

/**
 * A `ChannelSender` that records rather than transmits. The `failWith` hook
 * exercises the gate's failure path without needing an adapter that can be
 * told to break.
 */
export class RecordingChannelSender implements ChannelSender {
  readonly channel: ChannelType = 'WHATSAPP';
  readonly sent: RecordedSend[] = [];
  failWith: Error | null = null;

  send(request: ChannelSendRequest): Promise<ChannelSendResult> {
    if (this.failWith !== null) {
      const error = this.failWith;
      this.failWith = null;
      return Promise.reject(error);
    }

    const providerMessageId = `wamid.MEM${this.sent.length + 1}`;
    this.sent.push({ ...request, providerMessageId });
    return Promise.resolve({
      providerMessageId,
      providerConversationId: 'conv-mem',
      category: categoryOf(request.content),
    });
  }

  /** Forgets what has been sent so far, for tests that assert on a later phase. */
  reset(): void {
    this.sent.length = 0;
  }

  lastBody(): string | null {
    const last = this.sent.at(-1);
    if (last === undefined) return null;
    switch (last.content.kind) {
      case 'text':
        return last.content.body;
      case 'template':
        return last.content.preview;
      case 'interactive':
        return last.content.body;
      case 'media':
        return last.content.caption ?? '';
    }
  }
}

function categoryOf(content: OutboundContent): ConversationCategory {
  return content.kind === 'template' ? content.category : 'SERVICE';
}

/** Deterministic stand-in for the shop-scoped blind index in `packages/db`. */
export function testBlindIndex(shopId: string, value: string): string {
  return createHmac('sha256', `test-blind-index:${shopId}`).update(value).digest('hex').slice(0, 32);
}
