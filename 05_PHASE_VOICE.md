# PHASE 5 — VOICE LAYER

**Load `00_MASTER_PROMPT.md` first. Phases 1–4 complete.**

## Objective
Give the agent a phone voice: outbound approval-chase calls and an inbound status/booking line in Tamil/Hindi/English with natural code-switching, DTMF fallback for low-tech callers, mandatory disclosure and recording consent, warm handoff that bridges to the human advisor with a whispered summary — all developed and demoable through a **browser softphone** so no telco account is required until go-live.

## Deliverables
`TelephonyPort` + `ExotelAdapter` (+ Twilio alt) + `BrowserLoopbackAdapter` with console softphone · streaming STT/TTS via extended SpeechPort · voice agent runtime (turn manager, barge-in, latency budget) · call flows: outbound approval rung, inbound line, warm handoff with screen-pop · DTMF fallback · consent/recording pipeline · cost metering + kill switch · voice simulation tests · `pnpm demo:phase5`.

---

## Tasks

### 5.1 TelephonyPort + adapters
**Build:** Port surface: `originateCall(to, context)` · inbound-call webhook → normalised `CallSession` events (`ringing, answered, dtmf(digit), media_stream_open, hangup`) · bidirectional audio streaming (provider media-stream WebSocket → internal PCM frames interface) · `bridgeTo(number, whisperAudio)` · `startRecording/stopRecording`. **ExotelAdapter** primary (India numbers, DLT-clean voice; consult current Exotel Voice Streaming docs — API surfaces drift) with **TwilioAdapter** as the documented alternative behind the same contract. **BrowserLoopbackAdapter**: the console `/softphone` page acts as the far-end phone — WebRTC/WebSocket audio between browser mic/speaker and the same PCM frames interface the real adapters use, with on-screen DTMF keypad, ringing UI, and "answer as customer <persona>" selection.
**Approach:** The loopback adapter is the whole phase's development surface — build it first and make it indistinguishable from a real adapter at the port boundary. Audio format: 8kHz mono μ-law/PCM16 normalised internally to 16kHz PCM16.
**Verify:** Contract test: scripted call lifecycle identical across loopback and (behind `LIVE_TEL_TEST=1`) a real adapter; DTMF events arrive as typed events.

### 5.2 Streaming speech pipeline
**Build:** Extend `SpeechPort` with `streamTranscribe(frames) → partial/final segments (+language tags)` and `streamSynthesize(textChunks, voiceRef) → frames`. `SarvamStreamingAdapter` (Saaras streaming STT — sub-150ms-class first token; Bulbul streaming TTS — sub-250ms-class first byte, Tanglish/Hinglish native; verify current websocket API in docs) + Google streaming fallback + `MockStreamingSpeechAdapter` (fixture audio in, scripted partials out — CI default).
**Approach:** Backpressure-aware pipes; jitter buffer on synthesis out; per-call language lock-in after 2 confident detections with mid-call switch allowed on sustained change.
**Verify:** Loopback round-trip: spoken fixture → partials → final within latency budget markers logged per stage.

### 5.3 Voice agent runtime (turn manager)
**Build:** `VoiceAgentRunner` wraps the Phase 3 `AgentRunner` with telephony realities: **turn detection** (endpointing on STT finality + 700ms silence), **barge-in** (customer speech during TTS → cut synthesis, commit partial as heard, re-plan), **latency budget** ≤ 1.2s speech-end → speech-start (pipeline: streaming STT partials feed early planning; short first sentence synthesised while the rest streams), voice-specific composition policy (≤ 2 sentences per turn, confirm-by-readback for decisions: "So I'll go ahead with the brake pads at ₹2,400 — shall I confirm? Say yes or press 1"), and per-call step/time caps with graceful "I'll have Kumar sir call you" exits.
**Approach:** Same tools, same guardrails, same post-checker (checker runs on the composed turn text before synthesis). Every call produces a persisted transcript with turn timings — the audit story must be as strong as chat.
**Verify:** Loopback tests: barge-in cuts audio ≤ 300ms; readback-confirm required before `record_customer_decision` fires from voice; budget breach triggers the graceful exit, never dead air > 3s (comfort filler i18n clips: "oru nimisham…").

