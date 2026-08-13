# PHASE 2 — CHANNEL GATEWAY & ZERO-MIGRATION INTAKE

**Load `00_MASTER_PROMPT.md` first. Phase 1 must be complete (`phase-1-complete` tag).**

## Objective
Messages flow in and out, and job cards enter the system through all three on-ramps — with the paper-photo path as the flagship. Ship the WhatsApp port with a real Meta Cloud API adapter and a full **Sandbox Simulator** inside the console, the media pipeline, the OCR intake pipeline with staff confirmation, entity resolution for Indian registrations and phone numbers, and consent capture that gates every outbound message from this day forward.

## Deliverables
`WhatsAppPort` + `MetaCloudAdapter` + `SandboxWhatsAppAdapter` with simulator UI · message router + session manager (24h window) · media pipeline on StoragePort · `OcrPort` + vision intake with confidence scoring and golden fixtures · staff confirmation flow · forwarded-text/voice-note intake draft parser · minimal digital job-card form · entity resolution · consent capture + outbound gate · Conversations inbox · `pnpm demo:phase2`.

---

## Tasks

### 2.1 WhatsAppPort + adapters
**Build:** `packages/adapters/whatsapp/port.ts`: `sendSessionMessage`, `sendTemplate(templateRef, vars)`, `sendInteractive(buttons|list)`, `sendMedia`, `markRead`, plus an inbound normalised event type (`text|media|button_reply|location|reaction`, with `waMessageId`, `from`, `timestamp`). **MetaCloudAdapter:** webhook GET verify handshake, POST receive with X-Hub-Signature-256 verification, media download URL exchange, send endpoints, error taxonomy mapping (rate limit vs invalid recipient vs window-closed), template registry table (`wa_templates`: name, language, category, status) — consult current Meta Cloud API docs while wiring. **SandboxWhatsAppAdapter:** in-process adapter persisting to the same `messages` table, delivering "inbound" messages injected via a dev-only API.
**Approach:** Adapter selection at boot from env per master §5. Outbound calls go through a per-shop rate limiter (BullMQ) so a burst can never trip Meta throttling. Every send records provider message id + conversation category for cost metering (billing math itself lands in Phase 7).
**Verify:** Contract test suite runs identically against both adapters (sandbox in CI; Meta adapter behind a `LIVE_WA_TEST=1` flag using a test number). Signature-verification rejects a tampered payload.

### 2.2 Sandbox Simulator UI
**Build:** Console route `/sandbox` (DEMO_MODE only): pick a persona (any seeded customer, or staff member in the shop group), see a WhatsApp-style thread, send text/emoji/images/voice notes (browser mic → uploaded audio), tap interactive buttons. Everything routes through the real inbound pipeline as if Meta delivered it.
**Approach:** This is the single most-used dev surface for the rest of the build — invest in it: message bubbles render templates/interactive payloads faithfully; a timeline sidebar shows the pipeline trace (webhook → router → session → handlers) for the selected message.
**Verify:** Playwright: simulate a customer text → appears in Conversations inbox with correct session state; button tap produces a normalised `button_reply` event.

### 2.3 Message router + session manager
**Build:** Router classifies inbound by line: customer thread vs **staff group** (technician evidence channel) vs unknown number. `ConversationSessionService` opens/refreshes sessions, tracks the WhatsApp 24-hour customer-service window per thread (`windowExpiresAt`), and exposes `canSendSessionMessage(threadId)` — when false, senders must use an approved template or another channel. Opt-out keywords (`STOP`, `UNSUBSCRIBE`, plus Hindi/Tamil equivalents from i18n) immediately set consent to revoked and confirm once.
**Approach:** Window tracking is core product logic, not adapter detail — it lives in domain, fed by adapter timestamps. Unknown numbers get a polite identification prompt, never silence.
**Verify:** Time-travel tests (fake clock) across the 24h boundary; opt-out flips the gate instantly and audits.

### 2.4 Media pipeline
**Build:** Inbound media → StoragePort (MinIO/GCS) with content-type sniffing, size caps, image normalisation (EXIF rotate, max-dimension resize, thumbnail), audio transcode to 16kHz mono WAV (for Phase 4 STT) via a worker. `MediaAsset` rows link to message + (later) WorkItem.
**Verify:** Fixture uploads for jpeg/png/webp/ogg/opus; oversized file rejected with a friendly message; thumbnails render in the inbox.

