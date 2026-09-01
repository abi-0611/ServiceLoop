import type { ShopConfig } from '@serviceloop/config';
import {
  addDays,
  systemClock,
  uuidv7,
  type Clock,
  type EventEnvelope,
  type LedgerStatus,
  type Paise,
  type RepitchResponse,
} from '@serviceloop/shared';
import type { Actor } from '../job-card/context';
import { SYSTEM_ACTOR } from '../job-card/context';
import type { AuditAppender, OutboxWriter, UnitOfWork } from '../ports';
import { horizonFor, triggerTagsFor } from './horizon';
import type { LedgerStore } from './ports';
import type { LedgerItem, NextVisitPrompt, OpenLedgerItemInput } from './types';

/**
 * The declined-work ledger's lifecycle (phase 6.1).
 *
 * `open → repitched(n) → converted | expired | opted_out`, and the transitions
 * are here rather than spread across the four things that cause them because
 * two of them are irreversible in a way that matters to a person:
 *
 *   - **`opted_out` is permanent.** A customer who tapped "not interested" must
 *     never hear about that item again, from any trigger, in any season, for
 *     ever. There is no method on this class that reopens one, and the trigger
 *     engine refuses any status but `OPEN` and `RE_PITCHED`.
 *   - **`converted` is money.** It is the numerator of the recovery rate the
 *     whole business case rests on, so it may only be recorded with the visit
 *     the money arrived on — a database CHECK enforces that, not just this code.
 *
 * The two-re-pitch cap lives in three places on purpose, the same way phase 4's
 * balance-reminder cap does: the shop-config schema, a database CHECK, and
 * `mayRepitch` below. A caller cannot exceed it even by trying, which is the
 * point of putting a limit underneath the thing that is supposed to respect it.
 */

export interface LedgerServiceDeps<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly ledger: LedgerStore<Tx>;
  readonly audit: AuditAppender<Tx>;
  readonly outbox: OutboxWriter<Tx>;
  readonly loadConfig: (tx: Tx, shopId: string) => Promise<ShopConfig>;
  readonly clock?: Clock;
}

export interface OpenResult {
  readonly ledgerItemId: string;
  readonly created: boolean;
  readonly followUpAfter: Date | null;
  readonly triggerTags: readonly string[];
}

export class LedgerService<Tx> {
  private readonly clock: Clock;

  constructor(private readonly deps: LedgerServiceDeps<Tx>) {
    this.clock = deps.clock ?? systemClock;
  }

  /**
   * Records a declined or deferred item with its horizon and trigger tags.
   *
   * Called from the work-item decline path, which has already written the state
   * transition and the bare ledger row in its own transaction (phase 3.6). This
   * fills in what phase 6 needs and emits `ledger.item_opened`, whose
   * `amountPaise` is the denominator of every recovery figure that follows —
   * which is why it is stated once, here, and never recomputed later from an
   * estimate that may have been superseded in the meantime.
   */
  async open(input: OpenLedgerItemInput & { readonly traceId: string; readonly actor?: Actor }): Promise<OpenResult> {
    const actor = input.actor ?? SYSTEM_ACTOR;
    const at = this.clock.now();

    return this.deps.uow.transaction(async (tx) => {
      const config = await this.deps.loadConfig(tx, input.shopId);
      const followUpAfter = horizonFor(config.retention, {
        category: input.category,
        declinedAt: at,
        customerPromisedAt: input.customerPromisedAt ?? null,
      });
      const triggerTags = triggerTagsFor(config.retention, {
        category: input.category,
        declineReason: input.declineReason,
      });

      const { id, created } = await this.deps.ledger.open(
        tx,
        uuidv7(),
        { ...input, followUpAfter, triggerTags },
        at,
      );

      // A redelivered `work_item.state_changed` finds the row already there.
      // Emitting a second `ledger.item_opened` would double the denominator of
      // the recovery rate, which is the one number this phase exists to defend.
      if (!created) {
        return { ledgerItemId: id, created: false, followUpAfter, triggerTags };
      }

      await this.deps.audit.append(tx, {
        shopId: input.shopId,
        actorType: actor.type,
        actorId: actor.id,
        action: 'ledger.item_opened',
        entityType: 'DeclinedWorkLedger',
        entityId: id,
        payload: {
          workItemId: input.workItemId,
          jobCardId: input.jobCardId,
          kind: input.kind,
          declineReason: input.declineReason,
          amountPaise: input.amountPaise,
          category: input.category,
          followUpAfter: followUpAfter?.toISOString() ?? null,
          triggerTags,
        },
        traceId: input.traceId,
      });

      const envelope: EventEnvelope = {
        id: uuidv7(),
        type: 'ledger.item_opened',
        occurredAt: at.toISOString(),
        shopId: input.shopId,
        traceId: input.traceId,
        payload: {
          ledgerItemId: id,
          jobCardId: input.jobCardId,
          workItemId: input.workItemId,
          customerId: input.customerId,
          vehicleId: input.vehicleId,
          kind: input.kind,
          reason: input.declineReason,
          amountPaise: input.amountPaise,
          category: input.category,
          followUpAfter: followUpAfter?.toISOString() ?? null,
          triggerTags: [...triggerTags],
          actor: { type: actor.type, id: actor.id },
        },
      };
      await this.deps.outbox.enqueue(tx, envelope);

      return { ledgerItemId: id, created: true, followUpAfter, triggerTags };
    });
  }

