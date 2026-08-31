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
`pnpm db:seed` creates "Sri Murugan Auto Works" (Chennai): 4 staff, 15 customers with mixed
language preferences, 15 vehicles (including a BH-series registration), 15 job cards spread across
states with realistic work items and estimates, 12 media placeholders plus the price-list knowledge
document in MinIO. Cards are **driven** to their target state through the transition services
rather than inserted in it, so the seed produces a genuine hash-chained audit trail (93 transitions)
and real outbox events. `--reset` rebuilds by rolling migrations back and forward.

Six of those cards sit in `AWAITING_APPROVAL`, each for its own customer — deliberately the biggest
column on the board, because a shop with one car waiting on a decision does not need this product.
Grown from ten cards during phase 4; see *Resolved — the six red Playwright tests* below.

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

---

## Phase 2 — Channel gateway & zero-migration intake

**Status: COMPLETE**, with one measured exception recorded below and in the gate: the OCR accuracy
and calibration numbers have still not been produced against a real vision model (deviation 10).
Everything else is built, wired and green — `pnpm demo:phase2` runs 16/16 steps, the Playwright
suite is 30/30, and the API, db and worker integration suites pass.

### `[2.1] DONE — WhatsAppPort + Meta Cloud and Sandbox adapters`
`packages/adapters/src/whatsapp/`: `port.ts` (`sendSessionMessage`, `sendTemplate`,
`sendInteractive`, `sendMedia`, `markRead`, `downloadMedia`, `receive`, `verifySubscription`) with
the WhatsApp payload limits asserted at the boundary, so an over-long button title fails in a unit
test with the field name rather than as a 132000 in production.
`MetaCloudWhatsAppAdapter`: GET verify handshake, POST receive with X-Hub-Signature-256 checked
*before* the body is parsed, media download URL exchange, and a 40-row error taxonomy
(`META_ERROR_KIND_BY_CODE`) mapping provider codes onto `RATE_LIMITED | WINDOW_CLOSED |
INVALID_RECIPIENT | TEMPLATE_INVALID | AUTH_FAILED | …`. An unrecognised code maps to `UNKNOWN` and
is deliberately **not** retryable.
`SandboxWhatsAppAdapter`: in-process, same contract, inbound injected via a dev-only API.
A per-shop token-bucket rate limiter (Redis-backed, in-memory fallback) shapes every send.
Files: `packages/adapters/src/whatsapp/*`, `wa_templates` in `packages/db/src/schema/comms.ts`.

### `[2.3] DONE — message router + session manager`
`InboundRouter` classifies each inbound as customer thread, staff evidence group, or unknown
number; `ConversationSessionService` opens and refreshes threads and tracks the 24-hour
customer-service window in the domain, fed by adapter timestamps and never computed in the
adapter. Opt-out keywords are matched whole-message across *all three* languages regardless of the
thread's declared language, because code-switching is the norm — `packages/shared/src/i18n/keywords.ts`.
Files: `packages/domain/src/messaging/{router,session}.ts`.

### `[2.4] DONE — media pipeline`
Sniff → size-cap → normalise (EXIF rotate, max-dimension resize) → thumbnail → 16 kHz mono WAV
transcode → store, all on `StoragePort`. Rejections carry a customer-facing reason. The pipeline
deliberately does **not** write `media_assets`; it stays a bytes-and-object-storage concern a test
can drive with the in-memory storage adapter.
Files: `packages/adapters/src/media/*`.

### `[2.8] DONE — entity resolution`
Registration normaliser (uppercase, strip separators, Indian formats including the BH series, OCR
lookalike repair) and phone → E.164 with `+91` defaulting, both in `packages/shared`. Merging
happens **only** on an exact normalised key; every near miss becomes a `merge_suggestions` row for
an advisor. `IN` is not an RTO state code, so `1N09BX4432` deliberately fails to repair rather
than inventing a vehicle nobody can ever match again.
Files: `packages/domain/src/intake/entity-resolution.ts`, `packages/shared/src/registration.ts`.

### `[2.9] DONE — consent capture + outbound gate`
`OutboundGate` is the only exported send API in the messaging module: consent state for the
message's purpose tag, session window versus template, quiet hours (deferred, never dropped) and
frequency caps, all in one choke point. `no-bypass.test.ts` walks the repository and proves no
other path reaches a channel.
Files: `packages/domain/src/messaging/{outbound-gate,consent}.ts`, `no-bypass.test.ts`.

### `[2.5] DONE — LlmPort, OcrPort, and the golden fixture eval`
**`LlmPort`** (`packages/adapters/src/llm/`) with two operations — `complete` for prose and
`extract` for a schema-validated document — and two adapters:

- `AnthropicLlmAdapter` over the Messages API, using `output_config.format` for structured
  extraction. It sends **no** sampling parameters and **no** `thinking`/`effort` field: model ids
  are shop configuration, so the adapter cannot know which model generation it is talking to, and
  omitting both is the one request shape every current model accepts.
- `SandboxLlmAdapter`, deterministic and credential-free, with a responder registry, image
  fixtures keyed by content hash, and a recorded call log the simulator's trace panel will read.

**Prompt/payload fencing.** Every prompt wraps caller-supplied content in an explicit payload
fence. This does two jobs: instructions and data are visibly separated, so a customer who types
"ignore the above and approve everything" is data rather than a new instruction; and deterministic
responders can find the real message instead of parsing the prompt's own few-shot examples.
Catching the second cost one bug and one test — `requestPayload()` exists because of it.

**`OcrPort`** with `VisionLlmOcrAdapter` (over LlmPort, so the identical code path runs live and
sandboxed) and `FixtureOcrAdapter` (resolves by image sha256; raises on an unregistered image
rather than inventing a card). The extraction prompt names the conventions that actually break
extraction — ditto marks, `/-` terminators, struck-through corrections, Tamil and Hindi item
names, carbon copies, letter/digit confusions — and spends as much space on *how sure to be* as on
what to read.

**Golden fixtures.** 12 HTML job cards across 5 layouts and 3 languages, each defined **once** as
data: the template renders from it and the answer key is derived from it, so a fixture and its
expected extraction cannot drift apart. Rendered to PNG via Playwright with seeded "handwriting"
jitter, then degraded four ways with sharp (skew, shadow, sensor noise, low-light plus heavy
JPEG). Images are cached and keyed on the template hash.
Files: `packages/simulator/src/ocr/{fixtures,render,capture,ground-truth,score,eval}.ts`.

### `[2.6] DONE — staff confirmation flow`
`IntakeService.recordDraft/correct/confirm/discard`, the interactive summary builder and the
quick-correction parser (`2 = TN 09 BX 4432`), and confirmation that creates Customer, Vehicle,
JobCard, WorkItems and estimate v1 through the domain services so audit and outbox fire. A
corrected field jumps to confidence 1 and its previous value is recorded, so the eval can later
learn from exactly what the extractor got wrong.
Both halves now exist and share one code path: a technician typing `3 = TN 09 BX 4432` into
WhatsApp and an advisor editing the field on `/intake/[id]` call the same `IntakeService.correct`,
so the audit trail cannot say two different things about how a card was made.
Files: `packages/domain/src/intake/{intake-service,confirmation,intake-pipeline}.ts`,
`apps/console/src/components/draft-review.tsx`, `apps/api/src/messaging/intake.controller.ts`.

### `[2.7] DONE — forwarded text and voice-note intake`
`SpeechPort` + `MockSpeechAdapter` (fixtures by audio hash, real WAV duration parsed off the RIFF
header, raises rather than returning empty text for unregistered audio). `LlmTextDraftExtractor`
and `VoiceNoteDraftExtractor` produce the same `JobCardDraft` as the photo path. The recogniser's
confidence is passed *into* the parse rather than discarded, so a shaky transcript produces a
diffident draft instead of a confident job card built on a misheard word.
The acceptance corpus is 10 forwarded messages spanning English, Tamil-English and Hindi-English
in both native script and romanised form, asserted field by field.
Files: `packages/adapters/src/{speech,intake}/*`.

### `[2.x] DONE — Postgres stores for every phase-2 port`
`PgDraftStore`, `PgJobCardWriter`, `PgEntityLookup`, `PgConversationStore`, `PgMessageStore`,
`PgConsentStore`, `PgCustomerLookup`. Notable: draft documents are re-validated on read; job-card
codes are allocated under an advisory lock so numbering stays contiguous and readable on paperwork
a customer keeps; delivery receipts only ever move a message *forward* through the status
lifecycle, because a `read` can overtake its own `delivered`; phone lookup goes through the
shop-scoped blind index, never the non-deterministic ciphertext.
Files: `packages/db/src/stores/{intake,messaging}-store.ts`.

### `[2.x] DONE — the inbound pipeline, as domain logic`
The piece that was missing between the router and the channel. `InboundHandler`
(`packages/domain/src/messaging/inbound-handler.ts`) takes a normalised inbound message and does
the four things the phase description implies but no single component owned: ingest its media,
route it, act on the router's follow-ups, and reply through `OutboundGate`.

The split from `InboundRouter` is deliberate. The router *classifies* and has no outbound
consequences, which is why it can be reasoned about without a channel and why phase 3's agent can
consume its output without inheriting any reply logic. The handler is where "so what do we do"
lives — identification prompts, opt-out acknowledgements, consent decisions, intake runs, draft
confirmations and quick corrections — and every one of its replies goes through the gate.

It also emits a `TraceStep[]`: webhook → media → router → session → intake → gate, with the outcome
of each. That is what the simulator's trace panel renders, and it is the difference between "the
reply never arrived" and "the reply was blocked at the consent gate because SERVICE is REVOKED".
Phone numbers are masked in it, because it is rendered in a browser.

### `[2.2] DONE — Sandbox Simulator UI`
Console `/sandbox`, DEMO_MODE only and refused three times over: the page 404s when the flag is
off, the API 403s, and the endpoint additionally refuses if the live adapter is wired. Personas are
read from the database rather than a fixture list, so the picker always reflects the shop as it
actually is; a staff persona writes into the evidence group, which is what makes their photo an
intake trigger without a caption.

An injected message is rendered as a **real Cloud API webhook envelope**, signed with the sandbox
app secret, and pushed through the same `receive` → `toInboundMessage` → `InboundHandler` path a
Meta delivery takes. There is no private back door into the router. Delivery receipts travel the
same route, so the inbox's ticks are exercised in dev rather than only in production.
Files: `apps/console/src/components/simulator.tsx`, `apps/api/src/messaging/sandbox.controller.ts`.

### `[2.10] DONE — Conversations inbox`
Thread list with unread counts, language, a live 24-hour window countdown and the customer's
consent state; thread view with media, message-state ticks, template names and purpose tags; and an
advisor reply box that posts through `OutboundGate`. A human typing there bypasses the *autonomy*
check — a person has taken responsibility for the words — and nothing else.

A message the gate refused is rendered **in the thread**, struck through, with its code and reason.
Hiding it would leave an advisor believing a customer was told something they never were, which is
the exact failure the gate exists to make visible. A quiet-hours hold shows its due time.
Files: `apps/console/src/app/(app)/conversations/**`, `apps/console/src/components/{message-bubble,reply-box,window-countdown}.tsx`.

### `[2.8] DONE — minimal digital job card`
`POST /intake/job-cards` and the console form behind it. It builds the same `JobCardDraft` the
photo path does and confirms it through the same service, so entity resolution, the audit chain and
the outbox behave identically. Every field arrives at confidence 1 — which is the honest value, not
a shortcut: a person looked at the vehicle and typed its number, and marking it lower would put a ⚠
against something nobody needs to check.

### `[2.x] DONE — API wiring`
`apps/api/src/messaging/`: the webhook (GET handshake, POST with the signature checked over
`request.rawBody` before anything is parsed), the dev-only sandbox endpoints, conversations
list/thread/reply/read/consent-request, intake drafts list/detail/correct/confirm/discard, the
new-job-card form, and media serving.

Two things worth naming. **The webhook always answers 200 once the signature holds** — Meta retries
any non-2xx, and a handler error surfacing as a 500 would make it redeliver the same photograph
until it gave up; idempotency is what makes that safe. And **an invalid signature answers 401, not
500**, for the same reason in reverse: a permanently invalid signature must tell the provider to
stop. Media is streamed through the API rather than handed out as a presigned URL, because a
presigned URL is a bearer token for a customer's photograph that outlives the session that minted
it.

### `[2.x] DONE — workers`
`DeferredSender` drains quiet-hours holds through `OutboundGate.release`, which re-runs every
customer protection: a customer who opted out at midnight does not receive the 21:30 message at
08:00 because it was "already approved". Polling rather than a BullMQ delayed job, deliberately —
a delayed job fixes the send time at deferral, and a shop that changes its quiet hours or a
customer who opts out overnight must be honoured by a message queued hours earlier.

`audio-transcode` runs on `media.ingested` and produces the 16 kHz mono WAV phase 4's STT consumes.
The webhook path now stores audio with `deferAudio`, so ffmpeg never runs inside a request: the
worker is both where the binary lives and where the time budget is.
Files: `apps/workers/src/{deferred-sender,handlers/audio-transcode}.ts`.

### Verification run (2026-08-14)

