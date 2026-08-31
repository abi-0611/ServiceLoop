import type { LlmContent, LlmMessage, LlmPort, LlmToolCall } from '@serviceloop/adapters';
import type { ShopConfig } from '@serviceloop/config';
import type {
  AgentRunStore,
  AgentStepRecord,
  ConversationStore,
  JobCardContext,
  MessageSnapshot,
  UnitOfWork,
} from '@serviceloop/domain';
import {
  systemClock,
  uuidv7,
  type AgentObjective,
  type AgentRunOutcome,
  type Clock,
  type EventEnvelope,
  type Language,
} from '@serviceloop/shared';
import type { AuditAppender, OutboxWriter } from '@serviceloop/domain';
import { objectiveSpec, type ObjectiveSpec } from './objectives';
import { assemblePrompt, buildAgentPromptSections, type ShopProfile } from './prompt';
import { RunState, type ToolContext, type ToolRegistry } from './tool-registry';

/**
 * `AgentRunner` — the deterministic outer loop (phase 3.2).
 *
 * Plain TypeScript, no agent framework. The loop is:
 *
 *     assemble prompt → LLM → validate tool calls → execute through the
 *     registry → append results → repeat
 *
 * with hard caps on steps, tokens and wall clock, and a terminal report of
 * `objective_met | handoff | blocked | budget_exhausted`.
 *
 * Three properties make it auditable rather than merely functional:
 *
 *   - **Every step is persisted before the next begins.** A process that dies
 *     mid-run leaves a complete record of everything it had already decided,
 *     and `replay()` over that record reproduces the identical tool calls.
 *   - **The runtime, not the model, decides the objective is met.** Completion
 *     is observed from a *successful* invocation of one of the objective's
 *     `metWhen` tools. A model that announces success having sent nothing ends
 *     the run as `budget_exhausted`, which is the truth.
 *   - **A human message aborts the run.** The conversation's `humanOverrideAt`
 *     is re-read before every step; a person taking the wheel stops the agent
 *     mid-loop and the run is recorded as ABORTED, not FAILED (L6).
 */

export interface AgentRunnerDeps<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly llm: LlmPort;
  readonly runs: AgentRunStore<Tx>;
  readonly conversations: ConversationStore<Tx>;
  readonly registry: ToolRegistry;
  readonly audit: AuditAppender<Tx>;
  readonly outbox: OutboxWriter<Tx>;
  readonly clock?: Clock;
}

export interface RunRequest {
  readonly shopId: string;
  readonly objective: AgentObjective;
  readonly conversationId: string;
  readonly customerId: string | null;
  readonly jobCardId: string | null;
  /** The inbound message that triggered this. Doubles as the run's idempotency key. */
  readonly triggerMessageId: string | null;
  readonly traceId: string;
  readonly config: ShopConfig;
  readonly shop: ShopProfile;
  readonly card: JobCardContext | null;
  readonly conversationTail: readonly MessageSnapshot[];
  readonly sources: readonly { readonly id: string; readonly text: string }[];
  readonly language: Language;
  readonly customerName: string;
  readonly actorId?: string | null;
}

export interface RunReport {
  readonly runId: string;
  readonly outcome: AgentRunOutcome;
  readonly steps: number;
  readonly reason: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Present when the run never started because one was already running. */
  readonly skipped?: 'DUPLICATE_TRIGGER' | 'ALREADY_RUNNING' | 'HUMAN_OVERRIDE';
}

export class AgentRunner<Tx> {
  private readonly clock: Clock;

  constructor(private readonly deps: AgentRunnerDeps<Tx>) {
    this.clock = deps.clock ?? systemClock;
  }

