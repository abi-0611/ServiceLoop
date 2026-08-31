import {
  checkBannedPatterns,
  checkDisclosure,
  checkPrices,
  sourcesFor,
  type CheckReason,
} from '@serviceloop/agent-core';
import { APPROVAL_SUBJECT_TYPE, type EvidenceBundle } from '@serviceloop/domain';
import type { Persona, PersonaOutcome } from './personas';
import {
  createSimWorld,
  SIM_CONVERSATION,
  SIM_CUSTOMER,
  SIM_JOB_CARD,
  SIM_SHOP,
  SIM_T0,
  type SimWorld,
  type SimWorldOptions,
} from './world';

/**
 * Running one persona, and judging it.
 *
 * Four assertions, and they are the four the phase asks for: the objective's
 * outcome, the turn count, guardrail compliance on **every message the customer
 * actually received**, and time to decision.
 *
 * The guardrail re-check is the one worth explaining. It does not trust the
 * checker that ran during the conversation — it re-runs the structural layers
 * over the sent bodies afterwards, from the bundle's own sources. So a transcript
 * that drifts into a price nobody quoted, urgency no note carries, or a first
 * message with no AI disclosure fails the persona even if every individual step
 * reported success at the time.
 */

export interface PersonaFailure {
  readonly kind: 'OUTCOME' | 'TURNS' | 'GUARDRAIL' | 'TIME_TO_DECISION' | 'SCRIPT';
  readonly detail: string;
}

export interface PersonaResult {
  readonly persona: string;
  readonly description: string;
  readonly ok: boolean;
  readonly outcome: PersonaOutcome;
  readonly messages: readonly string[];
  readonly failures: readonly PersonaFailure[];
  readonly durationMs: number;
}

export interface RunPersonaOptions {
  /**
   * Overrides the shop configuration the persona runs against.
   *
   * The `sim` CLI never passes this; the test suite does, to prove that
   * *tightening* the price floor makes `price_objector` fail. A guardrail whose
   * removal nothing notices is not a guardrail.
   */
  readonly configPatch?: SimWorldOptions['configPatch'];
}

export async function runPersona(
  persona: Persona,
  options: RunPersonaOptions = {},
): Promise<PersonaResult> {
  const started = Date.now();
  const failures: PersonaFailure[] = [];

  const llm = persona.script();
  const world = createSimWorld({
    language: persona.language,
    customerName: persona.customerName,
    ...(llm === undefined ? {} : { llm }),
    configPatch:
      options.configPatch ??
      (persona.name === 'price_objector'
        ? // A shop that permits a 10% concession, so the floor is a real
          // boundary rather than "any change at all".
          { pricing: { priceFloorPercent: 90, discountCeilingPercent: 10 } }
        : {}),
  });

  const bundle = await world.buildBundle();
  const approvalId = await openApproval(world, bundle);
  const outcome = await persona.run(world, bundle, approvalId);

  /* --- the objective's outcome ------------------------------------------- */

  if (outcome.decision !== persona.expect.decision) {
    failures.push({
      kind: 'OUTCOME',
      detail: `expected decision ${String(persona.expect.decision)}, got ${String(outcome.decision)}`,
    });
  }

  if (persona.expect.approvedWorkItemIds !== undefined) {
    const expected = [...persona.expect.approvedWorkItemIds].sort();
    const actual = [...outcome.approvedWorkItemIds].sort();
    if (expected.join(',') !== actual.join(',')) {
      failures.push({
        kind: 'OUTCOME',
        detail: `expected ${expected.length} approved item(s), got ${actual.length}`,
      });
    }
  }

  if (persona.expect.handoffs !== undefined && outcome.handoffs !== persona.expect.handoffs) {
    failures.push({
      kind: 'OUTCOME',
      detail: `expected ${persona.expect.handoffs} handoff(s), got ${outcome.handoffs}`,
    });
  }

  /* --- turns -------------------------------------------------------------- */

  const customerTurns = outcome.turns.filter((turn) => turn.actor === 'customer').length;
  if (customerTurns > persona.maxTurns) {
    failures.push({
      kind: 'TURNS',
      detail: `took ${customerTurns} customer turns, budget is ${persona.maxTurns}`,
    });
  }

  /* --- time to decision (L3 measures this, not messages sent) ------------- */

  if (
    outcome.timeToDecisionMinutes !== null &&
    outcome.timeToDecisionMinutes > persona.maxMinutesToDecision
  ) {
    failures.push({
      kind: 'TIME_TO_DECISION',
      detail: `decided after ${outcome.timeToDecisionMinutes} minutes, budget is ${persona.maxMinutesToDecision}`,
    });
  }

  /* --- guardrails, re-checked over what was actually sent ----------------- */

  const messages = world.sentBodies();
  for (const [index, body] of messages.entries()) {
    for (const reason of auditMessage(world, bundle, body, index === 0)) {
      failures.push({
        kind: 'GUARDRAIL',
        detail: `message ${index + 1}: ${reason.code} — ${reason.detail}`,
      });
    }
  }

  /* --- no agent run may end blocked --------------------------------------- */

  // A `blocked` run is the checker refusing something the agent tried to say.
  // Inside a persona that is not a guardrail working — it is a transcript that
  // should never have been written, and it must fail loudly rather than show up
  // as a quiet missing message.
  for (const run of world.agentHarness.agentWorld.runs.values()) {
    if (run.outcome === 'blocked') {
      failures.push({
        kind: 'GUARDRAIL',
        detail: `agent run ${run.objective} ended blocked: ${run.reason ?? 'no reason recorded'}`,
      });
    }
  }

  /* --- the script must have been played out ------------------------------- */

  if (llm !== undefined && !llm.isExhausted()) {
    failures.push({
      kind: 'SCRIPT',
      // An unplayed turn means the agent stopped earlier than the persona
      // expected — which is a finding about the runtime, not about the fixture.
      detail: `${llm.remaining()} scripted turn(s) were never reached`,
    });
  }

  return {
    persona: persona.name,
    description: persona.description,
    ok: failures.length === 0,
    outcome,
    messages,
    failures,
    durationMs: Date.now() - started,
  };
}

