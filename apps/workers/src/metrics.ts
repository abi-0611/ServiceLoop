import { createServer, type Server } from 'node:http';
import {
  collectRuntimeMetrics,
  metricsContentType,
  registry,
  renderMetrics,
} from '@serviceloop/observability';

/**
 * The worker metrics endpoint.
 *
 * The *metrics themselves* moved to `@serviceloop/observability` in phase 7.4,
 * and that move is the whole point of this file now being nine lines of HTTP.
 * They lived here, on a registry only this process had, while the alert rules
 * named them by string — so a rule referencing `serviceloop_dead_lettered_total`
 * matched nothing when evaluated against the API's registry, and an alert rule
 * that matches nothing never fires. It looks exactly like a condition that has
 * never happened.
 *
 * One registry, one module, one test comparing it against the rules file.
 */

export * from '@serviceloop/observability';

collectRuntimeMetrics('serviceloop_workers_');

export function startMetricsServer(port: number, isHealthy: () => boolean): Server {
  const server = createServer((request, response) => {
    if (request.url === '/health' || request.url === '/healthz') {
      const healthy = isHealthy();
      response.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: healthy ? 'ok' : 'down' }));
      return;
    }

    if (request.url === '/metrics') {
      renderMetrics()
        .then((body) => {
          response.writeHead(200, { 'content-type': metricsContentType });
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

/** Re-exported so the existing `import { registry }` call sites keep working. */
export { registry };
