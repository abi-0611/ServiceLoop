# Runbook — starting, stopping, scaling

The mechanics. For "something is broken", go to
[alerts.md](alerts.md) or [playbooks.md](playbooks.md).

## The shape of the thing

Three processes and four stateful dependencies.

| Process | What it is | What breaks if it stops |
| --- | --- | --- |
| `api` | Nest HTTP server | Webhooks are refused; Meta retries and eventually gives up, losing inbound customer messages. The console goes blank. |
| `workers` | Outbox dispatcher, queue consumers, six polling sentinels | Nothing customer-facing goes out. Escalation rungs never fire. Quiet-hours holds never release. **This is the one people forget to scale.** |
| `console` | Next.js | Staff cannot work. Customers are unaffected. |

| Dependency | What breaks if it stops |
| --- | --- |
| Postgres | Everything. |
| Redis | Queues and rate limits. Escalation *timers* are lost; the escalation *rows* are not — see [playbooks.md](playbooks.md#redis-loss). |
| Object storage | Media ingest and invoice rendering. Conversations continue. |
| Meta Cloud API | Customer messaging. Falls back to SMS where a shop has enabled it. |

## Local

```bash
pnpm infra:up
```

```bash
pnpm db:migrate && pnpm db:seed
```

```bash
pnpm dev
```

Grafana, Prometheus, Alertmanager and ClamAV are in a separate compose profile,
because a developer does not need two hundred megabytes of dashboards to fix a
typo:

```bash
pnpm infra:ops
```

Grafana is then on <http://localhost:3002> with the four committed dashboards
already provisioned, and Prometheus on <http://localhost:9090>.

## Staging and production

Both run on Cloud Run. See [../deploy.md](../deploy.md) for deploying; this
section is for operating what is already there.

### Restarting a service

Cloud Run has no restart. Redeploying the same revision is the equivalent, and
is safe — the images are immutable and the migration job is idempotent:

```bash
gcloud run services update serviceloop-api-prod --region asia-south1 --no-traffic --tag restart
```

For a genuine "turn it off and on again", move traffic to the current revision
explicitly, which forces new instances:

```bash
gcloud run services update-traffic serviceloop-api-prod --region asia-south1 --to-latest
```

### Scaling

The `min-instances` settings are load-bearing and are explained in
`infra/deploy/deploy.sh`. In short:

- **api: 1.** A cold start behind a WhatsApp webhook means Meta times out and
  redelivers, and a redelivered webhook is a duplicated inbound message that
  only the idempotency key saves us from.
- **workers: 1.** The workers *are* the timers. A worker scaled to zero is a
  ladder that never climbs, and nothing anywhere reports an error — the
  customer simply never hears back.
- **console: 0.** Nobody is looking at a board at 3am.

To scale up under load, raise `max-instances` rather than `min-instances`:

```bash
gcloud run services update serviceloop-api-prod --region asia-south1 --max-instances 30
```

⚠ Do **not** raise `workers` beyond 4 without reading
[alerts.md](alerts.md#queue-lag) first. The sentinels poll; more workers means
more concurrent scans of the same due-set, and while every one of them is
idempotent, they contend on the same rows.

### Reading the logs

Logs are structured JSON with the PII redaction policy applied
(`packages/shared/src/logging.ts`). A phone number, a customer name or a message
body will not be in them, by design.

```bash
gcloud logging read 'resource.labels.service_name="serviceloop-api-prod" AND severity>=WARNING' --limit 50 --format json
```

To follow one customer interaction across processes, use the trace id — it is on
every log line, every audit row and every outbox envelope:

```bash
gcloud logging read 'jsonPayload.traceId="<trace-id>"' --limit 200 --format json
```

**If you need the message body itself**, do not add a `console.log`. Open the
sampled full-body window, which closes on its own:

```bash
gcloud run services update serviceloop-api-prod --region asia-south1 \
  --update-env-vars "LOG_FULL_BODIES_UNTIL=$(date -u -d '+2 hours' +%Y-%m-%dT%H:%M:%SZ),LOG_FULL_BODY_SAMPLE_RATIO=0.05"
```

That is a timestamp rather than a boolean deliberately: a debug flag somebody
flips at 02:00 is a flag that is still on three months later, quietly writing
every customer's messages to a log sink. This one expires whether or not anybody
remembers it. Sampling is deterministic per conversation, so a sampled thread is
sampled for its whole length.

### Kill switches

Things that can be turned off without a deploy, in decreasing order of how often
you will want them:

| Switch | Effect |
| --- | --- |
| `VOICE_KILL_SWITCH=true` | No outbound calls. Ladder rungs fall through to an advisor task. Read per call, so it takes effect on the next one. |
| `SMS_FALLBACK_ENABLED=false` | No SMS. A WhatsApp outage becomes advisor tasks rather than SMS spend. |
| `RATE_LIMIT_ENABLED=false` | ⚠ Staging only; production refuses to boot with it off. |
| Shop config `autonomy` → `L0` | That shop's agent drafts and sends nothing. The most surgical switch available: it affects one shop, is audited, and does not need a deploy. |

## Health and metrics

| Endpoint | What it means |
| --- | --- |
| `GET /health` | The process is up. Nothing more. |
| `GET /health/ready` | Postgres and Redis were reachable a moment ago, and `demoMode` says whether the adapters are live. |
| `GET /metrics` | Prometheus text. Not internet-exposed in production. |
| workers `:9101/health` | The worker's own liveness, which flips to 503 during a graceful shutdown so the load balancer stops before the drain does. |

## Graceful shutdown

Both processes handle `SIGTERM` and drain in a fixed order. It matters, and the
order is not arbitrary:

1. Mark unhealthy, so nothing new is routed here.
2. Stop the outbox dispatcher and the sentinels claiming new work.
3. Let in-flight queue jobs finish.
4. Finish in-flight *calls* with the apology path — a customer listening to a
   line that goes silent is the worst outcome available.
5. Close Redis, Postgres, the metrics server; flush traces.

Cloud Run allows 10 seconds by default before `SIGKILL`. If step 4 starts
timing out, raise the service's termination grace period rather than shortening
the drain.
