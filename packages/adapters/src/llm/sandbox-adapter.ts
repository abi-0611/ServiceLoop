import { createHash } from 'node:crypto';
import type { LlmTaskClass } from '@serviceloop/shared';
import { JOB_CARD_DRAFT_SCHEMA_NAME } from './schemas';
import { extractDraftFromText } from './heuristic-draft';
import {
  extractFencedPayload,
  hashPrompt,
  LlmError,
  requestImage,
  requestPayload,
  requestText,
  type LlmCompletion,
  type LlmExtraction,
  type LlmExtractionRequest,
  type LlmPort,
  type LlmRequest,
  type LlmToolCall,
} from './port';

/**
 * `SandboxLlmAdapter` — a deterministic LlmPort with no credentials.
 *
 * Sandbox adapters are the development backbone, not throwaways (master §5), so
 * this one does real work: the same request always produces the same answer,
 * job-card extraction runs the heuristic parser, image extraction resolves
 * against registered fixtures by content hash, and a responder may answer with
 * **tool calls**, which is what lets a scripted agent run drive the real outer
 * loop rather than a stub of it.
 *
 * Determinism is the contract. Nothing here consults a clock or a random
 * source, so a failing CI run reproduces exactly on a developer's machine.
 */

/** What a responder may answer with: prose, tool calls, or both. */
export interface SandboxReply {
  readonly text?: string;
  readonly toolCalls?: readonly { readonly name: string; readonly args: unknown }[];
}

export interface LlmResponder {
  readonly name: string;
  /** `schemaName` is null for `complete`, the schema's name for `extract`. */
  matches(request: LlmRequest, schemaName: string | null): boolean;
  /** Prose and/or tool calls. Required when the responder handles `complete`. */
  complete?(request: LlmRequest): string | SandboxReply;
  /**
   * A value that must satisfy the request's schema. Returning something that
   * does not is a `SCHEMA_MISMATCH`, exactly as it would be from a real model —
   * the sandbox is held to the same contract it is standing in for.
   */
  extract?(request: LlmRequest): unknown;
}

export interface SandboxLlmOptions {
  readonly models?: Partial<Readonly<Record<LlmTaskClass, string>>>;
  /** Prepended to the built-in responders, so a test can override any of them. */
  readonly responders?: readonly LlmResponder[];
}

const DEFAULT_MODELS: Readonly<Record<LlmTaskClass, string>> = {
  AGENT: 'sandbox-agent',
  CLASSIFY: 'sandbox-classify',
  EXTRACT: 'sandbox-extract',
  JUDGE: 'sandbox-judge',
};

export class SandboxLlmAdapter implements LlmPort {
  readonly driver = 'sandbox' as const;

  private readonly responders: LlmResponder[];
  private readonly fixtures = new Map<string, unknown>();
  private readonly models: Readonly<Record<LlmTaskClass, string>>;
  /** Every call, in order — the simulator's pipeline trace reads this. */
  private readonly calls: Array<{
    taskClass: LlmTaskClass;
    schema: string | null;
    responder: string;
  }> = [];

  constructor(options: SandboxLlmOptions = {}) {
    this.models = { ...DEFAULT_MODELS, ...options.models };
    this.responders = [...(options.responders ?? []), ...this.builtinResponders()];
  }

  modelFor(taskClass: LlmTaskClass): string {
    return this.models[taskClass];
  }

  /**
   * Registers the expected extraction for a specific image.
   *
   * The OCR eval harness and the seeded demo both use this: a fixture PNG goes
   * in with its expected `JobCardDraft`, and every later request carrying those
   * exact bytes resolves to it. Keyed on content, not filename, so a fixture
   * that is re-encoded stops matching instead of silently drifting.
   */
  registerImageFixture(bytes: Buffer, value: unknown): void {
    this.fixtures.set(sha256(bytes), value);
  }

  registerResponder(responder: LlmResponder): void {
    this.responders.unshift(responder);
  }

  /** Ordered log of what answered what. Cleared by `resetCalls()`. */
  recordedCalls(): ReadonlyArray<{
    taskClass: LlmTaskClass;
    schema: string | null;
    responder: string;
  }> {
    return [...this.calls];
  }

  resetCalls(): void {
    this.calls.length = 0;
  }

