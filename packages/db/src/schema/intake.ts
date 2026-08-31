import { relations } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, primaryId, timestamptz, updatedAt } from './columns';
import { conversations, messages } from './comms';
import { customers, shops, staff, vehicles } from './core';
import { jobCards, mediaAssets } from './jobs';
import {
  intakeDraftStatusEnum,
  intakeSourceEnum,
  mergeSuggestionKindEnum,
  mergeSuggestionStatusEnum,
} from './enums';

/**
 * Zero-migration intake (L2).
 *
 * A photographed paper card, a forwarded WhatsApp message and a voice note all
 * land in the *same* place: a `job_card_drafts` row holding a `JobCardDraft`
 * with per-field confidence. Nothing becomes a real JobCard until a human has
 * confirmed the draft, so an OCR mistake can never quietly become a record.
 */

export const jobCardDrafts = pgTable(
  'job_card_drafts',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    source: intakeSourceEnum('source').notNull(),
    status: intakeDraftStatusEnum('status').notNull().default('AWAITING_CONFIRMATION'),

    /** Where the draft came from, when it came over a channel. */
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    mediaId: uuid('media_id').references(() => mediaAssets.id, { onDelete: 'set null' }),
    submittedByStaffId: uuid('submitted_by_staff_id').references(() => staff.id, {
      onDelete: 'set null',
    }),

    /** The forwarded text or the voice-note transcript, exactly as received. */
    rawInput: text('raw_input'),
    /** The extracted `JobCardDraft` document, validated by its zod schema. */
    draft: jsonb('draft').notNull(),
    /** Field-path → corrected value, recorded before the draft was confirmed. */
    corrections: jsonb('corrections').notNull().default([]),

    /** Mean field confidence × 1000, so the column stays an integer. */
    confidenceMilli: integer('confidence_milli').notNull().default(0),
    /** Field paths below the shop's confirmation threshold — the ⚠ list. */
    lowConfidenceFields: jsonb('low_confidence_fields').notNull().default([]),

    /** Extraction provenance: which model saw the image, under which prompt. */
    extractorModel: text('extractor_model'),
    extractorPromptHash: text('extractor_prompt_hash'),
    extractionMs: integer('extraction_ms'),

    /** Filled in by entity resolution at confirmation time. */
    resolvedCustomerId: uuid('resolved_customer_id').references(() => customers.id, {
      onDelete: 'set null',
    }),
    resolvedVehicleId: uuid('resolved_vehicle_id').references(() => vehicles.id, {
      onDelete: 'set null',
    }),
    jobCardId: uuid('job_card_id').references(() => jobCards.id, { onDelete: 'set null' }),

    failureReason: text('failure_reason'),
    confirmedAt: timestamptz('confirmed_at'),
    discardedAt: timestamptz('discarded_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('job_card_drafts_shop_status_idx').on(table.shopId, table.status, table.createdAt),
    index('job_card_drafts_conversation_idx').on(table.conversationId, table.createdAt),
    uniqueIndex('job_card_drafts_message_key').on(table.shopId, table.messageId),
  ],
);

/**
 * Ambiguous entity matches. Entity resolution merges only on an exact,
 * unambiguous key (normalised registration, E.164 phone); anything else becomes
 * a suggestion an advisor decides on. ServiceLoop never guesses which two
 * customers are the same person.
 */
export const mergeSuggestions = pgTable(
  'merge_suggestions',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    kind: mergeSuggestionKindEnum('kind').notNull(),
    status: mergeSuggestionStatusEnum('status').notNull().default('OPEN'),
    /** The record we would keep. */
    primaryEntityId: uuid('primary_entity_id').notNull(),
    /** The record proposed for merging into it. */
    candidateEntityId: uuid('candidate_entity_id').notNull(),
    reason: text('reason').notNull(),
    /** Similarity × 1000. Never used to auto-merge, only to sort the queue. */
    scoreMilli: integer('score_milli').notNull().default(0),
    context: jsonb('context').notNull().default({}),
    draftId: uuid('draft_id').references(() => jobCardDrafts.id, { onDelete: 'set null' }),
    resolvedByStaffId: uuid('resolved_by_staff_id').references(() => staff.id, {
      onDelete: 'set null',
    }),
    resolvedAt: timestamptz('resolved_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('merge_suggestions_pair_key').on(
      table.shopId,
      table.kind,
      table.primaryEntityId,
      table.candidateEntityId,
    ),
    index('merge_suggestions_shop_status_idx').on(table.shopId, table.status, table.createdAt),
  ],
);

export const jobCardDraftsRelations = relations(jobCardDrafts, ({ one }) => ({
  shop: one(shops, { fields: [jobCardDrafts.shopId], references: [shops.id] }),
  conversation: one(conversations, {
    fields: [jobCardDrafts.conversationId],
    references: [conversations.id],
  }),
  media: one(mediaAssets, { fields: [jobCardDrafts.mediaId], references: [mediaAssets.id] }),
  jobCard: one(jobCards, { fields: [jobCardDrafts.jobCardId], references: [jobCards.id] }),
}));

export const mergeSuggestionsRelations = relations(mergeSuggestions, ({ one }) => ({
  shop: one(shops, { fields: [mergeSuggestions.shopId], references: [shops.id] }),
  draft: one(jobCardDrafts, {
    fields: [mergeSuggestions.draftId],
    references: [jobCardDrafts.id],
  }),
}));