  async run(request: RunRequest): Promise<RunReport> {
    const spec = objectiveSpec(request.objective);
    const caps = request.config.agent;
    const runId = uuidv7();
    const startedAt = this.clock.now();

    const sections = buildAgentPromptSections({
      shop: request.shop,
      config: request.config,
      objective: spec,
      card: request.card,
      conversationTail: request.conversationTail,
      sources: request.sources,
      threadLanguage: request.language,
      customerName: request.customerName,
    });
    const prompt = assemblePrompt(sections);
    const model = this.deps.llm.modelFor('AGENT');

    const opened = await this.deps.uow.transaction(async (tx) => {
      const conversation = await this.deps.conversations.findById(
        tx,
        request.shopId,
        request.conversationId,
      );
      // A human already has the wheel. Starting a run to be aborted on its
      // first step would burn a model call to learn what is already known.
      if (conversation?.humanOverrideAt != null) return { blocked: 'HUMAN_OVERRIDE' as const };

      const active = await this.deps.runs.activeRunIds(tx, request.shopId, request.conversationId);
      if (active.length > 0) return { blocked: 'ALREADY_RUNNING' as const };

      const id = await this.deps.runs.start(tx, {
        id: runId,
        shopId: request.shopId,
        objective: request.objective,
        conversationId: request.conversationId,
        jobCardId: request.jobCardId,
        customerId: request.customerId,
        approvalRequestId: null,
        triggerMessageId: request.triggerMessageId,
        maxSteps: caps.maxSteps,
        model,
        promptContext: {
          sections: [...prompt.sections],
          promptHash: prompt.hash,
          objective: request.objective,
          tools: [...spec.tools],
          maxSteps: caps.maxSteps,
          wallClockBudgetMs: caps.wallClockBudgetMs,
          maxTokensPerRun: caps.maxTokensPerRun,
          sourceIds: request.sources.map((source) => source.id),
        },
        startedAt,
      });

      if (id === null) return { blocked: 'DUPLICATE_TRIGGER' as const };

      const envelope: EventEnvelope = {
        id: uuidv7(),
        type: 'agent.run_started',
        occurredAt: startedAt.toISOString(),
        shopId: request.shopId,
        traceId: request.traceId,
        payload: {
          runId,
          objective: request.objective,
          conversationId: request.conversationId,
          jobCardId: request.jobCardId,
          promptHash: prompt.hash,
          actor: { type: 'AGENT', id: request.actorId ?? null },
        },
      };
      await this.deps.outbox.enqueue(tx, envelope);

      await this.deps.audit.append(tx, {
        shopId: request.shopId,
        actorType: 'AGENT',
        actorId: request.actorId ?? null,
        action: 'agent.run_started',
        entityType: 'AgentRun',
        entityId: runId,
        payload: {
          objective: request.objective,
          conversationId: request.conversationId,
          jobCardId: request.jobCardId,
          promptHash: prompt.hash,
          model,
          sections: [...prompt.sections],
        },
        traceId: request.traceId,
      });

      return { blocked: null };
    });

    if (opened.blocked !== null) {
      return {
        runId,
        outcome: 'blocked',
        steps: 0,
        reason: describeBlock(opened.blocked),
        inputTokens: 0,
        outputTokens: 0,
        skipped: opened.blocked,
      };
    }

    return this.loop(request, spec, runId, prompt, model, startedAt);
  }