  /**
   * May this item be pitched again?
   *
   * The cap, stated once. `OPTED_OUT` is checked first and separately from the
   * count because the two refusals mean different things to whoever reads the
   * audit row: one is "we have asked enough", the other is "they told us to
   * stop", and only one of them is ever reconsidered.
   */
  mayRepitch(item: LedgerItem, config: ShopConfig): { ok: boolean; code?: string; reason?: string } {
    if (item.status === 'OPTED_OUT') {
      return {
        ok: false,
        code: 'ITEM_OPTED_OUT',
        reason: 'The customer asked not to hear about this item again',
      };
    }
    if (item.status !== 'OPEN' && item.status !== 'RE_PITCHED') {
      return { ok: false, code: 'ITEM_CLOSED', reason: `Ledger item is ${item.status}` };
    }
    if (item.repitchCount >= config.retention.maxRepitchesPerItem) {
      return {
        ok: false,
        code: 'REPITCH_CAP_REACHED',
        reason: `This item has already been re-pitched ${item.repitchCount} time(s); the cap is ${config.retention.maxRepitchesPerItem}`,
      };
    }
    return { ok: true };
  }

  /** Records that a re-pitch went out, moving the item to `RE_PITCHED`. */
  async recordRepitch(input: {
    readonly shopId: string;
    readonly ledgerItemId: string;
    readonly touchId: string;
    readonly messageId: string | null;
    readonly trigger: 'next_visit' | 'time_elapsed' | 'season' | 'odometer' | 'manual';
    readonly purpose: 'SERVICE' | 'MARKETING';
    readonly traceId: string;
    readonly actor?: Actor;
  }): Promise<number> {
    const actor = input.actor ?? SYSTEM_ACTOR;
    const at = this.clock.now();

    return this.deps.uow.transaction(async (tx) => {
      const item = await this.deps.ledger.lockById(tx, input.shopId, input.ledgerItemId);
      if (item === null) return 0;

      const config = await this.deps.loadConfig(tx, input.shopId);
      const repitchCount = item.repitchCount + 1;
      // The horizon is pushed past the floor, not merely cleared. An item whose
      // `followUpAfter` stayed in the past would be "due" on every scan from
      // now until the cap, and the only thing standing between the customer and
      // a daily message would be the gate — which is a guardrail, not a plan.
      const followUpAfter = addDays(at, config.retention.minDaysBetweenTouches);

      await this.deps.ledger.recordRepitch(tx, {
        shopId: input.shopId,
        ledgerItemId: input.ledgerItemId,
        repitchCount,
        followUpAfter,
        at,
      });

      await this.deps.audit.append(tx, {
        shopId: input.shopId,
        actorType: actor.type,
        actorId: actor.id,
        action: 'ledger.repitched',
        entityType: 'DeclinedWorkLedger',
        entityId: input.ledgerItemId,
        payload: {
          touchId: input.touchId,
          trigger: input.trigger,
          purpose: input.purpose,
          repitchCount,
          messageId: input.messageId,
          nextHorizon: followUpAfter.toISOString(),
        },
        traceId: input.traceId,
      });

      if (item.customerId !== null) {
        const envelope: EventEnvelope = {
          id: uuidv7(),
          type: 'ledger.repitched',
          occurredAt: at.toISOString(),
          shopId: input.shopId,
          traceId: input.traceId,
          payload: {
            ledgerItemId: input.ledgerItemId,
            touchId: input.touchId,
            jobCardId: item.jobCardId,
            customerId: item.customerId,
            trigger: input.trigger,
            repitchCount,
            amountPaise: item.amountPaise,
            purpose: input.purpose,
            messageId: input.messageId,
            actor: { type: actor.type, id: actor.id },
          },
        };
        await this.deps.outbox.enqueue(tx, envelope);
      }

      return repitchCount;
    });
  }

