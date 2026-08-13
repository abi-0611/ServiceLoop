# PHASE 6 — RETENTION ENGINE, OWNER DIGEST & ANALYTICS

**Load `00_MASTER_PROMPT.md` first. Phases 1–5 complete.**

## Objective
Turn one-visit customers into recurring revenue and give the owner daily proof of value without a dashboard login: the declined-work ledger with contextual re-pitches, post-service feedback with review routing and service recovery, consent-gated reminders, the WhatsApp owner digest with one-tap actions, and the metrics service that computes every KPI the product plan promises.

## Deliverables
DeclinedWorkLedger lifecycle + trigger engine + re-pitch composer · feedback flow with sentiment routing (review link vs owner alert + recovery task) · service-due and document-expiry reminders (MARKETING consent machinery) · daily owner digest + realtime exception alerts · event-sourced metrics service + console analytics · win-back flow · `pnpm demo:phase6`.

---

## Tasks

### 6.1 Declined-work ledger lifecycle
**Build:** Ledger entries (created by Phase 3 decisions) carry: source card/lines, reason (`customer_deferred | customer_partial | price | distrust | other`), technician severity note ref, follow-up horizon (explicit customer promise, or defaults by category from shop KB: brake wear 60–90d, tyres 90d, cosmetic none), trigger tags (`next_visit`, `time_elapsed`, `season:monsoon`, `odometer:+3000` when customer-reported), status (`open → repitched(n) → converted | expired | opted_out`), and hard caps (max 2 re-pitches per item, min 21 days between any retention touches per customer).
**Verify:** Lifecycle state tests; caps enforced at the OutboundGate frequency layer, not just in composer logic.

