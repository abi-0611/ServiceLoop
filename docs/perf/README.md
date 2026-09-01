# Load and performance

Three k6 suites, one per target in the phase-7 acceptance gate. Each threshold
below is a **machine-checkable assertion inside the suite**, not a number in a
document — the suite exits non-zero when it is missed, which is why CI can gate
on it.

## The targets

| Suite | Target | Threshold in code |
| --- | --- | --- |
| `perf/webhook-burst.js` | 200 inbound msgs/s for 60s, p95 ack < 500ms, **zero drops** | `p(95)<500`, `http_req_failed: rate==0`, `webhook_dropped: count==0` |
| `perf/concurrent-conversations.js` | 500 concurrent conversations with agent runs; ladder timing drift < 5s; queue lag recovers < 2 min | `ladder_rung_delay_seconds_p95: max<5`, `worker_queue_lag_seconds: p(95)<120` |
| `perf/console-board.js` | Board with 5k cards, p95 route < 800ms | `p(95)<800` on board, card and analytics routes |

## Running them

Against the local compose stack:

```bash
pnpm infra:up && pnpm db:migrate && pnpm db:seed
```

```bash
pnpm perf:webhook
```

```bash
pnpm perf:conversations
```

```bash
pnpm perf:board
```

The board suite needs a session token:

```bash
TOKEN=<access token> API_BASE_URL=http://localhost:3001 k6 run perf/console-board.js
```

**A local run is a smoke test, not a result.** Numbers from a laptop are not
comparable between machines or between weeks. The archived results below are
from the CI-nightly runner, which is a fixed size, and that is the only reason
the comparison means anything.

## Reading the results

**The webhook suite's `zero drops` is the hard one, and latency is secondary.**
A webhook is the one endpoint where we do not control the retry policy: Meta
redelivers anything that 5xxs or times out, so a slow ack does not shed load, it
multiplies it. The failure this reproduces is a Saturday morning where a shop's
customers all message at once, the ack time climbs past Meta's timeout, and
every message arrives twice — doing double the work that made it slow.

If p95 climbs but drops stay at zero, you have headroom. If drops appear, the
system is in the multiplying regime and the number to fix is throughput, not
latency.

**The conversations suite measures ladder drift, not throughput.** The rungs are
promises about *time* — "if nobody answers in twenty minutes, escalate" — and a
system under load that climbs the ladder four seconds late is fine, while one
that is on time but has a queue lag climbing without bound is not. Read the two
together.

**The board suite is the only one a person feels.** 800ms is generous; the
reason it is not tighter is that the board is fetched once and worked from for
an hour. If it regresses, look for an N+1 before looking at indexes.

## Index and N+1 audit

Run `EXPLAIN (ANALYZE, BUFFERS)` over the top ten queries after any schema
change touching a hot path. The ones that matter:

| Query | Watch for |
| --- | --- |
| Board listing by shop and state | Seq scan on `job_cards` — the composite index is `(shop_id, state)` |
| Conversation tail | Sort without index on `(conversation_id, created_at desc)` |
| Outbox claim | Anything other than an index scan; `SKIP LOCKED` on a seq scan is a table lock in disguise |
| Metric rollup read | Should be a single-row lookup. If it is a scan, something is folding on the request path — which the analytics controller is structurally prevented from doing |
| Retention scan | The horizon predicate must be sargable |
| Blind-index phone lookup | Must hit `customers_shop_phone_hash_key`. A seq scan here is every inbound webhook doing a table scan |

## Archived results

Each nightly run writes its summary here as `<date>-<suite>.json`. Keep the
JSON, not a screenshot: a regression is found by diffing two runs, and a
screenshot cannot be diffed.

| Date | Suite | p95 | Threshold | Result |
| --- | --- | --- | --- | --- |
| *(nightly runs append here)* | | | | |

**This table is empty because the nightly workflow has not run yet.** It is
populated by `.github/workflows/nightly.yml`, which archives the k6 summary as a
build artifact and appends a row. A row here that nobody can trace back to a
build artifact should be deleted rather than trusted.