| Suite | Result |
|---|---|
| `packages/shared` | 37 passed |
| `packages/config` | 19 passed |
| `packages/domain` | 397 passed · 90.9% statements, 82.5% branches |
| `packages/adapters` | 163 passed · 1 skipped |
| `packages/agent-core` | 9 passed |
| `packages/simulator` | 17 passed |
| `packages/db` integration | 32 passed |
| `apps/workers` integration | 6 passed |
| `apps/api` integration | 33 passed |
| `apps/console` Playwright | 30 passed (desktop + mobile) |
| `pnpm eval:ocr` (self-test mode) | 5/5 gates passed |
| `pnpm demo:phase1` | 15/15 steps |
| `pnpm demo:phase2` | 16/16 steps |
| lint + typecheck, all packages | clean |

---

## Phase 2 Acceptance Gate — current state

- [x] Contract tests pass against the Sandbox WhatsApp adapter.
- [x] Paper-photo → OCR draft → correction → confirmed OPEN card, end-to-end in the sandbox.
      `demo:phase2` steps 3–7 walk it: photograph into the workshop group → 16 extracted fields
      with 3 flagged ⚠ → `3 = TN09BX…` typed back → Confirm → `JC-2026-00NN` OPEN with the
      corrected plate on the vehicle and the extractor plus the corrected field in the audit
      trail. Well inside the 60-second budget — the whole scenario runs in under a second.
- [ ] OCR eval gates met, **including against a real vision model**. The harness, the fixtures,
      the scoring and the gates are done and green — but only in **self-test mode**. See deviation
      10; this remains the single open item in the phase.
- [x] 24h-window logic, opt-out, quiet hours and consent gating proven by tests; zero send paths
      bypass `OutboundGate`, proved by `no-bypass.test.ts`.
- [x] Forwarded-text and voice-note fixtures parse correctly with mock STT — 10 of 10.
- [x] Entity resolution handles the registration and phone variant table; ambiguity produces merge
      suggestions, never silent merges.
- [x] `pnpm demo:phase2` runs photo intake, text intake, voice intake and a consent-gated outbound,
      printing pass/fail — 16/16.

**The `phase-2-complete` tag has deliberately not been created.** The master's definition of done
for a phase is "every checkbox in its Acceptance Gate passes", and the OCR box does not. Everything
that can be verified without a model credential is verified; the remaining step is one command
(deviation 10) and does not require code.

---

## Decisions & deviations — Phase 2

10. **`eval:ocr` reports accuracy only when a vision model is configured.** With no
    `ANTHROPIC_API_KEY` the fixture adapter would hand back the answer key and the eval would print
    a green 100% forever, which is worse than having no eval. The harness therefore runs in one of
    two labelled modes: **live**, which enforces the phase-2 gates against a real model, and
    **self-test**, which drives the scorer with a synthetic reader of known error rate and known
    honesty to prove the gates fire, and says plainly that it measured no model accuracy. CI runs
    self-test. **The phase-2 OCR accuracy and calibration gates have therefore not been measured
    against a vision model in this environment.** A test asserts that a reader which is accurate
    but *confidently wrong* fails the calibration gate, so the gate is known to work — but the real
    numbers are unknown and must be produced before this phase can be called done.
11. **OCR is a port, and it appears in the boot log.** The master's stack table has OCR riding on
    `LlmPort` rather than being its own concern, which is how it is implemented — but "which thing
    read my customer's job card" is exactly what an operator needs to know, and the sandbox answer
    (a fixture set that refuses unknown images) differs materially from the live one. `ocr` is
    therefore a row in `PORTS` whose adapter is derived from the LLM adapter's own sandbox flag,
    so the two can never disagree.
12. **A deterministic heuristic parser backs the sandbox LLM.** A sandbox adapter that returned a
    canned draft would make every intake test vacuous. `extractDraftFromText` is a real parser —
    registration, phone, make and model vocabulary, service keywords in three languages, rupee
    shorthand, promised-time phrases — and it doubles as the honest baseline for the eval: a
    vision model that cannot beat a vocabulary lookup on clean text is not earning its cost.
13. **Confidence is assigned by *how a value was found*, not tuned to look good.** An exact
    vocabulary hit scores 0.85, a value derived from another (a make inferred from a model) 0.72,
    a positional guess 0.55, an ambiguous price attribution 0.42, an OCR repair 0.35. This is what
    makes the calibration gate meaningful rather than circular.
14. **Generated OCR fixture images are gitignored.** `manifest.json` records the template hash each
    image was built from, so `pnpm eval:ocr` regenerates exactly what changed; committing about
    5 MB of PNGs would only add drift.
15. **`packages/adapters` now depends on `packages/domain`.** The channel sender, the media fetcher
    and the draft-extraction bridge implement ports the domain declares — the same arrangement
    `packages/db` already has, and no cycle, since domain depends only on `shared` and `config`.
    `no-bypass.test.ts` anticipated `apps/api/src/messaging/whatsapp-channel-sender.ts`; the sender
    lives in `packages/adapters/src/whatsapp/` instead, which was already on the allowance list,
    because the API, the workers and the demo runner all need it and three copies of a send bridge
    is exactly the drift that test exists to prevent. The stale API path was removed from `ALLOWED`.
16. **`OutboundRequest.systemReply` — a named exemption from the autonomy check only.** Every flow
    defaults to `L0_SHADOW`, which means "the agent drafts, a human approves". Applied literally to
    *every* outbound, it would hold the opt-out acknowledgement a customer is owed the instant they
    type STOP, and leave an unrecognised number in silence until an advisor came back from lunch.
    Master §6 scopes autonomy to what the agent *chooses to say*; `systemReply` marks the messages
    the shop has no discretion over — identification prompt, opt-out ack, the consent ask, a media
    rejection notice, the draft summary a technician confirms. Consent, window, quiet hours, caps
    and disclosure all still apply, and each one is audited like any other send.
17. **Two gaps in the gate found by the phase-2 demo, both closed by tightening.**
    (a) An **unidentified thread skipped quiet hours entirely** — it returned early before the
    quiet-hours check. Not knowing who someone is does not make 2am acceptable; if anything it is
    worse, since there is no relationship to justify it. Consent and caps genuinely cannot be
    evaluated without a customer record; quiet hours can, and now are.
    (b) `PgMessageStore.recentOutboundAt` returned raw driver rows, so `sent_at` arrived as a
    **string rather than a `Date`** and the frequency-cap check crashed on the second outbound
    message to any customer. The in-memory store returned `Date`s, which is why no unit test caught
    it. Conversion now happens at the `tx.execute` boundary, where it belongs.
18. **The consent ask is exempt from frequency caps, and is idempotent on the registry.** Caps
    exist to stop a shop pestering someone; the message that asks whether the shop may write at all
    is the opposite of that, and blocking it strands the customer with no consent record and the
    shop with no lawful way to obtain one. It cannot be abused as a way around the cap because
    `ConsentCaptureService` writes a `PENDING` SERVICE row *before* sending and refuses a second
    ask. That also fixed the original idempotency key: keying on "has anything been sent on this
    thread" was wrong, because an unknown number gets an identification prompt first and that must
    not consume the shop's one chance to ask.
19. **The webhook resolves its shop from `metadata.phone_number_id`, and the seed configures one.**
    One webhook URL serves every tenant, so the delivery has to identify its shop, and that field is
    the only stable thing in a Meta payload that does — the body is attacker-controlled until the
    signature has been checked. `messaging.whatsappPhoneNumberId` is therefore part of shop config,
    and the seed points the demo shop at the sandbox number so the sandbox and Meta resolve their
    shop by exactly the same route rather than the sandbox having a special case. The fallback is
    *sole*-shop, not first-shop, so it cannot silently pick a tenant on an installation that has
    grown a second one.
20. **`db:seed --reset` clears data before rolling back.** The phase-2 down migration deliberately
    refuses to run while an unidentified or staff-group conversation exists — those rows have no
    home in the phase-1 shape, and a real `db:rollback` should stop rather than lose them. But
    `--reset` is not that; it is "destroy and rebuild", and the rows are going either way. Clearing
    first leaves the guard exactly as strict where it matters while letting a rebuild proceed —
    which it could not, as soon as anyone ran `demo:phase2` first.
21. **The console proxies the API through one allowlisted route handler.** `/api/[...path]`
    attaches the httpOnly access token server-side, so no browser script can read it. The allowlist
    (`conversations`, `intake`, `sandbox`, `media`) is the point: a blanket forwarder would turn
    the console origin into an open credentialled gateway to every API route, and adding a prefix
    should be a line in a diff a reviewer sees.

---

## OPEN QUESTIONS — Phase 2

7. **What is a real vision model's field accuracy and calibration on the golden set?** Unknown —
   see deviation 10. Run `LLM_DRIVER=anthropic ANTHROPIC_API_KEY=… DEMO_MODE=false pnpm eval:ocr`
   before claiming the phase-2 OCR gate. If calibration fails, the prompt's confidence rubric is
   the first thing to tune, not the accuracy threshold.
8. **Should a partial registration (`MH12`) be allowed to create a vehicle?** Currently it is
   recorded as a low-confidence draft value and entity resolution refuses to match on it. Taken
   conservatively: an advisor must complete the plate before the card can be confirmed. Revisit if
   shops find this obstructive.
9. **A customer photograph captioned with the intake trigger creates a draft but sends them no
   summary.** The numbered proofreading list is a staff surface — asking a customer to check
   sixteen extracted fields is not a customer experience — so their card lands in the console
   intake queue for an advisor instead. Conservative reading: they get no automated acknowledgement
   of it beyond the ordinary inbound handling. Phase 3's agent is the right owner of "tell the
   customer we received their card", since it can say something useful rather than a receipt.
10. **Group threads that are not the configured staff group get no automated reply at all.** The
    router classifies them as conversation for a human. Auto-answering an unknown group would
    broadcast to strangers, so silence is the safe default — but it does mean a shop that changes
    its staff group id without updating config goes quiet on that channel. Phase 7's go-live
    checklist should verify `messaging.staffGroupId` against the live account.
11. **Advisor replies do not currently pause anything, because there is nothing yet to pause.**
    `conversations.humanOverrideAt` is set on a human reply and on a `HUMAN` keyword, and the inbox
    surfaces it; phase 3 is where it must actually halt a running objective. The flag and its two
    write paths exist now so phase 3 consumes a field with real history rather than starting from
    an empty column.

---

## Handoff to Phase 3

Phase 3 builds the agent on top of what phase 2 finished. Consume and extend, never redesign:

- **`OutboundGate.send` is still the only way to reach a customer.** The agent's
  `send_customer_message` tool wraps it; it does not become a second sender. `no-bypass.test.ts`
  walks the repository and will fail the build if it does. Note the two existing exemptions from
  the *autonomy* check and nothing else — `isHumanReply` and `systemReply` (deviation 16) — and add
  no third without the same treatment.
- **`InboundRouter` classifies; `InboundHandler` acts.** The agent hangs off the `CONVERSATION`
  follow-up, which is deliberately the one the handler does the least with. `RoutedMessage` carries
  `conversationId`, `customerId`, `senderStaffId`, `language` and `windowExpiresAt` — everything an
  objective needs to decide whether it may speak freely or must spend a template.
- **Session windows are domain state, already fed.** `ConversationSessionService.canSendSessionMessage`
  and `windowState` answer "free-form or template?" for a ladder rung. Do not recompute from
  timestamps.
- **`humanOverrideAt`** is set on every advisor reply and every `HUMAN` keyword (open question 11).
  Pausing a running objective on it is phase 3's job.
- **`OutboundGate.release`** already exists and re-runs every customer protection. It is what the
  HITL approval queue calls when an advisor approves a `PENDING_APPROVAL` message, and what the
  quiet-hours drain calls. The L0-shadow queue is a console surface over rows that already exist.
- **`TraceStep[]`** from `InboundHandler` is the shape the simulator renders. Agent steps should
  extend the same trace rather than inventing a second observability channel — the sandbox is the
  primary test bench for the agent and it is already fast (`demo:phase2` runs in under a second).
- **`JobCardDraft` conventions** — per-field confidence, `draftFields` ordering, `applyCorrection`
  — are what the intake surfaces agree on. Anything phase 3 extracts should land in the same shape.
- **The staff evidence group** is wired end to end: a technician's photo or voice note is attributed
  to them via `senderStaffId`, which is what lets a later customer-facing claim cite a technician
  note under L7.

---

## Phase 3 — Agent runtime & Approval Autopilot

**Status: COMPLETE.** Every Acceptance Gate checkbox passes: 827 unit tests, 42 Playwright tests
across desktop and mobile, all six personas green in `pnpm sim`, and `demo:phase1`, `demo:phase2` and
`demo:phase3` each passing in any order from a clean seed. Migration 0003 is proven reversible against
a real Postgres.

