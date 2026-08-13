import { getEnv } from '@serviceloop/config';
import { createDatabase } from '../client';
import { rollbackLastMigration } from '../migrator';

async function main(): Promise<void> {
  const env = getEnv();
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to roll back automatically in production — run the down script deliberately.',
    );
  }

  const handle = createDatabase(env);
  try {
    const result = await rollbackLastMigration(handle.db);
    if (result.rolledBack === null) {
      console.info('[rollback] nothing to roll back');
      return;
    }
    console.info(`[rollback] reverted ${result.rolledBack} (${result.remaining} still applied)`);
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error('[rollback] failed');
  console.error(error);
  process.exitCode = 1;
});