### 2.5 Paper job-card OCR intake (flagship)
**Build:** Flow: staff sends a photo captioned `#jobcard` (or taps "New job card from photo" in console) → `OcrPort.extractJobCard(image)` returns a zod `JobCardDraft`: customer{name, phone}, vehicle{registration, make, model, odometer}, complaints[], estimateLines[{description, qty, unitPrice?}], advisorName, promisedAt — **each field carrying `confidence: 0–1` and a source-region hint**. Implement `VisionLlmAdapter` over LlmPort with a tightly specified extraction prompt (include few-shot examples of messy handwriting conventions: ditto marks, Tamil/Hindi item names, ₹ shorthand, strikethroughs).
**Approach — fixtures are the craft here:** generate the golden test set yourself: build 12 HTML job-card templates (varied layouts: ruled register page, carbon-copy pad, printed form with handwriting font mix), render to PNG via Playwright, add noise/skew/shadow variants with sharp. Store expected JSON beside each. This gives a deterministic OCR eval without needing real photos, and real photos can be added to the same harness later.
**Verify:** Eval script `pnpm eval:ocr` prints per-field accuracy; gate: ≥ 90% field accuracy on clean fixtures, ≥ 75% on degraded, and — critically — **calibration**: fields the model gets wrong must carry low confidence (measure and assert a threshold split).

### 2.6 Staff confirmation flow
**Build:** The draft returns to the sender as an interactive summary: high-confidence fields shown, low-confidence fields (< 0.8) prefixed ⚠ with tap-to-correct prompts (reply `2 = TN 09 BX 4432` style quick corrections), plus Confirm / Edit in console / Discard. Confirm → creates Customer/Vehicle (via entity resolution), JobCard `OPEN`, WorkItems `PROPOSED`, estimate v1 — all through domain services so audit + outbox fire.
**Verify:** Sandbox E2E: photo → draft → one correction → confirm → card appears on the board with the correction applied; audit trail shows OCR source and the human correction.

### 2.7 Forwarded text / voice-note intake
**Build:** Advisor forwards a free-text message ("Ravi anna Swift MH12 brake pad + oil change 3500 evening delivery") or a voice note → LlmPort structured parse into the same `JobCardDraft` (voice path stores audio now, transcribes via a batch `SpeechPort.transcribe` call — implement the port and `MockSpeechAdapter` reading fixture transcripts here; real Sarvam adapter arrives Phase 4).
**Verify:** 10 fixture messages incl. Tamil-English and Hindi-English code-switch parse to correct drafts.

### 2.8 Minimal digital job card + entity resolution
**Build:** Console "New Job Card" form for greenfield shops (never the pitch, always available). `EntityResolution`: registration normaliser (uppercase, strip spaces/hyphens, validate against Indian formats incl. `BH`-series; store raw + normalised), phone → E.164 with `+91` defaulting, dedupe: match vehicle by normalised registration, customer by phone; ambiguous matches queue a merge suggestion for the advisor instead of guessing.
**Verify:** Table-driven tests over 25 registration variants; merge-suggestion path covered.

### 2.9 Consent capture + outbound gate
**Build:** First outbound contact to any customer opens with identification + AI disclosure + SERVICE-purpose consent capture (interactive Yes/No; a job-card handover at the counter counts as implied service consent per shop config, but the message still offers opt-out). MARKETING consent is a separate, later ask (Phase 6). `OutboundGate` — a single choke point every send must pass — checks: consent state for the message's purpose tag, session window vs template, quiet hours, frequency caps. There is no send path that bypasses it; enforce by making the gate the only exported send API in `packages/domain` messaging module.
**Verify:** Attempted send without consent is blocked, audited, and surfaced in console; quiet-hours message is deferred to a scheduled job, not dropped.

### 2.10 Conversations inbox
**Build:** Console inbox: thread list (unread, language tag, window countdown), thread view with media, message-state ticks, purpose tags, and a manual advisor reply box (advisor sends count as human messages, pausing any active agent objective on that thread — flag for Phase 3 to consume).
**Verify:** Playwright: full sandbox round trip customer↔advisor.

---

## Acceptance Gate — Phase 2
- [ ] Contract tests pass against Sandbox adapter in CI (and Meta adapter under `LIVE_WA_TEST` when credentials exist).
- [ ] Paper-photo → OCR draft → correction → confirmed OPEN card, end-to-end in the sandbox, in < 60 seconds of user actions.
- [ ] OCR eval gates met, including confidence calibration.
- [ ] 24h-window logic, opt-out, quiet hours, and consent gating proven by tests; zero send paths bypass `OutboundGate`.
- [ ] Forwarded-text and voice-note fixtures parse correctly (mock STT).
- [ ] Entity resolution handles the registration/phone variant table; ambiguity produces merge suggestions, never silent merges.
- [ ] `pnpm demo:phase2` runs: photo intake + text intake + a consent-gated outbound, printing pass/fail; tag `phase-2-complete`.

## Handoff notes for Phase 3
Phase 3 builds the agent on top of: `OutboundGate`, session windows, the staff-group evidence channel, `JobCardDraft` conventions, and the inbox's human-override flag. The simulator is the primary test bench for the agent — keep it fast.
