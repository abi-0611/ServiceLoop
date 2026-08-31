import Anthropic from '@anthropic-ai/sdk';
import type { LlmTaskClass } from '@serviceloop/shared';
import {
  DEFAULT_RETRY_POLICY,
  hashPrompt,
  LlmError,
  parseJsonObject,
  retryDelayMs,
  type LlmCompletion,
  type LlmContent,
  type LlmExtraction,
  type LlmExtractionRequest,
  type LlmMessage,
  type LlmPort,
  type LlmRequest,
  type LlmToolCall,
  type RetryPolicy,
} from './port';

/**
 * `AnthropicLlmAdapter` — the real LlmPort, over the Claude Messages API.
 *
 * Two deliberate restraints on the request surface:
 *
 * 1. **Sampling parameters only when a shop asks for one.** `temperature` is
 *    rejected outright by some current Claude models and never guaranteed
 *    determinism on the older ones, so the default is to send none at all —
 *    the one request shape that is valid everywhere. A shop that has a model
 *    which takes it, and a reason to move it, sets `LLM_<CLASS>_TEMPERATURE`
 *    and this adapter forwards it.
 * 2. **No `thinking` or `effort` field.** Model ids are shop configuration
 *    (master §10), so this adapter cannot know which generation it is talking
 *    to — and both fields are rejected by *some* current model. Omitting them
 *    lets each model apply its own default. If a shop wants deeper reasoning it
 *    picks a model that reasons.
 *
 * Structured extraction goes through `output_config.format`, so the JSON comes
 * back constrained rather than coaxed. The response is still validated by the
 * schema's own `parse` before anything downstream sees it.
 */

export interface AnthropicLlmConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  /** Model id per task class (master §10 — never hardcoded). */
  readonly models: Readonly<Record<LlmTaskClass, string>>;
  /** Optional per-class temperature. Absent means "send none". */
  readonly temperatures?: Partial<Readonly<Record<LlmTaskClass, number>>>;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  readonly retry?: RetryPolicy;
}

/**
 * Above roughly 16k output tokens a non-streaming request risks the SDK's HTTP
 * timeout, so anything larger is streamed and reassembled.
 */
const STREAMING_THRESHOLD_TOKENS = 16_000;

