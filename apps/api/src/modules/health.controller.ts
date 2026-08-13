import { Controller, Get, Header, Inject } from '@nestjs/common';
import { getEnv } from '@serviceloop/config';
import type { Database } from '@serviceloop/db';
import type { HealthResponse } from '@serviceloop/shared';
import { sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { collectDefaultMetrics, Registry } from 'prom-client';
import { Public } from '../auth/auth.types';
import { DATABASE, REDIS } from '../infra/tokens';

/** Liveness, readiness and Prometheus metrics. */

const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'serviceloop_api_' });

@Controller()
export class HealthController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Public()
  @Get('health')
  health(): { status: 'ok'; version: string; demoMode: boolean } {
    const env = getEnv();
    return { status: 'ok', version: env.APP_VERSION, demoMode: env.DEMO_MODE };
  }

  /** Readiness actually touches its dependencies rather than assuming them. */
  @Public()
  @Get('health/ready')
  async ready(): Promise<HealthResponse> {
    const env = getEnv();
    const checks = await Promise.all([
      timed('postgres', async () => {
        await this.db.execute(sql`select 1`);
      }),
      timed('redis', async () => {
        await this.redis.ping();
      }),
    ]);

    const down = checks.filter((check) => check.status === 'down');
    return {
      status: down.length === 0 ? 'ok' : down.length === checks.length ? 'down' : 'degraded',
      demoMode: env.DEMO_MODE,
      version: env.APP_VERSION,
      checks,
    };
  }

  @Public()
  @Get('metrics')
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  async metrics(): Promise<string> {
    return registry.metrics();
  }
}

async function timed(
  name: string,
  probe: () => Promise<void>,
): Promise<HealthResponse['checks'][number]> {
  const started = Date.now();
  try {
    await probe();
    return { name, status: 'ok', latencyMs: Date.now() - started, detail: null };
  } catch (error) {
    return {
      name,
      status: 'down',
      latencyMs: Date.now() - started,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
