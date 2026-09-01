import { getEnv, migrateShopConfig, type ShopConfig } from '@serviceloop/config';
import { MetricsService } from '@serviceloop/domain';
import { localDaysBetween, uuidv7, type IsoDay } from '@serviceloop/shared';
import { sql } from 'drizzle-orm';
import { AuditService } from '../services/audit-service';
import { OutboxService } from '../services/outbox-service';
import { createDatabase, PgUnitOfWork, type Tx } from '../client';
import { PgShopConfigStore } from '../stores/shop-config-store';
import { PgEventLogReader, PgRollupStore } from '../stores/retention-store';

/**
 * `pnpm metrics:recompute --from 2026-08-01 [--to 2026-08-31] [--shop <id>]`
 *
 * The audit story for the number the whole business rests on (phase 6.9).
 *
 * Every KPI the console shows and every rupee the evening digest quotes is a
 * fold over the event log, and this command runs that fold again. It exists so
 * that "₹42,000 recovered from previously declined work" is a claim somebody
 * can *check* rather than a claim they have to accept — including six months
 * later, from a database backup, with the original workers long gone.
 *
 * The output that matters is the changed-day count, and *changed* means one
 * precise thing: a day that already had a stored rollup produced different
 * numbers this time. A rollup is a derived value with exactly one right answer,
 * so that is news — either a bug has just been fixed or one has just been
 * introduced — and the exit code says so, non-zero, which is how a nightly cron
 * notices without anybody reading the log.
 *
 * A day the fold had never seen is *filled in*, not changed. Backfilling a
 * quarter a shop was live for before analytics existed writes a hundred rollups
 * where none stood, and none of that is a regression. Counting those as changes
 * would make the alarm fire on its own first run and be muted for ever after.
 */

interface Options {
  readonly from: IsoDay;
  readonly to: IsoDay | null;
  readonly shopId: string | null;
}

function parseArgs(argv: readonly string[]): Options {
  const value = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    return index === -1 ? null : (argv[index + 1] ?? null);
  };

  const from = value('--from');
  if (from === null || !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    throw new Error('Usage: recompute --from YYYY-MM-DD [--to YYYY-MM-DD] [--shop <uuid>]');
  }
  const to = value('--to');
  if (to !== null && !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new Error('--to must be YYYY-MM-DD');
  }

  return { from, to, shopId: value('--shop') };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const env = getEnv();
  const handle = createDatabase(env);

  try {
    const uow = new PgUnitOfWork(handle.db);
    const configStore = new PgShopConfigStore();

    const loadConfig = async (tx: Tx, shopId: string): Promise<ShopConfig> => {
      const stored = await configStore.load(tx, shopId);
      const timezone = (await configStore.loadShopTimezone(tx, shopId)) ?? env.DEFAULT_TIMEZONE;
      return migrateShopConfig(stored?.raw ?? {}, timezone).config;
    };

    const metrics = new MetricsService<Tx>({
      uow,
      events: new PgEventLogReader(),
      rollups: new PgRollupStore(),
      audit: new AuditService(handle.db),
      outbox: new OutboxService(handle.db),
      loadConfig,
    });

    const shopIds =
      options.shopId === null ? await listActiveShopIds(handle.db) : [options.shopId];
    if (shopIds.length === 0) {
      console.info('[recompute] no active shops');
      return;
    }

    let changedTotal = 0;
    for (const shopId of shopIds) {
      const results = await metrics.recompute({
        shopId,
        from: options.from,
        ...(options.to === null ? {} : { to: options.to }),
        traceId: `recompute:${uuidv7()}`,
      });

      const filled = results.filter((result) => result.previousHash === null);
      const changed = results.filter(
        (result) => result.previousHash !== null && result.changed,
      );
      changedTotal += changed.length;

      const span =
        options.to === null ? results.length : localDaysBetween(options.from, options.to) + 1;
      console.info(
        `[recompute] ${shopId}: ${results.length}/${span} day(s) folded, ${filled.length} filled in, ${changed.length} changed`,
      );
      for (const result of changed) {
        console.info(
          `[recompute]   ${result.day}: ${result.previousHash ?? '(none)'} → ${result.payloadHash} (${result.eventsRead} events)`,
        );
      }
    }

    if (changedTotal > 0) {
      // Non-zero on change, deliberately. A derived value that moved when it
      // was recomputed is the one outcome anybody needs to be told about, and a
      // cron job that only reads exit codes should be told.
      console.error(
        `[recompute] ${changedTotal} day(s) that already had a rollup produced different numbers`,
      );
      process.exitCode = 1;
      return;
    }

    // There is no dry-run mode, on purpose: a fold that reproduces the stored
    // rollup writes the identical bytes, so "check" and "repair" are the same
    // operation. A flag that pretended otherwise would be a flag somebody
    // trusted in production.
    console.info('[recompute] every day that had a rollup reproduced exactly');
  } finally {
    await handle.close();
  }
}

async function listActiveShopIds(
  db: ReturnType<typeof createDatabase>['db'],
): Promise<readonly string[]> {
  const result = await db.execute<{ id: string }>(sql`
    select id from shops where is_active = true and deleted_at is null order by created_at asc
  `);
  return result.rows.map((row) => row.id);
}

main().catch((error: unknown) => {
  console.error('[recompute] failed');
  console.error(error);
  process.exitCode = 1;
});
