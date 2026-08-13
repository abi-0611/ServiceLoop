# PHASE 1 — FOUNDATION & DOMAIN CORE

**Load `00_MASTER_PROMPT.md` first. It defines the stack, layout, domain model, state machines, and conventions this phase implements.**

## Objective
A runnable skeleton containing everything every later phase depends on: the monorepo, the dev environment, the database schema, the job-card state machine, the reliability spine (transactional outbox + workers), the guardrail config engine, the hash-chained audit log, console authentication, and a seeded demo shop. At the end of this phase a developer runs two commands and sees a live job-card board populated with demo data.

## Prerequisites
None. This is the first session. Initialise git, create `PROGRESS.md` with a header and the `OPEN QUESTIONS` section.

## Deliverables
Monorepo per the master layout · `infra/compose.yaml` dev stack · schema v1 + migrations · `JobCardTransitionService` · outbox + BullMQ dispatcher · guardrail config engine · audit log service · console with auth and three shell pages · seed script · CI pipeline · `pnpm demo:phase1`.

---

## Tasks

### 1.1 Scaffold the monorepo
**Build:** pnpm workspaces + Turborepo with the exact package layout from the master. Root scripts: `dev`, `build`, `lint`, `typecheck`, `test`, `db:migrate`, `db:seed`, `demo:phase1`. Shared `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`), ESLint flat config, Prettier, `.editorconfig`, `.nvmrc` (Node 22).
**Approach:** Wire Turborepo task graph so `test` depends on `build` of internal packages; cache everything cacheable. Add `packages/config` first with a zod `env.ts` that parses and freezes all environment variables at boot — every app imports env only from here. Include `DEMO_MODE` with default `true`.
**Verify:** `pnpm -w typecheck && pnpm -w lint` clean on the empty skeleton; a deliberate bad env value fails boot with a readable zod error.

### 1.2 Dev environment
**Build:** `infra/compose.yaml`: Postgres 16 (named volume), Redis 7, MinIO (+ bucket bootstrap job creating `serviceloop-media`). `.env.example` documenting every variable with comments. `README.md` quickstart: `docker compose up -d && pnpm i && pnpm db:migrate && pnpm db:seed && pnpm dev`.
**Approach:** Healthchecks on all services; apps wait for health in dev scripts. Pin image digests.
**Verify:** Cold clone → quickstart → all services healthy in under 3 minutes.

### 1.3 Database schema v1 (Drizzle)
**Build:** Tables: `shops`, `staff` (role enum), `customers`, `vehicles`, `job_cards`, `work_items`, `estimates`, `estimate_lines`, `media_assets`, `evidence_bundles`, `approval_requests`, `conversations`, `messages`, `consents`, `declined_work_ledger`, `escalations`, `shop_config`, `audit_events`, `events_outbox`, `idempotency_keys`. UUIDv7 PKs; `created_at/updated_at` everywhere; soft-delete only where DPDP deletion requires hard-delete instead (customers/media get hard-delete paths later — design FKs with `ON DELETE` behaviour now).
**Approach:** Encode enums as Postgres enums generated from the shared zod schemas so TS and DB never drift. `vehicles.registration_normalised` unique per shop with a functional index. `estimate_lines` are immutable once their estimate version is accepted — enforce via trigger or repository-level guard plus a test. Add `pgcrypto`; create an `encrypted_text` custom column helper for PII fields (`customers.phone`, `customers.full_name`) using app-layer AES-GCM with key from env (document key-rotation plan in a schema comment; Phase 7 finalises).
**Verify:** `drizzle-kit` migration applies and rolls back cleanly; a Testcontainers smoke test inserts one row per table via repositories.

### 1.4 JobCard + WorkItem state machines
**Build:** In `packages/domain`: typed transition maps exactly as specified in the master, `JobCardTransitionService.transition(cardId, event, actor, meta)` and the WorkItem equivalent. Each call runs in one transaction: guard check → state write → `audit_events` append → `events_outbox` insert. Illegal transitions throw a typed `IllegalTransitionError` and write an audit event of the attempt.
**Approach:** Pure transition logic (state, event) → next state as side-effect-free functions with exhaustive `switch` and `never` checks; the service layers persistence around it. Guards receive a context object (e.g., cannot enter `AWAITING_PAYMENT` with unapproved required WorkItems). Dominant-blocking-state derivation for the JobCard from its WorkItems is a pure function with table-driven tests.
**Verify:** Property-style test iterating every (state, event) pair against the spec table; concurrency test: two simultaneous transitions on one card — exactly one wins (row lock via `SELECT … FOR UPDATE`).

### 1.5 Transactional outbox + workers app
**Build:** `apps/workers` bootstraps BullMQ. An outbox dispatcher polls `events_outbox` (`FOR UPDATE SKIP LOCKED`, batch 100, 250ms idle backoff), publishes to queues by event type, marks dispatched. Consumer harness with per-queue retry policy (exponential, max 5) and a dead-letter queue with an admin list endpoint.
**Approach:** Envelope schema: `{id, type, occurredAt, shopId, payload, traceId}` zod-validated on both ends. Consumers must be idempotent: check `idempotency_keys` on `(consumer, event_id)` inside the handler transaction.
**Verify:** Integration test: state transition → outbox row → queue → consumer side-effect, exactly once under a forced duplicate delivery; kill the dispatcher mid-batch and confirm no loss and no double-processing on restart.

