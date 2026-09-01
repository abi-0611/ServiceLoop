import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { checkAdapterAllowList, formatAdapterSelection, getEnv } from '@serviceloop/config';
import { ConfigurationError } from '@serviceloop/shared';
import cookieParser from 'cookie-parser';
import Redis from 'ioredis';
import { AppModule } from './app.module';
import { ProblemDetailsFilter } from './common/problem-details.filter';
import { rootLogger } from './common/logger';
import { createRateLimiters } from './common/rate-limit';
import { allowedOrigins, applySecurityHeaders } from './common/security';

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
    /**
     * Keeps the untouched request bytes on `request.rawBody`.
     *
     * X-Hub-Signature-256 is a digest over exactly what Meta sent. Verifying it
     * against a re-serialised body would fail on any key reordering or unicode
     * escaping difference — and the tempting "fix" for that is to stop
     * verifying, which is how a forged webhook gets to write into a shop's
     * conversations.
     */
    rawBody: true,
  });

  applySecurityHeaders(app);
  app.use(cookieParser());

  /**
   * Rate limiting, mounted before the guards.
   *
   * Order is the point: a limiter behind authentication would let an attacker
   * spend a JWT verification (and, on the OTP routes, a Redis round trip) per
   * request before being refused. `app.getHttpAdapter()` rather than a Nest
   * middleware class because these need to run ahead of everything, including
   * the request-context middleware.
   */
  const limiters = createRateLimiters(rateLimitRedis(env.REDIS_URL));
  app.use('/auth/otp', limiters.auth);
  app.use('/webhooks', limiters.webhook);
  app.use(limiters.general);
  app.use(limiters.perShop);

  app.useGlobalFilters(new ProblemDetailsFilter());
  app.enableShutdownHooks();
  app.enableCors({
    origin: [...allowedOrigins()],
    credentials: true,
    allowedHeaders: ['content-type', 'authorization', 'x-request-id'],
    // The console only ever reads its own request id back; anything else it
    // needs comes in the body.
    exposedHeaders: ['x-request-id'],
    maxAge: 600,
  });

  return app;
}

/**
 * A dedicated connection for the limiters.
 *
 * Deliberately *not* the injected `REDIS` provider: that one is created inside
 * the Nest container, and these middlewares are mounted before the container's
 * lifecycle has anything the outer function can await. A second connection is
 * cheap; a limiter that silently fell back to per-process counting because the
 * client was not ready yet is not.
 *
 * `null` when the connection cannot be made — the limiters then count in
 * process memory, which is a weaker limit but still a limit. Failing the boot
 * instead would mean a Redis blip takes the API down.
 */
function rateLimitRedis(url: string): Redis | null {
  try {
    const client = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: false });
    client.on('error', (error: Error) => {
      rootLogger.warn({ err: error }, 'rate-limit redis connection error');
    });
    return client;
  } catch (error) {
    rootLogger.warn({ err: error }, 'rate limiting fell back to per-process counters');
    return null;
  }
}

export function logBootBanner(): void {
  const env = getEnv();
  rootLogger.info(
    {
      nodeEnv: env.NODE_ENV,
      deployEnv: env.DEPLOY_ENV,
      demoMode: env.DEMO_MODE,
      version: env.APP_VERSION,
    },
    'serviceloop api starting',
  );
  for (const line of formatAdapterSelection(env)) rootLogger.info(line);

  /**
   * The production adapter allow-list, enforced at boot rather than merely
   * logged (phase 7.7).
   *
   * A violation is fatal. The alternative — log it and carry on — means a
   * process that has already told an operator it is misconfigured continuing to
   * send real customers messages through an adapter nobody signed off on, and
   * the log line is discovered a week later.
   */
  const violations = checkAdapterAllowList(env);
  if (violations.length > 0) {
    for (const violation of violations) rootLogger.fatal({ violation }, 'adapter allow-list');
    throw new ConfigurationError(
      `Refusing to boot: the live adapters do not match ADAPTER_ALLOWLIST.\n${violations.map((line) => `  • ${line}`).join('\n')}`,
      { violations },
    );
  }
}