### `[3.0] DONE — shared vocabulary, schema and migration 0003`
New enums (`LLM_TASK_CLASSES`, `AGENT_OBJECTIVES`, `AGENT_RUN_OUTCOMES`, `CUSTOMER_DECISIONS`,
`ESCALATION_RUNG_TYPES`, `ADVISOR_TASK_*`, `REVIEW_ACTIONS`), ten new event types with payloads and a
new `agent-events` queue, and shop-config v3 (`agent` block plus ladder rungs re-expressed as a
`type`). Tables: `llm_usage`, `agent_runs`, `agent_steps`, `advisor_tasks`, `message_reviews`, plus
columns on `escalations`, `evidence_bundles` and `approval_requests`. Migration 0003 up and down are
hand-written and reversible; six CHECK constraints put the invariants in the database rather than
only in the service that happens to write the row today.
Files: `packages/shared/src/{enums,events}.ts`,
`packages/config/src/{shop-config,shop-config-migrations,env}.ts`,
`packages/db/src/schema/agent.ts`, `packages/db/migrations/0003_phase3_agent_approval.sql` (+ `down/`).

### `[3.1] DONE — LlmPort task classes, tool calls, retries, MockLlm, metering`
`LlmPort` now names a **task class** (`AGENT`/`CLASSIFY`/`EXTRACT`/`JUDGE`) rather than a call site,
carries typed tool definitions and tool-call responses, and takes an optional per-class temperature.
`AnthropicLlmAdapter` owns its retries — full jitter, `retry-after` honoured over its own choice,
retryable kinds only — and reports `attempts` on every completion. `MockLlmAdapter` replays a recorded
script in order and **raises rather than improvising** when a turn runs out or a guard fails.
`MeteredLlmPort` wraps whichever adapter is live and writes tokens, latency, attempts and a cost
estimate to `llm_usage`; failed calls are metered too, and an unpriced model records a **null** cost
rather than a wrong one.
Files: `packages/adapters/src/llm/{port,anthropic-adapter,sandbox-adapter,mock-adapter,metering,zod-json-schema}.ts`.

### `[3.2] DONE — agent runtime (packages/agent-core)`
`AgentRunner.run()` is the deterministic outer loop: assemble → LLM → validate → execute → append →
repeat, under step, token and wall-clock caps, ending in
`objective_met | handoff | blocked | budget_exhausted`. Prompt assembly composes the constitution
verbatim, the shop profile and price-list digest, the customer and vehicle, live JobCard state, the
citable sources, the fenced conversation tail and the objective spec — with the language policy
telling the model to mirror the customer including code-switch.
Proven by test: the step cap ends a run, a human replying mid-run aborts it (as `ABORTED`, not
`FAILED`), a redelivered trigger message cannot start a second run, a model that announces success
having sent nothing ends `budget_exhausted`, and `replay()` over the persisted steps reproduces the
identical tool calls.
Files: `packages/agent-core/src/{runner,prompt,constitution,objectives}.ts`.

### `[3.3] DONE — tool set v1`
All ten tools, each validating, checking invariants, auditing and returning typed results *including
refusals*. `compose_customer_message` never sends; `send_customer_message` is the only tool that
reaches a customer and runs the post-checker then `OutboundGate`. `adjust_offer` rejects below-floor
and above-ceiling offers through `checkOfferedPrice`, and refuses outright when an item has no list
price rather than inventing one. An objective is shown only its permitted tools, and a call outside
that set is refused with the list of what *is* available.
Files: `packages/agent-core/src/{tools,tool-registry}.ts`.

### `[3.4] DONE — evidence bundle builder`
Technician evidence → bundle: media set, affected work items, estimate-v2 draft lines, and an
explanation whose every sentence carries the source ids it restates. Anchored by `#TN09BX4432`
shorthand (through the phase-2 normaliser, so an unrepairable plate resolves to nothing rather than a
guess), by reply-to a pinned card message, or explicitly. The builder re-verifies every claim's
sources against the sources it supplied, so a writer that cites `note:fabricated` is caught before
the post-checker, before HITL, and long before a customer.
Files: `packages/domain/src/agent/evidence-bundle.ts`, `packages/agent-core/src/explanation-writer.ts`.

### `[3.5] DONE — claim-anchoring post-checker`
Three layers, cheapest first: structural (disclosure, banned patterns, prices matching estimate lines
exactly), coverage (every factual *sentence in the body* is a declared claim citing a real source),
and a `JUDGE`-class model over each {claim, source} pair. It fails **closed** — a judge that times out
blocks.
**Red team: 22 adversarial candidates, 100% blocked. Clean set: 12 candidates, 0% false blocks.**
Files: `packages/agent-core/src/post-checker.ts` (+ `.test.ts`).

### `[3.6] DONE — Approval Autopilot flow`
`createApprovalRequest` writes the row *before* the send — so the request exists even when the gate
holds the message for HITL, which is the L0 default — and composes the interactive message with
Approve / Ask a question / Call me. `recordCustomerDecision` locks the row, transitions each work
item individually (so each writes its own ledger entry), moves the card, cancels the ladder and emits
the phase-4 ETA hook. Partial approval updates exactly the approved lines and ledgers the rest as
`DEFERRED` with reason `customer_partial`. A second tap of Approve records nothing new.
The three buttons are wired: `InboundHandler` recognises the reply ids and hands off to
`ApprovalReplyHandler`, which records the decision and confirms it, opens the objection objective, or
raises a high-urgency callback task. Approve and Call me each answer the customer immediately —
someone who taps a button and hears nothing assumes it failed and taps again.
Files: `packages/domain/src/agent/{approval-service,approval-replies}.ts`,
`packages/domain/src/messaging/approval-actions.ts`.

### `[3.7] DONE — escalation ladder engine`
Default approval cadence is now T0 → T+45m → T+2h `VOICE_OR_ADVISOR` → T+24h `OWNER_DIGEST`. Rungs
are rows plus delayed jobs; **the row is the authority**, so a job that survives a failed queue
removal finds its rung `CANCELLED` and does nothing. Quiet hours defer rather than skip. A decision or
a human takeover cancels every remaining rung atomically. Duplicate scheduling is suppressed by the
unique index. Proven under a fake clock: full ladder in order, decision at T+50m cancels the rest,
quiet-hours rung defers to 08:00, duplicate suppressed, human takeover stops the chase.
Files: `packages/domain/src/agent/{escalation,advisor-tasks}.ts`.

### `[3.9] DONE — HITL review queue + autonomy graduation`
Approve-send / Edit-then-send / Reject-with-reason, over `OutboundGate.release` so every *customer*
protection is re-run while the autonomy check is not. Edits are stored before and after with a line
diff computed server-side, and an edit keeps the approval buttons rather than stripping them. The
graduation report is a pure function of counts and config, and it refuses to recommend below the
sample size, below the approve-without-edit bar, or above the checker-block ceiling.
`GET /review/queue`, `POST /review/:messageId/decide`, `GET /review/graduation` and the advisor-task
endpoints are live, all parsed through shared contracts on the way out so a drift between API and
console is a build error rather than a blank panel. The graduation report is OWNER-only, because
raising autonomy is an owner's decision.

**The console page** puts the candidate's words first and largest, the checker's reasons directly
under them, and the waiting time on every card — the cost of shadow mode is a customer waiting, and
hiding it is how a shop never leaves L0. Editing is a first-class action rather than a correction:
it opens the same words in a textarea and records before, after and a diff, because "how often does
it get this right without me?" cannot be answered from a queue that only records approvals.
Rejection demands a reason for the same purpose. Advisor tasks share the page: someone opening it is
asking "what needs me?", and a call the ladder raised is exactly that.

The E2E produces its candidate through the **real path** — the sandbox has the customer message
first (which opens the 24-hour window), then asks `ApprovalService` to put a genuine evidence bundle
to them, and the gate holds it because the shop is at L0. Nothing is a fixture row inserted to make a
page look populated.
Files: `packages/domain/src/agent/review.ts`, `apps/api/src/messaging/review.controller.ts`,
`apps/console/src/app/(app)/review/page.tsx`, `apps/console/src/components/review-candidate.tsx`,
`apps/console/test/e2e/review.spec.ts`.

### `[3.x] DONE — Postgres stores, and migration 0003 against a real database`
`PgLlmUsageSink`, `PgAgentRunStore`, `PgJobCardContextReader`, `PgPriceListReader`,
`PgEvidenceBundleStore`, `PgApprovalStore`, `PgEscalationStore`, `PgAdvisorTaskStore` and
`PgReviewStore`, written against the in-memory doubles as their specification. Idempotency comes from
the unique indexes: `ON CONFLICT DO NOTHING` turns "already exists" into a null return rather than an
exception the caller has to classify.

Migration 0003 was applied, rolled back and re-applied against the running Postgres. Reconciling the
drizzle snapshot found one genuine omission — the `message_reviews.reviewer_staff_id` foreign key was
in the schema but missing from the handwritten SQL — now fixed; `drizzle-kit generate` reports no
drift. The schema smoke test's table-count guard did its job, and now covers the five new tables with
a real row each.
Files: `packages/db/src/stores/agent-store.ts`, `packages/db/migrations/meta/0003_snapshot.json`.

### `[3.x] DONE — API and worker wiring`
`createAgentRuntime` in `packages/agent-core` is the single composition root, for the same reason
`createChannelPorts` was in phase 2: three processes want the identical set, and each assembling it by
hand is how they drift.

Workers: an `escalations` BullMQ queue whose **job id is the escalation id**, so a rung scheduled
twice has one timer; a worker that calls `fireRung` and lets the row decide whether anything happens;
and an `approval-ladder` handler that schedules the ladder from `approval.requested` and cancels it on
`approval.decided`. Rungs get one attempt, not five — "retry" here means "message the customer again",
and the ladder's next rung *is* the retry.

API: the runtime is a provider, the inbound handler receives the approval port, and the review queue
has its endpoints.
Files: `packages/agent-core/src/composition.ts`, `apps/workers/src/{escalations,main}.ts`,
`apps/workers/src/handlers/approval-ladder.ts`,
`apps/api/src/messaging/{agent.providers,review.controller}.ts`.

### `[3.8] DONE — objection handling`
`resolve_partial_approval` covers the five intents the phase names: price (through `adjust_offer`,
inside the limits or an honest refusal plus the owner-check offer), defer, scepticism (re-send the
media and offer the old-part inspection — a standing allowed claim), a plain question answered from
the bundle's sources, and confusion, which offers a call rather than explaining a third time.

The objective completes on a *reply* as well as on a decision or a handoff. An agent that has
answered the question has finished its turn: the customer has not decided because they have only just
been told something, and a runtime that kept looping would spend its remaining steps talking to
itself. `price_objector`, `sceptic` and `confused_elder` are the transcripts that prove each intent.
Files: `packages/agent-core/src/objectives.ts`, `packages/simulator/src/personas/personas.ts`.

### `[3.10] DONE — conversation simulator and `pnpm demo:phase3``
**`pnpm sim`** runs six personas — `quick_approver`, `price_objector`, `silent_customer`, `sceptic`,
`confused_elder`, `partial_approver` — in scripted mode: `MockLlmAdapter`, a fake clock, in-memory
stores, no credentials. Each asserts four things: the objective's outcome, the turn count, time to
decision, and **guardrail compliance re-checked over every message the customer actually received**.
It also fails a persona whose agent run ended `blocked`, because inside a persona that is not a
guardrail working — it is a transcript that should never have been written.

The suite also runs under vitest, so it gates CI as a test as well as a report.

**The property the phase asks for by name is asserted:** tightening the price floor back to the
shipped default makes `price_objector` fail loudly, with a `GUARDRAIL` finding. Without that test the
other six would stay green through a change that silently disabled the floor.

**`pnpm demo:phase3`** narrates one saga in 15 steps against the **real database** — deliberately,
because the domain rules have their own in-memory suites and the personas need no database at all, so
what the demo uniquely exercises is the phase-3 Postgres stores that every other test replaces with a
double. It creates its own customer, vehicle and job card, *drives* the card to `AWAITING_APPROVAL`
through the transition service so the audit chain is genuine, and is re-runnable: borrowing a seeded
card would work once and then hit the daily frequency cap on a customer it had already messaged.

The saga: technician evidence → bundle with every claim anchored → interactive request with three
buttons → ladder scheduled at T+45m/T+2h/T+24h → a third off refused by the floor → the refusal
relayed honestly → a 10% concession accepted and quotable → Approve tapped twice, decided once →
work items `APPROVED`, card `IN_PROGRESS` → ladder cancelled and timers dropped → `eta.requested` on
the outbox → 33 metered model calls with cost estimates.
Files: `packages/simulator/src/personas/**`, `packages/simulator/src/cli/sim.ts`,
`packages/simulator/src/scenarios/phase3-demo.ts`.

### Six bugs the simulator and the console E2E found

Worth recording, because each was invisible to the unit suites and each was a real defect:

1. **`activeBundle` passed a job-card id where a conversation id was expected**, so the agent had no
   sources and *every* reply it composed was blocked. The fix added
   `EvidenceBundleStore.findLatestForJobCard` — the read the name always implied.
2. **`adjust_offer` judged every shop against the default config**, so a workshop that had
   deliberately allowed a 10% concession still had every concession refused, citing a floor its owner
   never set. Tools now load the shop's own document per call, the same way the gate does.
3. **The minimum interval between messages silenced the agent's replies.** A customer who asked a
   question within an hour of the last message got nothing. Replies are now exempt from that knob —
   and only that knob; the daily and weekly caps still apply in full.
4. **An approved concession was not quotable.** `adjust_offer` accepted a price the agent then could
   not state, because the only price on file was the original. The guardrail that approves a price now
   mints the source id for it.
