import { readFileSync } from 'node:fs';
import type { LlmTaskClass } from '@serviceloop/shared';
import { z } from 'zod';
import {
  hashPrompt,
  LlmError,
  type LlmCompletion,
  type LlmExtraction,
  type LlmExtractionRequest,
  type LlmPort,
  type LlmRequest,
  type LlmToolCall,
} from './port';

/**
 * `MockLlmAdapter` — replays recorded exchanges, in order.
 *
 * The sandbox adapter answers by *rule* (a heuristic parser, an echo), which is
 * the right thing for intake. Scripting a multi-step agent run needs the other
 * kind of determinism: turn 1 calls `get_job_card`, turn 2 calls
 * `compose_customer_message`, turn 3 calls `send_customer_message`, in that
 * order, every time. That is what this adapter is for, and it is what makes the
 * agent's behaviour regression-testable in CI forever after (phase 3.10).
 *
 * Two properties it refuses to compromise on:
 *
 *   - **It never invents a turn.** Running past the end of a script, or hitting
 *     an `expect` that does not match, raises rather than falling back to
 *     something plausible. A test that passes because the mock improvised is a
 *     test that proves nothing.
 *   - **It records what it was asked.** `exchanges()` returns the prompts and
 *     replies of a run, which is how a recorded fixture is produced from a live
 *     session in the first place.
 */

export const RecordedToolCallSchema = z.object({
  name: z.string().min(1),
  args: z.unknown(),
});

export const RecordedTurnSchema = z.object({
  /** Optional guard: the turn only applies if the prompt contains this text. */
  expect: z.string().optional(),
  /** Optional guard on the task class, so a JUDGE call cannot eat an AGENT turn. */
  taskClass: z.enum(['AGENT', 'CLASSIFY', 'EXTRACT', 'JUDGE']).optional(),
  text: z.string().default(''),
  toolCalls: z.array(RecordedToolCallSchema).default([]),
  /** For `extract` turns: the document to return. Validated by the caller's schema. */
  value: z.unknown().optional(),
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
});
export type RecordedTurn = z.infer<typeof RecordedTurnSchema>;

export const RecordedScriptSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  model: z.string().default('mock-model'),
  turns: z.array(RecordedTurnSchema).min(1),
});
export type RecordedScript = z.infer<typeof RecordedScriptSchema>;

export interface RecordedExchange {
  readonly taskClass: LlmTaskClass;
  readonly promptHash: string;
  readonly schema: string | null;
  readonly turnIndex: number;
}

export interface MockLlmOptions {
  /**
   * Task classes this script answers. Everything else goes to `delegate`.
   *
   * A recording is of the *agent's* turns. A claim-judge call made while the
   * agent is mid-run is infrastructure, not a turn, and letting it consume the
   * next scripted step would desynchronise the whole script — with a failure
   * that looks like the agent misbehaving.
   */
  readonly handles?: readonly LlmTaskClass[];
  readonly delegate?: LlmPort;
}

export class MockLlmAdapter implements LlmPort {
  readonly driver = 'mock' as const;

  private readonly script: RecordedScript;
  private readonly exchangeLog: RecordedExchange[] = [];
  private readonly handles: ReadonlySet<LlmTaskClass>;
  private readonly delegate: LlmPort | null;
  private cursor = 0;

  constructor(script: RecordedScript, options: MockLlmOptions = {}) {
    this.script = RecordedScriptSchema.parse(script);
    this.handles = new Set(options.handles ?? ['AGENT']);
    this.delegate = options.delegate ?? null;
  }

