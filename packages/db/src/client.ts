import { getEnv, type Env } from '@serviceloop/config';
import type { UnitOfWork } from '@serviceloop/domain';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import * as schema from './schema';

/**
 * Database access. One pool per process; `Database` is the drizzle handle and
 * `Tx` is the transaction-scoped handle every repository accepts, so a caller
 * can never accidentally run half of a unit of work outside its transaction.
 */

export type Database = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Anything that can execute a query: the pool handle or a transaction handle. */
export type Executor = Database | Tx;

export interface DatabaseHandle {
  readonly db: Database;
  readonly pool: Pool;
  close(): Promise<void>;
}

export function createPoolConfig(env: Env = getEnv()): PoolConfig {
  return {
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    statement_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS,
    application_name: `${env.SERVICE_NAME}${env.DEMO_MODE ? '-demo' : ''}`,
  };
}

export function createDatabase(env: Env = getEnv()): DatabaseHandle {
  const pool = new Pool(createPoolConfig(env));
  const db = drizzle(pool, { schema, logger: env.LOG_LEVEL === 'trace' });

  return {
    db,
    pool,
    async close() {
      await pool.end();
    },
  };
}

/**
 * The domain's `UnitOfWork` over a real Postgres transaction. Drizzle rolls
 * back automatically when the callback throws, which is what makes
 * "state write + audit append + outbox insert, or nothing" true.
 */
export class PgUnitOfWork implements UnitOfWork<Tx> {
  constructor(private readonly db: Database) {}

  async transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => work(tx));
  }
}

export { schema };
