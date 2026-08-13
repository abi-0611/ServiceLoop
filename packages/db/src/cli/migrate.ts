import { formatAdapterSelection, getEnv } from '@serviceloop/config';
import { createDatabase } from '../client';
import { runMigrations } from '../migrator';

async function main(): Promise<void> {
  const env = getEnv();
  console.info(`[migrate] target ${redactUrl(env.DATABASE_URL)}`);
  for (const line of formatAdapterSelection(env)) console.info(`[migrate] ${line}`);

  const handle = createDatabase(env);
  try {
    const started = Date.now();
    await runMigrations(handle.db);
    console.info(`[migrate] up to date in ${Date.now() - started}ms`);
  } finally {
    await handle.close();
  }
}

function redactUrl(url: string): string {
  return url.replace(/\/\/([^:]+):[^@]+@/, '//$1:***@');
}

main().catch((error: unknown) => {
  console.error('[migrate] failed');
  console.error(error);
  process.exitCode = 1;
});
