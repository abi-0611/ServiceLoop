import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assert, assertEqual, AssertionFailed, ScenarioRunner } from './runner';

describe('ScenarioRunner', () => {
  let written: string[] = [];

  beforeEach(() => {
    written = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs every step and exits zero when all pass', async () => {
    const order: string[] = [];
    const exitCode = await new ScenarioRunner('demo')
      .step('first', () => {
        order.push('first');
        return 'ok';
      })
      .step('second', async () => {
        order.push('second');
        return 'also ok';
      })
      .run();

    expect(exitCode).toBe(0);
    expect(order).toEqual(['first', 'second']);
    expect(written.join('')).toContain('PASSED — 2/2 steps');
  });

  it('stops at the first failure, skips the rest, and exits non-zero', async () => {
    let thirdRan = false;
    const exitCode = await new ScenarioRunner('demo')
      .step('first', () => 'ok')
      .step('second', () => {
        throw new AssertionFailed('the board was empty');
      })
      .step('third', () => {
        thirdRan = true;
        return 'ok';
      })
      .run();

    expect(exitCode).toBe(1);
    expect(thirdRan).toBe(false);

    const output = written.join('');
    expect(output).toContain('the board was empty');
    expect(output).toContain('skipped');
    expect(output).toContain('FAILED — 1/3 steps passed');
  });

  it('runs teardowns in reverse order even after a failure', async () => {
    const order: string[] = [];
    await new ScenarioRunner('demo')
      .step('boom', () => {
        throw new Error('kaboom');
      })
      .onTeardown(async () => {
        order.push('first');
      })
      .onTeardown(async () => {
        order.push('second');
      })
      .run();

    expect(order).toEqual(['second', 'first']);
  });

  it('survives a teardown that itself fails', async () => {
    const exitCode = await new ScenarioRunner('demo')
      .step('fine', () => 'ok')
      .onTeardown(async () => {
        throw new Error('could not close the pool');
      })
      .run();

    expect(exitCode).toBe(0);
    expect(written.join('')).toContain('teardown failed');
  });
});

describe('assertions', () => {
  it('reports the expected and actual values', () => {
    expect(() => assertEqual(1, 2, 'counts must match')).toThrow(
      /counts must match \(expected 2, got 1\)/,
    );
    expect(() => assert(false, 'must be true')).toThrow(AssertionFailed);
    expect(() => assert(true, 'must be true')).not.toThrow();
  });
});
