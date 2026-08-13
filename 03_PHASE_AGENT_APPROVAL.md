# PHASE 3 — AGENT RUNTIME & APPROVAL AUTOPILOT (THE WEDGE)

**Load `00_MASTER_PROMPT.md` first. Phases 1–2 complete.**

## Objective
The product's core: a guardrailed conversational agent that pursues objectives, and the Approval Autopilot flow end-to-end — technician evidence in, evidence bundle out, escalation ladder running, objections handled, decisions recorded, humans in the loop. Also the conversation simulator that makes agent behaviour regression-testable in CI forever after.

## Deliverables
`LlmPort` + Anthropic adapter with cost metering · agent runtime (deterministic outer loop, typed tool registry, prompt assembly) · tool set v1 · EvidenceBundle builder · claim-anchoring post-checker · escalation ladder engine · objection handling within guardrails · HITL review queue + autonomy graduation · `packages/simulator` persona suite in CI · `pnpm demo:phase3`.

---

## Tasks

### 3.1 LlmPort + adapter
**Build:** `LlmPort.complete(req)` supporting system+messages, typed tool definitions (zod → JSON schema), tool-call responses, temperature/model per **task class** (`AGENT`, `CLASSIFY`, `EXTRACT`, `JUDGE`) mapped to model IDs in config. `AnthropicAdapter` with retries (jittered, respect rate-limit headers), timeout budget, and a `MockLlmAdapter` that replays recorded fixtures for deterministic tests. Meter every call: tokens, latency, cost estimate, task class → `llm_usage` table.
**Verify:** Contract tests on both adapters; a forced 429 retries then succeeds; usage rows written.

### 3.2 Agent runtime (`packages/agent-core`)
**Build:** `AgentRunner.run(objective, threadContext)` — a **deterministic outer loop**: assemble prompt → LLM → validate tool calls (zod) → execute through ToolRegistry → append results → repeat, with hard caps (max 6 steps, max tokens, wall-clock budget) and a terminal report (`objective_met | handoff | blocked | budget_exhausted`). Prompt assembly composes: agent constitution (behavioural rules from master §1 and §6, verbatim), shop profile + price-list KB, customer + vehicle context, live JobCard state, conversation tail, objective spec, and **language policy**: detect the customer's language/register from their messages; mirror it, including code-switch; default from customer profile.
**Approach:** The runtime is plain TypeScript — no agent framework. Every step is persisted (`agent_steps`: prompt hash, tool calls, results, checker verdicts) before the next begins, so any run is replayable. A human message arriving mid-run (Phase 2 flag) aborts the run and reschedules evaluation.
**Verify:** Unit tests with MockLlm scripting multi-step runs; step cap and abort-on-human proven; replay of a persisted run reproduces identical tool calls.

### 3.3 Tool set v1 (typed, guardrail-enforcing)
**Build:** `get_job_card` · `get_customer_context` · `compose_customer_message(draft, claims[])` — returns a candidate, **never sends** · `send_customer_message(candidate)` — the only send tool: runs OutboundGate, autonomy check (L0 → routes to HITL instead), and post-checker · `create_approval_request(workItemIds, ladderRef)` · `record_customer_decision(approvalId, decision, scope)` — supports full/partial/deferred; writes WorkItem transitions and DeclinedWorkLedger entries · `adjust_offer(lineId, newPrice)` — **rejects** below price floor / above discount ceiling from shop config, returning a typed refusal the agent must relay honestly ("I can check with the owner") · `schedule_followup(threadId, at, objective)` · `handoff_to_human(summary, urgency)` — creates an advisor task with a one-line brief + full context link · `log_note`.
**Approach:** Tools are the guardrails (master L5). Each tool validates args, checks invariants, audits, and returns typed results including refusals — the agent experiences constraints as tool outcomes, not as prompt suggestions.
**Verify:** Direct tool tests: floor-violating `adjust_offer` rejected regardless of any prompt content; `send_customer_message` at L0 lands in HITL, never on the wire.

