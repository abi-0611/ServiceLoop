# Runbook — alerts

One section per alert rule in `infra/prometheus/alerts.yml`. Each says what
fired, what it means for a customer, what to check in what order, and how to
know it is over.

If you have arrived here from an alert with no matching section, that is a bug —
the alert should not exist without one.

---

## OutboxBacklogGrowing {#outbox-backlog}

**Fires when** the oldest unsent outbox row is more than 60 seconds old, for 2
minutes.

**What the customer sees:** nothing. That is the problem. Every customer-facing
message leaves through the outbox, so this climbing means messages are queued
and not sent — approval requests, ready alerts, delay notices — and the shop has
no way to tell.

This is the most important alert in the system and the one to act on first, even
if others fired at the same time. A backed-up outbox produces webhook errors,
model timeouts and DLQ growth downstream, which is why Alertmanager inhibits the
others while it is firing.

### Check in this order

1. **Is the worker running at all?** This is the answer most of the time.
   ```bash
   gcloud run services describe serviceloop-workers-prod --region asia-south1 --format 'value(status.conditions)'
   ```
   A worker scaled to zero, crash-looping, or failing its own health check
   produces exactly this symptom and no other.

2. **Is it a poison row?** One row failing repeatedly blocks nothing (the
   dispatcher uses `SKIP LOCKED`), but a row failing *and being retried* burns
   the batch.
   ```sql
   select id, type, attempts, last_error, occurred_at
   from events_outbox where status = 'PENDING'
   order by occurred_at limit 20;
   ```
   An `attempts` column climbing on one `type` is a broken handler.

3. **Is Postgres or Redis refusing connections?** `/health/ready` on the API
   answers both in one call.

4. **Is it simply load?** Check `serviceloop_queue_depth`. If the depth is high
   and the lag is falling, the system is draining and you can wait.

### Resolve