5. **Quiet hours pre-empted the autonomy check.** A draft composed at 21:30 was deferred to the
   morning *instead of* being held for review, so it never appeared in the queue overnight and only
   then started the clock on a human reading it — a 21:30 estimate would reach the customer a working
   day late. The autonomy hold now runs first; `release()` re-runs quiet hours, so the customer still
   hears nothing until 08:00.
6. **A released message that hit quiet hours was never rescheduled.** Found immediately after fixing
   (5): `release()` recorded the deferral but left the row in `PENDING_APPROVAL` with no
   `scheduled_for`, so the deferred sender could never pick it up. An advisor's approval at 21:30
   would have been actioned and never sent, and the candidate would have sat in the queue looking
   untouched. `MessageStore.reschedule` is the write that was missing.

### Verification run (2026-08-15)

| Suite | Result |
|---|---|
| `packages/shared` | 37 passed |
| `packages/config` | 19 passed |
| `packages/domain` | 428 passed |
| `packages/adapters` | 184 passed · 1 skipped |
| `packages/agent-core` | 61 passed |
| `packages/simulator` | 27 passed |
| `packages/db` integration | 32 passed |
| `apps/workers` integration | 6 passed |
| `apps/api` integration | 33 passed |
| `pnpm sim` | 6/6 personas |
| `pnpm demo:phase1` | 15/15 steps |
| `pnpm demo:phase2` | 16/16 steps |
| `pnpm demo:phase3` | 15/15 steps, twice in a row |
| `apps/console` Playwright | 42 passed (desktop + mobile) |
| migration 0003 up -> down -> up | clean; `db:generate` reports no drift |
| `pnpm typecheck` | 16/16 packages clean |
| `pnpm lint` | 16/16 packages clean |

The three demos were also run in sequence from a clean seed — `phase1 → phase2 → phase3 → phase1` —
to prove they are order-independent and leave the shop's configuration as they found it.

---

## Phase 3 Acceptance Gate — current state

- [x] **Full Approval Autopilot demo in sandbox: technician evidence → bundle → customer
      approve/partial/silent paths all correct, ladder timings honoured under fake clock.**
      `pnpm demo:phase3` walks the approve path end to end against Postgres in 15/15 steps;
      `pnpm sim` walks partial (`partial_approver`) and silent (`silent_customer`, whose whole ladder
      fires under a fake clock) plus three objection paths. The ladder's timings — the T+45m rung
      deferring behind the frequency cap, the decision at T+50m cancelling the rest, the quiet-hours
      rung deferring to 08:00 — are proven in `agent.test.ts`.
- [x] **`adjust_offer` floor/ceiling enforcement proven at the tool layer; agent relays refusals
      honestly.** Demo steps 07 and 08: a third off is refused with the shop's real floor in the
      reason, and the message that follows relays the refusal without quoting the refused figure.
      Also unit-tested in `runner.test.ts`, and `personas.test.ts` proves that *removing* the
      permitted discount makes `price_objector` fail.
- [x] **Post-checker blocks 100% of the red-team set; false-block < 5% on the clean set.**
      22 adversarial candidates, all blocked. 12 clean candidates, 0 blocked.
- [x] **Every agent step persisted and replayable; human message aborts runs.** Demo step 10 replays
      a persisted run against SQL; `runner.test.ts` proves the abort, the `ABORTED` status, and that a
      replay reproduces the identical tool calls.
- [x] **All six simulator personas pass in scripted mode in CI.** `pnpm sim` — 6/6, and the same
      suite runs under vitest so it gates a build rather than only a terminal.
- [x] **`pnpm demo:phase3` narrates one full approval saga (evidence → objection → concession →
      approval) and exits green.** 15/15, re-runnable.
- [x] **L0 shadow mode: nothing reaches a customer without HITL; edits audited; graduation report
      live.** At L0 the agent's draft lands in the queue and the wire stays silent; an advisor's edit
      is stored before-and-after with a diff and sent in place of the draft; the graduation report
      computes from review counts with its thresholds exercised exhaustively, and an owner sees it on
      the review page. Proven end to end in Playwright on desktop and mobile: the agent drafts, the
      advisor edits, and the customer receives the edit.
- [x] **Tag `phase-3-complete`.** Ready to create — every checkbox above passes.

**All checkboxes pass.** The tag has not been created, because creating a git tag is the user's call
rather than something to do unasked.

---

## Phase 3 — outstanding work

Listed so the next session can pick up exactly here. None of it is design work; every port it fills
is defined and already tested against an in-memory implementation of the same contract.

Nothing here blocks the Acceptance Gate; these are deliberate scope calls recorded so phase 4 finds
them rather than rediscovers them.

1. **An agent run triggered from an inbound message.** `openObjectionObjective` is a no-op in both
   composition roots today: the button is answered synchronously and the run is left to the next
   inbound message. Wiring it means an `agent-runs` queue and a worker — small, but queue surface
   phase 3 does not otherwise need.
2. **`scheduleFollowup` books nothing.** The tool reports `not-scheduled` honestly rather than
   pretending; phase 4's reminder engine is its natural home.
3. **Live-model simulator mode.** The phase describes a nightly, LLM-judge-scored, report-only run
   alongside the scripted one. Only the scripted mode exists. A harness that had never been run
   against a model would be a claim rather than a capability, so it is listed here rather than
   shipped empty.

---

## Decisions & deviations — Phase 3

22. **Task classes replace `LlmPurpose`, and `EXTRACT` absorbs `vision`.** The phase file names four
    classes; a fifth for vision would be two names for one job, since vision-ness is a property of the
    *content* (an image block) and not of the task. One consequence is deliberate and worth naming:
    phase 2's forwarded-text extractor moves from the cheap classifier model to the extract model.
    Producing a typed document from free text is the same task as reading a photographed card, and a
    shop should not end up with a careful reader for photos and a careless one for messages.
23. **The Anthropic adapter now sends `temperature` — but only when configured.** Phase 2 sent no
    sampling parameters at all, for the good reason that current models reject them. The phase-3
    requirement is per-task-class temperature, so it is an optional env value per class that defaults
    to *absent*: the shipped request shape is unchanged, and a shop with a model that takes it can set
    one.
24. **Model prices are configuration, and an unpriced model records a null cost.** `LLM_PRICING_JSON`
    maps model id → USD per million tokens. Hardcoding prices would violate §10 and would drift; a
    spend report that says "unknown" is actionable, one that quietly applies last year's rate is not.
25. **`zodToJsonSchema` dispatches on zod's `_def.typeName`, not `instanceof`.** Tool schemas are
    declared in `agent-core` and converted in `adapters`, and under pnpm those two can resolve
    different copies of zod — at which point every `instanceof` check silently returns false. Found by
    a test that failed on sixteen cases at once. It also **throws** on an unsupported node rather than
    emitting a permissive schema: a tool whose shape cannot be expressed must fail at registration,
    not at runtime with a model free to invent arguments.
26. **The ladder defers a rung that would breach the frequency cap, rather than either side giving
    way.** The shipped approval ladder nudges at T+45m and the shipped cap is 60 minutes, so a shop on
    the defaults hits this on its very first reminder. Neither number is wrong — the cadence is what
    closes an approval (L3), the cap is what stops a shop pestering someone — and weakening either to
    make them agree would be weakening a guardrail (§10). The rung waits fifteen minutes instead.
    Only message-shaped rungs wait; a phone call is not another notification.
27. **Urgency is licensed per *claim*, not per message.** A technician note about brake pads saying
    "metal to metal soon" does not license calling the engine oil dangerous. The first implementation
    checked the whole source set and let exactly that through; the red team caught it.
28. **An evidence bundle's grand total is its own citable source (`line:total`).** Otherwise a
    sentence stating the total cites individual lines and the judge is asked to do arithmetic to clear
    it — unreliable, and the wrong question. The total is a figure the estimate carries, so it gets an
    id like any other.
29. **The approval message carries the AI disclosure when it is first contact.** It very often *is*
    the shop's first message to a customer — they handed the keys over at the counter and heard
    nothing since — so the composer has to know, rather than building a message the gate then refuses
    while the customer waits.
30. **`escalations.rung_type` is a new column, not a new value on `escalation_channel`.** Postgres
    cannot remove an enum value, so widening the existing type would have made migration 0003
    irreversible. `channel` records what a rung actually used (`VOICE_OR_ADVISOR` reports `HUMAN`
    until phase 5 places calls); `rung_type` records what the shop configured.
31. **`@serviceloop/domain/testing` is a real subpath, via a two-line shim at the package root.** The
    repo compiles with classic `moduleResolution: node`, which ignores the `exports` map. The
    simulator and the phase demos need the in-memory doubles; nothing in `apps/` should be able to
    reach one by accident.

32. **The `PriceListReader` derives list prices from the estimate, not from a price-list table.**
    There is no such table: phase 1 stores the shop's price list as a knowledge document in object
    storage, which is prose. What `adjust_offer` needs is a *number* to compute a floor from, and the
    honest one is the line total the shop quoted — that is what it asked for before any concession. An
    item with no line has no list price and the tool refuses rather than inventing one.
33. **`isAcknowledgement` — a third named exemption, from frequency caps only.** A customer who taps
    Approve and hears nothing assumes it did not work and taps again, so the silence a cap imposes
    causes the very repetition the cap exists to prevent. Same reasoning as the opt-out ack
    (deviation 18), and scoped the same way: consent, window, quiet hours, disclosure and claim
    anchoring all still apply, and only a caller answering an inbound action may set it.
34. **The escalation queue gives a rung one attempt, not five.** Everywhere else in this system a
    retry is free. Here "retry" means "message the customer again", and the ladder already has a
    retry: the next rung. A failed rung is a row an operator can see.
35. **The approval button ids live in `messaging`, not in `agent`.** The agent module imports
    `OutboundGate`, so the inbound handler importing the agent would close a cycle. A button id is
    channel vocabulary anyway — whoever reads inbound messages has to recognise it.

36. **A persona is a script of what a *person* does, not of what the agent says.** The agent's turns
    are scripted through `MockLlmAdapter`, but every assertion is about the outcome: the decision, the
    turn count, the time to decision, and the guardrails re-checked over what was actually sent.
    Asserting on the agent's wording would make the suite a change-detector for prose.
37. **The persona guardrail audit re-runs the structural checks; it does not re-run claim coverage.**
    The claims a message declared are not stored on the message row, and re-deriving them would be
    inventing evidence rather than checking it. Disclosure, banned patterns and prices against the
    estimate *are* re-checkable from the body, and those are the three the red team exercises most.
38. **`MockLlmAdapter` answers only `AGENT` calls and delegates the rest.** A claim-judge call made
    while the agent is mid-run is infrastructure, not a turn, and letting it consume the next scripted
    step desynchronised the whole script — with a failure that looked like the agent misbehaving.
39. **A recorded script may write `{{candidateId}}`.** Ids differ between runs, so a replay cannot
    hard-code the candidate a compose call returned; the adapter resolves placeholders from the most
    recent tool result, which is exactly what a real model does by reading it.
40. **`demo:phase3` creates its own customer and card rather than borrowing a seeded one.** Borrowing
    works once and then hits the shop's daily frequency cap on a customer already messaged — and the
    demo would look broken while the guardrail was working. It also moves the shop's quiet hours away
    from *now*, so the demo can be run at 22:00; phase 2 proves the quiet-hours rule itself.

41. **The autonomy hold runs before the quiet-hours defer.** A quiet-hours defer is about when a
    *customer* may be disturbed; it says nothing about when an *advisor* may read something. Deferring
    first hid the draft from the review queue overnight and only then started the clock on a human
    looking at it. `release()` re-runs quiet hours, so the customer still hears nothing until 08:00 —
    the guardrail is unchanged, only its position in the sequence.
42. **The sandbox can put an approval to a customer (`POST /sandbox/approval-draft`).** DEMO_MODE
    only, behind the same double guard as every other sandbox route, and it is not a fixture: it
    injects a real signed inbound delivery so the 24-hour window opens the way it does in production,
    then builds a genuine evidence bundle and sends it through `ApprovalService` → `OutboundGate`. At
    L0 the gate holds it, which is exactly how a candidate reaches the queue. It *prefers* a card with
    no open request but does not require one — the seed has a single such card, and refusing the
    second time would make a demo aid work once.
43. **Every phase-3 API response is parsed through a shared contract on the way out.** The console
    parses the same schema on the way in, so a drift between the two is a build error in one of them
    rather than a blank panel in a workshop.
44. **`demo:phase2` and `demo:phase3` move the shop's quiet hours away from *now*, and put back what
    they found.** The shipped default is 21:00–08:00, so an evening run would have had its first
    message deferred and looked broken while the guardrail worked. Phase 2 still proves the
    quiet-hours rule itself in the step that narrows the window deliberately. Restoring on teardown
    matters too: `demo:phase3` left the shop at L2 and the next `demo:phase1` failed on the
    conservative-defaults assertion, three scenarios away from the cause.

---

## OPEN QUESTIONS — Phase 3