### 3.4 Evidence bundle builder
**Build:** Technician flow on the staff group: photos/video + a voice/text note tagged to a card (reply-to the card's pinned message, or `#TN09BX4432` shorthand) → `EvidenceBundle`: media set, affected WorkItems, new/changed estimate lines (estimate v2 draft), and an LLM-generated **plain-language explanation** produced with a hard rule: it may only restate what exists in the technician note and estimate lines, at the customer's reading level and language.
**Approach:** Generate the explanation with `claims[]` — each sentence mapped to source IDs (`note:…`, `line:…`, `media:…`). This structure is what the post-checker consumes.
**Verify:** Fixture technician notes (Tamil-English, Hindi-English, terse) produce bundles whose every claim maps to a real source; an injected unsupported claim in a fixture is caught (see 3.5).

### 3.5 Claim-anchoring post-checker
**Build:** `PostChecker.review(candidateMessage)`: (a) structural checks — AI-disclosure present where required, no banned patterns (invented urgency lexicon, absolute promises, diagnosis-beyond-notes), price mentions match estimate lines exactly; (b) claim audit — every factual claim carries a source ID that exists and supports it (verify support with a CLASSIFY-class LLM judge over {claim, source} pairs, fixture-tested); (c) verdict `pass | block_to_hitl(reasons)`. Blocked messages surface in HITL with reasons highlighted.
**Verify:** Red-team fixture set (≥ 20 adversarial candidates: fabricated wear claims, unauthorised discount, fear-mongering, missing disclosure) — 100% blocked; clean set passes with < 5% false-block rate.

### 3.6 Approval Autopilot flow
**Build:** `create_approval_request` sends (through the normal gates) an interactive message: explanation, itemised addition with prices and new total, media, buttons **Approve ✅ / Approve partially · ask a question 💬 / Call me 📞**. Button handlers: approve → `record_customer_decision` → WorkItems `APPROVED` → JobCard back to `IN_PROGRESS`, confirmation message with revised ETA hook (Phase 4 fills ETA; emit the event now). Partial/question → opens an agent objective `resolve_partial_approval` on the thread. Call me → immediate `handoff_to_human` with urgency high.
**Verify:** Sandbox E2E for all three buttons; partial approval updates exactly the approved lines and ledgers the rest as DEFERRED with reason `customer_partial`.

### 3.7 Escalation ladder engine
**Build:** Ladder definitions in shop config per objective; default for `approval`: T0 send bundle → T+45m gentle reminder (session or template per window state) → T+2h **voice rung** — until Phase 5, this rung creates a prioritised advisor task "call now" with the agent's brief; the rung type is `VOICE_OR_ADVISOR` so Phase 5 swaps implementation, not config → T+24h owner-digest exception. Engine = BullMQ delayed jobs keyed by `approvalId`, **cancelled atomically on any customer decision or human takeover**; respects quiet hours (defer, don't skip); every rung audited.
**Verify:** Fake-clock integration tests: full ladder fires in order; decision at T+50m cancels remaining rungs; quiet-hours rung defers to morning; duplicate rung suppressed by idempotency.

### 3.8 Objection handling
**Build:** Objective `resolve_partial_approval` intents: price (`adjust_offer` within limits, or honest refusal + owner-check offer), defer (accept, set horizon, ledger with reason `customer_deferred`, confirm safety framing only if technician note supports it), scepticism (re-send media, offer old-part inspection at pickup — a standing allowed claim), pure question (answer from bundle sources only), confusion/elderly signals (simplify, offer Call me proactively).
**Verify:** Simulator personas (3.10) cover each intent; transcripts satisfy the post-checker on every turn.

### 3.9 HITL review queue + autonomy graduation
**Build:** Console **Review Queue**: pending candidates with thread context, checker annotations, actions Approve-send / Edit-then-send (edits diffed + audited + stored as preference-training data) / Reject-with-reason. **Graduation report** per shop per flow: last-30-run approval-without-edit rate, checker-block rate, handoff quality thumbs; owner sees a recommendation ("Approval flow ready for L1") and flips autonomy in Settings — the system recommends, the owner decides.
**Verify:** Playwright: L0 end-to-end — agent drafts, advisor edits, send goes out with the edit; graduation metrics compute correctly from fixtures.

### 3.10 Conversation simulator (CI fixture forever)
**Build:** `packages/simulator`: persona scripts driving the sandbox inbound API against a seeded scenario — `quick_approver`, `price_objector` (two rounds, accepts within-floor concession), `silent_customer` (tests full ladder with fake clock), `sceptic`, `confused_elder` (short messages, Tamil, expects Call-me offer), `partial_approver`. Runner asserts: objective outcome, max turns, guardrail compliance on every message (post-checker re-run), and time-to-decision. Two modes: scripted (MockLlm, deterministic, CI-required) and live-model (nightly, LLM-judge rubric scored, report-only).
**Verify:** `pnpm sim` green in CI; deliberately breaking the price floor makes `price_objector` fail loudly.

---

## Acceptance Gate — Phase 3
- [ ] Full Approval Autopilot demo in sandbox: technician evidence → bundle → customer approve/partial/silent paths all correct, ladder timings honoured under fake clock.
- [ ] `adjust_offer` floor/ceiling enforcement proven at the tool layer; agent relays refusals honestly.
- [ ] Post-checker blocks 100% of the red-team set; false-block < 5% on the clean set.
- [ ] L0 shadow mode: nothing reaches a customer without HITL; edits audited; graduation report live.
- [ ] All six simulator personas pass in scripted mode in CI.
- [ ] Every agent step persisted and replayable; human message aborts runs.
- [ ] `pnpm demo:phase3` narrates one full approval saga (evidence → objection → concession → approval) and exits green; tag `phase-3-complete`.

## Handoff notes for Phase 4
Phase 4 reuses the runtime for status Q&A, fills the ETA hook emitted in 3.6, and implements the real `SpeechPort` adapters the mock has been standing in for. The ladder's `VOICE_OR_ADVISOR` rung stays advisor-backed until Phase 5.
