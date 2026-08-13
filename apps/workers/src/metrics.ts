import { createServer, type Server } from 'node:http';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Worker metrics (master §2 — observability wired from phase 1).
 * Exposed on `WORKERS_METRICS_PORT` alongside a liveness endpoint.
 */

export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'serviceloop_workers_' });

export const outboxDispatched = new Counter({
  name: 'serviceloop_outbox_dispatched_total',
  help: 'Outbox events successfully published to a queue',
  labelNames: ['queue', 'type'] as const,
  registers: [registry],
});

export const outboxFailed = new Counter({
  name: 'serviceloop_outbox_failed_total',
  help: 'Outbox events whose publish attempt failed',
  labelNames: ['type'] as const,
  registers: [registry],
});

export const outboxParked = new Counter({
  name: 'serviceloop_outbox_parked_total',
  help: 'Outbox events parked as FAILED after exhausting their attempts',
  labelNames: ['type'] as const,
  registers: [registry],
});

export const outboxBacklog = new Gauge({
  name: 'serviceloop_outbox_backlog',
  help: 'Outbox rows by status',
  labelNames: ['status'] as const,
  registers: [registry],
});

export const jobsProcessed = new Counter({
  name: 'serviceloop_queue_jobs_processed_total',
  help: 'Queue jobs processed',
  labelNames: ['queue', 'type', 'outcome'] as const,
  registers: [registry],
});

export const jobDuration = new Histogram({
  name: 'serviceloop_queue_job_duration_seconds',
  help: 'Queue job handling duration',
  labelNames: ['queue', 'type'] as const,
  buckets: [0.005, 0.025, 0.1, 0.5, 1, 5, 15],
  registers: [registry],
});

export const deadLettered = new Counter({
  name: 'serviceloop_dead_lettered_total',
  help: 'Jobs moved to the dead-letter queue',
  labelNames: ['queue', 'type'] as const,
  registers: [registry],
});

export const chainIntegrityFailures = new Counter({
  name: 'serviceloop_audit_chain_integrity_failures_total',
  help: 'Audit chain verifications that found a break',
  labelNames: ['shop'] as const,
  registers: [registry],
});

export function startMetricsServer(port: number, isHealthy: () => boolean): Server {
  const server = createServer((request, response) => {
    if (request.url === '/health' || request.url === '/healthz') {
      const healthy = isHealthy();
      response.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: healthy ? 'ok' : 'down' }));
      return;
    }

    if (request.url === '/metrics') {
      registry
        .metrics()
        .then((body) => {
          response.writeHead(200, { 'content-type': registry.contentType });
          response.end(body);
        })
        .catch((error: unknown) => {
          response.writeHead(500, { 'content-type': 'text/plain' });
          response.end(String(error));
        });
      return;
    }

    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  });

  server.listen(port);
  return server;
}