  /**
   * The customer's one-tap answer (phase 6.3).
   *
   * "Remind me later" is a response and not a silence: it pushes the horizon
   * out by the shop's configured month *and counts against the two-pitch cap*,
   * because a customer who has deferred twice has been asked twice. Treating it
   * as no answer would let a shop pitch indefinitely by never being told no.
   */
  async recordResponse(input: {
    readonly shopId: string;
    readonly ledgerItemId: string;
    readonly response: RepitchResponse;
    readonly traceId: string;
    readonly actor?: Actor;
  }): Promise<{ readonly applied: boolean; readonly status: LedgerStatus }> {
    const actor = input.actor ?? SYSTEM_ACTOR;
    const at = this.clock.now();

    return this.deps.uow.transaction(async (tx) => {
      const item = await this.deps.ledger.lockById(tx, input.shopId, input.ledgerItemId);
      if (item === null) return { applied: false, status: 'CLOSED' as LedgerStatus };
      if (item.status === 'OPTED_OUT' || item.status === 'CONVERTED') {
        // Already terminal. A second tap on an old message is not an error and
        // must not reopen anything — least of all an opt-out.
        return { applied: false, status: item.status };
      }

      const config = await this.deps.loadConfig(tx, input.shopId);

      if (input.response === 'NOT_INTERESTED') {
        await this.closeInTx(tx, {
          item,
          status: 'OPTED_OUT',
          reason: 'The customer tapped "Not interested" on a re-pitch',
          convertedJobCardId: null,
          recoveredAmountPaise: 0,
          response: input.response,
          at,
          actor,
          traceId: input.traceId,
        });
        return { applied: true, status: 'OPTED_OUT' };
      }

      const followUpAfter =
        input.response === 'REMIND_LATER'
          ? addDays(at, config.retention.remindLaterDays)
          : item.followUpAfter;

      await this.deps.ledger.recordResponse(tx, {
        shopId: input.shopId,
        ledgerItemId: input.ledgerItemId,
        response: input.response,
        followUpAfter,
        at,
      });

      await this.deps.audit.append(tx, {
        shopId: input.shopId,
        actorType: actor.type,
        actorId: actor.id,
        action: 'ledger.response_recorded',
        entityType: 'DeclinedWorkLedger',
        entityId: input.ledgerItemId,
        payload: {
          response: input.response,
          followUpAfter: followUpAfter?.toISOString() ?? null,
        },
        traceId: input.traceId,
      });

      return { applied: true, status: item.status };
    });
  }

  /**
   * The item converted: the customer had the work done.
   *
   * `recoveredAmountPaise` is what they actually spent, which is frequently not
   * what was quoted — a part's price moved, or an advisor bundled it with
   * something else. The ledgered figure stays as the denominator and this is
   * the numerator, and keeping them separate is why the recovery rate is a
   * number and not an assertion.
   */
  async convert(input: {
    readonly shopId: string;
    readonly ledgerItemId: string;
    readonly convertedJobCardId: string;
    readonly recoveredAmountPaise: Paise;
    readonly traceId: string;
    readonly actor?: Actor;
  }): Promise<boolean> {
    const actor = input.actor ?? SYSTEM_ACTOR;
    const at = this.clock.now();

    return this.deps.uow.transaction(async (tx) => {
      const item = await this.deps.ledger.lockById(tx, input.shopId, input.ledgerItemId);
      if (item === null || item.status === 'CONVERTED') return false;

      await this.closeInTx(tx, {
        item,
        status: 'CONVERTED',
        reason: `Converted on job card ${input.convertedJobCardId}`,
        convertedJobCardId: input.convertedJobCardId,
        recoveredAmountPaise: input.recoveredAmountPaise,
        response: null,
        at,
        actor,
        traceId: input.traceId,
      });
      return true;
    });
  }

  /**
   * The horizon came and went without the item ever converting.
   *
   * Distinct from `CLOSED` because it is not the end of the relationship: an
   * expired item still surfaces on the next visit, where an advisor standing in
   * front of the customer can raise it in a way no message ever could.
   */
  async expire(input: {
    readonly shopId: string;
    readonly ledgerItemId: string;
    readonly reason: string;
    readonly traceId: string;
    readonly actor?: Actor;
  }): Promise<boolean> {
    const actor = input.actor ?? SYSTEM_ACTOR;
    const at = this.clock.now();

    return this.deps.uow.transaction(async (tx) => {
      const item = await this.deps.ledger.lockById(tx, input.shopId, input.ledgerItemId);
      if (item === null) return false;
      if (item.status !== 'OPEN' && item.status !== 'RE_PITCHED') return false;

      await this.closeInTx(tx, {
        item,
        status: 'EXPIRED',
        reason: input.reason,
        convertedJobCardId: null,
        recoveredAmountPaise: 0,
        response: null,
        at,
        actor,
        traceId: input.traceId,
      });
      return true;
    });
  }