  async complete(request: LlmRequest): Promise<LlmCompletion> {
    const responder = this.responders.find(
      (candidate) => candidate.complete !== undefined && candidate.matches(request, null),
    );
    if (responder?.complete === undefined) {
      throw new LlmError('NO_RESPONDER', 'No sandbox responder handles this completion request', {
        model: this.modelFor(request.taskClass),
        context: { taskClass: request.taskClass },
      });
    }

    this.calls.push({ taskClass: request.taskClass, schema: null, responder: responder.name });
    const reply = responder.complete(request);
    const normalised: SandboxReply = typeof reply === 'string' ? { text: reply } : reply;

    const toolCalls: LlmToolCall[] = (normalised.toolCalls ?? []).map((call, index) => ({
      // Deterministic ids: a replay must produce byte-identical steps, which a
      // random id would quietly break.
      id: `sandbox_tool_${this.calls.length}_${index}`,
      name: call.name,
      args: call.args,
    }));

    return this.completion(request, normalised.text ?? '', toolCalls, null);
  }

  async extract<T>(request: LlmExtractionRequest<T>): Promise<LlmExtraction<T>> {
    const image = requestImage(request);
    const fixture = image === null ? undefined : this.fixtures.get(sha256(image.bytes));

    let raw: unknown;
    let responderName: string;

    if (fixture !== undefined) {
      raw = fixture;
      responderName = 'image-fixture';
    } else {
      const responder = this.responders.find(
        (candidate) =>
          candidate.extract !== undefined && candidate.matches(request, request.schema.name),
      );
      if (responder?.extract === undefined) {
        throw new LlmError(
          'NO_RESPONDER',
          `No sandbox responder handles extraction of "${request.schema.name}"`,
          { model: this.modelFor(request.taskClass), context: { schema: request.schema.name } },
        );
      }
      raw = responder.extract(request);
      responderName = responder.name;
    }

    this.calls.push({
      taskClass: request.taskClass,
      schema: request.schema.name,
      responder: responderName,
    });

    let value: T;
    try {
      value = request.schema.parse(raw);
    } catch (error) {
      throw new LlmError(
        'SCHEMA_MISMATCH',
        `Sandbox responder "${responderName}" produced a value that does not satisfy "${request.schema.name}": ${
          error instanceof Error ? error.message : String(error)
        }`,
        { model: this.modelFor(request.taskClass) },
      );
    }

    const text = JSON.stringify(value);
    return {
      ...this.completion(request, text, [], request.schema.name),
      value,
      raw: text,
    };
  }

  private completion(
    request: LlmRequest,
    text: string,
    toolCalls: readonly LlmToolCall[],
    schemaName: string | null,
  ): LlmCompletion {
    return {
      text,
      toolCalls,
      model: this.modelFor(request.taskClass),
      taskClass: request.taskClass,
      usage: {
        // Four characters per token is the usual rough ratio. Deterministic
        // numbers matter more here than accurate ones: the cost-metering tests
        // need a stable value, not a real one.
        inputTokens: Math.ceil(approximateChars(request) / 4),
        outputTokens: Math.ceil((text.length + JSON.stringify(toolCalls).length) / 4),
      },
      latencyMs: 0,
      attempts: 1,
      stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
      promptHash: hashPrompt(request, schemaName ?? undefined),
    };
  }

  private builtinResponders(): LlmResponder[] {
    return [
      {
        name: 'heuristic-job-card',
        matches: (_request, schemaName) => schemaName === JOB_CARD_DRAFT_SCHEMA_NAME,
        extract: (request) => {
          // The *payload*, not the prompt: reading the instructions along with
          // the message would have this parser extracting a job card out of its
          // own few-shot examples.
          const text = requestPayload(request);
          if (
            requestImage(request) !== null &&
            extractFencedPayload(requestText(request)) === null
          ) {
            // An unregistered photo. Refusing loudly beats inventing a card:
            // "the sandbox has no fixture for this image" is a fixable message,
            // a fabricated customer is a corrupted database.
            throw new LlmError(
              'NO_RESPONDER',
              'No fixture is registered for this image; register one with registerImageFixture()',
              { model: this.modelFor(request.taskClass) },
            );
          }
          return extractDraftFromText(text).draft;
        },
      },
      {
        name: 'echo',
        matches: () => true,
        complete: (request) => {
          const text = requestText(request).trim();
          return text.length === 0
            ? 'sandbox: no input'
            : `sandbox(${request.taskClass}): ${text.slice(0, 400)}`;
        },
      },
    ];
  }
}

function approximateChars(request: LlmRequest): number {
  let total = (request.system ?? '').length;
  for (const message of request.messages) {
    for (const block of message.content) {
      switch (block.kind) {
        case 'text':
          total += block.text.length;
          break;
        // A full-page photo lands around 1,500 tokens on current vision models.
        case 'image':
          total += 6_000;
          break;
        case 'tool_use':
          total += JSON.stringify(block.args ?? null).length;
          break;
        case 'tool_result':
          total += block.content.length;
          break;
      }
    }
  }
  for (const tool of request.tools ?? []) {
    total += tool.description.length + JSON.stringify(tool.inputSchema).length;
  }
  return total;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
