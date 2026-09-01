import { getEnv } from '@serviceloop/config';
import type { Request, RequestHandler, Response, NextFunction } from 'express';
import rateLimit, { type Store } from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import type Redis from 'ioredis';
import type { AuthenticatedStaff } from '../auth/auth.types';
import { rootLogger } from './logger';

/**
 * Rate limiting (phase 7.1).
 *
 * Three limiters rather than one, because the three kinds of traffic have
 * nothing in common:
 *
 * - **auth** — a handful of requests per minute per address. This is where
 *   accounts are taken: an OTP is six digits, and 600 attempts a minute walks
 *   the whole space in under a fortnight. Ten is generous for a person who has
 *   fat-fingered their phone number.
 * - **webhooks** — thousands per minute. A Meta redelivery storm after an
 *   outage is *legitimate* traffic carrying real customer messages, and a limit
 *   tuned for a browser would drop them. The ceiling exists because the
 *   endpoint is public, not because we expect to reach it.
 * - **everything else** — a browsing advisor, plus a second limit per *shop*
 *   so one tenant's runaway script cannot starve the others.
 *
 * The counters live in Redis so the limit is a property of the deployment
 * rather than of whichever Cloud Run instance answered. That matters more than
 * it sounds: with `min-instances: 1` and autoscaling, a per-process limiter
 * multiplies its ceiling by the instance count exactly when load is highest.
 */

export interface RateLimiters {
  readonly auth: RequestHandler;
  readonly webhook: RequestHandler;
  readonly general: RequestHandler;
  readonly perShop: RequestHandler;
}

const NO_OP: RequestHandler = (_request, _response, next) => next();

export function createRateLimiters(redis: Redis | null): RateLimiters {
  const env = getEnv();
  if (!env.RATE_LIMIT_ENABLED) {
    return { auth: NO_OP, webhook: NO_OP, general: NO_OP, perShop: NO_OP };
  }

  const store = (prefix: string): Store | undefined =>
    redis === null
      ? undefined
      : new RedisStore({
          prefix: `ratelimit:${prefix}:`,
          // `sendCommand` rather than the client directly: `rate-limit-redis`
          // only needs SCRIPT/EVAL, and passing the whole ioredis instance
          // couples us to its version.
          sendCommand: (...args: string[]) => redis.call(...(args as [string, ...string[]])) as never,
        });

  const base = {
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    standardHeaders: 'draft-7' as const,
    legacyHeaders: false,
  };

  return {
    auth: rateLimit({
      ...base,
      limit: env.RATE_LIMIT_AUTH_MAX,
      ...(store('auth') === undefined ? {} : { store: store('auth') as Store }),
      handler: refuse('AUTH_RATE_LIMITED', 'Too many sign-in attempts. Try again in a minute.'),
    }),
    webhook: rateLimit({
      ...base,
      limit: env.RATE_LIMIT_WEBHOOK_MAX,
      ...(store('webhook') === undefined ? {} : { store: store('webhook') as Store }),
      handler: refuse(
        'WEBHOOK_RATE_LIMITED',
        'This webhook endpoint is being called faster than it can be served.',
      ),
    }),
    general: rateLimit({
      ...base,
      limit: env.RATE_LIMIT_GLOBAL_MAX,
      ...(store('general') === undefined ? {} : { store: store('general') as Store }),
      handler: refuse('RATE_LIMITED', 'Too many requests. Slow down and try again shortly.'),
    }),
    perShop: rateLimit({
      ...base,
      limit: env.RATE_LIMIT_SHOP_MAX,
      ...(store('shop') === undefined ? {} : { store: store('shop') as Store }),
      /**
       * Keyed on the authenticated shop, falling back to the address for a
       * request that has not reached the guard yet. `skip` on unauthenticated
       * requests instead would leave the public webhook routes counted under a
       * single bucket named "anonymous", which is one shop's traffic throttling
       * every other shop's.
       */
      keyGenerator: (request: Request): string => {
        const staff = (request as Request & { staff?: AuthenticatedStaff }).staff;
        return staff === undefined ? `ip:${request.ip ?? 'unknown'}` : `shop:${staff.shopId}`;
      },
      handler: refuse(
        'SHOP_RATE_LIMITED',
        'This workshop has made too many requests this minute. Try again shortly.',
      ),
    }),
  };
}

/**
 * A refusal shaped like every other error this API produces (RFC 9457), and
 * logged once at `warn` — a rate limit that fires silently is indistinguishable
 * from an outage to whoever is looking at the console.
 */
function refuse(code: string, detail: string) {
  return (request: Request, response: Response, _next: NextFunction): void => {
    rootLogger.warn(
      { code, path: request.path, method: request.method },
      'request refused by a rate limit',
    );
    response
      .status(429)
      .type('application/problem+json')
      .send({
        type: `https://serviceloop.dev/errors/${code.toLowerCase().replace(/_/g, '-')}`,
        title: 'TooManyRequests',
        status: 429,
        code,
        detail,
      });
  };
}