- Worker down → redeploy or raise `min-instances`, see
  [operations.md](operations.md#scaling).
- Poison row → identify the handler from `type`, fix it, redeploy. The row
  retries on its own. Do **not** delete it.
- Genuine load → raise `WORKER_CONCURRENCY` (default 5) before raising instance
  count; the bottleneck is usually a single worker's concurrency, not the
  number of workers.

**Over when** `serviceloop_outbox_oldest_pending_seconds` is back under 10 and
staying there.

---

## DeadLetterGrowth {#dead-letter-growth}

**Fires when** more than 5 jobs were dead-lettered in ten minutes, sustained
for five.

**What the customer sees:** depends entirely on which handler is failing. A
dead-lettered `message.sent` costs a cost-metering row. A dead-lettered
`approval.requested` costs a customer their approval request.

Growth is what matters, not depth. A DLQ that has been at forty for a week is
something somebody triaged; forty new rows in ten minutes is a handler that has
started failing on live traffic.

### Check

```bash
pnpm dlq:list
```

It groups by event type and error message, because a DLQ with 200 rows is
almost always two problems and a flat list hides that.

### Resolve

Fix the handler first. Then, and only then:

```bash
pnpm dlq:replay --all --type approval.requested
```

⚠ **Replaying re-runs a handler that already failed.** Some handlers are only
*mostly* idempotent — replaying a `message.sent` after its cost row was written
double-counts, and replaying an event whose downstream state has since changed
can produce a message a customer should no longer receive. The command makes you
type the number of jobs, which cannot be muscle memory.

If a job cannot be replayed, drop it explicitly with a reason rather than
leaving it:

```bash
pnpm dlq:drop --id <jobId>
```

**Over when** `increase(serviceloop_dead_lettered_total[10m])` is zero and the
queue is empty or intentionally parked.

---

## WebhookErrorBurst {#webhook-errors}

**Fires when** more than 10% of provider webhook deliveries fail, for 5 minutes.

**What the customer sees:** their messages appear to vanish. Meta retries a 5xx
for a while and then gives up — permanently.

### Check

1. **Signature failures or server errors?** They are different problems.
   ```bash
   gcloud logging read 'resource.labels.service_name="serviceloop-api-prod" AND jsonPayload.component="whatsapp-webhook"' --limit 50
   ```
   A burst of 401s means `WHATSAPP_APP_SECRET` is wrong — usually because the
   app secret was rotated in the Meta console and not in Secret Manager. A burst
   of 500s is our bug.

2. **Is it one shop?** `ShopResolver` maps `phone_number_id` to a shop. A
   newly-added number that is not in any shop's config produces a 4xx for that
   shop only, and looks like a partial outage.

3. **Rate limiting?** `RATE_LIMIT_WEBHOOK_MAX` is 3000/minute. A Meta redelivery
   storm after *their* outage is legitimate traffic and can reach it. Raise it
   temporarily rather than dropping customer messages.

**Over when** the error rate is back under 1%. Then check for gaps: Meta does
not redeliver indefinitely, and messages lost during the burst are lost. Search
`conversations` for threads whose `last_inbound_at` predates the incident and
have no reply.

---

## LlmErrorRateHigh {#llm}

**Fires when** more than 5% of model calls error over ten minutes.

**What the customer sees:** slower replies, and eventually an advisor calling
them instead. The agent degrades to queue-and-apologise rather than sending
nonsense — that is designed, and it is why this is a warning and not a page.

Full procedure: [playbooks.md](playbooks.md#llm-provider-down).

---

## ModelSpendAnomaly {#cost-anomaly}

**Fires when** this hour's model spend is more than four times the trailing
week's hourly average, for 30 minutes.

An anomaly rather than a ceiling, because shops differ by an order of magnitude
and a threshold that suits the busiest is silent for the smallest.

### Check

```sql
select task_class, model, count(*), sum(cost_usd_micros) / 1e6 as usd
from llm_usage where created_at > now() - interval '2 hours'
group by 1, 2 order by 4 desc;
```

Almost always one of three things:

1. **An agent loop retrying.** `attempts > 1` on many rows. A provider returning
   a retryable error that is not actually transient.
2. **A shop's autonomy was raised.** More drafting, legitimately. Check
   `audit_events` for `shop_config.updated`.
3. **A prompt regression** — a change that stopped truncating conversation
   history, so every call carries the whole thread.

### Resolve

The blunt instrument is the shop's `agent.maxTokensPerRun` and `agent.maxSteps`,
which are configuration and take effect without a deploy. Setting a shop to `L0`
stops it drafting entirely, which is the emergency stop.

---

## AuditChainVerificationFailed {#audit-chain}

**Fires when** any chain verification reports `broken`. There is no threshold
and there should not be.

⚠ **Do not repair anything.** Do not re-hash, do not delete the offending row,
do not "fix" the sequence. Repairing destroys the evidence of what broke it, and
the chain's entire value is that it cannot be quietly fixed.

### Check

```bash
pnpm audit:verify
```

It reports the exact break index, the event id and the reason. The three reasons
mean different things:

| Reason | Means |
| --- | --- |
| `Sequence gap` | A row was deleted, or two writers raced and one lost its sequence number. |
| `Broken link` | A row's `prev_hash` does not match the chain head — an insert in the middle, or a restore that lost rows. |
| `Content tampered` | A payload was modified after the fact. |

**`Content tampered` on a row flagged `payload_redacted` is not a failure** and
the verifier will not report it as one. Those are rows a DPDP erasure lawfully
rewrote; they are counted separately and reported as `redacted`. If you see
`redacted` counts in the output, that is the system working.

### Resolve

1. Capture the state: dump the twenty rows either side of the break.
2. Establish whether it is us or an operator. `Content tampered` with no
   redaction flag is somebody having run an `UPDATE` against the database.
3. If it is a code bug, the chain from the break onward is unverifiable and
   stays that way. Note it, fix the writer, and let the chain continue — a
   truthful record with a documented gap beats a rebuilt one.

---

## DataRequestOverdue {#dpdp-overdue}

**Fires when** an approved DPDP request is past its scheduled execution time by
an hour.

A statutory clock. Nothing else in the system would notice a stuck deletion: it
fails quietly, the customer is not told, and the shop finds out when a regulator
asks.

### Check

```sql
select id, kind, status, scheduled_for, started_at, outcome_reason
from data_requests
where status in ('APPROVED','SCHEDULED','RUNNING') and scheduled_for < now();
```

A request stuck in `RUNNING` is a worker that died mid-cascade. That is
resumable and safe: every cascade step is idempotent and the steps table refuses
a duplicate line.

### Resolve

```bash
curl -X POST "$API/privacy/requests/<id>/execute" -H "authorization: Bearer $OWNER_TOKEN"
```

Full procedure and the legal context: [../privacy/dpdp.md](../privacy/dpdp.md).

---

## WhatsAppChannelDown {#whatsapp}

**Fires when** the channel circuit breaker opens — three consecutive transport
failures.

Full procedure: [playbooks.md](playbooks.md#whatsapp-outage).

---

## TemplateSendsBlocked {#template-blocked}

**Fires when** business-initiated messages are being refused with
`WINDOW_CLOSED_NEEDS_TEMPLATE` for fifteen minutes.

**What the customer sees:** silence. This is the outage nobody notices until a
shop asks why their customers have gone quiet, which is why it has an alert of
its own.

Deliberately narrow: a rise in `CONSENT_REVOKED` is the guardrail working, and
alerting on it would be alerting on customers exercising a right.

### Check

Almost always a template Meta has paused or rejected. Open the template ops
screen (`/settings/templates`) and look at the status and quality rating. A
template sliding to `RED` is on its way to being paused; by the time the status
says `PAUSED` it is too late to do anything but rewrite and resubmit under a new
name — Meta does not allow an approved template's content to be edited.

```bash
pnpm lint:templates
```

confirms the *manifest* is consistent. It cannot tell you what Meta thinks; only
the ops screen can.

### Resolve

Short term, nothing technical helps: without an approved template there is no
lawful way to open a conversation with somebody whose window has closed. The
shop's advisors ring the affected customers, and the ladder's advisor-task rung
is what surfaces them.

Medium term, submit a replacement (`sl_<name>_v2`), which takes Meta between an
hour and a fortnight. That lead time is why the template manifest is a release
artefact and is linted in CI — see
[../onboarding.md](../onboarding.md#templates).
