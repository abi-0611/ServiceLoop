/**
 * Test doubles for every domain port.
 *
 * A separate entry point (`@serviceloop/domain/testing`) rather than part of the
 * main surface: these are production-quality implementations that the simulator
 * and the phase demos depend on, but nothing in `apps/` should be able to reach
 * an in-memory store by accident.
 */

export * from './in-memory';
export * from './in-memory-agent';
export * from './in-memory-intake';
export * from './in-memory-messaging';
export * from './in-memory-status';
export * from './in-memory-retention';
export * from './in-memory-voice';
export * from './in-memory-delivery';
export * from './loop-harness';
export * from './retention-harness';
