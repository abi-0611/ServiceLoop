import { smsSegments } from '@serviceloop/adapters';
import { getEnv } from '@serviceloop/config';
import { PgCostStore } from '@serviceloop/db';
import type { ConversationCategory } from '@serviceloop/shared';
import { sql } from 'drizzle-orm';
import type { EventHandler } from './registry';

/**
 * Per-conversation cost metering (phase 7.3).
 *
 * A consumer of `message.sent` rather than a call inside `OutboundGate`, and
 * the reason is the one every other meter in this codebase shares: a metering
 * failure must never fail a customer send. If the cost row cannot be written,
 * the message has already reached the customer, the event is retried, and the
 * count catches up. Metering inline would turn a lock on the cost table into an
 * undelivered ready-alert.
 *
 * It runs inside the consumer's transaction alongside the idempotency claim, so
 * a redelivered `message.sent` cannot double-count.
 *
 * **What it counts, and why it is not "one message, one charge".** Meta bills a
 * 24-hour *conversation*, opened by its first message of a given category;
 * every message inside that window is free. `messages.provider_conversation_id`
 * carries the id the provider reported, so the send that opened a conversation
 * is the earliest one bearing that id — and the rest increment `messages`
 * alone. Counting every message as a conversation would overstate a busy
 * approval thread tenfold, in the direction that flatters the product.
 *
 * The pricing table is `WA_PRICING_JSON`: configuration, because Meta reprices
 * by market without asking and a redeploy to correct a margin figure is a
 * redeploy nobody does. The rate is written onto the row, so a repricing is
 * visible rather than retroactive.
 */

interface MessageRow extends Record<string, unknown> {
  readonly shop_id: string;
  readonly channel: string;
  readonly conversation_category: ConversationCategory | null;
  readonly body: string;
  readonly sent_at: Date | null;
  readonly first_in_conversation: boolean;
}

export function createCostMeterHandler(): EventHandler {
  const costs = new PgCostStore();

  return {
    name: 'cost-meter',
    handles: ['message.sent'],
    async handle({ tx, envelope }) {
      const messageId = (envelope.payload as { messageId?: string }).messageId;
      if (messageId === undefined) return { metered: false, reason: 'no messageId' };

      const env = getEnv();
      const result = await tx.execute<MessageRow>(sql`
        select m.shop_id, m.channel, m.conversation_category, m.body, m.sent_at,
               -- Did this message *open* the billable conversation?
               --
               -- True when nothing earlier shares its provider conversation id.
               -- A null id counts as opening, which is right for SMS (every one
               -- is billed alone) and conservative for a provider that does not
               -- report one — over-counting a cost is the safe direction for a
               -- number a shop budgets against.
               (m.provider_conversation_id is null or not exists (
                  select 1 from messages e
                  where e.provider_conversation_id = m.provider_conversation_id
                    and e.direction = 'OUTBOUND'
                    and e.sent_at < m.sent_at
               )) as first_in_conversation
        from messages m
        where m.id = ${messageId}
      `);

      const row = result.rows[0];
      if (row === undefined || row.sent_at === null) {
        return { metered: false, reason: 'message not found or not sent' };
      }

      const day = row.sent_at.toISOString().slice(0, 10);

      if (row.channel === 'SMS') {
        const segments = smsSegments(row.body);
        await costs.recordSms(tx, {
          shopId: row.shop_id,
          day,
          messages: 1,
          segments,
          // The provider's quoted price arrives on the receipt. Until that is
          // reconciled this stays zero rather than becoming an invented figure:
          // a guessed cost in a margin report is worse than a missing one,
          // because it looks like data.
          costPaise: 0,
        });
        return { metered: true, channel: 'SMS', segments };
      }

      if (row.channel !== 'WHATSAPP') return { metered: false, reason: row.channel };

      // A free-form reply inside an open window carries no category of its own.
      // It rides on a conversation already counted, so it adds a message and
      // no cost.
      const category: ConversationCategory = row.conversation_category ?? 'SERVICE';
      const opened = row.first_in_conversation ? 1 : 0;
      const ratePaise = env.WA_PRICING_JSON[category];

      await costs.recordConversation(tx, {
        shopId: row.shop_id,
        day,
        category,
        conversations: opened,
        messages: 1,
        ratePaise,
      });

      return { metered: true, channel: 'WHATSAPP', category, conversations: opened, ratePaise };
    },
  };
}
