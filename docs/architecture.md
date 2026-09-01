# What runs where

Enough of the shape to debug something at 2am. Not a design document — the
reasoning lives beside the code it explains, and `PROGRESS.md` records the
decisions.

## Three processes

```
                    ┌──────────────┐
   WhatsApp  ──────▶│              │
   Razorpay  ──────▶│     api      │──────┐
   Exotel    ──────▶│  (Nest/HTTP) │      │
                    └──────────────┘      │
                            ▲             ▼
                            │      ┌─────────────┐
                    ┌──────────────┤  Postgres   │
   staff  ─────────▶│   console    │  (+ outbox) │
                    │  (Next.js)   └─────────────┘
                    └──────────────┘      ▲
                                          │
                    ┌──────────────┐      │
                    │   workers    │──────┘
                    │  (timers +   │
                    │   consumers) │──────▶ Redis (queues, rate limits)
                    └──────────────┘
```

**`api`** terminates every webhook and serves the console. It writes rows and
outbox events; it does not send anything to a customer. A webhook handler that
sent a message directly would be outside the outbox, and the outbox is what makes
"exactly once" true.

**`workers`** is where everything customer-facing actually happens: the outbox
dispatcher, one consumer per queue, and **seven polling sentinels**. It is the
process people forget to scale, and the process whose absence is silent — the
console keeps working, the webhooks keep returning 200, and nothing reaches a
customer.

**`console`** is a Next.js app that talks to the API. It holds the session
cookie and proxies browser-side writes through an allow-listed route handler, so
the access token never reaches page JavaScript.

## The sentinels

Each answers to a different clock, which is why there are seven rather than one
loop with seven branches.

| Sentinel | Interval env | What it watches |
| --- | --- | --- |
| `SilentBayScanner` | `SILENT_BAY_SCAN_MS` | A vehicle nobody has touched during working hours |
| `ReminderSentinel` | `REMINDER_SCAN_MS` | Deferred sends whose quiet hours have ended |
| `RetentionScanner` | `RETENTION_SCAN_MS` | Declined work whose horizon or season has arrived |
| `FeedbackSentinel` | `FEEDBACK_SCAN_MS` | Deliveries a day or two old, owed a feedback ask |
| `StuckApprovalSentinel` | `ALERT_SCAN_MS` | An approval nobody has answered |
| `DigestScheduler` | `DIGEST_SCAN_MS` | The shop's own wall clock passing its digest time |
| `DataRequestSentinel` | `DPDP_SCAN_MS` | Approved erasures whose grace window has elapsed |

A sentinel that throws logs and returns; nothing is marked done, so the next
tick reclaims the same work. That is why a worker restart never loses a rung.

## The four rules everything obeys

**1. Every customer-facing message passes `OutboundGate`.** Consent, the 24-hour
window, quiet hours, frequency caps, autonomy level, claim anchoring and the
retention floor are enforced in one place. `no-bypass.test.ts` walks the
repository on every build to prove there is no second path.

**2. Nothing leaves a transaction except through the outbox.** A row written and
an event emitted are the same commit or neither happens. The dispatcher reads
`events_outbox` with `SKIP LOCKED` and enqueues; consumers claim idempotently.

**3. The audit chain is append-only and hash-linked.** A trigger enforces it. A
DPDP erasure rewrites payloads in place with the trigger briefly disabled inside
one transaction, leaves the row's own `hash` alone, and marks
`payload_redacted` — so the chain still verifies and the verifier reports
redaction rather than corruption.

**4. Numbers come from stored rollups, never from a live fold.** The console,
the WhatsApp digest and `pnpm metrics:recompute` read the same row. That is what
makes an owner able to say "prove it" and get the same answer.

## Data

**Postgres** is the system of record and holds 55 tables. Customer PII is
encrypted at the column level (`encryptedText`) with a blind index for lookup by
phone, so a dump, a replica or a backup contains no readable name or number.

**Redis** holds BullMQ queues, rate-limit counters and escalation timers. Losing
it loses *timers*, not *rows*: escalation rows survive in Postgres and are
rescheduled. See the Redis-loss playbook.

**Object storage** (GCS in cloud, MinIO locally) holds media and rendered
invoices. Nothing in it is authoritative — every object has a row.

## Packages

```
packages/
  shared/        enums, contracts, i18n catalogue, template manifest, time
  domain/        the rules. No I/O, no SQL, no vendor. Generic over `Tx`.
  db/            the SQL. Drizzle schema, stores, migrations.
  config/        env parsing, shop config schema + migrations
  adapters/      WhatsApp, SMS, storage, speech, telephony, payments, antivirus
  agent-core/    LLM runtime, composition, the approval ladder
  observability/ OpenTelemetry + prom-client wiring
  simulator/     personas and the per-phase demos
```

The direction is strict: `domain` depends on `shared` and nothing else. `db`
depends on `domain` for its port types. Neither `db` nor `adapters` depends on
the other, which is why each process assembles its own wiring rather than
importing a shared factory.

## Where to look when something is wrong

| Symptom | First place |
| --- | --- |
| Nothing reaching customers | `workers` running? `serviceloop_outbox_age_seconds` |
| Messages sent but not received | Template approved in that language? `/settings/templates` |
| Webhooks failing | Signature verification; app secret rotated? |
| Numbers disagree | `pnpm metrics:recompute --from … --to …` |
| A customer says they were messaged after opting out | `outbound_blocks` audit events — the gate records refusals |
| Erasure "did not work" | It did; the console is meant to show nothing. Check the completion report on the request |
