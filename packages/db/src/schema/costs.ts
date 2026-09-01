import { bigint, date, index, integer, pgTable, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, primaryId, updatedAt } from './columns';
import { shops } from './core';
import { conversationCategoryEnum } from './enums';

/**
 * Channel cost metering (phase 7.3).
 *
 * Two tables rather than one, and the split is not fastidiousness: WhatsApp
 * bills per 24-hour *conversation* and SMS bills per *segment*. Adding them
 * under one "messages" column would produce a number that is not a count of
 * anything, and a margin figure derived from it would be wrong in a direction
 * that flatters the product.
 */

export const conversationCosts = pgTable(
  'conversation_costs',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    category: conversationCategoryEnum('category').notNull(),
    /**
     * Billable conversations opened. This is the number Meta charges for.
     *
     * A conversation is opened by the first message in a 24-hour window of a
     * given category, and every message inside that window rides free. Counting
     * messages instead would overstate a busy approval thread tenfold.
     */
    conversations: integer('conversations').notNull().default(0),
    /** Messages sent inside those conversations. Free, but worth seeing. */
    messages: integer('messages').notNull().default(0),
    costPaise: bigint('cost_paise', { mode: 'number' }).notNull().default(0),
    /**
     * The per-conversation rate this row was priced at.
     *
     * Stored so a later repricing is visible rather than retroactive. Meta
     * reprices by market without asking, and a margin report that silently
     * changes last month's cost is a report nobody can reconcile against an
     * invoice — which makes it a report nobody uses.
     */
    ratePaise: bigint('rate_paise', { mode: 'number' }).notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('conversation_costs_shop_day_category_key').on(
      table.shopId,
      table.day,
      table.category,
    ),
    index('conversation_costs_shop_day_idx').on(table.shopId, table.day),
  ],
);

export const smsCosts = pgTable(
  'sms_costs',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    messages: integer('messages').notNull().default(0),
    /**
     * Segments, which is what an operator bills.
     *
     * Tracked separately from `messages` because the ratio between them is the
     * fact a shop needs: one Tamil ready-alert is four segments where its
     * English twin is one, and a shop that discovers that from its bill rather
     * than from this column has been badly served.
     */
    segments: integer('segments').notNull().default(0),
    costPaise: bigint('cost_paise', { mode: 'number' }).notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('sms_costs_shop_day_key').on(table.shopId, table.day)],
);
