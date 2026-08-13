# ServiceLoop — Progress log

Format: `[phase.task] status — notes — files touched`.
Read this first on session start and resume from the last incomplete task.

---

## Phase 1 — Foundation & domain core

**Status: COMPLETE.** Acceptance gate green, `pnpm demo:phase1` passes 15/15 steps.

### `[1.1] DONE — monorepo scaffold`
pnpm workspaces + Turborepo with the exact package layout from the master. Root scripts:
`dev build lint typecheck test test:unit db:migrate db:rollback db:seed demo:phase1 infra:*`.
Shared `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`, project references), ESLint flat
config, Prettier, `.editorconfig`, `.nvmrc`.
`packages/config` holds a zod `env.ts` that parses and deep-freezes every variable at boot;
`DEMO_MODE` defaults to `true`. A deliberate bad value fails boot with a field-scoped error
(`packages/config/src/config.test.ts`).
Files: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`,
`eslint.config.mjs`, `.prettierrc.json`, `.editorconfig`, `.nvmrc`, `.gitignore`,
`packages/*/package.json`, `packages/config/src/{env,dotenv,adapter-selection}.ts`.

### `[1.2] DONE — dev environment`
`infra/compose.yaml`: Postgres 16.6, Redis 7.4 (`noeviction`, required by BullMQ), MinIO plus a
one-shot `mc` job that creates `serviceloop-media`. All images pinned by digest, all with
healthchecks. `.env.example` documents every variable. `README.md` carries the quickstart.
Files: `infra/compose.yaml`, `.env.example`, `README.md`.

### `[1.3] DONE — database schema v1`
All 20 tables, UUIDv7 primary keys, `created_at/updated_at` everywhere. Postgres enums are
generated from the shared zod tuples so TS and the DB cannot drift.
`vehicles.registration_normalised` is unique per shop. `estimate_lines` are immutable once their
estimate is `ACCEPTED` — enforced by a trigger *and* covered by a test. `pgcrypto` installed;
`encrypted_text` is a Drizzle custom column doing app-layer AES-256-GCM with the key from env,
with the rotation plan documented in `packages/db/src/crypto/pii.ts`. Migrations apply and roll
back cleanly (`pnpm db:rollback`, hand-written `migrations/down/*.sql`).
Files: `packages/db/src/schema/*.ts`, `packages/db/src/crypto/pii.ts`,
`packages/db/migrations/**`, `packages/db/src/migrator.ts`, `packages/db/test/schema.test.ts`.

### `[1.4] DONE — JobCard + WorkItem state machines`
Pure transition tables with exhaustive `switch` + `assertNever`; guards receive a context object
and can only refuse an edge, never create one. `JobCardTransitionService.transition()` runs guard
check → state write → audit append → outbox insert in one transaction. Illegal transitions throw
`IllegalTransitionError` **and** commit an audit row for the attempt (the rejection is recorded,
then the error is thrown outside the transaction so it survives).
Dominant-blocking-state derivation is a pure, table-tested function.
Tests: all 156 (state × event) pairs checked against the master's edge list; concurrency test with
10 simultaneous transitions leaves exactly one winner via `SELECT … FOR UPDATE`.
Files: `packages/domain/src/job-card/*`, `packages/domain/src/work-item/*`,
`packages/domain/src/ports.ts`, `packages/db/src/stores/*`, `packages/db/test/transitions.test.ts`.

### `[1.5] DONE — transactional outbox + workers`
`apps/workers` boots the dispatcher plus one consumer per queue. The dispatcher claims batches
with `FOR UPDATE SKIP LOCKED` (batch 100, 250 ms idle backoff), publishes, and marks dispatched
inside the claim transaction. Envelope is zod-validated on both write and read. Consumers claim
`(consumer, event_id)` in `idempotency_keys` inside the handler transaction. Per-queue retry is
exponential with max 5, then the job is copied to the dead-letter queue; `GET /audit/dead-letter`
is the admin list endpoint. The event id doubles as the BullMQ job id, so Redis de-duplicates too.
Tests: transition → outbox → queue → consumer, exactly once under forced duplicate delivery and
under a dispatcher that dies mid-batch (nothing lost, nothing double-processed).
Files: `apps/workers/src/*`, `packages/db/src/services/outbox-service.ts`,
`apps/workers/test/dispatch.test.ts`, `packages/db/test/outbox.test.ts`.

### `[1.6] DONE — guardrail config engine`
`shop_config` stores a zod-validated document: autonomy per flow (all default `L0_SHADOW`), price
floor %, discount ceiling %, quiet hours with IANA timezone, enabled languages, an escalation
ladder per objective, `paymentBeforeDelivery`, frequency caps, and a disclosure block typed as
`z.literal(true)` so it cannot be switched off. `GuardrailService.validateAndPatch` is the single
write path: deep-merge, revalidate the whole document, audit the field-level diff with its actor.
`configVersion` with an in-code migration function moves old documents forward on read.
Files: `packages/config/src/shop-config*.ts`, `packages/domain/src/guardrails/*`,
`packages/db/src/stores/shop-config-store.ts`.

### `[1.7] DONE — hash-chained audit log`
`hash = sha256(prevHash ‖ canonicalJson(facts))` per shop chain, `verifyChain(shopId)` walks and
reports the exact break index. A Postgres trigger rejects UPDATE and DELETE on `audit_events`, and
`audit_events.shop_id` is `ON DELETE RESTRICT` so a shop cannot be dropped while its chain exists.
The chain head is cached in Redis for O(1) appends with the database as truth; a divergent cache
is corrected from the database rather than trusted.
Tamper test disables the trigger (the only way an attacker with DB access could do it), mutates a
historical row, and asserts the reported break index.
Files: `packages/domain/src/audit/chain.ts`, `packages/db/src/services/audit-service.ts`,
`packages/db/migrations/0001_guardrail_triggers.sql`.

### `[1.8] DONE — API app + authentication`
NestJS 11 with `health`, `auth`, `jobcards`, `config`, `audit` modules. Phone-OTP sign-in: codes
are hashed in Redis with a TTL, an attempt counter and a resend cooldown; delivery goes through
`NotifierPort`, and DEMO_MODE returns the code so the console can display it. Short-lived JWT
access token plus a rotating opaque refresh cookie (consumed on use, so a replay fails).
Multi-tenancy: `shopId` comes from the token only, every repository is shop-scoped, and a
cross-tenant probe returns **404, not 403**. RBAC via `@Roles('OWNER')` as a global guard.
Errors are RFC 9457 problem-details; every request carries a request id into logs, audit rows and
outbox envelopes.
Files: `apps/api/src/**`, `apps/api/test/api.test.ts`.

### `[1.9] DONE — console shell`
Next.js 15 App Router, Tailwind, shadcn-style primitives written in-repo. Pages: **Job Card Board**
(kanban by state, card drawer with work items, estimate lines and the audit trail),
**Conversations** (empty state), **Settings → Guardrails** (bound to `ShopConfigV1Schema`, field-level
errors surfaced). Shop switcher for multi-shop owners. Mobile-first — advisors use phones, so touch
targets are 44 px and the mobile viewport is a first-class Playwright project.
Cards are explicitly `draggable={false}`: state changes only through domain events.
Session cookies stay httpOnly on the console's origin via route-handler proxies.
Files: `apps/console/src/**`, `apps/console/test/e2e/*`.

### `[1.10] DONE — seed + demo script`
`pnpm db:seed` creates "Sri Murugan Auto Works" (Chennai): 4 staff, 12 customers with mixed
language preferences, 12 vehicles (including a BH-series registration), 10 job cards spread across
states with realistic work items and estimates, 7 media placeholders plus the price-list knowledge
document in MinIO. Cards are **driven** to their target state through the transition services
rather than inserted in it, so the seed produces a genuine hash-chained audit trail (71 transitions)
and real outbox events. `--reset` rebuilds by rolling migrations back and forward.
`pnpm demo:phase1` runs 15 acceptance steps and exits non-zero on any failure.
Files: `packages/db/src/seed/*`, `packages/db/src/cli/*`, `packages/simulator/src/**`.

### `[1.11] DONE — CI`
GitHub Actions, two jobs: `static` (lint → typecheck → unit tests → domain coverage gate → build)
and `integration` (compose stack → migrate → seed → integration suites → `demo:phase1` →
Playwright). Playwright reports upload on failure.
Files: `.github/workflows/ci.yml`.

---

## Phase 1 Acceptance Gate

- [x] Cold-clone quickstart to a populated Job Card Board in ≤ 5 minutes — compose up (~20 s
      warm), `pnpm i`, `db:migrate` (0.4 s), `db:seed` (~4 s), `pnpm dev`.
- [x] Full (state × event) transition matrix tested — 156 pairs against the master's edge list;
      illegal transitions audited and rejected; concurrent transitions leave exactly one winner.
- [x] Outbox delivers exactly-once under duplicate delivery and dispatcher crash.
- [x] Guardrail config validated, versioned, audited; defaults conservative (all flows L0).
- [x] Audit chain verification detects tampering at the exact index.
- [x] Cross-tenant isolation test passes; RBAC enforced (404 not 403).
- [x] Domain coverage ≥ 80% — **97.5% statements, 88.8% branches**; zero `any` in
      `packages/domain` (lint-enforced).
- [x] `pnpm demo:phase1` green locally; tag `phase-1-complete`.

### Verification run (2026-08-14)

| Suite | Result |
|---|---|
| `packages/shared` | 37 passed |
| `packages/config` | 15 passed |
| `packages/domain` | 256 passed · 97.5% statements |
| `packages/adapters` | 9 passed |
| `packages/agent-core` | 9 passed |
| `packages/simulator` | 5 passed |
| `packages/db` integration | 32 passed |
| `apps/workers` integration | 6 passed |
| `apps/api` integration | 22 passed |
| `apps/console` Playwright | 20 passed (desktop + mobile) |
| `pnpm demo:phase1` | 15/15 steps |

---

## Decisions & deviations

Recorded per master §2 ("explain why" for any substitution).

1. **`nestjs-zod` not used.** The phase note suggested it; a ~40-line `ZodBody`/`ZodQuery`/`ZodParam`
   param decorator (`apps/api/src/common/zod.ts`) validates with the *same* schemas the console
   client uses, with no extra dependency and no version-compat surface. Zod is still the only
   validation language.
2. **Explicit `@Inject()` on every constructor parameter.** Vitest transpiles with esbuild, which
   does not emit `design:paramtypes`, so type-based DI silently fails under test. Explicit tokens
   make the wiring identical in test and production rather than relying on decorator metadata.
3. **`process.loadEnvFile` instead of `dotenv`.** Node 22 has it built in and it does not overwrite
   variables that are already set, which is the precedence we want (real env beats `.env`).
4. **Refresh tokens and OTP codes live in Redis, not Postgres.** Schema v1's table list is fixed by
   the master; both are short-lived, hashed, and TTL-bound, which is what Redis is for.
5. **Compose host ports are parameterised** (`POSTGRES_PORT`, `REDIS_PORT`, `MINIO_PORT`). A
   developer machine often already runs Postgres on 5432; defaults are unchanged.
6. **`LoggingNotifier` prints the OTP in full** — the log *is* the delivery channel in dev — so it
   deliberately bypasses the redacting application logger. The env schema now refuses any notifier
   other than `sms` when `NODE_ENV=production`, closing the leak that would otherwise create.
7. **UUIDv7 uses Web Crypto, not `node:crypto`.** `@serviceloop/shared` is imported by the console's
   client bundle; `globalThis.crypto` is available in Node 18+ and every browser.
8. **The phase-1 queue consumer is an audit-chain integrity monitor.** A consumer that did nothing
   would be a stub. Verifying a bounded tail of the shop's chain on every event is real work,
   squarely inside phase 1 (§1.7), and the `HandlerRegistry` is the seam later phases hang their
   handlers off.
9. **`packages/adapters` ships `storage/` and `notifier/` only.** The master's layout lists
   `whatsapp/ telephony/ speech/ payments/ llm/ sms/` too, but those belong to phases 2–5 and a
   port with no working adapter would be a stub. `selectAdapters()` reports them as `PENDING` with
   the phase that delivers them, so the boot log never claims a capability that does not exist.

---

## OPEN QUESTIONS

Recorded per master §10. Each was resolved with the most conservative reading; revisit when the
owning phase lands.

1. **`IN_DIAGNOSIS → IN_PROGRESS` without an approval step?** The master's diagram has no such edge.
   Taken conservatively: *all* work needs approval before it starts. If shops need a "no approval
   required for pre-agreed work" path, it should be a shop-config flag, not a new edge. *(Phase 3.)*
2. **`QUALITY_CHECK → IN_PROGRESS` for rework?** Not in the diagram, so not implemented. Rework
   currently means a new work item. *(Phase 4.)*
3. **Are `DECLINED`/`DEFERRED` work items revivable?** Treated as terminal; recovery creates a new
   work item on a later visit, which keeps the original decision as immutable evidence of what the
   customer actually said. *(Phase 6 re-pitch may want to link the two.)*
4. **Outstanding balance before payments exist.** `loadOutstandingBalancePaise` sums accepted
   estimates, since there is nowhere to record a payment until phase 4. Conservative: an accepted
   estimate is fully outstanding, so the pay-before-delivery guard holds. *(Phase 4 replaces this
   with invoice-minus-payments.)*
5. **Multi-shop staff identity.** One person in several shops is matched by phone number, because
   blind indexes are shop-scoped and cannot be compared across shops. A future `people` table would
   make this explicit. *(Phase 7.)*
6. **CI required-status-check on `main`** must be enabled in repository settings; it cannot be set
   from a workflow file.

---

## Handoff to Phase 2

Phase 2 consumes and **extends** — never redesigns — the following:

- **Event envelope + outbox.** `EventEnvelopeSchema` in `packages/shared/src/events.ts`; add new
  members to the discriminated union and a row to `QUEUE_BY_EVENT_TYPE`. The dispatcher and the
  consumer harness need no changes.
- **`conversations` + `messages` tables.** Already carry `windowExpiresAt` (the WhatsApp 24-hour
  window), `purpose` (consent gate), `templateName`, `providerMessageId` (unique per shop, for
  webhook idempotency) and `evidenceRefs` (claim anchoring).
- **`consents` table.** Append-oriented, purpose-scoped; latest row wins.
- **`media_assets` + `StoragePort`.** `mediaKey()` lays keys out shop-first so a DPDP deletion can
  enumerate by prefix.
- **Seeded shop.** `DEMO_SHOP_ID` and the fixtures are exported from `@serviceloop/db`.
- **Handler registry.** `apps/workers/src/handlers/registry.ts` — register a handler for the new
  event types; it runs inside the consumer's transaction alongside the idempotency claim.
- **Guardrail policies.** `checkConsent`, `checkFrequencyCaps`, `evaluateQuietHours`,
  `resolveSendMode`, `checkClaimAnchoring`, `checkDisclosure` are implemented and tested in
  `packages/domain/src/guardrails/policies.ts`; wire them into the send path rather than
  reimplementing.
- **Tool registry.** `packages/agent-core` already enforces validate → execute → post-check →
  record; phase 3's tools register onto it.