  static fromFile(path: string, options: MockLlmOptions = {}): MockLlmAdapter {
    return new MockLlmAdapter(
      RecordedScriptSchema.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown),
      options,
    );
  }

  /** True when this adapter answers the request itself rather than delegating. */
  private owns(request: LlmRequest): boolean {
    return this.handles.has(request.taskClass);
  }

  modelFor(): string {
    return this.script.model;
  }

  /** Every call this adapter served, in order. */
  exchanges(): readonly RecordedExchange[] {
    return [...this.exchangeLog];
  }

  /** True once the script has been played to the end — assert this in tests. */
  isExhausted(): boolean {
    return this.cursor >= this.script.turns.length;
  }

  remaining(): number {
    return this.script.turns.length - this.cursor;
  }

  reset(): void {
    this.cursor = 0;
    this.exchangeLog.length = 0;
  }

  async complete(request: LlmRequest): Promise<LlmCompletion> {
    if (!this.owns(request)) {
      if (this.delegate === null) {
        throw new LlmError(
          'NO_RESPONDER',
          `Script "${this.script.name}" only answers ${[...this.handles].join(', ')} calls and no delegate was given for ${request.taskClass}`,
          { model: this.script.model },
        );
      }
      return this.delegate.complete(request);
    }

    const turn = this.next(request, null);
    const bindings = bindingsFromToolResults(request);

    const toolCalls: LlmToolCall[] = turn.toolCalls.map((call, index) => ({
      id: `mock_tool_${this.cursor}_${index}`,
      name: call.name,
      args: substitute(call.args, bindings),
    }));
    return this.completion(request, turn, turn.text, toolCalls, null);
  }

  async extract<T>(request: LlmExtractionRequest<T>): Promise<LlmExtraction<T>> {
    if (!this.owns(request)) {
      if (this.delegate === null) {
        throw new LlmError(
          'NO_RESPONDER',
          `Script "${this.script.name}" only answers ${[...this.handles].join(', ')} calls and no delegate was given for ${request.taskClass}`,
          { model: this.script.model },
        );
      }
      return this.delegate.extract(request);
    }

    const turn = this.next(request, request.schema.name);
    if (turn.value === undefined) {
      throw new LlmError(
        'NO_RESPONDER',
        `Recorded turn ${this.cursor - 1} of script "${this.script.name}" has no \`value\`, but the caller asked for the "${request.schema.name}" document`,
        { model: this.script.model },
      );
    }

    let value: T;
    try {
      value = request.schema.parse(turn.value);
    } catch (error) {
      throw new LlmError(
        'SCHEMA_MISMATCH',
        `Recorded turn ${this.cursor - 1} of script "${this.script.name}" does not satisfy "${request.schema.name}": ${
          error instanceof Error ? error.message : String(error)
        }`,
        { model: this.script.model },
      );
    }

    const raw = JSON.stringify(value);
    return { ...this.completion(request, turn, raw, [], request.schema.name), value, raw };
  }

  /**
   * The next scripted turn, with its guards checked.
   *
   * The mismatch message names the script, the index and both sides of the
   * comparison, because the failure this adapter most often reports is "the
   * agent asked something the fixture did not anticipate" — and that is a
   * finding about the agent, not about the fixture, so it has to be readable.
   */
  private next(request: LlmRequest, schemaName: string | null): RecordedTurn {
    const turn = this.script.turns[this.cursor];
    if (turn === undefined) {
      throw new LlmError(
        'NO_RESPONDER',
        `Script "${this.script.name}" has ${this.script.turns.length} recorded turns and the caller asked for turn ${this.cursor + 1}`,
        { model: this.script.model, context: { script: this.script.name } },
      );
    }

    if (turn.taskClass !== undefined && turn.taskClass !== request.taskClass) {
      throw new LlmError(
        'NO_RESPONDER',
        `Script "${this.script.name}" turn ${this.cursor} expects a ${turn.taskClass} call, got ${request.taskClass}`,
        { model: this.script.model },
      );
    }

    if (turn.expect !== undefined) {
      const haystack = promptHaystack(request);
      if (!haystack.includes(turn.expect)) {
        throw new LlmError(
          'NO_RESPONDER',
          `Script "${this.script.name}" turn ${this.cursor} expects the prompt to contain ${JSON.stringify(turn.expect)}, and it does not`,
          { model: this.script.model, raw: haystack.slice(-2000) },
        );
      }
    }

    this.cursor += 1;
    this.exchangeLog.push({
      taskClass: request.taskClass,
      promptHash: hashPrompt(request, schemaName ?? undefined),
      schema: schemaName,
      turnIndex: this.cursor - 1,
    });
    return turn;
  }

  private completion(
    request: LlmRequest,
    turn: RecordedTurn,
    text: string,
    toolCalls: readonly LlmToolCall[],
    schemaName: string | null,
  ): LlmCompletion {
    return {
      text,
      toolCalls,
      model: this.script.model,
      taskClass: request.taskClass,
      usage: { inputTokens: turn.inputTokens, outputTokens: turn.outputTokens },
      latencyMs: 0,
      attempts: 1,
      stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
      promptHash: hashPrompt(request, schemaName ?? undefined),
    };
  }
}

/**
 * Values a later turn may refer to, harvested from earlier tool results.
 *
 * A recorded script cannot know the ids a run will generate — a candidate id, an
 * approval id — but a real model reads them out of the tool result it was just
 * handed, and a replay has to be able to do the same. So a turn may write
 * `"{{candidateId}}"` and it resolves to the value the most recent tool result
 * carried under that key.
 *
 * Later results win, because "the candidate id" means the one from the compose
 * that just happened, not the one three turns ago.
 */
function bindingsFromToolResults(request: LlmRequest): ReadonlyMap<string, unknown> {
  const bindings = new Map<string, unknown>();

  for (const message of request.messages) {
    for (const block of message.content) {
      if (block.kind !== 'tool_result') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(block.content) as unknown;
      } catch {
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
      for (const [key, value] of Object.entries(parsed)) bindings.set(key, value);
    }
  }

  return bindings;
}

/**
 * Replaces `{{key}}` placeholders anywhere in a recorded argument tree.
 *
 * A whole-string placeholder resolves to the *value* rather than to its text, so
 * `"{{workItemIds}}"` can produce an array. An unbound placeholder is left as it
 * is: the tool's own validation will reject it, and a visible `{{approvalId}}`
 * in a failure message says exactly what went wrong.
 */
function substitute(args: unknown, bindings: ReadonlyMap<string, unknown>): unknown {
  if (typeof args === 'string') {
    const whole = /^\{\{(\w+)\}\}$/.exec(args);
    if (whole?.[1] !== undefined && bindings.has(whole[1])) return bindings.get(whole[1]);
    return args.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
      const value = bindings.get(key);
      return value === undefined ? match : String(value);
    });
  }
  if (Array.isArray(args)) return args.map((entry) => substitute(entry, bindings));
  if (typeof args === 'object' && args !== null) {
    return Object.fromEntries(
      Object.entries(args).map(([key, value]) => [key, substitute(value, bindings)]),
    );
  }
  return args;
}

/** Everything textual a turn's `expect` guard may match against. */
function promptHaystack(request: LlmRequest): string {
  const parts: string[] = [request.system ?? ''];
  for (const message of request.messages) {
    for (const block of message.content) {
      switch (block.kind) {
        case 'text':
          parts.push(block.text);
          break;
        case 'tool_result':
          parts.push(block.content);
          break;
        case 'tool_use':
          parts.push(`${block.name} ${JSON.stringify(block.args ?? null)}`);
          break;
        case 'image':
          break;
      }
    }
  }
  return parts.join('\n');
}