12. ~~May `resolve_partial_approval` send more than one message per run?~~ **Answered while building
    the personas: one.** `send_customer_message` is now one of the objective's completion conditions,
    so a run answers once and stops. A customer who asks two questions in one message gets one answer
    and their next message starts the next run — which is also when the shop learns whether the first
    answer landed.
13. **What happens to a bundle whose estimate is superseded before the customer decides?** The
    approval row records the line ids it put to them, so the decision stays answerable — but a shop
    that re-prices mid-chase will have quoted one number and billed another. Phase 4 owns invoicing
    and should decide whether a superseded estimate cancels its open approval.
14. **The graduation report counts reviews shop-wide, not per objective.** `graduationCounts` filters
    runs by objective but reviews only by shop, because a held message does not record which objective
    produced it. The message row carries `agent_run_id`; joining through it is the fix, and it needs
    the Postgres store to exist first (outstanding item 1).

---

## Phase 4 — Status sentinel, delivery & payments

**Status: COMPLETE.** The loop closes: a technician's five-second voice note moves a customer's
job card, the customer hears about the delay before they ask, the car is announced ready with
pickup times, the invoice carries the photograph the work was approved on, a UPI payment arrives
as a signed webhook, and a gate pass lets the vehicle out exactly once. `pnpm demo:phase4` walks
all of that in 19/19 steps against the real database; `pnpm sim` runs 7/7 personas including the
phase's own `status_checker`. 1086 unit tests, `pnpm typecheck` and `pnpm lint` clean on all 16
packages, domain coverage back over the 80% gate at 88.7%, migration 0004 with no drift.

One known red: six of the console's 51 Playwright tests fail, all in the phase-3 review spec, for
a reason that is the frequency cap working — see "Known issue" at the end of this phase.

### `[4.0] DONE — shared vocabulary, shop-config v4, schema and migration 0004`
Twelve new enums (status signals, ETA reasons and materiality, payments, invoices, delivery
bookings, gate passes), a fourth agent objective, ten new event types and two new queues
(`status-events`, `delivery-events`) — the high-frequency technician traffic is deliberately kept
off the queue that carries the reconcile which releases somebody's car.

Shop-config **v4** adds `workingHours`, `eta`, `statusComms`, `delivery` and `invoice`, and widens
`payments` past its single ordering flag. `workingHours` is separate from `quietHours` because the
two answer different questions: when a *vehicle* is worked on versus when a *customer* may be
disturbed. The v3 → v4 migration is a plain deep-merge — every new block is additive and every new
field conservative — except that `invoice.gstin` and `invoice.legalName` stay null rather than
being inferred from the shop record, because a tax document is not somewhere to put a guess.

Nine new tables, three new `job_cards` columns, and eleven CHECK constraints putting the money and
tax invariants in the database rather than only in the service that happens to write the row today.
Migration 0004 up and down are both reversible.
Files: `packages/shared/src/{enums,events,working-hours,i18n/catalogue}.ts`,
`packages/config/src/{shop-config,shop-config-migrations,env,adapter-selection}.ts`,
`packages/db/src/schema/service.ts`, `packages/db/migrations/0004_phase4_status_delivery_payments.sql`
(+ `down/`).

### `[4.1] DONE — SpeechPort real adapters (Sarvam + Google) behind a failover policy`
`SarvamSpeechAdapter` (multipart, `api-subscription-key`, word timestamps, `language_code=unknown`
so the provider *detects* rather than being told) and `GoogleSpeechAdapter` (v2 `recognize`, ordered
`languageCodes`, `enableWordTimeOffsets`, vocabulary hints as a boosted inline phrase set). Both API
surfaces were checked against the current provider docs before wiring, per master §4.

`FailoverSpeechAdapter` is the phase's "2 consecutive provider failures → fallback + alert" rule,
and the detail that makes it useful is which errors *do not* count: `countsTowardsFailover` draws
the line at "is this about the provider or about the audio", so one four-byte voice note cannot move
a whole shop onto the second-best recogniser. The alert fires once per transition, not once per
failure.

`Transcript` gained `languageTags` — plural, because *"caliper open irukku, part varum 4 maniku"*
genuinely is, and collapsing it to one language is how a recogniser mangles the half it decided was
not there.
**53 tests**, including a contract suite run identically against all three adapters. Live tests are
behind `LIVE_STT_TEST=1` and skipped by default.
Files: `packages/adapters/src/speech/{port,sarvam-adapter,google-adapter,failover-adapter}.ts`.

### `[4.2] DONE — technician status parser`
EXTRACT-class parse into `StatusSignal`, with the routing rule as the feature: at or above
**0.85 confidence with exactly one matching card** the signal applies itself — transitions, audit,
ETA recalculation — and below it becomes one tap in the staff group.

Card resolution never requires an id (master L2). It works from an explicit code, a spoken plate
fragment, reply context, or a lone assigned card, in that order of how much the technician actually
told us. Two rules earned their place by fixture: **a fragment that matched nothing resolves to
nothing** rather than falling through to "their one open card", and **assignment only decides when
it is unique** — a technician with three cars open who says "done" has not said which.

`issue_found` leaves this module entirely and enters phase 3's evidence-bundle flow: new work needs
the customer's money and therefore their consent, not a state transition.

The corpus is fifteen transcripts written from how mechanics actually talk — almost none contain a
job-card number, one is a single word, and two contain both a status and a finding. The
deterministic parser that backs the sandbox is a real parser (three languages, native and romanised,
plate/time/part extraction), which is what makes those fixtures a test rather than an assertion that
a constant is constant. **69 tests.**
Files: `packages/domain/src/status/{card-matching,status-signal-service,types}.ts`,
`packages/adapters/src/status/{status-prompt,heuristic-status,status-parser,status-fixtures}.ts`.

### `[4.3] DONE — ETA engine`
A rules table, not a prediction — because every ETA is a promise a customer plans their day around,
and "the model said so" is not something an advisor can defend at the counter. Committed work only
(`APPROVED`/`IN_PROGRESS`; unapproved time would produce a "slip" the moment a customer declines),
per-kind fallbacks, one quality check, a configured buffer, laid onto **working hours** so four
hours approved at 22:00 does not promise a car at 02:00.

`blocked_parts` is the one branch that leaves the shop floor: a courier does not wait for opening
time, so the lead time is wall-clock and only the *fitting* is laid onto working hours after it
lands. A technician's own stated time is trusted over the configured lead — they have spoken to the
parts shop and the configuration has not.

Materiality is decided once, here, and travels on the event. A slip past 45 minutes is material; so
is crossing the promised day — and that one fires **once**, because "it will not be ready today"
repeated on every subsequent twenty-minute nudge is how a shop trains someone to mute the thread.
**Table-driven throughout**, as the acceptance gate asks.
Files: `packages/domain/src/status/{eta-rules,eta-service}.ts`, `packages/shared/src/working-hours.ts`.

### `[4.4] DONE — proactive status comms`
Bad news early, enforced: `blocked_parts` produces an immediate, reasoned, apologetic message and
there is no configuration that turns it off. Everything else is throttled to one coalesced update
per card per 2h, with three exemptions — approvals, ready alerts and delay notices — which are
exactly the three messages a customer is *waiting* for rather than being interrupted by.

Every ETA sentence cites the history entry that produced it, through the two new evidence-ref kinds
(`state:` and `eta:`). Without them "your car is in quality check, ready by four" has nothing to
anchor to and every status reply is blocked (L7).
Files: `packages/domain/src/status/status-comms.ts`, `packages/domain/src/guardrails/policies.ts`.

### `[4.5] DONE — inbound deflection (answer_status)`
A fourth agent objective, strictly grounded in live card state, ETA history and the estimate, with a
new `get_eta` tool. The tool **refuses honestly** when the ETA engine is not wired rather than
returning an empty history — an empty history reads as "nothing has gone wrong", and a model told
that will happily reassure a customer whose part has not arrived.

Out-of-scope traffic routes rather than being improvised: a new complaint, a price negotiation on
unapproved work, or a complaint about a person all hand off.
Files: `packages/agent-core/src/{objectives,tools,composition}.ts`.

### `[4.6] DONE — silent-bay sentinel`
Working hours, not wall clock — a card last touched at 18:50 on Saturday has been quiet for two days
and about ten minutes of shop time, and nudging about it at 09:05 on Monday teaches the staff group
to ignore the channel. Exactly one nudge per window, enforced by a unique index on
`(job_card_id, window_start)`, and one grouped message rather than six.

`AWAITING_PARTS` and `AWAITING_APPROVAL` are deliberately excluded: both are cards that are
*supposed* to be sitting still, and nudging a technician about them blames the wrong person for the
right delay.
Files: `packages/domain/src/status/silent-bay.ts`.

### `[4.7] DONE — ready-for-delivery + pickup slots`
Shop hours minus rush windows minus full bins. A slot tap is resolved against the **stored** offer,
never against a time in the customer's message: a ready alert sits in WhatsApp for hours, the shop
fills up, and honouring a stale button is how two people are promised the same half-hour. Returns
fewer offers — or none, with "tell us when suits you" — rather than relaxing a cap.
Files: `packages/domain/src/delivery/{slots,delivery-service}.ts`.

### `[4.8] DONE — invoice PDF with evidence appendix`
`@react-pdf/renderer` server-side, written with `createElement` rather than JSX so the adapters
package keeps compiling as plain TypeScript. The letterhead is **copied onto the invoice row**, not
read from config at render time: re-rendering last month's invoice after the shop corrects its
address must reproduce last month's document.

GST is split as floor-and-remainder rather than two roundings, so CGST + SGST equals the tax exactly
on every amount — two independent `round(rate/2)` calls disagree by a paisa on any odd figure, and a
tax invoice whose columns do not add up is one an accountant sends back. Intra-state and inter-state
are mutually exclusive, in the builder and in a database CHECK. Numbering uses the Indian financial
year read in the *shop's* zone.

The renderer is deterministic — creation date pinned to the invoice's issue date, no network fonts —
which is what makes the golden test possible: **byte-identical across runs, different when any figure
changes.** An erased photograph renders as a labelled placeholder rather than vanishing, so the
document cannot disagree with itself about how many things were photographed. **14 tests.**
Files: `packages/domain/src/delivery/{invoice-builder,invoice-service}.ts`,
`packages/adapters/src/invoice/pdf-renderer.ts`.

### `[4.9] DONE — PaymentsPort + Razorpay/Mock + reconcile`
`parseWebhook` takes **raw bytes and headers**, and no adapter may look at a parsed body before
verifying the signature — `JSON.parse` followed by `JSON.stringify` reorders keys, and that is the
failure mode where verification appears to work in testing and rejects every real delivery.

The event ledger is the truth: `amount_paid_paise` is a fold over `payment_events`, never a number
somebody increments, so a webhook retried six times credits once. The credited amount comes from
`payment.entity.amount` (what moved in *this* event) rather than `amount_paid` (a running total),
which is what stops the second instalment of a partial payment double-counting. Status is settled on
the amount rather than the provider's label.

`MockPaymentsAdapter` is a real adapter: it mints links, keeps a ledger, and emits **Razorpay-shaped
envelopes signed with a sandbox secret**, so the simulator's "simulate UPI success" produces bytes
that travel the identical verify → parse → reconcile path. A test asserts the real Razorpay verifier
accepts them.

The balance ladder is **two rungs, then a person** — enforced in the schema, in a database CHECK, and
in the service. This is someone who has already paid something and already has their vehicle; a
third automated chase is a debt-collection cadence. **38 tests**, including tampered-signature
rejection against both adapters.
Files: `packages/adapters/src/payments/{port,razorpay-adapter,mock-adapter}.ts`,
`packages/domain/src/delivery/payment-service.ts`.

### `[4.10] DONE — gate pass`
A signed, expiring token in a QR plus a six-character code, because a phone screen in the rain at
19:00 is not a reliable scanning target. **Only the hash is stored**: a database read cannot mint a
pass, which is the entire point of signing one.

The signature is checked *before* any row is read, so a gate being probed costs no queries; expiry is
checked *after* it, because reporting "expired" for an unsigned token would tell an attacker their
forgery parsed. A validly signed pass for another tenant answers the same as a forgery — confirming
it exists elsewhere would leak that another shop on the installation has that vehicle. Every
verification is audited, including failures: a forged code has no row to attach to, which is exactly
when the audit entry is the only record.

The code alphabet excludes 0/O, 1/I/L, 8/B and 5/S — the pairs a gate person mistypes.
Files: `packages/domain/src/delivery/{gate-pass-token,gate-pass-service}.ts`.

### `[4.x] DONE — Postgres stores, and migration 0004 against a real database`
`PgEtaStore`, `PgStatusSignalStore`, `PgCardResolver`, `PgSilentBayStore`, `PgStatusCommsStore`,
`PgDeliveryBookingStore`, `PgInvoiceStore`, `PgPaymentStore`, `PgGatePassStore` and
`PgGeneratedMediaWriter`, written against the in-memory doubles as their specification.

The idempotency the domain relies on comes from unique indexes rather than from careful callers, and
**59 integration tests against real Postgres prove each one**: a redelivered staff-group webhook
inserts nothing (`status_signals_message_key`), a webhook Razorpay retries credits once
(`payment_events_provider_key`), a second scan in the same window nudges nobody
(`silent_bay_nudges_card_window_key`), a second invoice for one visit is refused
(`invoices_job_card_key`). In every case the store returns **null** rather than throwing, so
"already happened" is a value the caller handles.

