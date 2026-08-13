/**
 * Scenario runner.
 *
 * Every phase ships a runnable demo (`pnpm demo:phase<N>`) that executes the
 * acceptance scenario against the sandbox adapters and prints a pass/fail
 * summary. This is that harness: ordered steps, one line each, a summary table,
 * and a non-zero exit on the first failure so CI can gate on it.
 *
 * Phase 3 extends the same runner with customer personas for the conversation
 * simulator; the step protocol does not change.
 */

export interface StepResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly durationMs: number;
  readonly error?: unknown;
}

export type StepFn = () => Promise<string> | string;

interface Step {
  readonly name: string;
  readonly fn: StepFn;
}

const GREEN = '[32m';
const RED = '[31m';
const DIM = '[2m';
const BOLD = '[1m';
const RESET = '[0m';

const useColour = process.env['NO_COLOR'] === undefined && process.stdout.isTTY === true;

function paint(colour: string, text: string): string {
  return useColour ? `${colour}${text}${RESET}` : text;
}

export class AssertionFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionFailed';
  }
}

/** Small assertion helpers so scenarios read as prose. */
export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new AssertionFailed(message);
}

export function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (!Object.is(actual, expected)) {
    throw new AssertionFailed(
      `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
    );
  }
}

export class ScenarioRunner {
  private readonly steps: Step[] = [];
  private readonly teardowns: Array<() => Promise<void>> = [];

  constructor(
    private readonly title: string,
    private readonly subtitle = '',
  ) {}

  step(name: string, fn: StepFn): this {
    this.steps.push({ name, fn });
    return this;
  }

  onTeardown(fn: () => Promise<void>): this {
    this.teardowns.push(fn);
    return this;
  }

  /** Runs every step in order, stopping at the first failure. Returns an exit code. */
  async run(): Promise<number> {
    const started = Date.now();
    process.stdout.write(`\n${paint(BOLD, this.title)}\n`);
    if (this.subtitle.length > 0) process.stdout.write(`${paint(DIM, this.subtitle)}\n`);
    process.stdout.write('\n');

    const results: StepResult[] = [];
    let failed = false;

    for (const [index, step] of this.steps.entries()) {
      const label = `${String(index + 1).padStart(2, '0')}. ${step.name}`;

      if (failed) {
        results.push({ name: step.name, ok: false, detail: 'skipped', durationMs: 0 });
        process.stdout.write(`${paint(DIM, `  -  ${label} — skipped`)}\n`);
        continue;
      }

      const stepStarted = Date.now();
      try {
        const detail = await step.fn();
        const durationMs = Date.now() - stepStarted;
        results.push({ name: step.name, ok: true, detail, durationMs });
        process.stdout.write(
          `  ${paint(GREEN, 'PASS')} ${label} ${paint(DIM, `(${durationMs}ms)`)}\n`,
        );
        if (detail.length > 0) process.stdout.write(`       ${paint(DIM, detail)}\n`);
      } catch (error) {
        const durationMs = Date.now() - stepStarted;
        failed = true;
        results.push({
          name: step.name,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
          durationMs,
          error,
        });
        process.stdout.write(`  ${paint(RED, 'FAIL')} ${label}\n`);
        process.stdout.write(
          `       ${paint(RED, error instanceof Error ? error.message : String(error))}\n`,
        );
        if (
          error instanceof Error &&
          !(error instanceof AssertionFailed) &&
          error.stack !== undefined
        ) {
          process.stdout.write(`${paint(DIM, error.stack)}\n`);
        }
      }
    }

    for (const teardown of this.teardowns.reverse()) {
      try {
        await teardown();
      } catch (error) {
        process.stdout.write(
          `  ${paint(RED, 'WARN')} teardown failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }

    const passed = results.filter((result) => result.ok).length;
    const total = results.length;
    const elapsed = Date.now() - started;

    process.stdout.write('\n');
    process.stdout.write(
      failed
        ? `${paint(RED, `FAILED — ${passed}/${total} steps passed in ${elapsed}ms`)}\n\n`
        : `${paint(GREEN, `PASSED — ${passed}/${total} steps in ${elapsed}ms`)}\n\n`,
    );

    return failed ? 1 : 0;
  }
}
