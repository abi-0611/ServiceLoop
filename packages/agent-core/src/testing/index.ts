/**
 * Test doubles and worlds for the agent runtime.
 *
 * A separate entry point (`@serviceloop/agent-core/testing`) for the same
 * reason `@serviceloop/domain/testing` is one: the voice call world is a
 * production-quality assembly that the simulator and the phase demos depend on,
 * and nothing in `apps/` should be able to reach an in-memory telephone by
 * accident.
 */

export * from './voice-world';
