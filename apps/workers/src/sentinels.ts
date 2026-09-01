import type { LoopRuntime } from '@serviceloop/agent-core';
import { PgConversationStore, type PgUnitOfWork, type Tx } from '@serviceloop/db';
import { groupThreadKey } from '@serviceloop/domain';
import { migrateShopConfig } from '@serviceloop/config';
import { PgShopConfigStore } from '@serviceloop/db';
import { uuidv7 } from '@serviceloop/shared';
import type { Logger } from 'pino';

/**
 * The phase-4 polling sentinels: the silent bay (4.6), the pickup reminder
 * (4.7) and the gentle balance ladder (4.9).
 *
 * Polling rather than delayed jobs, for the reason phase 2 established with the
 * quiet-hours drain: a delayed job fixes its decision at the moment of
 * scheduling, and every one of these depends on state that can change in
 * between. A shop that shortens its working hours, a customer who pays at the
 * counter, a technician who finally sends a note — each of those must be
 * honoured by a scan that reads the current world, not by a timer set an hour
 * ago against the old one.
 *
 * Each pass is independently safe to lose: nothing is marked done until it has
 * been done, so the next tick reclaims exactly what the failed one left.
 */

/**
 * What every sentinel needs, whatever it is scanning.
 *
 * Split out of `SentinelDeps` so phase 6's scanners can extend the same base
 * without dragging `LoopRuntime` in: a retention scan has no business holding a
 * payment gateway.
 */
export interface SentinelBase {
  readonly uow: PgUnitOfWork;
  readonly logger: Logger;
  /** Shops to scan. Resolved once at boot; a new shop joins on the next restart. */
  readonly shopIds: () => Promise<readonly string[]>;
}

export interface SentinelDeps extends SentinelBase {
  readonly loop: LoopRuntime<Tx>;
}

export abstract class PollingSentinel {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private busy = false;

  protected constructor(
    private readonly base: SentinelBase,
    private readonly intervalMs: number,
    private readonly label: string,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.busy) await new Promise((resolve) => setTimeout(resolve, 25));
  }

  /** One pass. Exposed so a test and the demo can drive it without a timer. */
  async runOnce(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.pass();
    } catch (error) {
      // A failed pass must not stop the loop: the next tick reclaims the same
      // work, because nothing was marked done.
      this.base.logger.error({ err: error }, `${this.label} pass failed`);
    } finally {
      this.busy = false;
    }
  }

  protected abstract pass(): Promise<void>;

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.runOnce().finally(() => this.schedule());
    }, this.intervalMs);
    this.timer.unref?.();
  }
}

/**
 * The silent-bay scan (phase 4.6).
 *
 * Runs per shop, because the threshold, the working hours and the staff group
 * are all shop configuration. The nudge goes to the shop's own staff thread;
 * a shop that has not configured one is scanned anyway — the
 * `silent_bay.detected` events still reach the owner digest in phase 6, they
 * just do not interrupt anybody's WhatsApp.
 */
export class SilentBayScanner extends PollingSentinel {
  private readonly conversations = new PgConversationStore();
  private readonly config = new PgShopConfigStore();

  constructor(
    private readonly deps: SentinelDeps,
    intervalMs: number,
  ) {
    super(deps, intervalMs, 'silent-bay');
  }

  protected async pass(): Promise<void> {
    for (const shopId of await this.deps.shopIds()) {
      const staffConversationId = await this.resolveStaffThread(shopId);

      const result = await this.deps.loop.silentBay.scan({
        shopId,
        staffConversationId,
        actor: { type: 'SYSTEM', id: null },
        traceId: `silent-bay:${uuidv7()}`,
      });

      if (result.nudged.length > 0) {
        this.deps.logger.info(
          {
            shopId,
            examined: result.examined,
            silent: result.silent.length,
            nudged: result.nudged.length,
            escalated: result.escalated.length,
            windowStart: result.windowStart.toISOString(),
          },
          'nudged silent bays',
        );
      }
    }
  }

  /** The shop's technician evidence group, from its own configuration. */
  private async resolveStaffThread(shopId: string): Promise<string | null> {
    return this.deps.uow.transaction(async (tx) => {
      const stored = await this.config.load(tx, shopId);
      const timezone = (await this.config.loadShopTimezone(tx, shopId)) ?? 'Asia/Kolkata';
      const config = migrateShopConfig(stored?.raw ?? {}, timezone).config;

      const groupId = config.messaging.staffGroupId;
      if (groupId === null) return null;

      const thread = await this.conversations.findByThreadKey(
        tx,
        shopId,
        'WHATSAPP',
        groupThreadKey(groupId),
      );
      return thread?.id ?? null;
    });
  }
}

/**
 * Pickup reminders (4.7) and the balance ladder (4.9).
 *
 * One sentinel for both because they are the same shape — claim what is due,
 * act, mark it — and because a shop with neither should pay for one timer, not
 * two.
 *
 * The balance ladder's cap lives in three places by design: the shop-config
 * schema, a database CHECK, and `sendBalanceReminder` itself. This loop simply
 * asks for what is due; it cannot exceed the cap even if it tried, which is the
 * point of putting the limit below the caller.
 */
export class ReminderSentinel extends PollingSentinel {
  constructor(
    private readonly deps: SentinelDeps,
    intervalMs: number,
    private readonly batchSize: number,
  ) {
    super(deps, intervalMs, 'reminders');
  }

  protected async pass(): Promise<void> {
    await this.pickupReminders();
    await this.balanceReminders();
  }

  private async pickupReminders(): Promise<void> {
    for (const shopId of await this.deps.shopIds()) {
      const due = await this.deps.uow.transaction((tx) =>
        this.deps.loop.delivery.claimDueReminders(tx, shopId, this.batchSize),
      );

      for (const booking of due) {
        const result = await this.deps.loop.delivery.sendReminder({
          shopId,
          booking,
          actor: { type: 'SYSTEM', id: null },
          traceId: `pickup-reminder:${uuidv7()}`,
        });

        this.deps.logger.info(
          { shopId, bookingId: booking.id, sent: result.sent, status: result.status },
          'pickup reminder',
        );
      }
    }
  }

  private async balanceReminders(): Promise<void> {
    for (const shopId of await this.deps.shopIds()) {
      const due = await this.deps.uow.transaction((tx) =>
        this.deps.loop.payments.claimDueReminders(tx, shopId, this.batchSize),
      );

      for (const payment of due) {
        const result = await this.deps.loop.payments.sendBalanceReminder({
          shopId,
          paymentId: payment.id,
          actor: { type: 'SYSTEM', id: null },
          traceId: `balance-reminder:${uuidv7()}`,
        });

        this.deps.logger.info(
          { shopId, paymentId: payment.id, sent: result.sent, rung: result.rung, detail: result.detail },
          'balance reminder',
        );
      }
    }
  }
}