  private async loop(
    request: RunRequest,
    spec: ObjectiveSpec,
    runId: string,
    prompt: { readonly text: string; readonly hash: string },
    model: string,
    startedAt: Date,
  ): Promise<RunReport> {
    const caps = request.config.agent;
    const state = new RunState();
    const transcript: LlmMessage[] = [];
    const definitions = this.deps.registry.definitions(spec.tools);

    let steps = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let outcome: AgentRunOutcome = 'budget_exhausted';
    let reason: string | null = null;

    for (let step = 0; step < caps.maxSteps; step += 1) {
      // Re-read before every step: a person who replied while the previous step
      // was running has taken the wheel, and the agent must not talk over them.
      const overridden = await this.deps.uow.transaction(async (tx) => {
        const conversation = await this.deps.conversations.findById(
          tx,
          request.shopId,
          request.conversationId,
        );
        return conversation?.humanOverrideAt != null;
      });

      if (overridden) {
        await this.abort(request, runId, 'A human advisor replied while the run was in progress');
        return {
          runId,
          outcome: 'handoff',
          steps,
          reason: 'A human advisor replied while the run was in progress',
          inputTokens,
          outputTokens,
          skipped: 'HUMAN_OVERRIDE',
        };
      }

      const elapsed = this.clock.now().getTime() - startedAt.getTime();
      if (elapsed > caps.wallClockBudgetMs) {
        reason = `Wall-clock budget of ${caps.wallClockBudgetMs}ms exhausted after ${steps} step(s)`;
        break;
      }
      if (inputTokens + outputTokens > caps.maxTokensPerRun) {
        reason = `Token budget of ${caps.maxTokensPerRun} exhausted after ${steps} step(s)`;
        break;
      }

      const stepStarted = Date.now();
      const completion = await this.deps.llm.complete({
        taskClass: 'AGENT',
        system: prompt.text,
        messages: transcript.length === 0 ? [FIRST_TURN] : transcript,
        tools: definitions,
        toolChoice: { kind: 'auto' },
        traceId: request.traceId,
        shopId: request.shopId,
        agentRunId: runId,
      });

      steps += 1;
      inputTokens += completion.usage.inputTokens;
      outputTokens += completion.usage.outputTokens;

      const toolContext: ToolContext = {
        shopId: request.shopId,
        traceId: request.traceId,
        actorId: request.actorId ?? null,
        promptHash: prompt.hash,
        runId,
        conversationId: request.conversationId,
        customerId: request.customerId,
        jobCardId: request.jobCardId,
        language: request.language,
        state,
      };

      const executed = await this.executeCalls(completion.toolCalls, spec, toolContext);

      await this.persistStep(request, {
        runId,
        shopId: request.shopId,
        stepIndex: step,
        promptHash: prompt.hash,
        model,
        responseText: completion.text.length === 0 ? null : completion.text,
        toolCalls: completion.toolCalls.map((call) => ({ name: call.name, args: call.args })),
        toolResults: executed.map((entry) => ({
          name: entry.name,
          ok: entry.ok,
          result: entry.result,
        })),
        checkerVerdicts: executed.flatMap((entry) => entry.verdicts),
        inputTokens: completion.usage.inputTokens,
        outputTokens: completion.usage.outputTokens,
        latencyMs: Date.now() - stepStarted,
      });

      // A turn with no tool call is a model thinking out loud. It costs a step
      // and changes nothing, so the loop simply carries on — but if it is the
      // *only* thing that ever happens, the run ends budget-exhausted, which is
      // an accurate description of what occurred.
      if (completion.toolCalls.length > 0) {
        transcript.push(
          { role: 'assistant', content: assistantBlocks(completion.text, completion.toolCalls) },
          { role: 'user', content: executed.map((entry) => entry.block) },
        );
      } else if (completion.text.length > 0) {
        transcript.push(
          { role: 'assistant', content: [{ kind: 'text', text: completion.text }] },
          {
            role: 'user',
            content: [
              {
                kind: 'text',
                text: 'That was not a tool call, so nothing happened. Call a tool or hand off.',
              },
            ],
          },
        );
      }

      if (state.handedOff) {
        outcome = 'handoff';
        reason = 'The agent handed the conversation to an advisor';
        break;
      }

      const met = executed.find((entry) => entry.ok && spec.metWhen.includes(entry.name));
      if (met !== undefined) {
        outcome = 'objective_met';
        reason = null;
        break;
      }

      // A customer-facing tool that was blocked by the checker or the gate ends
      // the run: retrying the same send with the same evidence would produce the
      // same block, and the advisor already has the draft.
      const blocked = executed.find((entry) => entry.blockedToHitl);
      if (blocked !== undefined) {
        outcome = 'blocked';
        reason = blocked.blockedReason;
        break;
      }
    }

    if (steps >= caps.maxSteps && outcome === 'budget_exhausted' && reason === null) {
      reason = `Step cap of ${caps.maxSteps} reached without meeting the objective`;
    }

    await this.finish(request, runId, { outcome, steps, reason, inputTokens, outputTokens });
    return { runId, outcome, steps, reason, inputTokens, outputTokens };
  }

