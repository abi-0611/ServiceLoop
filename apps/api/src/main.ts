import 'reflect-metadata';
import { getEnv } from '@serviceloop/config';
import { createApp, logBootBanner } from './bootstrap';
import { rootLogger } from './common/logger';

async function main(): Promise<void> {
  logBootBanner();

  const env = getEnv();
  const app = await createApp();
  await app.listen(env.API_PORT, '0.0.0.0');

  rootLogger.info({ port: env.API_PORT, baseUrl: env.API_BASE_URL }, 'api listening');
}

main().catch((error: unknown) => {
  console.error('[api] failed to start');
  console.error(error);
  process.exit(1);
});
