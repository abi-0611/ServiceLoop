import 'reflect-metadata';
import { getEnv } from '@serviceloop/config';
import { startTracing, stopTracing } from '@serviceloop/observability';
import { createApp, logBootBanner } from './bootstrap';
import { rootLogger } from './common/logger';

/**
 * Tracing is started *before anything else is imported at runtime* — that is
 * why the call sits above `createApp` rather than inside it. OpenTelemetry's
 * auto-instrumentations patch `http`, `pg` and `ioredis` as they load, so a
 * provider registered after those modules have been required instruments
 * nothing and produces empty traces that look like a sampling problem.
 */
async function main(): Promise<void> {
  startTracing({ component: 'api' });
  logBootBanner();

  const env = getEnv();
  const app = await createApp();
  await app.listen(env.API_PORT, '0.0.0.0');

  rootLogger.info({ port: env.API_PORT, baseUrl: env.API_BASE_URL }, 'api listening');

  const shutdown = (signal: string): void => {
    rootLogger.info({ signal }, 'api shutting down');
    void app
      .close()
      // Flushed before exit, or the last few seconds of an incident — the part
      // anybody actually wants — leave with the process.
      .then(() => stopTracing())
      .then(
        () => process.exit(0),
        (error: unknown) => {
          rootLogger.error({ err: error }, 'unclean shutdown');
          process.exit(1);
        },
      );
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => shutdown(signal));
  }
}

main().catch((error: unknown) => {
  console.error('[api] failed to start');
  console.error(error);
  process.exit(1);
});
