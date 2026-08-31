import type { LlmPricing } from '@serviceloop/config';
import type { LlmTaskClass } from '@serviceloop/shared';
import {
  hashPrompt,
  LlmError,
  type LlmCompletion,
  type LlmExtraction,
  type LlmExtractionRequest,
  type LlmPort,
  type LlmRequest,
} from './port';

/**
 * Cost and latency metering for every model call (phase 3.1).
 *
 * A decorator rather than a base class, so metering is impossible to forget and
 * equally impossible to entangle with a provider: whichever `LlmPort` is live
 * gets wrapped once at the composition root, and every caller above it — the
 * agent runtime, the OCR pipeline, the claim judge — is metered without knowing
 * it.
 *
 * Failed calls are metered too. A run that burned four retries into a rate
 * limit and produced nothing still cost latency and (on the provider's side)
 * attention, and a spend report that only counts successes hides exactly the
 * pathology an operator needs to see.
 */

export interface LlmUsageRecord {
  readonly shopId: string | null;
  readonly taskClass: LlmTaskClass;
  readonly model: string;
  readonly driver: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly attempts: number;
  /** Micro-USD. Null when this model has no configured price — never guessed. */
  readonly costUsdMicros: number | null;
  readonly errorKind: string | null;
  readonly agentRunId: string | null;
  readonly promptHash: string;
  readonly traceId: string;
  readonly at: Date;
}

/**
 * Where usage rows go. `packages/db` implements it against `llm_usage`; tests
 * and the demo runner collect them in memory.
 */
export interface LlmUsageSink {
  record(usage: LlmUsageRecord): Promise<void>;
}

export class InMemoryLlmUsageSink implements LlmUsageSink {
  private readonly rows: LlmUsageRecord[] = [];

  async record(usage: LlmUsageRecord): Promise<void> {
    this.rows.push(usage);
  }

  all(): readonly LlmUsageRecord[] {
    return [...this.rows];
  }

  totalTokens(): number {
    return this.rows.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0);
  }

  clear(): void {
    this.rows.length = 0;
  }
}

/**
 * A sink that never blocks the caller.
 *
 * Metering is bookkeeping: a customer's approval message must not fail because
 * the usage table was briefly unavailable. Failures are reported to `onError`
 * and dropped, which is the correct trade for this specific row and for no
 * other row in the system.
 */
export class BestEffortUsageSink implements LlmUsageSink {
  constructor(
    private readonly inner: LlmUsageSink,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  async record(usage: LlmUsageRecord): Promise<void> {
    try {
      await this.inner.record(usage);
    } catch (error) {
      this.onError(error);
    }
  }
}

/**
 * Cost in micro-USD, or null when the model is unpriced.
 *
 * Prices are configuration (master §10) and they drift. An unpriced model
 * meters its tokens honestly and leaves the money column empty: a spend report
 * that says "unknown" is actionable, one that quietly applies last year's rate
 * is not.
 */
export function estimateCostUsdMicros(
  pricing: LlmPricing,
  model: string,
  usage: { readonly inputTokens: number; readonly outputTokens: number },
): number | null {
  const price = pricing[model];
  if (price === undefined) return null;

  const perMillion = 1_000_000;
  const inputUsd = (usage.inputTokens / perMillion) * price.inputPerMTokUsd;
  const outputUsd = (usage.outputTokens / perMillion) * price.outputPerMTokUsd;
  return Math.round((inputUsd + outputUsd) * 1_000_000);
}

export interface MeteredLlmOptions {
  readonly pricing?: LlmPricing;
  readonly clock?: { now(): Date };
}

export class MeteredLlmPort implements LlmPort {
  readonly driver: LlmPort['driver'];
  private readonly pricing: LlmPricing;
  private readonly now: () => Date;

  constructor(
    private readonly inner: LlmPort,
    private readonly sink: LlmUsageSink,
    options: MeteredLlmOptions = {},
  ) {
    this.driver = inner.driver;
    this.pricing = options.pricing ?? {};
    this.now = options.clock === undefined ? () => new Date() : () => options.clock!.now();
  }

  modelFor(taskClass: LlmTaskClass): string {
    return this.inner.modelFor(taskClass);
  }

  async complete(request: LlmRequest): Promise<LlmCompletion> {
    return this.meter(request, null, () => this.inner.complete(request));
  }

  async extract<T>(request: LlmExtractionRequest<T>): Promise<LlmExtraction<T>> {
    return this.meter(request, request.schema.name, () => this.inner.extract(request));
  }

  private async meter<T extends LlmCompletion>(
    request: LlmRequest,
    schemaName: string | null,
    call: () => Promise<T>,
  ): Promise<T> {
    const started = Date.now();
    try {
      const completion = await call();
      await this.sink.record({
        shopId: request.shopId ?? null,
        taskClass: request.taskClass,
        model: completion.model,
        driver: this.inner.driver,
        inputTokens: completion.usage.inputTokens,
        outputTokens: completion.usage.outputTokens,
        latencyMs: completion.latencyMs,
        attempts: completion.attempts,
        costUsdMicros: estimateCostUsdMicros(this.pricing, completion.model, completion.usage),
        errorKind: null,
        agentRunId: request.agentRunId ?? null,
        promptHash: completion.promptHash,
        traceId: request.traceId ?? 'unattributed',
        at: this.now(),
      });
      return completion;
    } catch (error) {
      const llmError = error instanceof LlmError ? error : null;
      await this.sink.record({
        shopId: request.shopId ?? null,
        taskClass: request.taskClass,
        model: llmError?.details.model ?? this.inner.modelFor(request.taskClass),
        driver: this.inner.driver,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: Date.now() - started,
        attempts: llmError?.attempts ?? 1,
        costUsdMicros: null,
        errorKind: llmError?.kind ?? 'UNKNOWN',
        agentRunId: request.agentRunId ?? null,
        // The prompt hash is computed from the request, so a failed call is
        // still traceable to the exact instructions that produced it — and it
        // is the same hash a successful call would have carried.
        promptHash: hashPrompt(request, schemaName ?? undefined),
        traceId: request.traceId ?? 'unattributed',
        at: this.now(),
      });
      throw error;
    }
  }
}