export interface AnthropicAdapterOptions {
  readonly client?: Anthropic;
  /** Injected so retry tests run in microseconds rather than seconds. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

export class AnthropicLlmAdapter implements LlmPort {
  readonly driver = 'anthropic' as const;
  private readonly client: Anthropic;
  private readonly retry: RetryPolicy;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(
    private readonly config: AnthropicLlmConfig,
    options: AnthropicAdapterOptions = {},
  ) {
    this.client =
      options.client ??
      new Anthropic({
        apiKey: config.apiKey,
        baseURL: config.baseUrl,
        // The TypeScript SDK takes milliseconds here, unlike Python's seconds.
        timeout: config.timeoutMs,
        // Retries are ours: the SDK's own would be invisible to the usage meter
        // and would not respect our jitter policy across a fleet of workers.
        maxRetries: 0,
      });
    this.retry = config.retry ?? DEFAULT_RETRY_POLICY;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
  }

  modelFor(taskClass: LlmTaskClass): string {
    return this.config.models[taskClass];
  }

  async complete(request: LlmRequest): Promise<LlmCompletion> {
    const model = this.modelFor(request.taskClass);
    const started = Date.now();

    const { message, attempts } = await this.send(request, model, undefined);

    return this.toCompletion(request, message, model, Date.now() - started, attempts, undefined);
  }

  async extract<T>(request: LlmExtractionRequest<T>): Promise<LlmExtraction<T>> {
    const model = this.modelFor(request.taskClass);
    const started = Date.now();

    const { message, attempts } = await this.send(request, model, {
      type: 'json_schema',
      name: request.schema.name,
      ...(request.schema.description === undefined
        ? {}
        : { description: request.schema.description }),
      schema: request.schema.jsonSchema,
    });

    const completion = this.toCompletion(
      request,
      message,
      model,
      Date.now() - started,
      attempts,
      request.schema.name,
    );

    const parsed = parseJsonObject(completion.text, model);

    let value: T;
    try {
      value = request.schema.parse(parsed);
    } catch (error) {
      // The model produced JSON, but not *our* JSON. This is the one failure the
      // intake path must never paper over: a half-read job card that validates
      // by accident is worse than one that visibly failed.
      throw new LlmError(
        'SCHEMA_MISMATCH',
        `The model response did not satisfy "${request.schema.name}": ${
          error instanceof Error ? error.message : String(error)
        }`,
        { model, raw: completion.text.slice(0, 2000) },
      );
    }

    return { ...completion, value, raw: completion.text };
  }

  /**
   * One provider call, with retries for retryable failures only.
   *
   * A refusal, an auth failure and a malformed request are never retried: the
   * same input would produce the same answer, and hammering a 401 four times
   * only delays the page an operator needs to see.
   */
  private async send(
    request: LlmRequest,
    model: string,
    format: Record<string, unknown> | undefined,
  ): Promise<{ message: Anthropic.Message; attempts: number }> {
    const maxTokens = request.maxOutputTokens ?? this.config.maxOutputTokens;
    const temperature = request.temperature ?? this.config.temperatures?.[request.taskClass];

    const params = {
      model,
      max_tokens: maxTokens,
      messages: request.messages.map(toApiMessage),
      ...(request.system === undefined ? {} : { system: request.system }),
      ...(temperature === undefined ? {} : { temperature }),
      ...(request.stopSequences === undefined || request.stopSequences.length === 0
        ? {}
        : { stop_sequences: [...request.stopSequences] }),
      ...(request.tools === undefined || request.tools.length === 0
        ? {}
        : {
            tools: request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.inputSchema,
            })),
            ...(request.toolChoice === undefined
              ? {}
              : { tool_choice: toApiToolChoice(request.toolChoice) }),
          }),
      ...(format === undefined ? {} : { output_config: { format } }),
    } as Anthropic.MessageCreateParamsNonStreaming;

    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        const message =
          maxTokens > STREAMING_THRESHOLD_TOKENS
            ? await this.client.messages.stream(params).finalMessage()
            : await this.client.messages.create(params);
        return { message, attempts: attempt };
      } catch (error) {
        const mapped = mapAnthropicError(error, model);
        if (!mapped.retryable || attempt > this.retry.maxRetries) {
          throw new LlmError(mapped.kind, mapped.message, { ...mapped.details, attempts: attempt });
        }
        await this.sleep(
          retryDelayMs(attempt, this.retry, mapped.retryAfterMs, this.random),
        );
      }
    }
  }

  private toCompletion(
    request: LlmRequest,
    message: Anthropic.Message,
    model: string,
    latencyMs: number,
    attempts: number,
    schemaName: string | undefined,
  ): LlmCompletion {
    // Safety classifiers decline with a successful HTTP status, so the stop
    // reason — not the transport — is what tells us the request was refused.
    if (message.stop_reason === 'refusal') {
      throw new LlmError('REFUSED', 'The model declined this request', {
        model,
        providerType: 'refusal',
        attempts,
        context: { stopDetails: message.stop_details ?? null },
      });
    }

    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    const toolCalls: LlmToolCall[] = message.content
      .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
      .map((block) => ({ id: block.id, name: block.name, args: block.input }));

    if (message.stop_reason === 'max_tokens') {
      throw new LlmError(
        'SCHEMA_MISMATCH',
        `The model hit its ${request.maxOutputTokens ?? this.config.maxOutputTokens}-token output limit before finishing`,
        { model, raw: text.slice(0, 2000), attempts },
      );
    }

    return {
      text,
      toolCalls,
      model: message.model,
      taskClass: request.taskClass,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
      },
      latencyMs,
      attempts,
      stopReason: message.stop_reason,
      promptHash: hashPrompt(request, schemaName),
    };
  }
}

