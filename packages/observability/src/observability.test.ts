import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registry } from './metrics';
import { SPAN_ATTRIBUTE_RULE, currentTraceId } from './tracing';

/**
 * The metric set, the alert rules and the dashboards must name the same series
 * (phase 7.4).
 *
 * The failure this prevents is quiet and total, and it shows up differently in
 * each place: an alert rule referencing a metric nobody exports never fires and
 * looks exactly like a condition that never happened, and a dashboard panel
 * querying one renders "No data", which an operator mid-incident reads as
 * "nothing is happening" rather than "this has been broken since March".
 *
 * "Every alert rule fired in test" is an acceptance-gate item; this is the half
 * of it that can be checked without standing Prometheus up.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..');
const ALERTS_PATH = join(REPO_ROOT, 'infra', 'prometheus', 'alerts.yml');
const DASHBOARD_DIR = join(REPO_ROOT, 'infra', 'grafana', 'dashboards');

const exportedMetrics = (): Set<string> =>
  new Set(registry.getMetricsAsArray().map((metric) => metric.name));

/**
 * Every `serviceloop_*` series named in a file, with the histogram and counter
 * suffixes Prometheus appends stripped back to the declared name.
 */
function referencedMetrics(source: string): Set<string> {
  const matches = source.matchAll(/\b(serviceloop_[a-z0-9_]+?)(?:_total|_sum|_count|_bucket)?\b/g);
  return new Set([...matches].map((match) => match[1] as string));
}

function unexported(referenced: Iterable<string>, exported: Set<string>): string[] {
  // prom-client appends `_total` to a Counter's exported name, so a rule may
  // spell it either way and both must resolve.
  return [...referenced].filter((name) => !exported.has(name) && !exported.has(`${name}_total`));
}

describe('the metric registry', () => {
  it('exports every metric the alert rules reference', () => {
    const missing = unexported(
      referencedMetrics(readFileSync(ALERTS_PATH, 'utf8')),
      exportedMetrics(),
    );
    expect(missing, 'Alert rules reference metrics nothing exports:').toEqual([]);
  });

  it('exports every metric the committed dashboards query', () => {
    const exported = exportedMetrics();
    const files = readdirSync(DASHBOARD_DIR).filter((name) => name.endsWith('.json'));

    // A directory that has been emptied would make the assertion below
    // vacuously true, which is the failure mode of every file-walking test.
    expect(files.length, 'no dashboards found to check').toBeGreaterThan(3);

    const missing: string[] = [];
    for (const file of files) {
      const referenced = referencedMetrics(readFileSync(join(DASHBOARD_DIR, file), 'utf8'));
      for (const name of unexported(referenced, exported)) missing.push(`${file}: ${name}`);
    }

    expect(missing, 'Dashboard panels query metrics nothing exports:').toEqual([]);
  });

  it('gives every metric a help string', () => {
    // A metric with no help is a metric nobody on call can interpret at 3am.
    for (const metric of registry.getMetricsAsArray()) {
      expect(metric.help.length, `${metric.name} has no help`).toBeGreaterThan(10);
    }
  });

  it('carries no per-customer label anywhere', () => {
    /**
     * Two problems at once, which is why it is asserted rather than reviewed:
     * an unbounded label explodes Prometheus's cardinality, and a customer id
     * in a metrics backend is personal data in a system with no redaction
     * policy in front of it.
     */
    const forbidden = ['customer', 'customer_id', 'phone', 'name', 'body', 'to'];
    for (const metric of registry.getMetricsAsArray()) {
      const labels = (metric as { labelNames?: readonly string[] }).labelNames ?? [];
      for (const label of labels) {
        expect(forbidden.includes(label), `${metric.name} has a forbidden label "${label}"`).toBe(
          false,
        );
      }
    }
  });

  it('renders as Prometheus text', async () => {
    const body = await registry.metrics();
    expect(body).toContain('serviceloop_outbox_oldest_pending_seconds');
    expect(registry.contentType).toContain('text/plain');
  });
});

describe('the alert rules', () => {
  const alerts = readFileSync(ALERTS_PATH, 'utf8');

  it('points every alert at a runbook', () => {
    // An alert with no runbook is a page that wakes somebody up to think from
    // first principles at 3am.
    const names = [...alerts.matchAll(/- alert: (\w+)/g)].map((match) => match[1] as string);
    expect(names.length).toBeGreaterThan(4);
    const runbookReferences = [...alerts.matchAll(/runbook: /g)].length;
    // One `runbook:` label plus one `Runbook:` annotation reference per alert.
    expect(runbookReferences).toBeGreaterThanOrEqual(names.length);
  });

  it('keeps the alert set small enough to be read', () => {
    // The same reasoning that keeps `ALERT_KINDS` to five in the product: a
    // stream that fires for everything is one people mute, and a muted stream
    // is worse than none because the shop believes it has one.
    const names = [...alerts.matchAll(/- alert: (\w+)/g)];
    expect(names.length).toBeLessThanOrEqual(12);
  });
});

describe('tracing', () => {
  it('reports no trace id when tracing is off', () => {
    // Null rather than a zero id: a log field that looks like a trace id and
    // matches nothing in the backend costs somebody ten minutes.
    expect(currentTraceId()).toBeNull();
  });

  it('states its attribute policy where a reviewer will see it', () => {
    expect(SPAN_ATTRIBUTE_RULE).toContain('never message bodies');
  });
});
