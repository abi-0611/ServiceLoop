import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, encryptedText, primaryId, timestamptz, updatedAt } from './columns';
import { customers, shops, staff } from './core';
import { jobCards, mediaAssets } from './jobs';
import {
  channelTypeEnum,
  consentPurposeEnum,
  consentSourceEnum,
  consentStatusEnum,
  conversationCategoryEnum,
  conversationKindEnum,
  conversationStateEnum,
  languageEnum,
  messageDirectionEnum,
  messageKindEnum,
  messageStatusEnum,
  waTemplateCategoryEnum,
  waTemplateStatusEnum,
} from './enums';

/**
 * Conversation, message, template and consent tables.
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
    /**
     * Null for the staff group and for numbers we have not identified yet.
     * A thread exists from the first inbound byte; a customer may be attached
     * to it later, which is exactly what the identification prompt does.
     */
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'cascade' }),
    kind: conversationKindEnum('kind').notNull().default('CUSTOMER'),
    channel: channelTypeEnum('channel').notNull(),
    /**
     * Provider thread identity, in a form that is safe to index.
     *
     * A WhatsApp `wa_id` *is* the customer's phone number, so storing it raw
     * would defeat the encrypted phone column two tables over. For person
     * threads this holds `wa:<blind index of the E.164 number>`; group ids are
     * not personal data and are stored verbatim as `wag:<group id>`.
     */
    externalThreadId: text('external_thread_id'),
    /** The raw address the adapter must dial/send to — encrypted at rest. */
    externalAddressEncrypted: encryptedText('external_address_encrypted'),
    /** Free-form label for the inbox when there is no customer record yet. */
    displayName: text('display_name'),
    state: conversationStateEnum('state').notNull().default('OPEN'),
    language: languageEnum('language').notNull().default('en'),
    lastInboundAt: timestamptz('last_inbound_at'),
    lastOutboundAt: timestamptz('last_outbound_at'),
    /** 24h after the last inbound message; null when no window is open. */
    windowExpiresAt: timestamptz('window_expires_at'),
    unreadCount: integer('unread_count').notNull().default(0),
    /**
     * Set when a human advisor replies by hand. Phase 3 reads this to pause any
     * running agent objective on the thread: a person has taken the wheel.
     */
    humanOverrideAt: timestamptz('human_override_at'),
    assignedStaffId: uuid('assigned_staff_id').references(() => staff.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /** The real natural key: one thread per provider address per channel. */
    uniqueIndex('conversations_shop_channel_thread_key').on(
      table.shopId,
      table.channel,
      table.externalThreadId,
    ),
    index('conversations_shop_customer_idx').on(table.shopId, table.customerId, table.channel),
    index('conversations_shop_state_idx').on(table.shopId, table.state),
    index('conversations_shop_kind_idx').on(table.shopId, table.kind, table.updatedAt),
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
    kind: messageKindEnum('kind').notNull().default('TEXT'),
    language: languageEnum('language').notNull().default('en'),
    body: text('body').notNull(),
    /** Set for template sends; the template id itself lives in shop config. */
    templateName: text('template_name'),
    templateLanguage: text('template_language'),
    templateVariables: jsonb('template_variables'),
    /** Interactive payload: buttons/list sent, or the reply that came back. */
    interactive: jsonb('interactive'),
    /** Purpose tag drives the consent gate on every outbound message. */
    purpose: consentPurposeEnum('purpose').notNull().default('SERVICE'),
    /** Meta's billing category for this conversation window (cost metering). */
    conversationCategory: conversationCategoryEnum('conversation_category'),
    providerConversationId: text('provider_conversation_id'),
    mediaId: uuid('media_id').references(() => mediaAssets.id, { onDelete: 'set null' }),
    providerMessageId: text('provider_message_id'),
    replyToMessageId: uuid('reply_to_message_id'),
    /** Evidence ids cited by this message — the claim-anchoring audit trail. */
    evidenceRefs: jsonb('evidence_refs').notNull().default([]),
    createdByAgent: boolean('created_by_agent').notNull().default(false),
    /** A human advisor typed this. Counts against agent autonomy on the thread. */
    isHumanReply: boolean('is_human_reply').notNull().default(false),
    agentRunId: uuid('agent_run_id'),
    /** Which staff member spoke, in the staff evidence group. */
    senderStaffId: uuid('sender_staff_id').references(() => staff.id, { onDelete: 'set null' }),
    approvedByStaffId: uuid('approved_by_staff_id').references(() => staff.id, {
      onDelete: 'set null',
    }),
    /** Quiet hours defer rather than drop: this is when the send becomes due. */
    scheduledFor: timestamptz('scheduled_for'),
    /** Why the OutboundGate refused. Never null on a BLOCKED row. */
    blockedReason: text('blocked_reason'),
    blockedCode: text('blocked_code'),
    errorCode: text('error_code'),
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
    index('messages_shop_customer_sent_idx').on(table.shopId, table.direction, table.sentAt),
    index('messages_scheduled_idx').on(table.status, table.scheduledFor),
    uniqueIndex('messages_provider_id_key').on(table.shopId, table.providerMessageId),
  ],
);

/**
 * Approved WhatsApp message templates, mirrored from the Meta template registry.
 *
 * Outside the 24-hour window a business-initiated message *must* use one of
 * these, and only in `APPROVED` status. Template names and languages are
 * configuration, never hardcoded (master §10).
 */
export const waTemplates = pgTable(
  'wa_templates',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    language: text('language').notNull(),
    category: waTemplateCategoryEnum('category').notNull(),
    status: waTemplateStatusEnum('status').notNull().default('PENDING'),
    /** Meta's own template id, present once the template has been created. */
    providerTemplateId: text('provider_template_id'),
    headerText: text('header_text'),
    bodyText: text('body_text').notNull(),
    footerText: text('footer_text'),
    /** Quick-reply / URL buttons, in the adapter's normalised shape. */
    buttons: jsonb('buttons').notNull().default([]),
    /** How many `{{n}}` placeholders the body carries; validated on every send. */
    variableCount: integer('variable_count').notNull().default(0),
    rejectionReason: text('rejection_reason'),
    approvedAt: timestamptz('approved_at'),
    syncedAt: timestamptz('synced_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('wa_templates_shop_name_lang_key').on(table.shopId, table.name, table.language),
    index('wa_templates_shop_status_idx').on(table.shopId, table.status),
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
    /** How the decision reached us — a regulator asks exactly this. */
    source: consentSourceEnum('source').notNull().default('INTERACTIVE_REPLY'),
    /** What the customer actually said/clicked, for a regulator. */
    evidence: text('evidence'),
    /** The message carrying the customer's own words, when there was one. */
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    capturedByStaffId: uuid('captured_by_staff_id').references(() => staff.id, {
      onDelete: 'set null',
    }),
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
  media: one(mediaAssets, { fields: [messages.mediaId], references: [mediaAssets.id] }),
}));

export const waTemplatesRelations = relations(waTemplates, ({ one }) => ({
  shop: one(shops, { fields: [waTemplates.shopId], references: [shops.id] }),
}));

export const consentsRelations = relations(consents, ({ one }) => ({
  customer: one(customers, { fields: [consents.customerId], references: [customers.id] }),
}));
