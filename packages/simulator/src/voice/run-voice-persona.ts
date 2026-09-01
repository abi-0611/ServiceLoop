import { DeferredLlmAdapter, deterministicJudge } from '@serviceloop/adapters';
import {
  createVoiceCallWorld,
  VOICE_SHOP,
  type PlacedCall,
  type VoiceCallWorld,
} from '@serviceloop/agent-core/testing';
import { MANDATORY_SCRIPT_KEYS, type CallTurnRecord } from '@serviceloop/domain';
import type { VoicePersona } from './personas';

/**
 * Running one voice persona, and judging it (phase 5.8).
 *
 * Two kinds of assertion, and the distinction is the point. The first is what
 * *this* persona was supposed to achieve — the decision, the handoff, the drop
 * to IVR — which is the persona's own business. The second is a set of
 * properties every call must have, checked here rather than in each persona,
 * because a property four fixtures happen to satisfy is not a guarantee:
 *
 *   - **The disclosure was heard.** Not "the script contained it" — the turn is
 *     in the persisted transcript, marked mandatory, before anything else.
 *   - **A decision was read back.** Any call that recorded one must carry a
 *     readback turn *earlier in the transcript* than the decision. This is the
 *     assertion that would catch a future refactor quietly dropping the
 *     confirm-by-readback step, which is the single most expensive mistake this
 *     layer could make.
 *   - **The latency markers stayed inside the budget.** Read from the stage
 *     timings each turn logged, not measured by the test — so what is being
 *     checked is the pipeline's own arithmetic, on a clock that really ticks.
 *   - **No dead air.** The runtime never left the line silent past its own
 *     limit, which is visible as the comfort filler having played rather than
 *     as a gap nobody recorded.
 */

export interface VoiceFailure {
  readonly kind: 'OUTCOME' | 'DISCLOSURE' | 'READBACK' | 'LATENCY' | 'SCRIPT' | 'CALL';
  readonly detail: string;
}

export interface VoicePersonaResult {
  readonly persona: string;
  readonly description: string;
  readonly ok: boolean;
  readonly failures: readonly VoiceFailure[];
  /** Everything the agent said, decoded from the audio the line carried. */
  readonly heard: readonly string[];
  /** What the person on the other end did, in order. */
  readonly did: readonly string[];
  readonly decision: string | null;
  readonly turns: number;
  readonly maxLatencyMs: number;
  readonly costPaise: number;
  readonly durationMs: number;
}

export async function runVoicePersona(persona: VoicePersona): Promise<VoicePersonaResult> {
  const started = Date.now();
  const failures: VoiceFailure[] = [];

  const slot = new DeferredLlmAdapter(deterministicJudge());
  const world = createVoiceCallWorld({
    language: persona.language,
    customerName: persona.customerName,
    llm: slot,
    ...(persona.configPatch === undefined ? {} : { configPatch: persona.configPatch }),
  });

  const approvalId = await world.openApproval();
  const scripted = persona.script(approvalId);
  if (scripted !== undefined) slot.use(scripted);

  const placed: PlacedCall =
    persona.direction === 'OUTBOUND'
      ? await world.placeOutbound(persona.actions, { approvalRequestId: approvalId })
      : await world.answerInbound(persona.actions);

  const { report, caller } = placed;

  /* --- what this persona was for ----------------------------------------- */

  if ((report.decision ?? null) !== (persona.expect.decision ?? null)) {
    failures.push({
      kind: 'OUTCOME',
      detail: `expected decision ${String(persona.expect.decision)}, got ${String(report.decision)}`,
    });
  }

  if (persona.expect.handedOff !== undefined && report.handedOff !== persona.expect.handedOff) {
    failures.push({
      kind: 'OUTCOME',
      detail: `expected handedOff ${String(persona.expect.handedOff)}, got ${String(report.handedOff)}`,
    });
  }

  if (
    persona.expect.degradedToIvr !== undefined &&
    report.degradedToIvr !== persona.expect.degradedToIvr
  ) {
    failures.push({
      kind: 'OUTCOME',
      detail: `expected degradedToIvr ${String(persona.expect.degradedToIvr)}, got ${String(report.degradedToIvr)}`,
    });
  }

  if (persona.expect.bargeIns !== undefined && report.bargeIns < persona.expect.bargeIns) {
    failures.push({
      kind: 'OUTCOME',
      detail: `expected at least ${persona.expect.bargeIns} barge-in(s), got ${report.bargeIns}`,
    });
  }

  if (persona.expect.summarySent !== undefined && report.summarySent !== persona.expect.summarySent) {
    failures.push({
      kind: 'OUTCOME',
      detail: `expected summarySent ${String(persona.expect.summarySent)}, got ${String(report.summarySent)}`,
    });
  }

  if (caller?.timedOut === true) {
    failures.push({ kind: 'CALL', detail: 'the caller gave up waiting for the agent' });
  }

  /* --- properties of every call ------------------------------------------ */

  const turns = await world.calls.loadTurns(VOICE_SHOP, report.callId);
  failures.push(...auditCall(turns, report.decision, world));

  /* --- the script must have been played out ------------------------------ */

  if (scripted !== undefined && !scripted.isExhausted()) {
    failures.push({
      kind: 'SCRIPT',
      detail: `${scripted.remaining()} scripted turn(s) were never reached`,
    });
  }

  const usage = world.voiceWorld.usage.get(report.callId);
  if (usage === undefined) {
    // Phase 5.7: a call that produced no usage row is a call the caps cannot
    // see, which is how a shop walks through its budget.
    failures.push({ kind: 'CALL', detail: 'no call_usage row was written' });
  }

  return {
    persona: persona.name,
    description: persona.description,
    ok: failures.length === 0,
    failures,
    heard: caller?.heard ?? [],
    did: caller?.did ?? [],
    decision: report.decision,
    turns: report.turns,
    maxLatencyMs: report.maxTurnLatencyMs,
    costPaise: usage?.estimatedCostPaise ?? 0,
    durationMs: Date.now() - started,
  };
}