function toApiToolChoice(choice: {
  readonly kind: 'auto' | 'any' | 'tool';
  readonly name?: string;
}): Anthropic.ToolChoice {
  if (choice.kind === 'tool' && choice.name !== undefined) {
    return { type: 'tool', name: choice.name };
  }
  return choice.kind === 'any' ? { type: 'any' } : { type: 'auto' };
}

function toApiMessage(message: LlmMessage): Anthropic.MessageParam {
  return {
    role: message.role,
    content: message.content.map(toApiBlock),
  };
}

function toApiBlock(block: LlmContent): Anthropic.ContentBlockParam {
  switch (block.kind) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'image':
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: block.mediaType,
          data: block.bytes.toString('base64'),
        },
      };
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.args as Record<string, unknown>,
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        content: block.content,
        is_error: block.isError,
      };
  }
}

/**
 * Provider failure → our taxonomy, once, here.
 *
 * Callers branch on the kind: a rate limit backs off, an auth failure pages an
 * operator, an invalid request is a bug to fix. The SDK's typed exception
 * classes are the input — never a string match on the message.
 */
export function mapAnthropicError(error: unknown, model: string): LlmError {
  if (error instanceof LlmError) return error;

  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new LlmError('TIMEOUT', `The model call to ${model} timed out`, { model });
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new LlmError('PROVIDER_UNAVAILABLE', `Could not reach the model API: ${error.message}`, {
      model,
    });
  }

  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 0;
    const kind =
      status === 401 || status === 403
        ? 'AUTH_FAILED'
        : status === 429
          ? 'RATE_LIMITED'
          : status === 400 || status === 404 || status === 422
            ? 'INVALID_REQUEST'
            : status === 413
              ? 'INVALID_REQUEST'
              : status >= 500
                ? 'PROVIDER_UNAVAILABLE'
                : 'UNKNOWN';

    const retryAfterMs = retryAfterFromHeaders(error.headers);

    return new LlmError(kind, `Model API error ${status}: ${error.message}`, {
      httpStatus: status,
      model,
      ...(typeof error.type === 'string' ? { providerType: error.type } : {}),
      // The provider is the only party that knows when its window reopens, so
      // its header wins over any backoff we would have chosen. 529 (overloaded)
      // sends one too, which is why this is not scoped to 429.
      ...(retryAfterMs === null ? {} : { retryAfterMs }),
    });
  }

  return new LlmError('UNKNOWN', error instanceof Error ? error.message : String(error), { model });
}

/**
 * `retry-after` (seconds) and the reset headers, in that order of trust.
 *
 * The SDK exposes headers as a `Headers`-like object on recent versions and a
 * plain record on older ones; both are read here rather than pinning to one,
 * because the shape is not part of the SDK's stability promise.
 */
export function retryAfterFromHeaders(headers: unknown): number | null {
  const get = headerReader(headers);
  if (get === null) return null;

  const retryAfter = get('retry-after');
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  }

  for (const name of [
    'anthropic-ratelimit-tokens-reset',
    'anthropic-ratelimit-requests-reset',
  ]) {
    const reset = get(name);
    if (reset === null) continue;
    const at = Date.parse(reset);
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  }

  return null;
}

function headerReader(headers: unknown): ((name: string) => string | null) | null {
  if (headers === null || headers === undefined) return null;

  const candidate = headers as { get?: unknown };
  if (typeof candidate.get === 'function') {
    const getter = candidate.get.bind(headers) as (name: string) => string | null | undefined;
    return (name) => getter(name) ?? null;
  }

  if (typeof headers === 'object') {
    const record = headers as Record<string, unknown>;
    return (name) => {
      const value = record[name] ?? record[name.toLowerCase()];
      return typeof value === 'string' ? value : null;
    };
  }

  return null;
}