  /**
   * Executes a turn's tool calls in order.
   *
   * A call to a tool this objective may not use is refused *here* rather than
   * left to the registry, so the refusal names the objective — which is the
   * information the model needs to pick a different action.
   */
  private async executeCalls(
    calls: readonly LlmToolCall[],
    spec: ObjectiveSpec,
    context: ToolContext,
  ): Promise<readonly ExecutedCall[]> {
    const executed: ExecutedCall[] = [];

    for (const call of calls) {
      if (!spec.tools.includes(call.name)) {
        const detail = `"${call.name}" is not available for the ${spec.key} objective. Available: ${spec.tools.join(', ')}.`;
        executed.push({
          name: call.name,
          ok: false,
          result: { refused: true, code: 'TOOL_NOT_PERMITTED', reason: detail },
          verdicts: [
            { checker: 'objective-scope', ok: false, code: 'TOOL_NOT_PERMITTED', reason: detail },
          ],
          blockedToHitl: false,
          blockedReason: '',
          block: toolResultBlock(call.id, detail, true),
        });
        continue;
      }

      const result = await this.deps.registry.invoke(call.name, call.args, context);

      if (!result.ok) {
        const detail = describeFailure(result.error);
        executed.push({
          name: call.name,
          ok: false,
          result: result.error,
          verdicts: [
            {
              checker: 'tool-registry',
              ok: false,
              code: result.error.kind,
              reason: detail,
            },
          ],
          blockedToHitl: false,
          blockedReason: '',
          block: toolResultBlock(call.id, detail, true),
        });
        continue;
      }

      const value = result.value as Record<string, unknown> | null;
      const refused = value !== null && value['refused'] === true;
      const blockedToHitl = refused && value?.['code'] === 'BLOCKED_TO_HITL';

      executed.push({
        name: call.name,
        ok: !refused,
        result: value,
        verdicts: refused
          ? [
              {
                checker: 'tool-guardrail',
                ok: false,
                code: String(value['code'] ?? 'REFUSED'),
                reason: String(value['reason'] ?? ''),
              },
            ]
          : [],
        blockedToHitl,
        blockedReason: blockedToHitl ? String(value['reason'] ?? '') : '',
        block: toolResultBlock(call.id, JSON.stringify(value), refused),
      });
    }

    return executed;
  }

  private async persistStep(request: RunRequest, step: AgentStepRecord): Promise<void> {
    await this.deps.uow.transaction(async (tx) => {
      await this.deps.runs.appendStep(tx, step);
      await this.deps.audit.append(tx, {
        shopId: request.shopId,
        actorType: 'AGENT',
        actorId: request.actorId ?? null,
        action: 'agent.step',
        entityType: 'AgentRun',
        entityId: step.runId,
        payload: {
          stepIndex: step.stepIndex,
          promptHash: step.promptHash,
          toolCalls: step.toolCalls.map((call) => call.name),
          toolResults: step.toolResults.map((result) => ({
            name: result.name,
            ok: result.ok,
          })),
          checkerVerdicts: step.checkerVerdicts,
          inputTokens: step.inputTokens,
          outputTokens: step.outputTokens,
        },
        traceId: request.traceId,
      });
    });
  }

  private async finish(
    request: RunRequest,
    runId: string,
    result: {
      readonly outcome: AgentRunOutcome;
      readonly steps: number;
      readonly reason: string | null;
      readonly inputTokens: number;
      readonly outputTokens: number;
    },
  ): Promise<void> {
    const now = this.clock.now();

    await this.deps.uow.transaction(async (tx) => {
      await this.deps.runs.finish(tx, {
        runId,
        outcome: result.outcome,
        stepCount: result.steps,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        reason: result.reason,
        finishedAt: now,
      });

      await this.deps.audit.append(tx, {
        shopId: request.shopId,
        actorType: 'AGENT',
        actorId: request.actorId ?? null,
        action: 'agent.run_finished',
        entityType: 'AgentRun',
        entityId: runId,
        payload: {
          objective: request.objective,
          outcome: result.outcome,
          steps: result.steps,
          reason: result.reason,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        },
        traceId: request.traceId,
      });

      const envelope: EventEnvelope = {
        id: uuidv7(),
        type: 'agent.run_finished',
        occurredAt: now.toISOString(),
        shopId: request.shopId,
        traceId: request.traceId,
        payload: {
          runId,
          objective: request.objective,
          conversationId: request.conversationId,
          outcome: result.outcome,
          steps: result.steps,
          reason: result.reason,
          actor: { type: 'AGENT', id: request.actorId ?? null },
        },
      };
      await this.deps.outbox.enqueue(tx, envelope);
    });
  }

