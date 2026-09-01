/**
 * k6 — the console board at scale (phase 7.6c).
 *
 *   k6 run perf/console-board.js
 *
 * Target: a shop with 5,000 job cards, p95 route under 800ms.
 *
 * Five thousand cards is not a plausible *open* board — it is two or three
 * years of history for a busy shop, and the board query has to stay fast as
 * that history accumulates behind it. The failure this catches is an index that
 * covers the state filter but not the shop scope, which is invisible at the
 * seeded fifty cards and quadratic at five thousand.
 *
 * The board, a card drawer and the analytics summary, because they fail
 * differently: the board is a filtered scan, the drawer is a fan-out of small
 * reads, and the summary reads a stored rollup and must not touch the event log.
 */
import http from 'k6/http';
import { check, group } from 'k6';

const API = __ENV.API_BASE_URL || 'http://localhost:3001';
const TOKEN = __ENV.ACCESS_TOKEN;

if (!TOKEN) {
  throw new Error(
    'Set ACCESS_TOKEN. Obtain one with the OTP flow against the seeded shop; ' +
      'see docs/perf/README.md.',
  );
}

export const options = {
  scenarios: {
    browsing: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '30s', target: 10 },
        { duration: '2m', target: 10 },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    'http_req_duration{route:board}': ['p(95)<800'],
    'http_req_duration{route:card}': ['p(95)<800'],
    'http_req_duration{route:analytics}': ['p(95)<800'],
    http_req_failed: ['rate<0.01'],
  },
};

const headers = { authorization: `Bearer ${TOKEN}` };

export default function () {
  let cardId = null;

  group('board', () => {
    const response = http.get(`${API}/jobcards/board`, { headers, tags: { route: 'board' } });
    check(response, { 'board 200': (r) => r.status === 200 });
    try {
      const cards = JSON.parse(response.body).cards ?? [];
      cardId = cards.length > 0 ? cards[Math.floor(Math.random() * cards.length)].id : null;
    } catch {
      cardId = null;
    }
  });

  if (cardId !== null) {
    group('card drawer', () => {
      const response = http.get(`${API}/jobcards/${cardId}`, { headers, tags: { route: 'card' } });
      check(response, { 'card 200': (r) => r.status === 200 });
    });
  }

  group('analytics', () => {
    const response = http.get(`${API}/analytics/summary?days=30`, {
      headers,
      tags: { route: 'analytics' },
    });
    // The property this asserts is architectural, not just fast: the summary
    // reads a stored rollup and never folds the event log on the request path.
    // A regression that started folding would show up here as seconds, not
    // milliseconds, long before it showed up as a wrong number.
    check(response, { 'analytics 200': (r) => r.status === 200 });
  });
}
