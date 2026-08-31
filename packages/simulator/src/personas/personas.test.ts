import { describe, expect, it } from 'vitest';
import { PERSONAS } from './personas';
import { runPersona } from './run-persona';

/**
 * The persona suite as a CI gate (phase 3.10).
 *
 * `pnpm sim` is the same run with a readable report; this is the version that
 * fails a build. Both matter: the CLI is what a developer looks at, and this is
 * what stops a regression reaching main while nobody is looking.
 */

describe('conversation simulator — scripted mode', () => {
  it('ships the six approval personas and phase 4’s status checker', () => {
    expect(PERSONAS.map((persona) => persona.name)).toEqual([
      'quick_approver',
      'price_objector',
      'silent_customer',
      'sceptic',
      'confused_elder',
      'partial_approver',
      // Phase 4.5: the only persona that decides nothing, because deflection is
      // measured by whether the answer was right, not by whether it closed.
      'status_checker',
    ]);
  });

  it.each(PERSONAS.map((persona) => [persona.name, persona] as const))(
    'passes: %s',
    async (_name, persona) => {
      const result = await runPersona(persona);

      // The failures are asserted as a list rather than a count, because "which
      // one broke" is the only useful thing to know when this regresses.
      expect(result.failures.map((failure) => `${failure.kind}: ${failure.detail}`)).toEqual([]);
      expect(result.ok).toBe(true);
    },
  );

  it('every persona reaches its objective inside its turn and time budget', async () => {
    for (const persona of PERSONAS) {
      const result = await runPersona(persona);
      const customerTurns = result.outcome.turns.filter(
        (turn) => turn.actor === 'customer',
      ).length;

      expect(customerTurns).toBeLessThanOrEqual(persona.maxTurns);
      if (result.outcome.timeToDecisionMinutes !== null) {
        expect(result.outcome.timeToDecisionMinutes).toBeLessThanOrEqual(
          persona.maxMinutesToDecision,
        );
      }
    }
  });
});

describe('the price floor is load-bearing', () => {
  /**
   * The property the phase asks for by name: **deliberately breaking the price
   * floor makes `price_objector` fail loudly**.
   *
   * "Breaking" here means tightening it back to the shipped default — no
   * discount at all — while the persona still tries to negotiate one. The
   * concession is refused by `adjust_offer`, the agent's message quoting the
   * discounted figure has no agreed-price source to cite, and the claim checker
   * blocks the send. The persona fails with a guardrail finding rather than
   * quietly sending a number the shop never agreed to.
   *
   * This is the test that makes the other six mean something. Without it, a
   * change that silently disabled the floor would leave all six green.
   */
  it('fails price_objector when no discount is permitted', async () => {
    const persona = PERSONAS.find((entry) => entry.name === 'price_objector');
    expect(persona).toBeDefined();
    if (persona === undefined) return;

    const result = await runPersona(persona, {
      configPatch: { pricing: { priceFloorPercent: 100, discountCeilingPercent: 0 } },
    });

    expect(result.ok).toBe(false);
    expect(result.failures.some((failure) => failure.kind === 'GUARDRAIL')).toBe(true);
  });

  it('passes the same persona when a 10% concession is permitted', async () => {
    const persona = PERSONAS.find((entry) => entry.name === 'price_objector');
    if (persona === undefined) throw new Error('persona missing');

    const result = await runPersona(persona, {
      configPatch: { pricing: { priceFloorPercent: 90, discountCeilingPercent: 10 } },
    });

    expect(result.failures).toEqual([]);
    expect(result.outcome.decision).toBe('FULL');
  });
});