  /**
   * The "while it's here" lines for one customer (phase 6.2).
   *
   * Read by the advisor's card drawer and injected into the approval flow's
   * context, which is the cheapest conversion moment there is: the vehicle is
   * on the lift, the customer is already deciding about money, and nothing has
   * to be sent to anybody.
   *
   * Opted-out items are absent, and that absence is the whole contract — an
   * advisor who is shown one will mention it, which is exactly the thing the
   * customer asked not to happen.
   */
  async nextVisitPrompts(input: {
    readonly shopId: string;
    readonly customerId: string;
    readonly excludeJobCardId?: string | null;
  }): Promise<readonly NextVisitPrompt[]> {
    return this.deps.uow.transaction(async (tx) => {
      const config = await this.deps.loadConfig(tx, input.shopId);
      if (!config.retention.nextVisitPromptEnabled) return [];

      const items = await this.deps.ledger.openForCustomer(tx, input.shopId, input.customerId);
      return items
        .filter((item) => item.status === 'OPEN' || item.status === 'RE_PITCHED')
        .filter((item) => item.jobCardId !== (input.excludeJobCardId ?? null))
        .map((item) => ({
          ledgerItemId: item.id,
          title: item.title ?? 'Deferred work',
          technicianNote: item.technicianNote,
          amountPaise: item.amountPaise,
          declinedAt: item.createdAt,
          declineReason: item.declineReason,
          repitchCount: item.repitchCount,
        }));
    });
  }

  async load(shopId: string, ledgerItemId: string): Promise<LedgerItem | null> {
    return this.deps.uow.transaction((tx) => this.deps.ledger.load(tx, shopId, ledgerItemId));
  }

  async openForCustomer(shopId: string, customerId: string): Promise<readonly LedgerItem[]> {
    return this.deps.uow.transaction((tx) =>
      this.deps.ledger.openForCustomer(tx, shopId, customerId),
    );
  }

  /* --------------------------------------------------------------- private */

  private async closeInTx(
    tx: Tx,
    input: {
      readonly item: LedgerItem;
      readonly status: LedgerStatus;
      readonly reason: string;
      readonly convertedJobCardId: string | null;
      readonly recoveredAmountPaise: Paise;
      readonly response: RepitchResponse | null;
      readonly at: Date;
      readonly actor: Actor;
      readonly traceId: string;
    },
  ): Promise<void> {
    const { item, at, actor } = input;

    await this.deps.ledger.close(tx, {
      shopId: item.shopId,
      ledgerItemId: item.id,
      status: input.status,
      reason: input.reason,
      convertedJobCardId: input.convertedJobCardId,
      recoveredAmountPaise: input.recoveredAmountPaise,
      at,
    });

    await this.deps.audit.append(tx, {
      shopId: item.shopId,
      actorType: actor.type,
      actorId: actor.id,
      action: 'ledger.item_closed',
      entityType: 'DeclinedWorkLedger',
      entityId: item.id,
      payload: {
        status: input.status,
        reason: input.reason,
        ledgeredAmountPaise: item.amountPaise,
        recoveredAmountPaise: input.recoveredAmountPaise,
        convertedJobCardId: input.convertedJobCardId,
        response: input.response,
      },
      traceId: input.traceId,
    });

    const envelope: EventEnvelope = {
      id: uuidv7(),
      type: 'ledger.item_closed',
      occurredAt: at.toISOString(),
      shopId: item.shopId,
      traceId: input.traceId,
      payload: {
        ledgerItemId: item.id,
        jobCardId: item.jobCardId,
        customerId: item.customerId,
        status: input.status,
        // The cohort is the one the item was *ledgered* in, not the one it
        // closed in, so the 90-day recovery rate can be folded in a single pass.
        openedAt: item.createdAt.toISOString(),
        ledgeredAmountPaise: item.amountPaise,
        recoveredAmountPaise: input.recoveredAmountPaise,
        convertedJobCardId: input.convertedJobCardId,
        response: input.response,
        reason: input.reason,
        actor: { type: actor.type, id: actor.id },
      },
    };
    await this.deps.outbox.enqueue(tx, envelope);
  }
}
