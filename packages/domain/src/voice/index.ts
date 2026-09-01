/**
 * The voice layer's domain surface (phase 5).
 *
 * Everything here is testable without a telephone: scripts, keypad policy, the
 * cost arithmetic, the gate that decides whether a call may be placed, and the
 * service that records what happened. The runtime that actually holds a line
 * open is `packages/agent-core`, which is the package allowed to import a
 * telephony adapter — the same split phase 3 made between `ApprovalService` and
 * `AgentRunner`.
 */

export * from './call-gate';
export * from './call-service';
export * from './cost-meter';
export * from './dtmf';
export * from './ports';
export * from './scripts';
export * from './types';