/**
 * Re-runs the structural checks over a message the customer received.
 *
 * Claim coverage is deliberately not re-run here: the claims a message declared
 * are not stored on the message row, and re-deriving them would be inventing
 * evidence rather than checking it. What *is* re-checkable from the body alone —
 * disclosure, banned patterns, and prices against the estimate — is checked, and
 * those are the three the red team exercises most.
 */
function auditMessage(
  world: SimWorld,
  bundle: EvidenceBundle,
  body: string,
  isFirst: boolean,
): readonly CheckReason[] {
  const candidate = {
    shopId: SIM_SHOP,
    language: world.language,
    body,
    claims: bundle.claims,
    sources: sourcesFor(bundle).map((source) => ({ id: source.id, text: source.text })),
    allowedAmountsPaise: [
      ...bundle.lines.map((line) => line.lineTotalPaise),
      bundle.totalPaise,
      // A concession `adjust_offer` accepted is a price the shop agreed to, so
      // it is quotable. Anything outside the floor never got this far.
      ...concessions(world, bundle),
    ],
    isFirstContactInSession: isFirst,
    traceId: 'sim:audit',
  };

  return [
    ...checkDisclosure(candidate),
    ...checkBannedPatterns(candidate),
    ...checkPrices(candidate),
  ];
}

/**
 * Prices `adjust_offer` accepted during this run.
 *
 * Read from the agent's own step record rather than from a list the persona
 * declares: a concession the tool refused never becomes quotable, and one it
 * accepted is a number the shop stands behind.
 */
function concessions(world: SimWorld, bundle: EvidenceBundle): readonly number[] {
  const accepted: number[] = [];

  for (const step of world.agentHarness.agentWorld.steps) {
    for (const result of step.toolResults) {
      if (result.name !== 'adjust_offer' || !result.ok) continue;
      const value = result.result as { newPaise?: unknown };
      if (typeof value.newPaise === 'number') accepted.push(value.newPaise);
    }
  }

  // The revised total, too: a message that restates it after a concession is
  // quoting arithmetic the shop just agreed to.
  if (accepted.length > 0) {
    const original = bundle.lines.reduce((sum, line) => sum + line.lineTotalPaise, 0);
    const cheapest = Math.min(...accepted);
    accepted.push(original - (bundle.lines[0]?.lineTotalPaise ?? 0) + cheapest);
  }

  return accepted;
}

/** Sends the bundle and opens the ladder, as the approval objective would. */
async function openApproval(world: SimWorld, bundle: EvidenceBundle): Promise<string> {
  const created = await world.runtime.approvals.createApprovalRequest({
    shopId: SIM_SHOP,
    jobCardId: SIM_JOB_CARD,
    customerId: SIM_CUSTOMER,
    conversationId: SIM_CONVERSATION,
    bundle,
    ladderRef: 'APPROVAL',
    actor: { type: 'AGENT', id: null },
    traceId: 'sim:request',
  });

  if (!created.ok) throw new Error(`approval request failed: ${created.reason}`);

  await world.runtime.ladder.scheduleLadder({
    shopId: SIM_SHOP,
    objective: 'APPROVAL',
    subjectType: APPROVAL_SUBJECT_TYPE,
    subjectId: created.approvalId,
    openedAt: new Date(SIM_T0),
    actor: { type: 'AGENT', id: null },
    traceId: 'sim:request',
    // Rung 0 is the bundle that just went out.
    skipRungs: [0],
  });

  return created.approvalId;
}
