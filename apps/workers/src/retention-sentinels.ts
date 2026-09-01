import type { RetentionRuntime } from '@serviceloop/agent-core';
import { migrateShopConfig } from '@serviceloop/config';
import { PgShopConfigStore, type PgUnitOfWork, type Tx } from '@serviceloop/db';
import { localDay, minutesOfDayInZone, parseHhMm, uuidv7 } from '@serviceloop/shared';
import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { PollingSentinel, type SentinelBase } from './sentinels';

/**
 * The phase-6 sentinels.
 *
 * Polling, for the reason every sentinel in this codebase polls: a delayed job
 * fixes its decision at the moment of scheduling, and every one of these
 * depends on state that changes in between. A re-pitch scheduled last Tuesday
 * for a customer who has since complained must not go out, and only a scan that
 * reads the current world can know that.
 *
 * Each pass is independently safe to lose: nothing is marked done until it has
 * been done, and the dedupe keys mean a repeated pass writes nothing twice.
 */

export interface RetentionSentinelDeps extends SentinelBase {
  readonly retention: RetentionRuntime<Tx>;
  readonly uow: PgUnitOfWork;
  readonly logger: Logger;
  readonly shopIds: () => Promise<readonly string[]>;
}

/**
 * The trigger engine, the reminders and the win-back (6.2, 6.5, 6.10).
 *
 * One sentinel for four flows because they share a floor: the twenty-one-day
 * minimum between retention touches is enforced per customer across all of
 * them, so running them in one pass — re-pitches first, because a technician's
 * finding beats a calendar — is the difference between honouring the floor and
 * discovering it.
 */
export class RetentionScanner extends PollingSentinel {
  constructor(
    private readonly deps: RetentionSentinelDeps,
    intervalMs: number,
    private readonly batchSize: number,
  ) {
    super(deps, intervalMs, 'retention');
  }

  protected async pass(): Promise<void> {
    for (const shopId of await this.deps.shopIds()) {
      const traceId = `retention:${uuidv7()}`;

      const scan = await this.deps.retention.retention.scan({
        shopId,
        limit: this.batchSize,
        traceId,
      });
      const serviceDue = await this.deps.retention.reminders.sendServiceDue({
        shopId,
        limit: this.batchSize,
        traceId,
      });
      const documents = await this.deps.retention.reminders.sendDocumentReminders({
        shopId,
        limit: this.batchSize,
        traceId,
      });
      const winBack = await this.deps.retention.retention.winBack({
        shopId,
        limit: this.batchSize,
        traceId,
      });

      const sent =
        scan.sent.length +
        [...serviceDue, ...documents, ...winBack].filter((row) => row.status === 'SENT').length;

      if (sent > 0 || scan.skipped.length > 0) {
        this.deps.logger.info(
          {
            shopId,
            examined: scan.examined,
            due: scan.due.length,
            repitched: scan.sent.length,
            withheld: scan.skipped.length,
            serviceDue: serviceDue.length,
            documents: documents.length,
            winBack: winBack.length,
          },
          'retention pass',
        );
      }
    }
  }
}

/** The post-service feedback ask, its one reminder, and its expiry (6.4). */
export class FeedbackSentinel extends PollingSentinel {
  constructor(
    private readonly deps: RetentionSentinelDeps,
    intervalMs: number,
    private readonly batchSize: number,
  ) {
    super(deps, intervalMs, 'feedback');
  }

  protected async pass(): Promise<void> {
    for (const shopId of await this.deps.shopIds()) {
      const traceId = `feedback:${uuidv7()}`;
      const asked = await this.deps.retention.feedback.sendDue({
        shopId,
        limit: this.batchSize,
        traceId,
      });
      // Silence is an answer, and recording it as one is what keeps the
      // satisfaction figure honest about its own response rate.
      const expired = await this.deps.retention.feedback.expireStale({
        shopId,
        limit: this.batchSize,
      });

      if (asked.length > 0 || expired > 0) {
        this.deps.logger.info(
          { shopId, asked: asked.filter((row) => row.sent).length, expired },
          'feedback pass',
        );
      }
    }
  }
}

