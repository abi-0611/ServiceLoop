import { relations } from 'drizzle-orm';
import { boolean, index, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, primaryId, timestamptz, updatedAt } from './columns';
import { customers, shops, staff } from './core';
import { jobCards, mediaAssets } from './jobs';
import {
  channelTypeEnum,
  consentPurposeEnum,
  consentStatusEnum,
  conversationStateEnum,
  languageEnum,
  messageDirectionEnum,
  messageStatusEnum,
} from './enums';

/**
 * Conversation, message and consent tables.
 *
 * Phase 2 builds the WhatsApp channel on exactly these — the handoff note says
 * extend, never redesign. `windowExpiresAt` is the WhatsApp 24-hour
 * customer-service window; outside it, only approved templates may be sent.
 */

export const conversations = pgTable(
  'conversations',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    channel: channelTypeEnum('channel').notNull(),
    /** Provider thread identity (WhatsApp wa_id, call sid, …). */
    externalThreadId: text('external_thread_id'),
    state: conversationStateEnum('state').notNull().default('OPEN'),
    language: languageEnum('language').notNull().default('en'),
    lastInboundAt: timestamptz('last_inbound_at'),
    lastOutboundAt: timestamptz('last_outbound_at'),
    /** 24h after the last inbound message; null when no window is open. */
    windowExpiresAt: timestamptz('window_expires_at'),
    assignedStaffId: uuid('assigned_staff_id').references(() => staff.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('conversations_shop_customer_channel_key').on(
      table.shopId,
      table.customerId,
      table.channel,
    ),
    index('conversations_shop_state_idx').on(table.shopId, table.state),
    index('conversations_window_idx').on(table.windowExpiresAt),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    jobCardId: uuid('job_card_id').references(() => jobCards.id, { onDelete: 'set null' }),
    direction: messageDirectionEnum('direction').notNull(),
    status: messageStatusEnum('status').notNull().default('DRAFT'),
    channel: channelTypeEnum('channel').notNull(),
    language: languageEnum('language').notNull().default('en'),
    body: text('body').notNull(),
    /** Set for template sends; the template id itself lives in shop config. */
    templateName: text('template_name'),
    /** Purpose tag drives the consent gate on every outbound message. */
    purpose: consentPurposeEnum('purpose').notNull().default('SERVICE'),
    mediaId: uuid('media_id').references(() => mediaAssets.id, { onDelete: 'set null' }),
    providerMessageId: text('provider_message_id'),
    /** Evidence ids cited by this message — the claim-anchoring audit trail. */
    evidenceRefs: jsonb('evidence_refs').notNull().default([]),
    createdByAgent: boolean('created_by_agent').notNull().default(false),
    agentRunId: uuid('agent_run_id'),
    approvedByStaffId: uuid('approved_by_staff_id').references(() => staff.id, {
      onDelete: 'set null',
    }),
    sentAt: timestamptz('sent_at'),
    deliveredAt: timestamptz('delivered_at'),
    readAt: timestamptz('read_at'),
    failureReason: text('failure_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('messages_conversation_idx').on(table.conversationId, table.createdAt),
    index('messages_shop_status_idx').on(table.shopId, table.status),
    uniqueIndex('messages_provider_id_key').on(table.shopId, table.providerMessageId),
  ],
);

/**
 * Consent registry with purpose limitation (DPDP Act 2023). Rows are append-
 * only in practice: a revocation is a new row, so the history of what the
 * customer agreed to and when is preserved.
 */
export const consents = pgTable(
  'consents',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    purpose: consentPurposeEnum('purpose').notNull(),
    status: consentStatusEnum('status').notNull().default('PENDING'),
    channel: channelTypeEnum('channel').notNull(),
    /** What the customer actually said/clicked, for a regulator. */
    evidence: text('evidence'),
    grantedAt: timestamptz('granted_at'),
    revokedAt: timestamptz('revoked_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('consents_lookup_idx').on(table.shopId, table.customerId, table.purpose, table.createdAt),
  ],
);

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  shop: one(shops, { fields: [conversations.shopId], references: [shops.id] }),
  customer: one(customers, { fields: [conversations.customerId], references: [customers.id] }),
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
}));

export const consentsRelations = relations(consents, ({ one }) => ({
  customer: one(customers, { fields: [consents.customerId], references: [customers.id] }),
}));
