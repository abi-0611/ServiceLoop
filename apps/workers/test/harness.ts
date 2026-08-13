import { getEnv, resetEnvCache } from '@serviceloop/config';
import { createDatabase, runMigrations, type Database, type DatabaseHandle } from '@serviceloop/db';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

/**
 * Workers integration harness: a throwaway Postgres and Redis, or the URLs in
 * `TEST_DATABASE_URL` / `TEST_REDIS_URL` when they are set.
 */

const POSTGRES_IMAGE =
  'postgres:16.6-alpine@sha256:1d04b9ba1d4996401f2552b51beda8187f175c0645c091e4781134fc9c9a3eef';
const REDIS_IMAGE =
  'redis:7.4-alpine@sha256:e7723ff73d963f5cc6d9c4643ea3d989527a402a319239054e9472a7fb9219a2';

export interface WorkerTestStack {
  readonly db: Database;
  readonly databaseUrl: string;
  readonly redisUrl: string;
  stop(): Promise<void>;
}

export async function startWorkerStack(): Promise<WorkerTestStack> {
  const containers: StartedTestContainer[] = [];

  let databaseUrl = process.env['TEST_DATABASE_URL'] ?? '';
  if (databaseUrl.length === 0) {
    const postgres = await new GenericContainer(POSTGRES_IMAGE)
      .withEnvironment({
        POSTGRES_USER: 'serviceloop',
        POSTGRES_PASSWORD: 'serviceloop',
        POSTGRES_DB: 'serviceloop_test',
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .withStartupTimeout(120_000)
      .start();
    containers.push(postgres);
    databaseUrl = `postgres://serviceloop:serviceloop@${postgres.getHost()}:${postgres.getMappedPort(5432)}/serviceloop_test`;
  }

  let redisUrl = process.env['TEST_REDIS_URL'] ?? '';
  if (redisUrl.length === 0) {
    const redis = await new GenericContainer(REDIS_IMAGE)
      .withCommand(['redis-server', '--maxmemory-policy', 'noeviction'])
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .withStartupTimeout(120_000)
      .start();
    containers.push(redis);
    redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
  }

  process.env['DATABASE_URL'] = databaseUrl;
  process.env['REDIS_URL'] = redisUrl;
  resetEnvCache();

  const handle: DatabaseHandle = createDatabase(getEnv());
  await runMigrations(handle.db);

  return {
    db: handle.db,
    databaseUrl,
    redisUrl,
    stop: async () => {
      await handle.close();
      for (const container of containers) await container.stop();
    },
  };
}
