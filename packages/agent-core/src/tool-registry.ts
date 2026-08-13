import { canonicalJson, type Result, err, ok } from '@serviceloop/shared';
import { createHash } from 'node:crypto';
import type { z } from 'zod';

/**
 * Typed tool registry (master §6 — "the agent acts only through typed tools").
 *
 * A tool declares a zod schema for its arguments; the registry is the only way
 * to invoke one, and it validates before the handler ever runs. An agent that
 * hallucinates an argument shape gets a typed rejection, not a partial effect.
 *
 * Phase 3 registers the real customer-facing tools on top of this. What is here
 * now is the invariant every one of them will inherit: validate, execute,
 * post-check, record.
 */

export interface ToolContext {
  readonly shopId: string;
  readonly traceId: string;
  readonly actorId: string | null;
  /** Hash of the prompt that produced this call, for the audit record. */
  readonly promptHash: string;
}

export type ToolFailure =
  | {
      readonly kind: 'INVALID_ARGS';
      readonly toolName: string;
      readonly issues: ReadonlyArray<{ path: string; message: string }>;
    }
  | { readonly kind: 'UNKNOWN_TOOL'; readonly toolName: string }
  | {
      readonly kind: 'BLOCKED';
      readonly toolName: string;
      readonly code: string;
      readonly reason: string;
    }
  | { readonly kind: 'THREW'; readonly toolName: string; readonly message: string };

export interface ToolDefinition<TArgs extends z.ZodTypeAny, TResult> {
  readonly name: string;
  readonly description: string;
  readonly args: TArgs;
  /** Tools that can reach a customer are marked so post-checkers can require evidence. */
  readonly customerFacing: boolean;
  handler(args: z.infer<TArgs>, context: ToolContext): Promise<TResult>;
}

export interface ToolCallRecord {
  readonly toolName: string;
  readonly argsHash: string;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly failure?: ToolFailure;
}

/**
 * A post-checker inspects a completed call before its result is handed back to
 * the agent. Returning a failure blocks the call — this is where claim
 * anchoring and disclosure enforcement live (phase 3).
 */
export interface PostChecker {
  readonly name: string;
  check(input: {
    readonly tool: string;
    readonly args: unknown;
    readonly result: unknown;
    readonly context: ToolContext;
  }):
    { readonly ok: true } | { readonly ok: false; readonly code: string; readonly reason: string };
}

export function hashArgs(args: unknown): string {
  return createHash('sha256').update(canonicalJson(args)).digest('hex').slice(0, 32);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyToolDefinition = ToolDefinition<z.ZodTypeAny, any>;

export class ToolRegistry {
  private readonly tools = new Map<string, AnyToolDefinition>();
  private readonly postCheckers: PostChecker[] = [];
  private readonly calls: ToolCallRecord[] = [];

  register<TArgs extends z.ZodTypeAny, TResult>(tool: ToolDefinition<TArgs, TResult>): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool as AnyToolDefinition);
    return this;
  }

  addPostChecker(checker: PostChecker): this {
    this.postCheckers.push(checker);
    return this;
  }

  names(): string[] {
    return [...this.tools.keys()].sort();
  }

  /** The tool catalogue an LLM is shown. Descriptions only — never handlers. */
  catalogue(): Array<{ name: string; description: string; customerFacing: boolean }> {
    return this.names().map((name) => {
      const tool = this.tools.get(name) as AnyToolDefinition;
      return {
        name: tool.name,
        description: tool.description,
        customerFacing: tool.customerFacing,
      };
    });
  }

  /** Calls recorded so far; the agent runtime writes these to the audit log. */
  history(): readonly ToolCallRecord[] {
    return this.calls;
  }

  async invoke(
    toolName: string,
    rawArgs: unknown,
    context: ToolContext,
  ): Promise<Result<unknown, ToolFailure>> {
    const started = Date.now();
    const tool = this.tools.get(toolName);

    if (tool === undefined) {
      const failure: ToolFailure = { kind: 'UNKNOWN_TOOL', toolName };
      this.record(toolName, rawArgs, started, failure);
      return err(failure);
    }

    const parsed = tool.args.safeParse(rawArgs);
    if (!parsed.success) {
      const failure: ToolFailure = {
        kind: 'INVALID_ARGS',
        toolName,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      };
      this.record(toolName, rawArgs, started, failure);
      return err(failure);
    }

    let result: unknown;
    try {
      result = await tool.handler(parsed.data, context);
    } catch (error) {
      const failure: ToolFailure = {
        kind: 'THREW',
        toolName,
        message: error instanceof Error ? error.message : String(error),
      };
      this.record(toolName, parsed.data, started, failure);
      return err(failure);
    }

    for (const checker of this.postCheckers) {
      const verdict = checker.check({ tool: toolName, args: parsed.data, result, context });
      if (!verdict.ok) {
        const failure: ToolFailure = {
          kind: 'BLOCKED',
          toolName,
          code: verdict.code,
          reason: `${checker.name}: ${verdict.reason}`,
        };
        this.record(toolName, parsed.data, started, failure);
        return err(failure);
      }
    }

    this.record(toolName, parsed.data, started);
    return ok(result);
  }

  private record(toolName: string, args: unknown, started: number, failure?: ToolFailure): void {
    this.calls.push({
      toolName,
      argsHash: hashArgs(args),
      ok: failure === undefined,
      durationMs: Date.now() - started,
      ...(failure === undefined ? {} : { failure }),
    });
  }
}
