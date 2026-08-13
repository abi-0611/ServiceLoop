# SERVICELOOP — MASTER PROMPT (READ FIRST, LOAD IN EVERY SESSION)

You are building **ServiceLoop**: an AI service advisor for independent automotive workshops in India. It owns the customer follow-up loop — evidence-backed approval chasing, proactive status updates, delivery + payment, and declined-work recovery — over WhatsApp and voice, in Tamil/Hindi/English with code-switching, **on top of whatever system the garage already uses, including paper job cards**.

This file is the constitution. Seven phase files (`01`–`07`) contain the work. Rules of engagement:

1. **One phase per session.** Load this file + the current phase file. Never start a phase before the previous phase's Acceptance Gate is green.
2. **Maintain `PROGRESS.md`** at repo root: after every task, append `[phase.task] status — notes — files touched`. On session start, read it first and resume from the last incomplete task.
3. **Never leave stubs.** No `TODO`, no `throw new Error("not implemented")` in committed code. If a capability belongs to a later phase, implement the port interface now and a working sandbox adapter — not a stub.
4. **When provider docs are needed** (Meta Cloud API, Exotel, Sarvam, Razorpay), consult current official docs before wiring the real adapter; API surfaces drift. Sandbox adapters never require docs or credentials.
5. **Every phase ends with a runnable demo**: `pnpm demo:phase<N>` must execute the phase's acceptance scenario against the sandbox adapters and print a pass/fail summary.

---

## 1. Product non-negotiables (engineering laws)

These come from the product plan and are not open to reinterpretation during implementation:

- **L1 — Agent-first, not record-first.** The unit of value is a closed loop (approval obtained, status delivered, payment collected). The job-card record serves the conversation, never the reverse.
- **L2 — Zero-migration intake.** A photographed paper job card must be a first-class, fully supported entry point forever. No feature may assume structured upstream software exists.
- **L3 — Escalation ladders close, they don't notify.** Every customer-facing objective ships with a cadence (message → reminder → voice call → human handoff) and is measured in time-to-decision, not messages-sent.
- **L4 — Language-native.** Tamil, Hindi, English, and their code-switched registers are launch languages across chat and voice. Language handling is core architecture, not localisation.
- **L5 — Guardrails are architectural.** The agent acts only through typed tools. Price floors, claim-anchoring, disclosure, and consent are enforced in the tool layer and post-checkers — never solely in prompts.
- **L6 — Human handoff is always one step away.** Every automated flow has a reachable, context-rich path to the human advisor.
- **L7 — Evidence or silence.** Any customer-visible claim about vehicle condition, urgency, or price must trace to a technician note, a media asset, or an estimate line. Untraceable claims are blocked.

## 2. Pinned technology stack

Do not substitute without an explicit note in `PROGRESS.md` explaining why.

| Concern | Choice | Rationale |
|---|---|---|
| Language / runtime | TypeScript 5.x strict, Node 22 LTS | One language across API, workers, agents, console |
| Monorepo | pnpm workspaces + Turborepo | Task caching, clean package boundaries |
| API framework | NestJS 11 (REST + webhooks) | DI, modules, testability at production scale |
| Validation | Zod everywhere (env, DTOs, tool args, shop config) | Single schema language |
| Database | PostgreSQL 16 + Drizzle ORM (drizzle-kit migrations) | Type-safe SQL-first; explicit migrations |
| Jobs / timers | BullMQ on Redis 7 | Delayed jobs are the escalation-ladder backbone |
| Reliability pattern | Transactional outbox → BullMQ dispatcher | No dual-write bugs between DB and queue |
| Object storage | StoragePort → MinIO (dev) / GCS (prod) | S3-compatible in dev, native GCS in prod |
| Console | Next.js 15 App Router + Tailwind + shadcn/ui | Owner/advisor console, HITL queue, sandbox simulator, softphone |
| Agent runtime | Custom, in `packages/agent-core` | Deterministic outer loop + typed tools beats framework magic; guardrails demand it |
| LLM | LlmPort → Anthropic Claude (default; latest Sonnet-class for agents, Haiku-class for classifiers), model IDs in config | Pluggable by design |
| OCR / vision | Vision-capable LLM via LlmPort | Paper job-card extraction |
| Speech | SpeechPort → Sarvam (Saaras STT streaming + batch, Bulbul TTS; code-mix native, India data residency) / Google Cloud Speech fallback / MockSpeech | Verified current as of July 2026 |
| Telephony | TelephonyPort → Exotel (primary, India) / Twilio (alt) / BrowserLoopback sandbox | Softphone-in-console enables credential-free voice dev |
| WhatsApp | WhatsAppPort → Meta Cloud API / SandboxWhatsApp (simulator UI in console) | Build everything before Meta verification exists |
| Payments | PaymentsPort → Razorpay Payment Links / MockPayments | UPI links + webhook reconcile |
| PDF | @react-pdf/renderer (server-side, no headless browser) | Invoices + evidence appendix |
| Tests | Vitest, Testcontainers (PG/Redis), Playwright (console), k6 (load) | Full pyramid |
| Observability | pino (PII-redacting serializers), OpenTelemetry, prom-client | Wired from Phase 1, hardened in Phase 7 |
| CI | GitHub Actions | lint → typecheck → test → build → sim suite |
| Deploy target | Docker multi-stage → GCP Cloud Run + Cloud SQL + Memorystore + GCS | Staging + prod |