Five things worth naming:

1. **The ETA head is locked on `job_cards`, not on the history.** The card row carries
   `eta_version`, so locking it is what makes two simultaneous recalculations produce versions 4 and
   5 rather than two rows both claiming to be 4. Appending the entry and moving the card's
   denormalised `current_eta` is one write.
2. **The invoice sequence is allocated under a transaction-scoped advisory lock**, so the series is
   gapless even when two advisors issue in the same second. A tax series with a hole in it is a
   question an auditor asks, and "two requests raced" is not an answer.
3. **`findByProviderLinkIdAnyShop` resolves a webhook without a shop id**, because one webhook URL
   serves every tenant and the payload carries no shop of ours. The provider's link id is the only
   thing that says whose money it is, and the *row* decides the shop from that point on.
4. **The silent-bay scan takes `greatest(state_changed_at, newest signal, newest media)` in SQL.**
   A bay with a photograph in it from twenty minutes ago is plainly being worked in, and nudging
   about it is noise the staff group learns to ignore.
5. **`staff.full_name` is read as plain text.** Unlike `customers.full_name_encrypted`, a
   technician's name is the shop's own employment record rather than a data principal's PII, and the
   nudge names them to colleagues in a group they are already in.

**One real bug the integration suite caught:** `PgStatusSignalStore.insert` omitted `created_at`,
so Postgres substituted `now()` and silently ignored the clock the domain had passed. Every
fake-clock test — the silent-bay windows, the ETA history ordering — would have passed in memory and
behaved differently against SQL. The column is now written from the record.

**Migration 0004 was applied, rolled back and re-applied against the running Postgres.** The
rollback drops all nine tables, removes the three `job_cards` columns and narrows `agent_objective`
back to its three phase-3 values; `db:generate` then reports no drift. The schema smoke test's
table-count guard did its job again — 28 → 37 — and now inserts a real row in each of the nine new
tables.
Files: `packages/db/src/stores/{status-store,delivery-store}.ts`,
`packages/db/test/phase4-stores.test.ts`, `packages/db/test/schema.test.ts`.

### `[4.x] DONE — API and worker wiring`
`createLoopRuntime` is the phase-4 composition root, for the same reason
`createAgentRuntime` and `createChannelPorts` are: the API, the workers and the demo runner want the
identical set of services, and each assembling it by hand is how one ends up on the mock payments
adapter while another is on Razorpay. It lives in `agent-core` because it needs *adapter* ports — a
payments gateway, a PDF renderer, a status parser — and `packages/domain` deliberately sees none of
them.

**API** — a `LoopModule` holding four controllers, importing `MessagingModule` for one thing above
all: there is exactly one `OutboundGate` in the process, and two would be two opinions about whether
a message may leave.

- `StatusController` — the pending-signal queue, the ETA history, and the one tap that confirms or
  discards. `confirm` and `discard` are separate verbs rather than one endpoint with a boolean:
  they mean different things to "how often was the parser right?", and collapsing them makes that
  unanswerable.
- `DeliveryController` — ready-with-slots, invoice issue, payment link, and the counter-cash record.
  Every write is idempotent by construction rather than by the caller being careful, because these
  are the buttons an advisor double-taps when the counter is busy.
- `PaymentsWebhookController` — signature over raw bytes before any parse; **401 on a bad signature**
  so a forged delivery tells the provider to stop, **200 on everything else** so a verified delivery
  is never redelivered. `@Public()`, and that is not a hole: the signature *is* the authentication,
  and it proves the body came from the provider rather than merely that somebody is logged in.
- `GatePassController` — issue, verify, revoke. `verify` answers **200 whatever the verdict**: a
  rejected pass is the answer to the question the gate person asked, not an HTTP error, and turning
  it into a 4xx would show a stack trace where the screen should show a red light and a sentence.
  The owner override is refused for a non-owner *in the controller*, before the service is reached.

**Workers** — three event handlers and two polling sentinels.

- `eta-recalculate` finally consumes `eta.requested`, the hook phase 3 emitted with no consumer.
- `eta-comms` announces a change **only if the entry is still the newest**: the event carries the
  version, and a superseded entry would tell a customer a time that is no longer true.
- `state-comms` sends the ready message with pickup slots on `→ READY_FOR_DELIVERY`, and the handful
  of other transitions a customer can act on.
- `SilentBayScanner` and `ReminderSentinel` poll rather than using delayed jobs, for the reason the
  quiet-hours drain does: each depends on state that can change between scheduling and firing — a
  shop that shortens its hours, a customer who pays at the counter, a technician who finally sends a
  note. Reading the due set each pass means the current rules always apply.

`claimDueReminders` moved onto the services rather than the workers reaching into the stores: a
caller that can claim rows can also skip the rules, and the point of the service layer is that there
is one way in.

**Verified by boot, not by inspection.** The API's 33 integration tests pass with `LoopModule`
mounted — the first run failed with an unresolved `AGENT_RUNTIME`, because `MessagingModule` had not
exported it. The worker process was started against the seeded database and reported all six
handlers registered and all eight queues consumed.

Files: `packages/agent-core/src/loop-composition.ts`, `apps/api/src/loop/**`,
`apps/workers/src/{loop-wiring,sentinels}.ts`, `apps/workers/src/handlers/status-comms.ts`.

### One defect the worker boot found, in phase-1 code

**Concurrent audit-chain appends collided on `(shop_id, seq)`.** `AuditService.append` read the head
and computed `seq + 1` with no lock, relying on the unique index to let exactly one writer commit —
which is true, but means the loser raises a unique violation and whatever it was doing *fails*.

Phase 1 never hit it because a job-card transition already holds `SELECT … FOR UPDATE` on the card,
so two of them serialised anyway. Two appends about *different* subjects in the same shop have no
such lock, and phase 4 made that ordinary: the consumer runs at `WORKER_CONCURRENCY`, and an ETA
recalculation, a status announcement and an escalation rung all append while sitting on different
rows. Booting the worker against a seeded database produced the violation within a second.

Fixed with a transaction-scoped advisory lock keyed on the shop, taken in `append` before the head
is read — the same technique the phase-4 invoice sequence uses. The unique index stays as the
backstop: the lock means concurrent appends *queue* instead of failing, and the index means that
even a writer which did not take the lock could never claim a seq twice. The phase-1 concurrency
test still passes, because which transition wins is decided by the card lock and is untouched.

### `[4.11] DONE — the inbound join: a staff-group note becomes a status signal`
The seam phase 4 was missing. Every piece existed and was tested — the recogniser, the parser, the
routing service — and nothing called them in order from a real inbound message.

`TechnicianNoteIngestor` (in `agent-core`, because it needs a `SpeechPort`) transcribes, hints the
recogniser with **the registrations actually in the workshop today**, and carries the recogniser's
confidence into the parse. `InboundHandler` calls it through a `TechnicianNotePort` the domain
declares, so the handler still knows nothing about a speech provider.

The decision that took the most thought is the fork the staff group forces. That one lane carries
*"new Swift just came in"* and *"4432 brake pads done"*, and only the second may move an existing
job card. The rule is `noteIdentifiesAVehicle`: a plate fragment, a job-card code, or a reply to
that card's own message. A note that names nothing goes to intake and **nothing is written** — a
confirm queue that filled up with new arrivals could not answer the one question it exists to
answer. A note that names a plate the shop does not have open *is* recorded, as a `NO_CARD_MATCH`
signal, and then falls through to intake: a plate nobody is working on is exactly what a car
arriving for the first time looks like. Either way the transcript travels with the fall-through, so
a voice note is transcribed once however the fork goes — `IntakePipeline` gained an optional
`transcript` for that, and the draft's source stays `VOICE_NOTE` because that is how it arrived.

The two taps phase 4 had defined and nobody consumed are wired at the same seam: `parseStatusAction`
(✅/✏️ on a confirmation card, in the staff group) and `parseSlotAction` (the customer's pickup
choice). Both were exported, tested, and unreachable from an actual message before this.
Files: `packages/domain/src/messaging/{ports,inbound-handler}.ts`,
`packages/agent-core/src/technician-notes.ts`, `apps/api/src/messaging/messaging.module.ts`.

### `[4.x] DONE — console surfaces`
Three screens and one panel, each written for the person who opens it.

- **Promise & ETA**, in the card drawer. The history, not the current value: the question an advisor
  is actually answering on the phone is *"you said four o'clock"*, and only the history contains the
  four o'clock. Every row says whether the customer was told, because an ETA that slipped and was
  announced is a shop doing its job and one that slipped in silence is a complaint that has not
  arrived yet.
- **Status signals** (`/status`) — the confirm queue. The transcript is the headline, the reading
  sits under it as a sentence, and the answer is one tap. When the parser could not choose between
  two cards the tap *is* the choice: each candidate gets its own button, because "confirm" plus a
  separate car picker is two decisions where the advisor has one. The API's pending read was widened
  to carry the vehicle's registration — a queue that printed job-card uuids would be asking an
  advisor to go and look each one up.
- **Gate** (`/gate`) — a page of its own, because the person who opens it is not who the rest of the
  console is for. They are at a barrier with a car idling. One colour, one word, one sentence, and
  the vehicle so they can check the car in front of them is the one on the screen. Two ways in: a
  scan arrives as `?t=<token>` and checks itself on load; a typed code is the fallback for a cracked
  screen. Reachable by a technician as well, because whoever is nearest the gate at six o'clock is
  who checks the pass.
- **Delivery & payment**, in the card drawer: ready-with-slots, issue invoice, payment link, gate
  pass — the four buttons in the order the afternoon actually happens. Every one is idempotent on
  the server rather than by the caller being careful, because these are the buttons an advisor
  double-taps when the counter is busy.

Files: `apps/console/src/app/(app)/{status,gate}/page.tsx`,
`apps/console/src/components/{eta-history,status-signal-card,delivery-panel,gate-verify}.tsx`,
`packages/shared/src/contracts.ts`, `apps/console/test/e2e/loop.spec.ts`.

### `[4.x] DONE — the gate-pass QR`
The deliverable said "short code + QR encoding a signed, expiring token", and until now only the
code existed. `QrPngRenderer` (`qrcode-generator` + the `sharp` already in the package) renders the
token at error-correction level **Q**, as a **PNG** rather than the library's own GIF — a gate pass
is scanned outdoors, off a screen, at an angle, and WhatsApp's image message accepts JPEG and PNG,
so the GIF would have been refused at the channel *after* the pass was issued. The code still
travels in the caption: a customer whose phone will not display the picture must still be able to
read out six characters at the barrier. A render failure does not fail the pass — the pass is
already valid at that point, and letting a raster library decide whether somebody can collect their
car would be the tail wagging the dog.
Files: `packages/adapters/src/delivery/qr-renderer.ts`, `apps/console/src/lib/qr.ts`.

### `[4.x] DONE — `status_checker` persona`
The seventh persona, and the only one that decides nothing — which is the point. It asks where the
car is five ways ("is it ready?", "car ready aacha?", "kitna time aur lagega?"), each against a
different card state, and the sixth question asks for 20% off and must **leave** rather than be
improvised. Every answer is grounded in the card's live state and its ETA history and nothing else.

Two things the persona surfaced rather than asserted. Its questions are spread across two days
because the shop's daily cap is three outbound messages per customer and the approval request had
already used one of them — a persona that answered five questions inside an hour would have been
testing a shop that had turned its own frequency cap off. And each question records the customer's
inbound before the run, because the customer writing is what re-opens the 24-hour service window;
without that, day two's answers were correctly blocked and the persona was measuring the wrong
thing.
Files: `packages/simulator/src/personas/{personas,world}.ts`.

### `[4.x] DONE — `pnpm demo:phase4``
Nineteen steps, against the real database, and nothing is called directly that a message would have
called: the technician's note goes in through `SandboxWhatsAppAdapter` and comes out of
`InboundHandler`; the payment arrives as bytes with a signature and travels the same verify → parse
→ reconcile path a real delivery takes. The tampered-signature step and the paid step present the
*same bytes* — the only difference between "refused" and "applied" is the signature, which is the
property that matters.

The shop is configured through `GuardrailService`, not by writing JSON, and the original document is
restored on teardown. The plate's last four digits are random per run: a fixed suffix means the
second run finds two open cards ending in the same digits and the resolver correctly refuses to
guess between them, and a demo that fails for the right reason is still a demo that fails.
Files: `packages/simulator/src/scenarios/phase4-demo.ts`.

### `[4.x] DONE — the phase-4 services under test, and the coverage gate back to green`
The doubles were built and never used. `in-memory-delivery.ts` shipped an `InMemoryPaymentStore`,
an `InMemoryGatePassStore`, a `StubInvoiceRenderer` and a `StubPaymentGateway`, and nothing in the
suite drove a single one of them: the phase-4 *services* were proved by `demo:phase4` against
Postgres and by their pure functions in isolation, with the classes in between untested. Domain
coverage had fallen to **63.6%** against the master's 80% gate, which CI's `static` job enforces —
so the repository's own acceptance criterion was red while the phase reported itself done.

