# PHASE 4 — STATUS SENTINEL, DELIVERY & PAYMENTS

**Load `00_MASTER_PROMPT.md` first. Phases 1–3 complete.**

## Objective
Close the middle and end of the loop: passive status capture from technician voice notes in any language, an ETA engine that tells customers bad news early, inbound "where's my car?" deflection, and the delivery finale — pickup slots, evidence-backed invoice PDF, UPI payment, gate-pass QR.

## Deliverables
Real `SpeechPort` adapters (Sarvam batch STT primary, Google fallback, Mock retained) · voice-note → status parser with confidence routing · ETA engine + proactive comms policy · inbound deflection agent objective · silent-bay nudges · ready-for-delivery flow with pickup slots · invoice PDF with evidence appendix · `PaymentsPort` (Razorpay + Mock) with reconcile · gate-pass QR · optional technician PWA (stretch) · `pnpm demo:phase4`.

---

## Tasks

### 4.1 SpeechPort real adapters (batch)
**Build:** `SpeechPort.transcribe(audioRef, hints)` → `{text, languageTags, segments[], confidence}`. `SarvamSpeechAdapter` (consult current Sarvam STT docs; request word timestamps + language tags; it handles code-mixed 8kHz audio natively) and `GoogleSpeechAdapter` fallback selected by config/failure policy (2 consecutive provider failures → fallback + alert). Keep `MockSpeechAdapter` (fixtures) as the CI default.
**Verify:** Contract tests across all three; live tests behind `LIVE_STT_TEST=1` with 5 recorded fixture audios (Tamil-English, Hindi-English, noisy).

### 4.2 Technician status parser
**Build:** Staff-group voice note or photo referencing a card → transcript → EXTRACT-class LLM parse into `StatusSignal`: `{cardRef, workItemRefs?, signalType: progress|blocked_parts|done|issue_found, etaHint?, confidence}`. Routing: confidence ≥ 0.85 and unambiguous card match → auto-apply via domain transitions; otherwise → one-tap advisor confirm card in console/WhatsApp ("Did Suresh mean: brake pads DONE on TN09BX4432? ✅/✏️"). `issue_found` signals route into the Phase 3 evidence-bundle flow rather than status.
**Approach:** The bar for technicians is a 5-second voice note (master L2 spirit): never require IDs — resolve card by recent assignment, registration fragment, or reply-context, and when two cards match, ask, don't guess.
**Verify:** 15 transcript fixtures incl. "caliper open irukku, part varum 4 maniku" style; ambiguity fixture produces a disambiguation ask; auto-apply writes correct transitions + audit.

### 4.3 ETA engine
**Build:** `EtaService`: each card holds `promisedAt` (from intake) and `currentEta` with a versioned history. Recalc triggers: work approved (+ per-line labour-time defaults from shop KB), `blocked_parts` (+ parts lead-time default or technician `etaHint`), technician `done` signals (pull earlier if ahead). Policy output: `EtaChange{old, new, reason, materiality}` — material slips (> 45 min or crossing the promised day) must generate a proactive customer message; immaterial ones batch into the next natural touchpoint.
**Approach:** Deterministic and explainable — a rules table, not an ML guess; every ETA message states the reason ("brake caliper part arrives by 4pm").
**Verify:** Table-driven recalc tests; materiality thresholds honoured; ETA history renders in the card drawer.

### 4.4 Proactive status comms
**Build:** Event-driven notifications on state transitions and material ETA changes, composed per language via the agent's `compose_customer_message` (so post-checker applies) at autonomy L1 when granted (templated class). Dedup/throttle: one coalesced update per card per 2h max except approvals/ready/delay events. Bad-news-early rule: `blocked_parts` triggers immediate delay notice with new ETA + apology framing from i18n.
**Verify:** Sandbox timeline for a full card shows correct, non-spammy sequence; a rapid burst of technician signals coalesces.

