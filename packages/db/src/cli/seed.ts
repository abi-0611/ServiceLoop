import { getEnv } from '@serviceloop/config';
import { sql } from 'drizzle-orm';
import { createDatabase, type Database } from '../client';
import { rollbackLastMigration, runMigrations } from '../migrator';
import { seedDemoShop } from '../seed/seed';

/**
 * `pnpm db:seed` — populate the demo shop.
 *
 * `--reset` rebuilds from scratch by rolling every migration back and
 * reapplying. That is the only supported way to re-seed, because
 * `audit_events` is append-only by trigger: a chain cannot be quietly deleted.
 */

/**
 * Empties every table before the schema is rolled back.
 *
 * The phase-2 down migration deliberately refuses to run while an unidentified
 * or staff-group conversation exists: those rows have no home in the phase-1
 * shape, and a real operational rollback should stop rather than lose them.
 * `--reset` is not that — it is "destroy and rebuild", and the rows are going
 * either way. Clearing first leaves the guard exactly as strict for
 * `db:rollback`, which is where it matters, while letting a rebuild proceed.
 *
 * The append-only trigger on `audit_events` has to come off for the truncate
 * and goes straight back on. Dev-only: `main` refuses `--reset` in production.
 */
async function truncateAllData(db: Database): Promise<void> {
  await db.execute(sql`
    alter table audit_events disable trigger audit_events_append_only;
    alter table estimate_lines disable trigger estimate_lines_immutable_when_accepted;
    truncate table idempotency_keys, events_outbox, audit_events, shop_config, escalations,
      declined_work_ledger, merge_suggestions, job_card_drafts, consents, messages,
      wa_templates, conversations, approval_requests, evidence_bundles, media_assets,
      estimate_lines, estimates, work_items, job_cards, vehicles, customers, staff, shops
      restart identity cascade;
    alter table audit_events enable trigger audit_events_append_only;
    alter table estimate_lines enable trigger estimate_lines_immutable_when_accepted;
  `);
}

async function resetSchema(db: Database): Promise<void> {
  await truncateAllData(db);
  console.info('[seed] existing data cleared');

  for (let guard = 0; guard < 50; guard += 1) {
    const result = await rollbackLastMigration(db);
    if (result.rolledBack === null) break;
    console.info(`[seed] rolled back ${result.rolledBack}`);
  }
  await runMigrations(db);
  console.info('[seed] schema rebuilt');
}

async function main(): Promise<void> {
  const env = getEnv();
  const reset = process.argv.includes('--reset');

  if (reset && env.NODE_ENV === 'production') {
    throw new Error('Refusing to reset the schema in production');
  }

  const handle = createDatabase(env);
  try {
    if (reset) await resetSchema(handle.db);

    const result = await seedDemoShop(handle.db, { env });
    if (result.skipped) return;

    console.info('[seed] done:');
    console.info(`  shop         ${result.shopId} (${1})`);
    console.info(`  staff        ${result.staff}`);
    console.info(`  customers    ${result.customers}`);
    console.info(`  vehicles     ${result.vehicles}`);
    console.info(`  job cards    ${result.jobCards}`);
    console.info(`  work items   ${result.workItems}`);
    console.info(`  estimates    ${result.estimates}`);
    console.info(`  media        ${result.mediaAssets}`);
    console.info(`  transitions  ${result.transitions}`);
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error('[seed] failed');
  console.error(error);
  process.exitCode = 1;
});