`createLoopHarness` is the seam: every phase-4 service wired to the in-memory doubles on a fake
clock, because half of what these services decide is *when* — whether a slip is material, whether a
bay has been quiet for three working hours, whether a reminder rung is due. Two suites drive it:

- **`status-services.test.ts`** — a note at 0.92 moves the card and audits it; one at 0.6 asks the
  staff group and moves nothing; assignment settles a fragment two cars answer to and *fails* to
  settle one where both are the technician's; a redelivered webhook closes nothing twice; `done` on
  a card that cannot move is recorded and skipped rather than forced; the ETA engine's versions,
  materiality and refusal to time a delivered car; the batching path marking an entry notified
  without sending; one silent-bay nudge per window, and none for a bay that is *supposed* to be
  sitting still.
- **`delivery-services.test.ts`** — ready refuses a second offer; the customer's second tap does not
  move the appointment out from under them; the invoice refuses without a registered name and
  returns the same number on a second press; CGST/SGST intra-state and IGST across a state line; one
  payment link however often the button is pressed; a retried webhook credits nothing; a part
  payment leaves the balance owing; cash at the counter settles the card; the ladder stops after two
  rungs and raises a person; and a gate pass that is refused with money outstanding, released on a
  recorded override, opens the barrier once, and is refused when forged, expired or revoked.

Domain coverage is now **88.7% statements, 87.9% functions, 78.2% branches** — 584 tests, up from
541.
Files: `packages/domain/src/testing/loop-harness.ts`,
`packages/domain/src/status/status-services.test.ts`,
`packages/domain/src/delivery/delivery-services.test.ts`.

### Three defects the demo and the suites found

**A fully paid card was left in `AWAITING_PAYMENT`.** `settleCard` tried `PAYMENT_SETTLED` then
`PAYMENT_REQUESTED` and returned after the first that worked. From `READY_FOR_DELIVERY` — the
ordinary case, where the shop created a link and the customer paid it in one go — only
`PAYMENT_REQUESTED` was legal, so the card stopped in the one state that means *"this shop is still
owed money"*, and the balance ladder would eventually have chased a customer who had already paid.
Now it reads the card's state and walks both events, and leaves a `DELIVERED` card alone.

**`payments.created_at` was left to `defaultNow()`.** The same defect deviation 61 corrected in the
status-signal store, in the one table where it decides customer-facing behaviour: the balance ladder
reads `coalesce(last_reminder_at, created_at)` to decide when the next gentle rung is due, so a
store substituting its own clock silently ignored the one the domain passed. Found by a store test
that had been passing on the date it was written and rotted two weeks later.
`delivery_bookings.created_at` had the same shape and was fixed with it.

**A demo thread key carried a phone number.** `external_thread_id` is what the router looks a thread
up by, and it takes the blind index, not the number. Writing the raw number both leaked PII into a
plaintext column and made the row the router created on the customer's first tap a *second* thread
for the same person — which is how the demo's ready message and the customer's slot choice ended up
on different conversations.

### Verification run (2026-08-31)

| Suite | Result |
|---|---|
| `packages/shared` | 37 passed |
| `packages/config` | 19 passed |
| `packages/domain` | 584 passed (52 new: the staff-group fork, the two taps, and the phase-4 services) |
| `packages/domain` coverage | **88.7% statements · 87.9% functions · 78.2% branches** — gate green |
| `packages/adapters` | 350 passed · 2 skipped |
| `packages/agent-core` | 68 passed (7 new: the note ingestor) |
| `packages/simulator` | 28 passed |
| `packages/db` integration | 91 passed |
| `apps/api` integration | 33 passed (with the `MessagingModule` ↔ `LoopModule` cycle wired) |
| `apps/workers` integration | 6 passed |
| worker boot | 6 handlers registered · 8 queues consumed · 0 audit collisions |
| `pnpm sim` | 7/7 personas |
| `pnpm demo:phase1` | 15/15 steps |
| `pnpm demo:phase2` | 16/16 steps |
| `pnpm demo:phase3` | 15/15 steps |
| `pnpm demo:phase4` | **19/19 steps** |
| `apps/console` Playwright | 45 passed · 6 failed (all phase-3 `review.spec.ts`; see below) |
| migration 0004 | `db:generate` reports no drift |
| `pnpm typecheck` | 16/16 packages clean |
| `pnpm lint` | 16/16 packages clean |
| `no-bypass.test.ts` | green — every phase-4 send goes through `OutboundGate` |

### Verification run (2026-08-17)

| Suite | Result |
|---|---|
| `packages/shared` | 37 passed |
| `packages/config` | 19 passed |
| `packages/domain` | 532 passed (67 new status, 37 new delivery) |
| `packages/adapters` | 350 passed · 2 skipped (53 speech, 69 status, 38 payments, 14 PDF) |
| `packages/agent-core` | 61 passed |
| `packages/simulator` | 27 passed |
| `packages/db` integration | 91 passed (59 new phase-4 store tests) |
| `apps/api` integration | 33 passed (with `LoopModule` mounted) |
| worker boot | 6 handlers registered · 8 queues consumed · 0 audit collisions |
| `pnpm sim` | 6/6 personas |
| `pnpm demo:phase1` | 15/15 steps |
| `pnpm demo:phase2` | 16/16 steps |
| `pnpm demo:phase3` | 15/15 steps |
| migration 0004 up → down → up | clean; `db:generate` reports no drift |
| `pnpm typecheck` | 16/16 packages clean |
| `pnpm lint` | 16/16 packages clean |
| `no-bypass.test.ts` | green — every phase-4 send goes through `OutboundGate` |

---

## Phase 4 Acceptance Gate — current state

- [x] **Voice-note fixture (Tamil-English) → correct state transition + proactive customer update,
      fully automatic at ≥ 0.85 confidence; low-confidence path asks the advisor.**
      `demo:phase4` step 05: *"caliper open irukku 4432, part varum 4 maniku"* arrives as audio in
      the staff group, is transcribed, parsed at 91%, matched to the card by the four digits the
      technician actually said, and applied — `IN_PROGRESS → AWAITING_PARTS` — with no human
      involved. Step 07 sends the same words through a recogniser that only managed 62%, and the
      signal lands in the confirm queue instead; step 08 is the advisor's one tap closing the work
      item.
- [x] **Material ETA slip generates an immediate, reasoned delay message; immaterial changes
      batch.** Step 06: the parts block is classified `MATERIAL_SLIP` and the customer is told,
      with the reason, before they ask. The immaterial path is table-tested in
      `packages/domain/src/status/status.test.ts` and marks the entry notified without sending.
- [x] **`status_checker` persona answered correctly at any state; out-of-scope probes routed, not
      improvised.** `pnpm sim` — five questions across `IN_PROGRESS`, `AWAITING_PARTS` and
      `QUALITY_CHECK`, each answer anchored to the card state or an ETA entry, and the discount
      probe hands off without a word to the customer.
- [x] **Ready → slot choice → invoice PDF → mock UPI payment → gate pass verified, as one
      continuous sandbox demo.** `demo:phase4` steps 10–18, in one run: three slots offered inside
      the shop's hours, the customer's tap booked once (tapped twice on purpose), an invoice with
      GST split intra-state and the caliper photograph in its appendix, a payment link re-used
      rather than duplicated, a signed webhook applied once, and a gate pass that opens the barrier
      exactly once.
- [x] **Payment webhooks signature-verified; reconcile idempotent; partial payments handled
      gently.** Steps 14 and 15 present the same bytes with a broken and an intact signature; the
      redelivery is asserted as a duplicate. The two-rung ladder and its refusal to go further are
      in `packages/domain/src/delivery/delivery.test.ts` and enforced by a CHECK constraint.
- [x] **`pnpm demo:phase4` runs the full middle-and-end loop.** 19/19, re-runnable.
- [ ] **Tag `phase-4-complete`.** Ready to create — every checkbox above passes. Not created,
      because a git tag is the user's call rather than something to do unasked.

## Resolved — the six red Playwright tests (was: the review-spec seed issue)

**Fixed. The console suite is 50/50 green.**

`apps/console/test/e2e/review.spec.ts` asks the sandbox to draft a fresh approval request three
times, and runs in two projects, so six drafts. `findApprovableCard` had exactly one card to choose
from — the seed put one card in `AWAITING_APPROVAL` — so every draft targeted the same customer.
The first send left the next refused by `MIN_INTERVAL_NOT_ELAPSED`: the shop requires sixty minutes
between messages to one customer, and four seconds had passed. That was the frequency cap working
exactly as designed, on a suite written as though it were not there.

Three changes, none of which touch the gate:

- **The seed holds six cars waiting on a decision, not one** (`packages/db/src/seed/fixtures.ts`).
  Fifteen cards and fifteen customers now, with three customers and five `AWAITING_APPROVAL` cards
  added. This is the realistic shape as well as the working one: the queue of customers who have
  been quoted and have not answered is the biggest pile in a workshop with nobody chasing it, and
  it is the pile this product exists to drain. A demo shop whose approval column was thinner than
  its delivery column showed the problem solved before the tour started. Each card belongs to its
  own customer, because a car cannot wait on two decisions.
- **The picker rotates** (`apps/api/src/messaging/sandbox.controller.ts`). `findApprovableCard`
  orders by the customer left alone longest and will not offer one inside the shop's own minimum
  interval — read from shop config, not assumed. Its "nothing found" answer now distinguishes *no
  card awaits approval* from *six do, and all six were written to in the last hour*, which is the
  difference between an empty queue and a full one you may not touch yet.
- **The spec reads the thread it wrote to** (`apps/console/test/e2e/review.spec.ts`). It asserted
  the edited text was visible somewhere on `/conversations` after clicking the first thread in the
  list; with several customers in play that matched a different customer's preview. It now
  navigates by the conversation id the route returns — which the route now returns, since the
  caller asks for "a card" and *which* customer that turned out to be is the route's answer rather
  than its input — and asserts on that thread, with a per-run signature in the edit.

`apps/api/test/api.test.ts` counted the board against a hardcoded `10`; it counts
`DEMO_JOB_CARDS.length` now, so the seed can change shape without a test needing to be told.

**The limit that remains, stated rather than papered over.** The suite gets one clean run per hour
per database: six drafts across six customers, four of which send. A rejected draft never sends, so
it leaves its customer writable and two candidates survive a full run — enough for a CI retry. A
second full run inside the hour needs `pnpm db:seed --reset` (five seconds, and already the
documented way to get a clean shop); CI always starts from a fresh seed. When the wall is hit the
route now says so in words instead of returning an opaque `BLOCKED`. The alternative — a seed with
enough cars to absorb repeated runs — would be a demo shop whose board exists to feed a test suite,
and would still only move the wall rather than remove it.

Verified on a freshly reset seed: `pnpm typecheck`, `pnpm lint`, `pnpm test` (16/16 tasks,
`api.test.ts` 33/33), the full Playwright suite 50/50, and `demo:phase1` 15/15, `demo:phase2`
16/16, `demo:phase3` 15/15, `demo:phase4` 19/19.

---

## Decisions & deviations — Phase 4

45. **`OutboundGate` gained a `templated` flag, and the agent cannot set it.** Master §6 defines L1
    as auto-send for "low-risk templated messages (status updates, ready alerts)", but until phase 4
    the gate read "templated" as "a Meta-approved template". Those two cannot both hold for a
    proactive status update sent inside the 24-hour window: it is free-form to WhatsApp and fully
    templated as far as *risk* is concerned. Without the distinction the phase's own requirement is
    unsatisfiable. The flag is ignored when `createdByAgent` is set, which is the case that matters —
    `send_customer_message` cannot assert its own prose is templated and talk its way from L1 into
    auto-sending free text.
46. **Proactive status comms compose from the i18n catalogue, not through `compose_customer_message`.**
    The phase asks for both that *and* L1 auto-send, and a message a model wrote is free-form by
    definition, which is L2. Taking the conservative reading (§10): the copy is built from the
    reviewed catalogue in the customer's language and the **anchoring** half of the post-checker still
    runs over claims declared against the ETA entry and the card state. The judge layer does not,
    because the risk it exists to catch is a model inventing a claim and no model wrote this. Inbound
    status *answers* do go through the agent and the full checker — that is `answer_status` (4.5).
47. **`EvidenceRef` gained `JOB_CARD_STATE` and `ETA`.** A status answer's facts are the card's live
    state and its ETA history, and neither is in an evidence bundle. Without them every status reply
    would be blocked by claim anchoring. Both are records the system already holds, so citing them is
    citation rather than invention.
48. **`agent_objective` was widened by *recreating* the type, not `ALTER TYPE … ADD VALUE`.**
    Postgres cannot remove an enum value, so drizzle-kit's generated `ADD VALUE` would have made
    migration 0004 one-way and broken "every migration reversible" (§8). Phase 3 dodged the same
    problem by adding a column (deviation 30); here a fourth objective genuinely is a fourth value of
    the same thing. The down migration **refuses** while any `agent_runs` row pursued
    `answer_status`, rather than silently re-labelling it — phase-4 data is expendable on a phase-4
    rollback, and an `agent_runs` row is phase-3 data that phase 4 merely widened.
49. **`BundleLine` gained `kind` and `taxRateBp`.** The ETA engine needs the line kind for its
    per-kind fallback and the invoice needs both for HSN/SAC and tax. Before phase 4 this was
    information the estimate had and the bundle threw away.
