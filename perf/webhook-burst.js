/**
 * k6 — inbound webhook burst (phase 7.6a).
 *
 *   k6 run perf/webhook-burst.js
 *
 * Target: 200 inbound messages/second for 60 seconds, p95 ack under 500ms,
 * zero drops.
 *
 * The shape of the test matters more than the numbers. A webhook is the one
 * endpoint where *we* are not in control of the retry policy: Meta redelivers
 * anything that 5xxs or times out, so a slow ack does not shed load, it
 * multiplies it. The failure mode this reproduces is a Saturday morning where a
 * shop's customers all message at once and the ack time climbs past Meta's
 * timeout, at which point every message is delivered twice and the queue is
 * doing double the work that made it slow.
 *
 * That is why `zero drops` is a hard threshold and latency is measured at the
 * ack rather than at the reply: the webhook's job is to persist and return, and
 * everything downstream of that is the queue's problem.
 */
import http from 'k6/http';
import { check } from 'k6';
import crypto from 'k6/crypto';
import { Counter } from 'k6/metrics';

const API = __ENV.API_BASE_URL || 'http://localhost:3001';
// The sandbox adapter signs with the same HMAC the live one verifies, so this
// exercises the real signature path rather than a bypass.
const APP_SECRET = __ENV.WHATSAPP_APP_SECRET || 'sandbox-app-secret';
const PHONE_NUMBER_ID = __ENV.WHATSAPP_PHONE_NUMBER_ID || 'sandbox-phone-number-id';

const dropped = new Counter('webhook_dropped');

export const options = {
  scenarios: {
    burst: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 200),
      timeUnit: '1s',
      duration: __ENV.DURATION || '60s',
      // Sized for the target rate at the *expected* latency, with headroom.
      // Too few and k6 reports its own starvation as application latency.
      preAllocatedVUs: 60,
      maxVUs: 300,
    },
  },
  thresholds: {
    // The acceptance gate, expressed as a machine-checkable assertion rather
    // than a number in a document.
    'http_req_duration{expected_response:true}': ['p(95)<500'],
    http_req_failed: ['rate==0'],
    webhook_dropped: ['count==0'],
  },
};

function envelope(index) {
  const from = `9198${String(76000000 + (index % 100000)).padStart(8, '0')}`;
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
                  // Unique per message: a repeated id is deduplicated by the
                  // idempotency key, which would make the test measure the
                  // fast path and report a latency nobody will ever see.
                  id: `wamid.load.${__VU}.${__ITER}.${Date.now()}`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: 'Is my car ready?' },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

export default function () {
  const body = envelope(__ITER);
  const signature = `sha256=${crypto.hmac('sha256', APP_SECRET, body, 'hex')}`;

  const response = http.post(`${API}/webhooks/whatsapp`, body, {
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
    tags: { name: 'webhook' },
  });

  const ok = check(response, {
    'acked 200': (r) => r.status === 200,
    // A 200 that says it received nothing is a drop wearing a success code —
    // exactly the failure a status-only assertion misses.
    'received at least one': (r) => {
      try {
        return JSON.parse(r.body).received >= 1;
      } catch {
        return false;
      }
    },
  });

  if (!ok) dropped.add(1);
}