### 6.2 Trigger engine
**Build:** Workers evaluating: **next-visit** (new JobCard OPEN for a vehicle with open ledger items → inject a "while it's here" prompt into the advisor's card drawer AND the approval flow context — the cheapest conversion moment), **time-elapsed** (horizon reached → schedule re-pitch), **season** (config calendar: monsoon window per region → items tagged `season:monsoon` like wipers/brakes/underbody), **odometer** (only from customer-volunteered readings — a light "how many km now?" ask piggybacks on other touchpoints, never standalone).
**Verify:** Fake-clock and seeded-scenario tests for each trigger; next-visit prompt appears in the card drawer within the demo.

### 6.3 Re-pitch composer (care-toned)
**Build:** Agent objective `repitch_declined_item`: message framed as continuity of care, referencing the original visit and evidence ("during April's service we'd flagged the rear brake pads — with the rains starting, good time to do it. Same price as quoted: ₹2,400"), price honoured from the original estimate unless shop KB prices changed (then say so plainly). Purpose tag: SERVICE when tied to a safety-relevant technician finding, MARKETING otherwise — the gate enforces the corresponding consent. One-tap responses: Book a slot / Remind me later (+30d, counts as a re-pitch) / Not interested (→ `opted_out`, item closed, audited).
**Verify:** Post-checker passes all composer outputs (claims anchored to the original evidence); MARKETING-tagged re-pitch to a customer without MARKETING consent is blocked; "Not interested" permanently silences that item.

### 6.4 Feedback + review routing + service recovery
**Build:** T+24–48h after DELIVERED (config): conversational feedback ask (1-tap 😊 😐 😞 + optional comment; voice note accepted and transcribed). Routing: positive → thank + Google-review deep link (shop's Place link in config) — ask once, never nag; neutral → thank + log; negative → **immediate** owner alert (realtime, not digest) + advisor recovery task with the transcript + a hold on all retention touches for that customer until the task closes.
**Verify:** All three routes in sandbox; negative feedback fires the alert within seconds and freezes retention touches; review ask is once-only per visit.

### 6.5 Reminders (service-due, documents)
**Build:** Service-due engine: next-service estimate from visit date + shop-default intervals (and odometer when known); reminder at T-7d and T-1d of the due window with booking slots. Document expiry (insurance, PUC) only when the customer has shared dates (an optional "want me to track your insurance/PUC renewal dates?" enrolment during delivery) — strictly MARKETING-consent-gated, single reminder per document per cycle.
**Verify:** Scheduling math tests; unenrolled customers never receive document reminders.

### 6.6 MARKETING consent machinery
**Build:** The explicit second ask (distinct from SERVICE consent), presented once at a natural moment (post-positive-feedback or delivery), with plain-language scope and instant opt-out honoured across all retention flows. Consent state changes audited with channel + message ref.
**Verify:** Full grant/revoke matrix against the OutboundGate; revocation mid-campaign halts scheduled touches.

### 6.7 Daily owner digest
**Build:** Evening WhatsApp brief (config time, default 20:30 IST), composed per language: vehicles in/out today · approvals pending > 2h (each with one-tap "I'll call" claiming the task) · ₹ approved today · ₹ recovered from previously declined work (the headline number) · feedback flags · silent bays. One-tap actions deep-link to console or trigger actions via button replies. Weekly edition (Sunday) adds trends. Owners with multiple shops get a consolidated + per-shop view.
**Approach:** Digest is assembled from the metrics service (6.9), not ad-hoc queries — one source of numeric truth.
**Verify:** Golden-content test on a seeded day of events: every number in the digest independently recomputed and matched; button actions round-trip in sandbox.

### 6.8 Realtime exception alerts
**Build:** Owner/advisor alert stream (WhatsApp, respecting quiet hours override config for critical items): approval stuck > 2h, negative feedback, payment failed twice, voice kill-switch activated, silent bay repeat. Dedup per incident.
**Verify:** Each trigger fires exactly once per incident in tests.

### 6.9 Metrics service + console analytics
**Build:** Event-sourced aggregation (consumes the standard envelope stream from all phases) into daily per-shop rollups: median + p90 approval turnaround · approval conversion rate (bundle→approved value %) · status-deflection proxy (customer status queries answered by agent ÷ total incl. handoffs) · on-time delivery vs promised/ETA · declined-work recovery rate (converted ₹ ÷ ledgered ₹, 90-day cohort) · repeat-visit rate (180d) · review velocity · agent containment + handoff quality (advisor thumbs on briefs) · guardrail flags (blocks, opt-outs, complaints). Console **Analytics** pages: shop overview, flow drill-downs, cohort comparisons; CSV export. Recompute job for backfills (idempotent over the event log).
**Approach:** Rollups are derivable-from-events by construction — a `recompute --from` command must reproduce identical numbers; this is the audit story for the "revenue recovered" claim the whole business rests on.
**Verify:** Property test: rollups equal a brute-force recomputation over a randomised event fixture; digest (6.7) and analytics pages read the same rollups.

### 6.10 Win-back
**Build:** Lapsed detection (no visit > shop-config months, default 8) → single MARKETING-gated win-back with a genuine hook (vehicle-age-appropriate check-up), max once per 6 months, opt-out honoured forever.
**Verify:** Cap and gating tests.

---

## Acceptance Gate — Phase 6
- [ ] A declined brake-pad item from a Phase 3 demo resurfaces on the season trigger, converts via one-tap booking, and shows up in "₹ recovered" — the full arc in one sandbox demo.
- [ ] Negative feedback → owner alerted in realtime, recovery task created, retention frozen for that customer; positive → single review ask.
- [ ] Every retention touch passes the OutboundGate purpose/consent/frequency checks; "Not interested" and revocation are permanent and instant.
- [ ] Digest numbers match independent recomputation on the golden day; one-tap actions work.
- [ ] Metrics recompute reproduces rollups exactly; analytics pages render all KPIs from the plan.
- [ ] `pnpm demo:phase6` simulates a compressed month (fake clock) and prints the digest + KPI summary; tag `phase-6-complete`.

## Handoff notes for Phase 7
Phase 7 needs: the consent registry complete (it is, after 6.6), the event log as the deletion-cascade map, and the metrics service as the health-signal source for alerting. Freeze schema changes except additive ones from here.