### 1.6 Guardrail config engine
**Build:** `shop_config` stores a zod-validated document: autonomy level per flow (`approval`, `status`, `delivery`, `retention`, `voice` — all default L0), price floor %, discount ceiling %, quiet hours (with IANA timezone, default `Asia/Kolkata`), languages enabled, escalation ladder timings per objective, payment-before-delivery flag, frequency caps. `GuardrailService` exposes typed reads and a single `validateAndPatch` write path that audits every change with actor + diff.
**Approach:** Schema versioned (`configVersion`) with an in-code migration function for old documents. Defaults are the most conservative values.
**Verify:** Round-trip tests; invalid patch rejected with field-level errors; audit diff recorded.

### 1.7 Hash-chained audit log
**Build:** `AuditService.append(event)` computes `hash = sha256(prevHash + canonicalJson(event))` per shop chain. `verifyChain(shopId)` walks and validates. Append-only enforced: a Postgres trigger rejects UPDATE/DELETE on `audit_events`.
**Approach:** Canonical JSON via stable key ordering; store `prev_hash`, `hash`. Chain head cached per shop in Redis for O(1) appends, with DB as truth.
**Verify:** Tamper test: mutate a historical row via raw SQL superuser in test → `verifyChain` reports the exact break index.

### 1.8 API app + authentication
**Build:** `apps/api` NestJS with modules: `health`, `auth`, `jobcards`, `config`, `audit`. Auth: phone-OTP for staff (OTP delivery via a `NotifierPort` — dev adapter logs the code; console shows it in DEMO_MODE), short-lived JWT access + rotating refresh cookie, role guard decorators (`@Roles('OWNER')`). Multi-tenancy: every query scoped by `shopId` from the token; write one global interceptor + repository convention and a test proving cross-shop reads fail.
**Approach:** nestjs-zod for DTOs; problem-details error responses; request-id middleware feeding pino and OTel context.
**Verify:** Playwright/API test: login as ADVISOR, list job cards, forbidden on config write; cross-tenant probe returns 404-not-403 (no existence leak).

### 1.9 Console shell
**Build:** Next.js app with auth flow against the API; layout with shop switcher (for multi-shop owners); pages: **Job Card Board** (kanban by state, card drawer showing WorkItems/estimate/audit trail), **Conversations** (empty state), **Settings → Guardrails** (form bound to `shop_config` with validation errors surfaced). Tailwind + shadcn/ui; mobile-first responsive — advisors use phones.
**Approach:** Server components for reads, route handlers proxying the API with the auth cookie; typed API client generated from zod schemas in `packages/shared`.
**Verify:** Playwright: login → board renders seeded cards → drag is disabled (state changes only via domain events, never drag-and-drop) → guardrail edit persists and audits.

### 1.10 Seed + demo script
**Build:** `pnpm db:seed`: one demo shop ("Sri Murugan Auto Works", Chennai), staff (owner/advisor/2 technicians), 12 customers with mixed language preferences, 10 job cards spread across states with realistic WorkItems, estimates, and 6 media placeholders in MinIO; a price-list knowledge document stored for Phase 3. `pnpm demo:phase1`: boots against DEMO_MODE, runs a scripted transition sequence on one card (OPEN → … → READY_FOR_DELIVERY), prints the audit chain verification and outbox delivery counts, exits non-zero on any failure.
**Verify:** Demo script green in CI.

### 1.11 CI
**Build:** GitHub Actions: pnpm cache → lint → typecheck → unit tests → Testcontainers integration tests → build → `demo:phase1`. Required status check on `main`.
**Verify:** Pipeline green; a seeded failing test fails the pipeline (then remove it).

---

## Acceptance Gate — Phase 1
- [ ] Cold-clone quickstart to a populated Job Card Board in ≤ 5 minutes.
- [ ] Full (state × event) transition matrix tested; illegal transitions audited and rejected; concurrent transition race safe.
- [ ] Outbox delivers exactly-once under duplicate delivery and dispatcher crash.
- [ ] Guardrail config validated, versioned, audited; defaults conservative (all flows L0).
- [ ] Audit chain verification detects tampering at the exact index.
- [ ] Cross-tenant isolation test passes; RBAC enforced.
- [ ] Domain package coverage ≥ 80%; zero `any` in `packages/domain`.
- [ ] `pnpm demo:phase1` green locally and in CI; tag `phase-1-complete`.

## Handoff notes for Phase 2
Phase 2 consumes: the outbox/event envelope, `ConversationSession` + `messages` tables, `consents` table, `MediaAsset` + StoragePort, and the seeded shop. Do not redesign these there — extend them.
