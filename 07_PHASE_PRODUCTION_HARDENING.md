# PHASE 7 — PRODUCTION HARDENING & DEPLOYMENT

**Load `00_MASTER_PROMPT.md` first. Phases 1–6 complete.**

## Objective
Everything between "it works in the sandbox" and "a real shop's customers depend on it": security hardening, the DPDP data-principal workflows, WhatsApp/DLT operational plumbing, observability and alerting, load and chaos verification, the GCP deployment with staging and prod, and the operational documentation a two-person team needs to run this — runbooks, incident playbooks, the shop-onboarding manual, and the go-live checklist that sequences every external registration.

## Deliverables
Security hardening pass · DPDP export/deletion workflows + privacy surfaces · WhatsApp template ops + cost metering + SMS/DLT fallback adapter · OTel + Prometheus + dashboards + alert rules with PII-safe logging · reliability drills (DLQ, backup/restore, graceful shutdown, chaos) · k6 load suite meeting targets · Docker + Cloud Run deploy (staging/prod) with CI/CD · `docs/` runbooks, playbooks, operator manual, go-live checklist · nightly full-journey E2E · `pnpm demo:phase7`.

---

## Tasks

### 7.1 Security hardening
**Build:** Helmet/CORS lockdown; per-route and per-shop rate limits (Redis); webhook signature verification audit across all providers (fail-closed); secrets exclusively via env in dev and GCP Secret Manager in prod (no secret ever in code, compose, or logs — add a gitleaks CI step); PII field-encryption finalised with documented key rotation procedure (dual-key decrypt window); RBAC matrix test (every endpoint × role); session hardening (refresh rotation reuse-detection); dependency scanning (`pnpm audit` + osv-scanner in CI, fail on high); SSRF guard on any URL-fetching path; upload antivirus hook point (ClamAV container in compose, port-abstracted).
**Verify:** Automated security test suite; gitleaks clean; a seeded reused-refresh-token attempt kills the session family.

