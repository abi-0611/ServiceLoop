import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { formatAdapterSelection, getEnv } from '@serviceloop/config';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { ProblemDetailsFilter } from './common/problem-details.filter';
import { rootLogger } from './common/logger';

/**
 * Application factory, shared by `main.ts` and the integration tests so the
 * tests exercise the same middleware, filters and guards as production.
 */
export async function createApp(): Promise<NestExpressApplication> {
  const env = getEnv();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger:
      env.LOG_LEVEL === 'trace' ? ['log', 'error', 'warn', 'debug', 'verbose'] : ['error', 'warn'],
    bodyParser: true,
  });

  app.use(cookieParser());
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.enableShutdownHooks();
  app.enableCors({
    origin: [env.CONSOLE_URL],
    credentials: true,
    allowedHeaders: ['content-type', 'authorization', 'x-request-id'],
  });

  return app;
}

export function logBootBanner(): void {
  const env = getEnv();
  rootLogger.info(
    { nodeEnv: env.NODE_ENV, demoMode: env.DEMO_MODE, version: env.APP_VERSION },
    'serviceloop api starting',
  );
  for (const line of formatAdapterSelection(env)) rootLogger.info(line);
}
