import { getEnv, resetEnvCache } from '@serviceloop/config';
import { sql } from 'drizzle-orm';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { createDatabase, type Database, type DatabaseHandle } from '../src/client';
import { runMigrations } from '../src/migrator';

/**
 * Integration-test harness.
 *
 * By default a throwaway Postgres 16 container is started with Testcontainers,
 * so the suite is self-contained on a developer machine and in CI. Setting
 * `TEST_DATABASE_URL` points the suite at an already-running database instead,
 * which is what the fast local loop uses.
 */

const POSTGRES_IMAGE =
  'postgres:16.6-alpine@sha256:1d04b9ba1d4996401f2552b51beda8187f175c0645c091e4781134fc9c9a3eef';

export interface TestDatabase {
  readonly db: Database;
  readonly url: string;
  stop(): Promise<void>;
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const existing = process.env['TEST_DATABASE_URL'];
  if (existing !== undefined && existing.length > 0) {
    const handle = openHandle(existing);
    await runMigrations(handle.db);
    return {
      db: handle.db,
      url: existing,
      stop: async () => {
        await handle.close();
      },
    };
  }

  const container: StartedTestContainer = await new GenericContainer(POSTGRES_IMAGE)
    .withEnvironment({
      POSTGRES_USER: 'serviceloop',
      POSTGRES_PASSWORD: 'serviceloop',
      POSTGRES_DB: 'serviceloop_test',
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(120_000)
    .start();

  const url = `postgres://serviceloop:serviceloop@${container.getHost()}:${container.getMappedPort(5432)}/serviceloop_test`;
  const handle = openHandle(url);
  await runMigrations(handle.db);

  return {
    db: handle.db,
    url,
    stop: async () => {
      await handle.close();
      await container.stop();
    },
  };
}

function openHandle(url: string): DatabaseHandle {
  process.env['DATABASE_URL'] = url;
  // The env document is frozen once parsed, so point it at the test database
  // before anything reads it.
  resetEnvCache();
  return createDatabase(getEnv());
}

/**
 * Empties every table between test files. `audit_events` is append-only by
 * trigger, so the trigger is disabled for the truncate and immediately
 * re-enabled — the only place in the codebase that is allowed to do this.
 */
export async function truncateAll(db: Database): Promise<void> {
  await db.execute(
    sql`
      alter table audit_events disable trigger audit_events_append_only;
      alter table estimate_lines disable trigger estimate_lines_immutable_when_accepted;
      truncate table
        idempotency_keys, events_outbox, audit_events, shop_config, escalations,
        declined_work_ledger, consents, messages, conversations, approval_requests,
        evidence_bundles, media_assets, estimate_lines, estimates, work_items,
        job_cards, vehicles, customers, staff, shops
      restart identity cascade;
      alter table audit_events enable trigger audit_events_append_only;
      alter table estimate_lines enable trigger estimate_lines_immutable_when_accepted;
    `,
  );
}