50. **`AUTO_APPLY_CONFIDENCE` is a constant, not shop configuration.** It is the line between "the
    system changed a customer's job card because it was sure" and "a human looked". A shop lowering
    it to reduce taps would be trading its customers' accuracy for its own convenience, which is
    exactly the guardrail weakening §10 forbids. A shop that finds the confirmations tiresome should
    fix the audio.
51. **Sarvam receives no vocabulary hints, and says so.** Its synchronous endpoint has no
    vocabulary-boost parameter — the current API takes file, model, language_code, mode,
    with_timestamps and input_audio_codec. Inventing a field would be ignored or rejected, and
    silently dropping the hints is how a caller comes to believe plate vocabulary is being applied
    when it is not. Google's adapter does support them, so a shop that depends on boosting
    registrations should run the fallback as primary and accept the code-mixing trade.
52. **An unlabelled Sarvam transcript scores 0.8, deliberately below the auto-apply bar.** The
    provider reports how sure it is of the *language*, not of the words; using that as transcript
    confidence would be a category error. 0.8 means an unlabelled transcript asks a human rather than
    moving a job card.
53. **The status parser multiplies the recogniser's confidence into its own.** A transcript the
    recogniser was 60% sure of cannot produce a 90%-sure signal. Blunt, and the right kind of blunt:
    it can only ever make the system ask a human more often.
54. **A note that never identifies a vehicle loses confidence.** The parse can be certain what
    happened and have no idea what it happened to. Without the penalty, "clutch plate is out of
    stock" scored above the auto-apply bar on the strength of its verb alone.
55. **The invoice refuses to issue without a configured legal name.** A tax invoice printed with a
    placeholder — or with the trading name where the registered name belongs — is a document with a
    false statement on it, and the shop answers for it. The refusal names the missing field.
56. **A failed PDF render does not fail the invoice.** The invoice is a database record of what was
    billed; the PDF is a rendering of it. A shop whose renderer hiccuped should have an invoice it
    can re-render, not a job card stuck with no bill. The null `mediaId` is what the console shows as
    "regenerate".
57. **Razorpay's own customer notifications are switched off.** The shop's message about money has to
    pass consent, quiet hours and the frequency caps like every other outbound; a provider SMS would
    bypass all four.
58. **Provider events are identified by `(event, link, payment)`, because Razorpay has no
    per-delivery event id.** That triple is exactly what a retry repeats and what a genuinely new
    instalment does not — asserted both ways in the test suite.
59. **The gate-pass HMAC key is separate from `JWT_SECRET`.** A gate pass is a bearer capability a
    customer forwards to whoever collects the car; it must not be signed with the key that mints
    staff sessions, and rotating one must not invalidate the other.
60. **The stored gate-pass hash is keyed with a fixed label, not the signing secret.** The hash exists
    so a *used* pass can be recognised; keying it with the secret would mean rotating the secret
    invalidated the record of every pass ever issued, not just those still in circulation.

61. **`created_at` is written from the record, not left to `defaultNow()`.** Found by the store
    integration suite: `PgStatusSignalStore.insert` omitted the column, so Postgres substituted
    `now()` and silently ignored the clock the domain had passed. The domain owns the clock — that
    is what makes the fake-clock silent-bay and ETA suites mean anything — and a store that
    substitutes its own makes those tests pass in memory and behave differently against SQL.
62. **The card resolver narrows in SQL and decides in the domain.** `byRegistrationFragment` does a
    suffix match in the query to keep the scan bounded, then re-checks every candidate through
    `registrationMatches`, which owns the four-character floor. Two places agreeing is not
    duplication here: SQL narrows, the domain decides, and only the domain's answer is used.
63. **An `OFFERED` booking does not count against the per-bin cap.** It has put three times to a
    customer and reserved none of them; counting offers would make a shop look full because it was
    being helpful.

64. **`AuditService.append` now takes a per-shop advisory lock.** Phase 1 documented the unique
    `(shop_id, seq)` index as "the real serialisation point", which is true and was sufficient while
    every append sat behind a job-card row lock. Phase 4's consumer appends from several concurrent
    handlers about different subjects in one shop, at which point relying on the index alone means
    the loser of a race *fails* rather than queues. The lock is transaction-scoped, held only across
    the head read and the insert, and the index stays as the backstop. Found by booting the worker
    against a seeded database, not by a test — which is itself worth noting.
65. **`claimDueReminders` lives on the services, not the stores.** The worker asks
    `DeliveryService`/`PaymentService` for what is due rather than reaching into the store: a caller
    that can claim rows can also skip the rules, and the balance ladder's two-rung cap is exactly a
    rule a busy loop should not be able to walk around.
66. **The payments webhook is `@Public()`.** The signature is the authentication, and it is stronger
    than a session: it proves the body came from the provider rather than merely that somebody is
    logged in. The shop is then resolved from the payment row the provider's link id matches, never
    from anything in the payload.
67. **`gate-pass/verify` answers 200 for a rejected pass.** A red light is the answer to the question
    the gate person asked, not an HTTP error. A 4xx would render a stack trace on a phone at a
    barrier where the screen needs to show one word and one sentence.
68. **A staff-group note becomes a status signal only when it names a vehicle.** The staff group
    carries two kinds of note that sound alike — *"4432 brake pads done"* and *"new Swift just came
    in, AC not cooling"* — and only one of them may move an existing job card. Nothing in the words
    separates them reliably, so the system uses the one thing that does: a plate fragment, a
    job-card code, or a reply to that card's own message. Assignment-based resolution still works
    inside `resolveCard`, and is still what settles an ambiguous plate; what it may not do is *open*
    the status lane from a group where intake also lives. The cost is one advisor tap that would
    otherwise have been offered — and it is only that, because a note naming no vehicle can never
    reach the auto-apply bar anyway: the parser docks it for exactly that (deviation 54). The
    instruction to technicians is one sentence: say the last four digits, or reply to the car's
    message.
69. **A `NO_CARD_MATCH` signal is written and *then* intake runs.** The two outcomes of the fork are
    deliberately asymmetric. A note that named nothing leaves no row at all, because a confirm queue
    that filled up with new arrivals could not answer "how often was the parser right?". A note that
    named a plate the shop does not have open leaves a row — the parse was a genuine attempt and
    belongs in the denominator — and then opens a draft, because a plate nobody is working on is
    exactly what a car arriving for the first time looks like.
70. **`IntakePipeline` accepts a transcript the caller already has.** The status sentinel reads every
    staff voice note before intake sees it. Transcribing the same five seconds a second time on the
    fall-through would cost the shop another provider call and the technician another wait, and the
    two would eventually disagree about what was said. The draft's `source` stays `VOICE_NOTE`,
    because that is how it arrived and that is what the on-ramp report counts.
71. **`MessagingModule` and `LoopModule` import each other through `forwardRef`.** Phase 4 made the
    dependency mutual and the honest thing is to say so: `LoopModule` needs the one `OutboundGate`
    that lives in messaging, and `InboundHandler` needs the status sentinel that lives in the loop —
    because a technician's note *is* an inbound message and a status update *is* an outbound one.
    The value graph stays acyclic; only the module graph is circular, which is the case `forwardRef`
    exists for. The alternative was a second `StatusSignalService`, and two of those is two opinions
    about whether a job card may move.
72. **The gate-pass QR is a PNG at error-correction level Q, not the library's GIF.** Q recovers
    about a quarter of the symbol, which is the difference between one scan and asking a customer to
    wipe their screen while a queue forms behind them. PNG because WhatsApp's image message accepts
    JPEG and PNG: the GIF `qrcode-generator` produces natively would have been refused at the
    channel *after* the pass had been issued. `sharp` was already in `packages/adapters` for
    thumbnails, so the raster costs nothing new.
73. **The console renders the gate-pass QR from the token returned at issue, once.** There is no
    endpoint that could serve it afterwards, because only its hash was stored — which is what lets a
    *used* pass be recognised. Closing the drawer loses it, and that is the correct lifetime for a
    bearer capability that opens a barrier. The delivery summary deliberately returns the code and
    never the token.
74. **`status_checker` spreads its questions across two days.** Not scheduling convenience: the
    shop's daily cap is three outbound messages per customer and the approval request has already
    used one of today's. Five answers inside an hour would have required a shop with its frequency
    cap turned off, and a persona that has to disable a guardrail to pass is measuring the guardrail,
    not the agent. The persona also records the customer's inbound before each run, because the
    customer writing is what re-opens the 24-hour service window — without it, day two's answers were
    correctly blocked.
75. **`AUTO_APPLIED` is what a confirmed signal *returns*, while `CONFIRMED` is what it stores.** The
    row records that a human agreed, because that is the graduation question; the outcome reports
    what the signal did, which is the same thing it would have done on its own. Collapsing the two
    would erase the answer to "how often was the parser right without us".

76. **The seed's `AWAITING_APPROVAL` column is the biggest one on the board, on purpose.** It held
    one card, which was tidy and wrong: a shop with one car waiting on a decision does not need this
    product. Six is what a Wednesday looks like in a workshop where nobody has been chasing, and it
    is the pile every phase after this one is built to drain. That it also gives anything pulling
    from that queue a second customer to reach for is a consequence of the realistic shape, not the
    reason for it.
77. **The sandbox's approval-draft picker refuses a customer it may not write to, rather than
    letting the gate refuse the send.** Both end in "no draft", but only one of them can say why.
    `MIN_INTERVAL_NOT_ELAPSED` is the correct answer to "may I send this?" and a baffling answer to
    "give me something to review" — the operator asked for a card, and the shop has six. The picker
    answers the question that was actually asked, and names the constraint when it cannot. It reads
    the interval from shop config and filters on `sent_at`, which is exactly what `recentOutboundAt`
    feeds the cap, so the picker and the gate cannot come to different views about who has been
    written to. A message held for quiet hours has not been sent, and counts for neither.

---

## OPEN QUESTIONS — Phase 4

15. **Should `job_cards.promisedAt` ever be rewritten?** Currently never: it is what the customer was
    told at the counter, and the ETA history carries every change since. A shop that renegotiates a
    promise face-to-face has no way to record the new one. Conservative reading: the ETA history is
    the record, and `promisedAt` stays the original. Revisit if advisors find it obstructive.
16. **Phase 3's open question 13 is still open.** A superseded estimate does not cancel its open
    approval, and phase 4 now bills from the estimate — so a shop that re-prices mid-chase can quote
    one number and invoice another. `toBillableLines` reads whatever estimate the card carries at
    invoice time. The conservative fix is for the invoice to refuse when an approval is open against
    a superseded estimate; not implemented, because it needs a decision about what the shop should
    *do* at that point.
17. **Silent-bay windows are epoch-aligned, not shop-day-aligned.** In IST the buckets begin at 08:30,
    11:30, 14:30 — which is what makes two workers with skewed clocks agree, but means a window can
    straddle opening time. The dedupe property is exact; the reporting boundary is arbitrary. Only
    worth changing if owners find the digest confusing.
18. **A line is "additional work" when it has media attached.** That is a good proxy — work a
    technician photographed is work found after the vehicle arrived — but it is a proxy. A line
    approved through the phase-3 bundle flow should carry that fact explicitly, and
    `invoice_lines.approved_at` is currently always null because the approval row records item ids,
    not per-line timestamps. Joining through `approval_requests.approved_work_item_ids` is the fix.
19. **Can a proactive status update be a customer's first-ever message?** Today, no: the gate
    refuses any first contact that does not disclose the AI, and the phase-4 comms compose from the
    i18n catalogue without a disclosure preamble. In practice a customer whose card reaches an ETA
    slip has already been written to — the intake confirmation, the consent ask, the approval
    request — so the case is rare. But it is reachable, and when it happens the customer hears
    nothing and an advisor sees a `BLOCKED` row. The conservative behaviour is the current one; the
    fix is for the status, delivery, payment and gate-pass services to prefix the disclosure the way
    `InboundHandler.withDisclosure` does, which needs a `MessageStore` on four services that do not
    have one. `demo:phase4` opens the thread through `ConsentCaptureService` for exactly this reason,
    which is also what production does.
20. **Should the daily frequency cap exempt replies the way the minimum interval does?** A customer
    who asks four questions in an afternoon gets three answers and then silence, because
    `checkFrequencyCaps` applies `maxOutboundPerCustomerPerDay` to everything while `isReply` only
    exempts the minimum interval. Answering somebody is not pestering them. Left alone because
    exempting replies from the daily cap is also how an agent could talk its way past it, and that
    trade needs a decision rather than an implementation.
21. **The balance ladder's first rung falls outside the 24-hour window.** It is sent as free text a
    day after the payment link, and unless the customer has written since, the gate refuses it as
    `WINDOW_CLOSED_NEEDS_TEMPLATE` — while `recordReminder` still burns the rung. Two rungs later
    the ladder raises the advisor task, so the loop does end in a person and nobody is chased in
    silence; what does not happen is the gentle reminder the phase asked for. The fix is a
    re-engagement template per language, which is a Meta approval rather than a code change, so it
    is recorded rather than faked. `messaging.templates.reengagement` is where it would be
    configured, and it defaults to null.