## 3. Monorepo layout (create exactly this in Phase 1)

```
serviceloop/
  apps/
    api/            # NestJS: webhooks, REST, auth
    workers/        # BullMQ processors: outbox, escalations, digests, reminders
    console/        # Next.js: board, inbox, HITL queue, settings, sandbox sim, softphone
  packages/
    domain/         # pure TS: entities, state machines, guardrail engine, policies
    db/             # drizzle schema, migrations, repositories
    agent-core/     # runtime, tool registry, prompt assembly, post-checkers
    adapters/       # whatsapp/ telephony/ speech/ payments/ storage/ llm/ sms/
    simulator/      # customer personas + conversation sim runner (used in CI)
    shared/         # zod schemas, types, i18n strings, utils
    config/         # env schema, shop-config schema, DEMO_MODE wiring
  infra/            # docker/, compose.yaml, deploy scripts, k6/
  docs/             # runbooks, go-live checklist, operator manual (Phase 7)
  PROGRESS.md
```

## 4. Domain model & glossary (canonical names — use verbatim)

**Shop** (a workshop; owns config/guardrails, price list KB, staff) · **Staff** (roles: OWNER, ADVISOR, TECHNICIAN) · **Customer** · **Vehicle** (keyed by normalised Indian registration number, incl. BH series) · **JobCard** (one service visit) · **WorkItem** (a line of work on a JobCard) · **Estimate / EstimateLine** (versioned; approved amounts immutable once accepted) · **MediaAsset** (photo/video/audio in object storage, linked to WorkItems) · **EvidenceBundle** (composed artifact: media + itemised lines + plain-language explanation) · **ApprovalRequest** (objective with a ladder and a decision) · **EscalationLadder** (config: rung timings, channels, quiet hours) · **ConversationSession** (per customer-channel thread; tracks WhatsApp 24h window) · **Consent** (per customer, per purpose: SERVICE, MARKETING; with timestamps and channel) · **DeclinedWorkLedger** (deferred/declined items + follow-up horizon + trigger tags) · **OwnerDigest** · **AuditEvent** (append-only, hash-chained).

### JobCard state machine (single source of truth; implement once in `packages/domain`)

```
DRAFT → OPEN → IN_DIAGNOSIS → AWAITING_APPROVAL ⇄ IN_PROGRESS → AWAITING_PARTS
   → IN_PROGRESS → QUALITY_CHECK → READY_FOR_DELIVERY → AWAITING_PAYMENT
   → DELIVERED → CLOSED          (CANCELLED reachable from any pre-DELIVERED state)
```
Rules: transitions only via `JobCardTransitionService`, which — in one DB transaction — validates the guard, writes the new state, appends the AuditEvent, and inserts outbox events. `AWAITING_PAYMENT` ordering (before/after delivery) is shop-configurable. Multiple WorkItems may hold different sub-states while the JobCard reflects the dominant blocking state.

### WorkItem states
`PROPOSED → PENDING_APPROVAL → { APPROVED | DECLINED | DEFERRED } → IN_PROGRESS → DONE`. DECLINED and DEFERRED write to the DeclinedWorkLedger with reason and horizon.

## 5. Ports & adapters doctrine + DEMO_MODE

Every external dependency is accessed **only** through a port interface in `packages/adapters/<concern>/port.ts`. Each port ships ≥2 adapters: one real, one sandbox. Sandbox adapters are production-quality code (typed, tested, deterministic where possible) — they are the development and demo backbone, not throwaways.

`DEMO_MODE=true` (env) forces all sandbox adapters, seeds the demo shop, and enables the console's **Sandbox Simulator** (act as any customer or technician over a fake WhatsApp) and **Browser Softphone** (Phase 5). CI runs entirely in DEMO_MODE. Real adapters activate per-provider via presence of credentials, validated by the zod env schema at boot with explicit log lines stating which adapter is live.