### 4.5 Inbound deflection ("where's my car?")
**Build:** Agent objective `answer_status` on customer threads: strict grounding — answers only from live card state, ETA history, and estimate; anything outside (new complaints, price negotiation on unapproved items, complaints about staff) routes to the right objective or handoff. Works any hour; quiet hours apply to outbound initiations, not replies.
**Verify:** Simulator persona `status_checker` asks five variants (incl. "car ready aacha?", "kitna time aur lagega?") and gets state-correct answers; an out-of-scope probe ("give 20% discount") produces the honest refusal path from Phase 3.

### 4.6 Silent-bay nudge
**Build:** Worker scan: cards in active states with no signal > N hours (config, default 3 working hours) → staff-group nudge listing silent cards; repeated silence surfaces in the owner digest (Phase 6 consumes the event — emit it now).
**Verify:** Fake-clock test produces exactly one nudge per window.

### 4.7 Ready-for-delivery + pickup slots
**Build:** `QUALITY_CHECK → READY_FOR_DELIVERY` triggers the ready message: summary of work done, amount due, and 3 suggested pickup slots (simple slotting: shop hours minus configured rush-hour caps, e.g., max K pickups per 30-min bin) with tap-to-choose; chosen slot recorded, day-of reminder scheduled.
**Verify:** Slot suggestions respect caps; choice confirmation and reminder fire.

### 4.8 Invoice PDF with evidence appendix
**Build:** `@react-pdf/renderer` server-side: shop letterhead (name/GSTIN/address from config), itemised approved lines with taxes (GST fields per line: HSN/SAC optional config, CGST/SGST split for intra-state default), totals, payment status, and an **evidence appendix** — thumbnails of the media backing each additional-work line with approval timestamps. Store PDF as MediaAsset; send on ready + attach on payment.
**Approach:** Deterministic layout tests via PDF snapshot hashing on fixed inputs; currency in `₹` with Indian digit grouping.
**Verify:** Golden-render test; a card with two approved additions shows both evidence blocks; GST math verified against fixtures.

### 4.9 PaymentsPort + adapters
**Build:** `PaymentsPort.createPaymentLink(cardId, amount)` / webhook → `PaymentEvent`. `RazorpayAdapter` (Payment Links + signed webhook verification — consult current docs) and `MockPaymentsAdapter` (sandbox UI button "simulate UPI success/failure" in the simulator). Reconcile worker: payment event → `AWAITING_PAYMENT → DELIVERED/CLOSED` per shop's ordering config; partial payments recorded, balance chased with a **gentle** reminder ladder (2 rungs max, then advisor task — never aggressive).
**Verify:** Contract tests both adapters; tampered webhook signature rejected; mock payment closes the loop in the demo; partial-payment ledger correct.

### 4.10 Gate pass
**Build:** On full payment (or owner override with reason), issue a gate-pass message: short code + QR encoding a signed, expiring token (`cardId`, `exp`, HMAC). Console/phone verify screen for the gate person: scan or type code → green/red with card summary; verification audited.
**Verify:** Forged and expired tokens rejected; happy path audited.

### 4.11 (Stretch) Technician PWA
**Build if time allows, else record in PROGRESS.md as deferred:** installable Next.js PWA route `/tech`: my-cards list, one-tap status buttons, camera capture, voice-note record, offline queue (IndexedDB) with background sync.
**Verify:** Offline capture syncs on reconnect.

---

## Acceptance Gate — Phase 4
- [ ] Voice-note fixture (Tamil-English) → correct state transition + proactive customer update, fully automatic at ≥ 0.85 confidence; low-confidence path asks the advisor.
- [ ] Material ETA slip generates an immediate, reasoned delay message; immaterial changes batch.
- [ ] `status_checker` persona answered correctly at any state; out-of-scope probes routed, not improvised.
- [ ] Ready → slot choice → invoice PDF (golden test green) → mock UPI payment → gate pass verified, as one continuous sandbox demo.
- [ ] Payment webhooks signature-verified; reconcile idempotent; partial payments handled gently.
- [ ] `pnpm demo:phase4` runs the full middle-and-end loop; tag `phase-4-complete`.

## Handoff notes for Phase 5
Phase 5 swaps the ladder's `VOICE_OR_ADVISOR` rung to real calls, reuses `answer_status` and approval objectives in voice form, and upgrades SpeechPort with streaming methods — extend the port, don't fork it.
