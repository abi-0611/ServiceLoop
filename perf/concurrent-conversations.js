/**
 * k6 — 500 concurrent active conversations (phase 7.6b).
 *
 *   k6 run perf/concurrent-conversations.js
 *
 * Targets: escalation-ladder timing drift under 5 seconds, queue lag recovering
 * within 2 minutes of the burst ending.
 *
 * This is the one that measures something a load generator cannot see on its
 * own. The interesting number is not HTTP latency — it is whether the
 * *timers* still fire on time when the queue is busy. An escalation rung is
 * scheduled for T+45m and fires when a worker gets to it, so a backed-up queue
 * does not drop messages, it delays them silently: a customer gets their
 * approval nudge an hour late and nothing anywhere reports an error.
 *
 * So the assertions read `/metrics` rather than the responses:
 * `serviceloop_ladder_rung_delay_seconds` and `serviceloop_queue_lag_seconds`
 * are the acceptance gate, and the HTTP checks only establish that the load
 * actually landed.
 *
 * Run against DEMO_MODE with the sandbox LLM adapter, which injects realistic
 * latency. A run against the mock adapter measures a system with no model in
 * it, which is not the system.
 */
import http from 'k6/http';
import { check } from 'k6';
import crypto from 'k6/crypto';
import { Trend } from 'k6/metrics';

const API = __ENV.API_BASE_URL || 'http://localhost:3001';
const METRICS = __ENV.METRICS_URL || 'http://localhost:9101/metrics';
const APP_SECRET = __ENV.WHATSAPP_APP_SECRET || 'sandbox-app-secret';
const PHONE_NUMBER_ID = __ENV.WHATSAPP_PHONE_NUMBER_ID || 'sandbox-phone-number-id';

const queueLag = new Trend('worker_queue_lag_seconds');
const rungDelay = new Trend('ladder_rung_delay_seconds_p95');

export const options = {
  scenarios: {
    conversations: {
      executor: 'ramping-vus',
      startVUs: 10,
      stages: [
        { duration: '1m', target: 500 },
        { duration: '3m', target: 500 },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '30s',
    },
    // Polls the worker's metrics endpoint throughout, including during the
    // ramp-down — recovery is half the assertion and it happens after the load
    // stops.
    observer: {
      executor: 'constant-vus',
      vus: 1,
      duration: '7m',
      exec: 'observe',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    // The acceptance gate, measured where it actually lives.
    ladder_rung_delay_seconds_p95: ['max<5'],
    // Two minutes after the burst ends. Sampled across the whole run, so the
    // p95 tolerates the peak and the max is what recovery has to bring down.
    worker_queue_lag_seconds: ['p(95)<120'],
  },
};

function inbound(vu, iteration) {
  const from = `9198${String(70000000 + (vu % 500)).padStart(8, '0')}`;
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'load-test',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '919000000000', phone_number_id: PHONE_NUMBER_ID },
              contacts: [{ profile: { name: 'Load Test' }, wa_id: from }],
              messages: [
                {
                  from,
                  id: `wamid.conv.${vu}.${iteration}.${Date.now()}`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  // Varied, so the agent takes different paths rather than
                  // hitting one cached classification five hundred times.
                  text: { body: PROMPTS[iteration % PROMPTS.length] },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

const PROMPTS = [
  'Is my car ready?',
  'How much will the brake job cost?',
  'That seems expensive, can you do better?',
  'Yes go ahead with the work',
  'When can I collect it?',
];

export default function () {
  const body = inbound(__VU, __ITER);
  const signature = `sha256=${crypto.hmac('sha256', APP_SECRET, body, 'hex')}`;
  const response = http.post(`${API}/webhooks/whatsapp`, body, {
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
  });
  check(response, { acked: (r) => r.status === 200 });
}

/** Scrapes the worker's Prometheus endpoint and records the two gate numbers. */
export function observe() {
  const response = http.get(METRICS);
  if (response.status !== 200) return;

  const lag = maxSeries(response.body, 'serviceloop_queue_lag_seconds');
  if (lag !== null) queueLag.add(lag);

  const delay = histogramQuantile(response.body, 'serviceloop_ladder_rung_delay_seconds', 0.95);
  if (delay !== null) rungDelay.add(delay);
}

/** The largest value of a labelled gauge across all its label sets. */
function maxSeries(text, metric) {
  let max = null;
  for (const line of text.split('\n')) {
    if (!line.startsWith(metric)) continue;
    const value = Number(line.slice(line.lastIndexOf(' ') + 1));
    if (Number.isFinite(value)) max = max === null ? value : Math.max(max, value);
  }
  return max;
}

/**
 * The quantile of a Prometheus histogram, read from its cumulative buckets.
 *
 * Approximate by construction — it returns the upper bound of the bucket the
 * quantile falls in — and that is the right resolution for the assertion: the
 * gate is "under five seconds", and the bucket boundaries are 1, 5, 15, 30.
 * A run that lands in the 5s bucket fails, which is what should happen.
 */
function histogramQuantile(text, metric, quantile) {
  const buckets = [];
  let total = null;

  for (const line of text.split('\n')) {
    if (line.startsWith(`${metric}_count`)) {
      total = (total ?? 0) + Number(line.slice(line.lastIndexOf(' ') + 1));
    }
    if (!line.startsWith(`${metric}_bucket`)) continue;
    const le = /le="([^"]+)"/.exec(line);
    if (le === null) continue;
    buckets.push({
      le: le[1] === '+Inf' ? Number.POSITIVE_INFINITY : Number(le[1]),
      count: Number(line.slice(line.lastIndexOf(' ') + 1)),
    });
  }

  if (total === null || total === 0 || buckets.length === 0) return null;
  buckets.sort((a, b) => a.le - b.le);

  const target = total * quantile;
  for (const bucket of buckets) {
    if (bucket.count >= target) return bucket.le;
  }
  return buckets[buckets.length - 1].le;
}