## 6. Autonomy levels & guardrails doctrine

Per-flow autonomy, stored in shop config, enforced in `send_customer_message` tooling:
- **L0 SHADOW** — agent drafts; every send requires HITL approval in console. All new shops start here for all flows.
- **L1 TEMPLATED** — auto-send for low-risk templated messages (status updates, ready alerts).
- **L2 CONVERSATIONAL** — auto conversational replies within guardrails; exceptions route to HITL.
- **L3 VOICE** — outbound/inbound voice autonomy (Phase 5+).

Hard guardrails (tool-layer, non-promptable): price floor and discount ceiling per shop (tool rejects violating offers); claim-anchoring post-checker (every factual claim must cite an evidence/estimate/technician-note ID, else the message is blocked to HITL); mandatory AI disclosure in first contact per session and at the top of every voice call; consent gate on all outbound (SERVICE vs MARKETING purpose tags); quiet hours; frequency caps; banned behaviours (invented diagnosis, invented urgency, medical/legal claims, promises of exact completion times beyond the ETA engine's output). Every agent step (prompt hash, tool calls, outputs, checker verdicts) lands in the audit log.

## 7. Compliance requirements (built, not bolted on)

- **DPDP Act 2023**: consent registry with purpose limitation; data-principal export and deletion workflows (Phase 7 completes; schema exists from Phase 1); India data residency for prod; PII field-level encryption (customer phone, name) at rest.
- **WhatsApp Business policy**: opt-in before business-initiated messages; respect the 24-hour customer-service window (session tracker is core, Phase 2); template category correctness; per-conversation cost metering; `STOP`-class opt-out keywords honoured instantly.
- **TRAI DLT**: SMS fallback only via registered templates; template IDs are config, never hardcoded.
- **Telephony**: recording-consent line and AI self-identification are non-removable parts of call scripts; recordings stored with retention policy.

## 8. Engineering conventions & global Definition of Done

Strict TS (`noUncheckedIndexedAccess` on); no `any` in `packages/domain` or `packages/agent-core`; ESLint + Prettier enforced in CI; conventional commits (`feat(scope): …`); every migration reversible; repository pattern over raw queries in app code; errors are typed (`Result`/domain error classes) at boundaries; idempotency keys on all webhook handlers and outbox consumers; i18n strings centralised in `packages/shared/i18n` (never inline customer-facing copy); feature flags via shop config.

**A task is DONE only when:** typecheck + lint clean · unit/integration tests written and green (domain coverage ≥ 80%) · seeded demo path still works (`pnpm demo:phase<N>` for all completed phases) · `PROGRESS.md` updated · no console errors in touched console pages.

**A phase is DONE only when:** every checkbox in its Acceptance Gate passes, demonstrated by the phase demo script, and a git tag `phase-<N>-complete` is created.

## 9. Phase index

| # | File | Delivers |
|---|---|---|
| 1 | `01_PHASE_FOUNDATION.md` | Monorepo, dev stack, schema, state machine, outbox, guardrail engine, audit log, auth, console shell, seed, CI |
| 2 | `02_PHASE_CHANNELS_INTAKE.md` | WhatsApp port + sandbox simulator, media pipeline, paper-card OCR intake, entity resolution, consent capture, inbox |
| 3 | `03_PHASE_AGENT_APPROVAL.md` | Agent runtime + tools, Approval Autopilot, escalation ladders, objection handling, HITL/shadow mode, conversation simulator |
| 4 | `04_PHASE_STATUS_DELIVERY_PAYMENTS.md` | Voice-note status parsing, ETA engine, proactive comms + deflection, invoices, UPI payments, gate pass |
| 5 | `05_PHASE_VOICE.md` | Telephony port + browser softphone, streaming STT/TTS, voice agent flows, DTMF, warm handoff |
| 6 | `06_PHASE_RETENTION_DIGEST_ANALYTICS.md` | Declined-work ledger + re-pitch, feedback/review routing, reminders, owner digest, metrics service |
| 7 | `07_PHASE_PRODUCTION_HARDENING.md` | Security, DPDP workflows, observability, load tests, GCP deployment, runbooks, go-live checklist, full-journey E2E |

## 10. Global don'ts

Don't bypass ports to call providers directly. Don't let any code path send a customer message without passing the consent gate, autonomy check, and post-checker. Don't invent business rules absent from these files — record the question in `PROGRESS.md` under `OPEN QUESTIONS` and choose the most conservative interpretation. Don't hardcode secrets, template IDs, model IDs, or prices. Don't weaken a guardrail to make a test pass. Don't skip the demo script.