### 5.4 Call flows
**Build:** (a) **Outbound approval rung**: the Phase 3 ladder's `VOICE_OR_ADVISOR` rung now originates a call (retry-on-no-answer once after 20 min, then advisor task). Script skeleton (i18n, non-removable segments marked ⚿): ⚿ AI disclosure + shop identification → ⚿ recording notice → context ("your Swift's brake pads…") → evidence recap → ask → objection handling (same intents as 3.8) → readback-confirm → close with WhatsApp summary send. (b) **Inbound line**: greeting ⚿, intent classify (status | approval response | booking | other), status answered from live state, booking creates an appointment draft for advisor confirm, "other"/frustration → warm handoff. (c) **Warm handoff**: `bridgeTo(advisor)` with a whispered 8-second summary to the advisor leg before joining, plus console screen-pop of the card and transcript.
**Verify:** Loopback E2E of all three flows with persona voices (pre-synthesised fixture audio); a DTMF-only caller completes an approval via keypad alone.

### 5.5 DTMF fallback
**Build:** Every decision point offers keys ("press 1 to approve, 2 to speak to Kumar, 9 to repeat"); a global `0` → handoff. Pure-IVR degradation mode if STT confidence stays poor for 2 turns.
**Verify:** Scripted DTMF-only path test green; degradation triggers correctly on noise fixtures.

### 5.6 Consent, recording, retention
**Build:** Recording starts only after the notice segment; recordings + transcripts stored via StoragePort with retention config (default 180 days, Phase 7 wires deletion cascades); per-call consent facts audited. Calls to customers with revoked SERVICE consent are impossible at the port call-site (gate check before originate).
**Verify:** Test asserts no media frames persisted pre-notice; revoked-consent originate blocked + audited.

### 5.7 Cost metering, kill switch, fallback
**Build:** Per-call metering (telco minutes est., STT/TTS seconds, LLM tokens) → `call_usage`; shop- and platform-level daily caps with alert-then-halt; `VOICE_KILL_SWITCH` env/config flag that instantly reverts all voice rungs to advisor tasks; any mid-call pipeline failure → apology clip + WhatsApp follow-up automatically sent.
**Verify:** Cap breach halts new originations and alerts; kill switch flips rung behaviour without deploy; injected STT outage mid-call produces the apology + WhatsApp path.

### 5.8 Voice simulation suite
**Build:** Extend `packages/simulator` with audio personas: fixture-recorded (or TTS-generated at build time) customer utterances driving the loopback adapter — `voice_quick_approver` (Tamil), `voice_price_objector` (Hindi-English), `voice_dtmf_elder`, `voice_noisy_line`. Scripted mode (MockStreamingSpeech, CI-required) asserts flow outcomes, disclosure presence on every call, readback-before-decision, and latency-stage budgets from logged markers; live-model/live-speech mode runs nightly, report-only.
**Verify:** `pnpm sim:voice` green in CI.

---

## Acceptance Gate — Phase 5
- [ ] Browser softphone demo: outbound approval call in Tamil-English — disclosure ⚿ heard, evidence recap, objection handled, DTMF `1` approves, job card updates, WhatsApp summary lands. All without any telco credentials.
- [ ] Inbound "car ready-aa?" call answered from live state; frustration fixture warm-bridges with whisper summary + screen-pop.
- [ ] Barge-in, readback-confirm, latency budget, and no-dead-air proven by tests.
- [ ] Consent/recording ordering enforced; revoked-consent calls impossible; kill switch verified.
- [ ] Voice sim suite green in CI; cost metering rows written per call.
- [ ] `pnpm demo:phase5` orchestrates one outbound + one inbound loopback call end-to-end; tag `phase-5-complete`.

## Handoff notes for Phase 6
Voice outcomes (containment, handoff counts, decisions-by-voice) must land in the same event stream the Phase 6 metrics service aggregates — emit them with the standard envelope now.
