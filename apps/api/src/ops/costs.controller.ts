import { Controller, Get, Inject } from '@nestjs/common';
import { getEnv } from '@serviceloop/config';
import { PgCostStore, PgShopConfigStore, type PgUnitOfWork } from '@serviceloop/db';
import { addLocalDays, localDay, localDaysBetween, ValidationError } from '@serviceloop/shared';
import { z } from 'zod';
import { CurrentStaff, Roles, type AuthenticatedStaff } from '../auth/auth.types';
import { ZodQuery } from '../common/zod';
import { UNIT_OF_WORK } from '../infra/tokens';

/**
 * Channel cost, per shop, per day (phase 7.3).
 *
 * The margin half of cost metering: the worker's `cost-meter` handler writes
 * the rows, and this reads them back split by channel and category. Owner-only,
 * because it is the shop's cost base and an advisor has no decision to make
 * with it.
 *
 * **Never one "messaging cost" number.** An owner asking why this month cost
 * more than last needs to see whether the difference is marketing conversations
 * or SMS fallback, and those have opposite remedies — one is a campaign to
 * stop, the other is an outage to fix. A summed figure cannot distinguish them,
 * so no endpoint here returns one without its split alongside.
 *
 * The pricing table is served with the totals rather than left implicit,
 * because Meta reprices by market without notice and the rate the rows were
 * costed at is the first thing anyone reconciling a bill asks for.
 */

const RangeQuery = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

/** A month, which is the period a shop is billed over. */
const DEFAULT_WINDOW_DAYS = 29;

@Controller('ops/costs')
export class CostsController {
  private readonly costs = new PgCostStore();
  private readonly config = new PgShopConfigStore();

  constructor(@Inject(UNIT_OF_WORK) private readonly uow: PgUnitOfWork) {}

  @Get()
  @Roles('OWNER')
  async daily(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodQuery(RangeQuery) query: z.infer<typeof RangeQuery>,
  ) {
    // "Today" is the shop's day, never the API's. A container running UTC
    // would otherwise report a Chennai shop's 2am as yesterday, and the missing
    // day would be the one somebody is asking about.
    const timezone =
      (await this.uow.transaction(async (tx) =>
        this.config.loadShopTimezone(tx, staff.shopId),
      )) ?? 'Asia/Kolkata';

    const to = query.to ?? localDay(new Date(), timezone);
    const from = query.from ?? addLocalDays(to, -DEFAULT_WINDOW_DAYS);

    const span = localDaysBetween(from, to);
    if (span < 0) {
      throw new ValidationError('`from` is after `to`', {
        fieldErrors: [{ path: 'from', message: 'The range starts after it ends' }],
      });
    }
    if (span > 400) {
      throw new ValidationError('Ranges longer than 400 days are not served; export instead');
    }

    const days = await this.uow.transaction(async (tx) =>
      this.costs.dailyCosts(tx, staff.shopId, from, to),
    );

    const totals = days.reduce(
      (accumulator, day) => ({
        whatsappConversations: accumulator.whatsappConversations + day.whatsapp.conversations,
        whatsappMessages: accumulator.whatsappMessages + day.whatsapp.messages,
        whatsappPaise: accumulator.whatsappPaise + day.whatsapp.costPaise,
        smsMessages: accumulator.smsMessages + day.sms.messages,
        smsSegments: accumulator.smsSegments + day.sms.segments,
        smsPaise: accumulator.smsPaise + day.sms.costPaise,
        totalPaise: accumulator.totalPaise + day.totalPaise,
      }),
      {
        whatsappConversations: 0,
        whatsappMessages: 0,
        whatsappPaise: 0,
        smsMessages: 0,
        smsSegments: 0,
        smsPaise: 0,
        totalPaise: 0,
      },
    );

    const byCategory: Record<string, number> = {};
    for (const day of days) {
      for (const [category, paise] of Object.entries(day.whatsapp.byCategory)) {
        byCategory[category] = (byCategory[category] ?? 0) + paise;
      }
    }

    return {
      range: { from, to },
      days,
      totals,
      byCategory,
      /**
       * Null rather than zero when nothing was sent.
       *
       * The same rule the analytics KPIs follow, and for the same reason: a
       * cost-per-conversation of ₹0.00 reads as "free", where "we opened no
       * billable conversations in this window" is the fact. One of those is a
       * result and the other is an absence.
       */
      costPerConversationPaise:
        totals.whatsappConversations === 0
          ? null
          : Math.round(totals.whatsappPaise / totals.whatsappConversations),
      /**
       * The rates the rows above were costed at, from `WA_PRICING_JSON`.
       *
       * Configuration, not code, so a repricing is an env change rather than a
       * deploy. Note this is the *current* table: a row priced before a change
       * carries its own `rate_paise`, which is why the stored rate is written
       * per row and why this field is labelled as current rather than applied.
       */
      currentPricingPaise: getEnv().WA_PRICING_JSON,
      smsCostNote:
        'SMS cost is zero until the provider receipt is reconciled. A guessed figure in a margin report looks like data.',
    };
  }
}
