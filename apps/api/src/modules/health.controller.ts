import { Controller, Get, Header, Inject } from '@nestjs/common';
import { getEnv } from '@serviceloop/config';
import type { Database } from '@serviceloop/db';
import type { HealthResponse } from '@serviceloop/shared';
import { sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import {
  collectRuntimeMetrics,
  metricsContentType,
  renderMetrics,
} from '@serviceloop/observability';
import { Public } from '../auth/auth.types';
import { DATABASE, REDIS } from '../infra/tokens';

/**
 * Liveness, readiness and Prometheus metrics.
 *
 * The metrics come from `@serviceloop/observability` rather than from a
 * registry declared here (phase 7.4). A private registry per process is how the
 * alert rules ended up naming series that only the *workers* exported: a rule
 * evaluated against this endpoint matched nothing, and an alert that matches
 * nothing looks exactly like a condition that never occurs.
 */

collectRuntimeMetrics('serviceloop_api_');

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
  @Header('content-type', metricsContentType)
  async metrics(): Promise<string> {
    return renderMetrics();
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
