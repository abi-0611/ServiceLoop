import { getEnv } from '@serviceloop/config';
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

async function resetSchema(db: Database): Promise<void> {
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