  private async abort(request: RunRequest, runId: string, reason: string): Promise<void> {
    const now = this.clock.now();
    await this.deps.uow.transaction(async (tx) => {
      await this.deps.runs.abort(tx, runId, reason, now);
      await this.deps.audit.append(tx, {
        shopId: request.shopId,
        actorType: 'AGENT',
        actorId: request.actorId ?? null,
        action: 'agent.run_aborted',
        entityType: 'AgentRun',
        entityId: runId,
        payload: { objective: request.objective, reason },
        traceId: request.traceId,
      });
    });
  }

  /**
   * Replays a persisted run: the tool calls it made, in order.
   *
   * The point is not to re-execute anything — the effects already happened —
   * but to prove the record is complete enough to reconstruct the decision. A
   * replay that does not match the original is a persistence bug, and it is
   * better found by a test than by a regulator.
   */
  async replay(
    shopId: string,
    runId: string,
  ): Promise<readonly { readonly name: string; readonly args: unknown }[]> {
    const steps = await this.deps.uow.transaction(async (tx) =>
      this.deps.runs.loadSteps(tx, shopId, runId),
    );
    return steps.flatMap((step) =>
      step.toolCalls.map((call: { readonly name: string; readonly args: unknown }) => ({
        name: call.name,
        args: call.args,
      })),
    );
  }
}

interface ExecutedCall {
  readonly name: string;
  readonly ok: boolean;
  readonly result: unknown;
  readonly verdicts: readonly {
    readonly checker: string;
    readonly ok: boolean;
    readonly code: string | null;
    readonly reason: string | null;
  }[];
  readonly blockedToHitl: boolean;
  readonly blockedReason: string;
  readonly block: LlmContent;
}

/**
 * The opening turn.
 *
 * Deliberately terse. Everything the agent needs is in the system prompt; a
 * chatty first user message would only add tokens and a second voice.
 */
const FIRST_TURN: LlmMessage = {
  role: 'user',
  content: [{ kind: 'text', text: 'Begin. Call the tools you need.' }],
};

function assistantBlocks(text: string, calls: readonly LlmToolCall[]): readonly LlmContent[] {
  const blocks: LlmContent[] = [];
  if (text.length > 0) blocks.push({ kind: 'text', text });
  for (const call of calls) {
    blocks.push({ kind: 'tool_use', id: call.id, name: call.name, args: call.args });
  }
  return blocks;
}

function toolResultBlock(toolUseId: string, content: string, isError: boolean): LlmContent {
  return { kind: 'tool_result', toolUseId, content, isError };
}

function describeFailure(error: {
  readonly kind: string;
  readonly toolName?: string;
  readonly issues?: ReadonlyArray<{ path: string; message: string }>;
  readonly reason?: string;
  readonly message?: string;
}): string {
  switch (error.kind) {
    case 'INVALID_ARGS':
      return `Invalid arguments for ${error.toolName}: ${(error.issues ?? [])
        .map((issue) => `${issue.path} — ${issue.message}`)
        .join('; ')}`;
    case 'UNKNOWN_TOOL':
      return `There is no tool called ${error.toolName}.`;
    case 'BLOCKED':
      return `${error.toolName} was blocked: ${error.reason ?? ''}`;
    default:
      return `${error.toolName} failed: ${error.message ?? 'unknown error'}`;
  }
}

function describeBlock(kind: 'DUPLICATE_TRIGGER' | 'ALREADY_RUNNING' | 'HUMAN_OVERRIDE'): string {
  switch (kind) {
    case 'DUPLICATE_TRIGGER':
      return 'A run for this trigger message already exists; the delivery was a duplicate';
    case 'ALREADY_RUNNING':
      return 'Another run is already active on this conversation';
    case 'HUMAN_OVERRIDE':
      return 'A human advisor has taken over this thread';
  }
}