### 7.2 DPDP data-principal workflows
**Build:** Console + API: **export** (customer's data as a ZIP: profile, cards, messages, media index, consents, invoices — generated async, delivered via expiring link) and **deletion** (verified request → cascade plan derived from the event/FK map: hard-delete PII and media, tombstone references so metrics and the audit chain stay intact via pseudonymised IDs; document the legal-retention carve-outs for invoices/GST records with retention clocks). Privacy notice templates (EN/TA/HI) in `docs/` + a `/privacy` page; grievance-contact config per the Act's expectations.
**Approach:** Deletion is a workflow with an approval step and a completion report, not a button — every cascade step audited (to the pseudonymised chain).
**Verify:** Deletion E2E on a seeded customer: PII unrecoverable (raw SQL probe), invoices retained with pseudonym, audit chain still verifies, metrics totals unchanged.

### 7.3 WhatsApp + SMS operational plumbing
**Build:** Template ops screen: catalog, submission status tracking, variable lint (mismatched placeholders fail CI), language variants coverage check (every customer-facing template must exist in EN/TA/HI). Per-conversation **cost metering** finalised: category + pricing table (config, updatable without deploy) → daily cost rollup per shop feeding margin analytics. `SmsPort` + DLT-compliant adapter (template IDs and header from config; consult current provider docs) as the fallback rung when WhatsApp is unreachable, wired into the OutboundGate channel-selection.
**Verify:** Template lint catches a broken fixture; simulated WhatsApp outage (adapter failure injection) falls back to SMS for a ladder rung and recovers.

### 7.4 Observability
**Build:** OpenTelemetry traces across webhook → domain → agent → adapter with conversation/card IDs as attributes; pino with **PII-redacting serializers** (phone, names, message bodies redacted at default level; sampled full-body debug behind a flag with TTL); prom-client metrics: queue depth/lag, outbox age, webhook failure rate, LLM error rate + p95 latency + cost/hour, STT/TTS latency stages, ladder-rung delays, OutboundGate blocks by reason. Grafana + Prometheus in compose with committed dashboards (JSON) for: system health, conversation funnel, cost, guardrails. Alert rules (Alertmanager or Cloud Monitoring in prod): outbox age > 60s, DLQ growth, webhook 5xx burst, LLM error > 5%, daily cost anomaly, audit-chain verify failure.
**Verify:** A traced sandbox conversation renders as one flame graph; log-redaction test proves no phone number in default logs; each alert rule fires on an injected condition.

### 7.5 Reliability drills
**Build/Run:** Graceful shutdown (drain BullMQ, finish in-flight calls with the apology path); DLQ replay tooling with operator confirmation; automated nightly `pg_dump` to GCS + **tested restore script** (restore into a scratch DB and run the demo suite against it); migration policy: expand-migrate-contract documented and linted (no destructive migration without a two-release window); chaos checks in CI-nightly: kill Redis mid-ladder, kill a worker mid-outbox-batch, LLM provider 100% failure for 5 minutes — assert no message loss, no duplicate customer sends, alerts fired.
**Verify:** Each drill scripted and green; restore-and-verify time < 30 minutes documented.

### 7.6 Performance & load
**Build:** k6 suites: (a) webhook burst — 200 inbound msgs/s for 60s, p95 ack < 500ms, zero drops; (b) 500 concurrent active conversations with agent runs (MockLlm with realistic latency injection) — ladder timing drift < 5s, queue lag recovers < 2 min; (c) console board with 5k cards — p95 route < 800ms. Index/N+1 audit with `EXPLAIN` on the top 10 queries; fix regressions.
**Verify:** Targets met in CI-nightly on a fixed-size runner; results archived to `docs/perf/`.

### 7.7 Deployment (GCP)
**Build:** Multi-stage Dockerfiles (distroless runtime) for `api`, `workers`, `console`; Cloud Run services (min-instances: api 1, workers 1; console can scale to zero) + Cloud SQL Postgres (private IP) + Memorystore Redis + GCS buckets + Secret Manager; two environments (`staging`, `prod`) via parameterised deploy scripts (or light Terraform if it stays under a day — scripts acceptable); CI/CD: merge to `main` → staging deploy + smoke suite + nightly jobs; manual promote to prod with migration gate. `DEMO_MODE` matrix documented: staging may run mixed real/sandbox adapters; prod requires explicit adapter allow-list at boot (loudly logged).
**Verify:** One-command staging deploy from a clean checkout; smoke suite (login, board, sandbox message round-trip, health/metrics endpoints) green; rollback procedure executed once as a drill.

### 7.8 Documentation set (`docs/`)
**Build:** **Runbook** (start/stop, scale, common alerts → actions); **incident playbooks**: WhatsApp outage, telco failure (kill switch + SMS), LLM provider down (queue-and-apologise mode), data-breach response steps incl. DPDP breach-notification duties; **operator manual — onboard a shop in 30 minutes**: WhatsApp-first script, config worksheet (price floors, hours, languages), shadow-mode explanation for the owner, graduation criteria; **go-live checklist** sequencing external dependencies with realistic lead times: Meta Business verification + WABA + number, template approvals, TRAI DLT entity/template registration, Exotel KYC + number, Razorpay activation, Sarvam/Google API keys (note Sarvam's startup credits program), GCP project/billing, privacy notice publication, recording-consent script sign-off.
**Verify:** A teammate (or a fresh Claude Code session given only `docs/`) can execute the staging deploy and the onboarding manual without asking questions — record gaps found and fix.

### 7.9 Full-journey E2E (the capstone)
**Build:** One nightly CI scenario in DEMO_MODE, fake clock, spanning the entire product: photo intake → confirm → technician evidence → approval bundle → price objection → concession within floor → approval → parts delay → proactive ETA message → inbound status voice call (loopback) answered → ready + slot → invoice PDF → mock UPI payment → gate pass → positive feedback → review link → declined item ledgered earlier resurfaces on trigger → converts → digest shows recovered ₹. Assert final state, guardrail compliance on every outbound, audit chain verification, and metric rollup correctness.
**Verify:** Green three consecutive nights before tagging.

---

## Acceptance Gate — Phase 7 (Go-live readiness)
- [ ] Security suite + gitleaks + dependency scan clean; RBAC matrix green; secrets only in Secret Manager.
- [ ] DPDP export and deletion workflows proven; audit chain survives deletion via pseudonymisation; retention carve-outs documented.
- [ ] Template lint, cost metering, and SMS fallback operational; WhatsApp-outage drill passes.
- [ ] Dashboards render; every alert rule fired in test; default logs PII-free.
- [ ] All reliability drills green, including restore-and-verify and the three chaos scenarios.
- [ ] k6 targets met; results archived.
- [ ] Staging deploy one-command; prod promote + rollback drills done; prod adapter allow-list enforced.
- [ ] Docs complete and independently executable; go-live checklist has an owner and date per item.
- [ ] Full-journey E2E green three consecutive nights.
- [ ] Tag `phase-7-complete` and `v1.0.0-rc1`.

## After this phase
The codebase is deployment-ready; go-live is executing the external-registrations checklist and flipping adapters per shop. First real shop runs at L0 shadow for every flow — exactly as the product plan's validation section prescribes.
