import type { ConversationCategory } from '@serviceloop/shared';
import { uuidv7 } from '@serviceloop/shared';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { conversationCosts, smsCosts } from '../schema/costs';

/**
 * Channel cost metering (phase 7.3).
 *
 * Upserted per shop, per day, per category as messages go out. The `+=` shape
 * matters: two workers sending at the same instant must not lose one of the
 * increments, so it is one `INSERT ... ON CONFLICT DO UPDATE SET x = x + n`
 * statement rather than a read, an add and a write.
 *
 * **Conversations, not messages, are what Meta bills.** A conversation is
 * opened by the first message of a given category inside a 24-hour window, and
 * every message after it in that window rides free. So `conversations` is
 * incremented only when the send actually opened one — which the provider tells
 * us, via the `conversation.id` on the send response — and `messages` counts
 * everything. Counting messages as conversations would overstate a busy
 * approval thread by a factor of ten, and a margin figure built on that would
 * be wrong in the direction that flatters the product.
 */
export class PgCostStore {
  async recordConversation(
    tx: Tx,
    input: {
      readonly shopId: string;
      readonly day: string;
      readonly category: ConversationCategory;
      /** 1 when this send opened a billable conversation, 0 otherwise. */
      readonly conversations: number;
      readonly messages: number;
      readonly ratePaise: number;
    },
  ): Promise<void> {
    const cost = input.conversations * input.ratePaise;

    await tx
      .insert(conversationCosts)
      .values({
        id: uuidv7(),
        shopId: input.shopId,
        day: input.day,
        category: input.category,
        conversations: input.conversations,
        messages: input.messages,
        costPaise: cost,
        ratePaise: input.ratePaise,
      })
      .onConflictDoUpdate({
        target: [conversationCosts.shopId, conversationCosts.day, conversationCosts.category],
        set: {
          conversations: sql`${conversationCosts.conversations} + ${input.conversations}`,
          messages: sql`${conversationCosts.messages} + ${input.messages}`,
          costPaise: sql`${conversationCosts.costPaise} + ${cost}`,
          // The *latest* rate seen for the day wins. A repricing mid-day leaves
          // a row whose cost is the sum of two rates and whose `rate_paise` is
          // the newer one — which is honest and reconcilable, where averaging
          // would be neither.
          ratePaise: input.ratePaise,
          updatedAt: new Date(),
        },
      });
  }

  async recordSms(
    tx: Tx,
    input: {
      readonly shopId: string;
      readonly day: string;
      readonly messages: number;
      readonly segments: number;
      readonly costPaise: number;
    },
  ): Promise<void> {
    await tx
      .insert(smsCosts)
      .values({
        id: uuidv7(),
        shopId: input.shopId,
        day: input.day,
        messages: input.messages,
        segments: input.segments,
        costPaise: input.costPaise,
      })
      .onConflictDoUpdate({
        target: [smsCosts.shopId, smsCosts.day],
        set: {
          messages: sql`${smsCosts.messages} + ${input.messages}`,
          segments: sql`${smsCosts.segments} + ${input.segments}`,
          costPaise: sql`${smsCosts.costPaise} + ${input.costPaise}`,
          updatedAt: new Date(),
        },
      });
  }

  /**
   * The daily cost rollup a shop's margin analytics reads.
   *
   * Returns paise, per day, split by channel — never a single "messaging cost"
   * number. An owner asking why this month cost more than last needs to see
   * that the difference is marketing conversations rather than SMS fallback,
   * and a summed figure cannot tell them.
   */
  async dailyCosts(
    tx: Tx,
    shopId: string,
    from: string,
    to: string,
  ): Promise<readonly DailyChannelCost[]> {
    const whatsapp = await tx
      .select()
      .from(conversationCosts)
      .where(
        and(
          eq(conversationCosts.shopId, shopId),
          gte(conversationCosts.day, from),
          lte(conversationCosts.day, to),
        ),
      );

    const sms = await tx
      .select()
      .from(smsCosts)
      .where(and(eq(smsCosts.shopId, shopId), gte(smsCosts.day, from), lte(smsCosts.day, to)));

    const byDay = new Map<string, DailyChannelCost>();
    const blank = (day: string): DailyChannelCost => ({
      day,
      whatsapp: { conversations: 0, messages: 0, costPaise: 0, byCategory: {} },
      sms: { messages: 0, segments: 0, costPaise: 0 },
      totalPaise: 0,
    });

    for (const row of whatsapp) {
      const entry = byDay.get(row.day) ?? blank(row.day);
      const merged: DailyChannelCost = {
        ...entry,
        whatsapp: {
          conversations: entry.whatsapp.conversations + row.conversations,
          messages: entry.whatsapp.messages + row.messages,
          costPaise: entry.whatsapp.costPaise + row.costPaise,
          byCategory: { ...entry.whatsapp.byCategory, [row.category]: row.costPaise },
        },
        totalPaise: entry.totalPaise + row.costPaise,
      };
      byDay.set(row.day, merged);
    }

    for (const row of sms) {
      const entry = byDay.get(row.day) ?? blank(row.day);
      byDay.set(row.day, {
        ...entry,
        sms: {
          messages: entry.sms.messages + row.messages,
          segments: entry.sms.segments + row.segments,
          costPaise: entry.sms.costPaise + row.costPaise,
        },
        totalPaise: entry.totalPaise + row.costPaise,
      });
    }

    return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  }
}

export interface DailyChannelCost {
  readonly day: string;
  readonly whatsapp: {
    readonly conversations: number;
    readonly messages: number;
    readonly costPaise: number;
    readonly byCategory: Readonly<Record<string, number>>;
  };
  readonly sms: {
    readonly messages: number;
    readonly segments: number;
    readonly costPaise: number;
  };
  readonly totalPaise: number;
}