/**
 * Approvals that have gone unanswered past the shop's threshold (6.8).
 *
 * Folded from the event log rather than queried from the approvals table, so
 * the alert stream and the evening digest cannot disagree about which requests
 * are stuck. The incident key is the approval id, so an owner hears once
 * however often this runs.
 */
export class StuckApprovalSentinel extends PollingSentinel {
  private readonly config = new PgShopConfigStore();

  constructor(
    private readonly deps: RetentionSentinelDeps,
    intervalMs: number,
  ) {
    super(deps, intervalMs, 'stuck-approvals');
  }

  protected async pass(): Promise<void> {
    const now = new Date();
    for (const shopId of await this.deps.shopIds()) {
      const stuck = await this.deps.retention.metrics.stuckApprovals({ shopId, now });
      for (const pending of stuck) {
        await this.deps.retention.alerts.approvalStuck({
          shopId,
          approvalId: pending.approvalId,
          jobCardId: pending.jobCardId,
          vehicleLabel: await this.vehicleLabel(shopId, pending.jobCardId),
          amountPaise: pending.amountPaise,
          waitedMinutes: pending.waitedMinutes,
          traceId: `stuck-approval:${uuidv7()}`,
        });
      }
      if (stuck.length > 0) {
        this.deps.logger.info({ shopId, stuck: stuck.length }, 'stuck approvals');
      }
    }
  }

  private async vehicleLabel(shopId: string, jobCardId: string): Promise<string> {
    return this.deps.uow.transaction(async (tx) => {
      const result = await tx.execute<{ label: string | null; registration: string | null }>(sql`
        select trim(concat_ws(' ', v.make, v.model)) as label,
               v.registration_normalised as registration
        from job_cards j left join vehicles v on v.id = j.vehicle_id
        where j.id = ${jobCardId} and j.shop_id = ${shopId}
      `);
      const row = result.rows[0];
      const label = row?.label ?? '';
      return label.length > 0 ? label : (row?.registration ?? 'a vehicle');
    });
  }
}

/**
 * The nightly fold and the evening brief (6.7, 6.9).
 *
 * One sentinel for both, and in that order: the digest is a projection of the
 * rollup, so the rollup has to be current before the brief is composed. A
 * scheduler that briefed from yesterday's numbers would be the exact failure
 * the "one source of numeric truth" rule exists to prevent.
 *
 * The digest fires when the shop's local wall clock has passed its configured
 * time and no digest exists for the day. The unique index on
 * `(shop, kind, day, recipient)` is what makes that safe: a worker restarted at
 * 20:31 finds the slot taken rather than briefing twice.
 */
export class DigestScheduler extends PollingSentinel {
  private readonly config = new PgShopConfigStore();

  constructor(
    private readonly deps: RetentionSentinelDeps,
    intervalMs: number,
  ) {
    super(deps, intervalMs, 'digest');
  }

  protected async pass(): Promise<void> {
    const now = new Date();

    for (const shopId of await this.deps.shopIds()) {
      const config = await this.deps.uow.transaction(async (tx) => {
        const stored = await this.config.load(tx, shopId);
        const timezone = (await this.config.loadShopTimezone(tx, shopId)) ?? 'Asia/Kolkata';
        return migrateShopConfig(stored?.raw ?? {}, timezone).config;
      });

      const timezone = config.quietHours.timezone;
      const day = localDay(now, timezone);
      const traceId = `digest:${uuidv7()}`;

      // The rollup first, always. Recomputed rather than accumulated, so a
      // worker that was down for an afternoon produces the right numbers rather
      // than the numbers it happened to see.
      await this.deps.retention.metrics.computeDay({ shopId, day, traceId });

      if (!config.digest.enabled) continue;
      if (minutesOfDayInZone(now, timezone) < parseHhMm(config.digest.dailyAt)) continue;

      const results = await this.deps.retention.digest.sendDaily({ shopId, day, traceId });
      const sent = results.filter((row) => row.sent).length;
      if (sent > 0) {
        this.deps.logger.info({ shopId, day, sent }, 'owner digest sent');
      }
    }
  }
}