/**
 * The properties every call has to have, read from the persisted transcript.
 *
 * From the transcript rather than from the report, deliberately: the report is
 * what the runtime says it did, and the transcript is what an auditor will
 * actually be shown. Checking the second is the only version of this that means
 * anything.
 */
function auditCall(
  turns: readonly CallTurnRecord[],
  decision: string | null,
  world: VoiceCallWorld,
): readonly VoiceFailure[] {
  const failures: VoiceFailure[] = [];
  const mandatory = new Set<string>(MANDATORY_SCRIPT_KEYS);

  const opening = turns.filter((turn) => turn.mandatorySegment);
  const disclosure = opening.find(
    (turn) => turn.scriptKey === 'voice.disclosure' || turn.scriptKey === 'voice.inbound.greeting',
  );
  const notice = opening.find((turn) => turn.scriptKey === 'voice.recording_notice');

  if (disclosure === undefined) {
    failures.push({ kind: 'DISCLOSURE', detail: 'no AI disclosure turn in the transcript' });
  }
  if (notice === undefined) {
    failures.push({ kind: 'DISCLOSURE', detail: 'no recording-notice turn in the transcript' });
  }
  if (disclosure !== undefined && disclosure.turnIndex !== 0) {
    failures.push({
      kind: 'DISCLOSURE',
      detail: `the disclosure was turn ${disclosure.turnIndex}, not the first thing said`,
    });
  }
  for (const turn of opening) {
    if (turn.scriptKey !== null && !mandatory.has(turn.scriptKey)) {
      failures.push({
        kind: 'DISCLOSURE',
        detail: `turn ${turn.turnIndex} is marked mandatory but "${turn.scriptKey}" is not in the catalogue's non-removable set`,
      });
    }
    if (turn.bargedIn) {
      failures.push({
        kind: 'DISCLOSURE',
        detail: `turn ${turn.turnIndex} (${turn.scriptKey ?? 'unnamed'}) was cut short by the caller`,
      });
    }
  }

  const recordingStarted = world.voiceWorld
    .factsFor(turns[0]?.callId ?? '')
    .findIndex((fact) => fact.fact === 'RECORDING_STARTED');
  const noticePlayed = world.voiceWorld
    .factsFor(turns[0]?.callId ?? '')
    .findIndex((fact) => fact.fact === 'RECORDING_NOTICE_PLAYED');
  if (recordingStarted >= 0 && recordingStarted < noticePlayed) {
    failures.push({
      kind: 'DISCLOSURE',
      detail: 'the recorder started before the notice was played',
    });
  }

  /* --- readback before a decision ---------------------------------------- */

  if (decision !== null) {
    const readback = turns.find((turn) => turn.scriptKey === 'voice.readback');
    if (readback === undefined) {
      failures.push({
        kind: 'READBACK',
        detail: 'a decision was recorded with no readback turn in the transcript',
      });
    } else {
      const confirmation = turns.find(
        (turn) => turn.role === 'CALLER' && turn.turnIndex > readback.turnIndex,
      );
      if (confirmation === undefined) {
        failures.push({
          kind: 'READBACK',
          detail: 'the readback was never answered, yet a decision was recorded',
        });
      }
    }
  }

  /* --- latency, from the markers the pipeline itself logged --------------- */

  const budget = world.config.voice.latencyBudgetMs;
  for (const turn of turns) {
    const measured = turn.latencyStages.SPEECH_END_TO_SPEECH_START;
    if (measured !== undefined && measured > budget) {
      failures.push({
        kind: 'LATENCY',
        detail: `turn ${turn.turnIndex} took ${measured}ms from speech-end to speech-start, budget is ${budget}ms`,
      });
    }
  }

  return failures;
}
