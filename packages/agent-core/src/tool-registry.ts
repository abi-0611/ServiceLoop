import type { LlmToolDefinition } from '@serviceloop/adapters';
import { zodToJsonSchema } from '@serviceloop/adapters';
import { canonicalJson, type Language, type Result, err, ok } from '@serviceloop/shared';
import { createHash } from 'node:crypto';
import type { z } from 'zod';

/**
 * Typed tool registry (master §6 — "the agent acts only through typed tools").
 *
 * A tool declares a zod schema for its arguments; the registry is the only way
 * to invoke one, and it validates before the handler ever runs. An agent that
 * hallucinates an argument shape gets a typed rejection, not a partial effect.
 *
 * The same zod schema becomes the JSON Schema the model is shown, so the shape
 * a tool advertises and the shape it accepts cannot drift.
 *
 * The invariant every phase-3 tool inherits: validate, execute, post-check,
 * record.
 */

export interface ToolContext {
  readonly shopId: string;
  readonly traceId: string;
  readonly actorId: string | null;
  /** Hash of the prompt that produced this call, for the audit record. */
  readonly promptHash: string;
  /** The run this call belongs to, so every effect is attributable. */
  readonly runId: string;
  readonly conversationId: string;
  readonly customerId: string | null;
  readonly jobCardId: string | null;
  readonly language: Language;
  /**
   * Per-run scratch space. Candidates composed but not yet sent live here, and
   * so does the objective's completion signal — the runtime reads it rather
   * than trusting the model's own account of what it achieved.
   */
  readonly state: RunState;
}

/**
 * Mutable per-run state the tools share.
 *
 * Deliberately small and deliberately not persisted: a candidate that was
 * composed and never sent is not a fact about the world, and the audit trail
 * records the compose call itself. What *is* persisted is every send, every
 * decision and every handoff — through their own services, transactionally.
 */
export class RunState {
  private readonly candidates = new Map<string, unknown>();
  private readonly notes: string[] = [];
  private readonly concessions = new Map<
    string,
    { readonly lineId: string; readonly description: string; readonly newPaise: number }
  >();
  /** Set by any tool that reaches a person: handoff, or an advisor task. */
  handedOff = false;
  /** Set by `send_customer_message` when the gate held the draft for HITL. */
  heldForReview = false;

  putCandidate(id: string, value: unknown): void {
    this.candidates.set(id, value);
  }

  candidate(id: string): unknown {
    return this.candidates.get(id);
  }

  addNote(note: string): void {
    this.notes.push(note);
  }

  /**
   * A concession `adjust_offer` accepted, and the source id under which the
   * agent may quote it.
   *
   * The guardrail that approved the price *is* the evidence for it. Without
   * this, an agent that legitimately negotiated a discount could not then state
   * the number, because the only price on file would be the original — which
   * would leave it either silent or blocked, and neither is the shop's intent.
   */
  recordConcession(input: {
    readonly lineId: string;
    readonly description: string;
    readonly newPaise: number;
  }): void {
    this.concessions.set(`line:${input.lineId}@agreed`, input);
  }

  agreedPrices(): ReadonlyMap<
    string,
    { readonly lineId: string; readonly description: string; readonly newPaise: number }
  > {
    return this.concessions;
  }

  allNotes(): readonly string[] {
    return [...this.notes];
  }
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
 * A registry-level check that inspects a *completed* call before its result is
 * handed back to the agent. Returning a failure blocks the call.
 *
 * Distinct from `PostChecker` in `post-checker.ts`, which reviews a composed
 * *message*: this one is a cheap cross-cutting invariant over any tool, that
 * one is the claim-anchoring machinery L7 demands. Both exist; only one of them
 * needs a model.
 */
export interface ToolInvariant {
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
  private readonly invariants: ToolInvariant[] = [];
  private readonly calls: ToolCallRecord[] = [];

  register<TArgs extends z.ZodTypeAny, TResult>(tool: ToolDefinition<TArgs, TResult>): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool as AnyToolDefinition);
    return this;
  }

  addInvariant(invariant: ToolInvariant): this {
    this.invariants.push(invariant);
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

  /**
   * The tool definitions sent to the model, built from the same zod schemas the
   * registry validates against.
   *
   * `only` narrows the catalogue to an objective's permitted set: an objective
   * that has no business recording a decision should not be shown a tool that
   * records one, because the cheapest way to stop a mistake is to make it
   * unrepresentable.
   */
  definitions(only?: readonly string[]): readonly LlmToolDefinition[] {
    const permitted = only === undefined ? null : new Set(only);
    return this.names()
      .filter((name) => permitted === null || permitted.has(name))
      .map((name) => {
        const tool = this.tools.get(name) as AnyToolDefinition;
        return {
          name: tool.name,
          description: tool.description,
          inputSchema: zodToJsonSchema(tool.args),
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

    for (const checker of this.invariants) {
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
