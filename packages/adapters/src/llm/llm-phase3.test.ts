import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AnthropicLlmAdapter, retryAfterFromHeaders } from './anthropic-adapter';
import {
  BestEffortUsageSink,
  estimateCostUsdMicros,
  InMemoryLlmUsageSink,
  MeteredLlmPort,
} from './metering';
import { MockLlmAdapter, type RecordedScript } from './mock-adapter';
import {
  DEFAULT_RETRY_POLICY,
  hashPrompt,
  LlmError,
  retryDelayMs,
  userText,
  type LlmPort,
  type LlmRequest,
  type LlmToolDefinition,
} from './port';
import { SandboxLlmAdapter } from './sandbox-adapter';
import { UnsupportedSchemaError, zodToJsonSchema } from './zod-json-schema';

/**
 * Phase 3.1 — contract tests for the LLM port.
 *
 * The two that matter most are "a forced 429 retries then succeeds" and "usage
 * rows are written": both are properties of the *port*, so both are asserted
 * against a stub client rather than a live model.
 */

const MODELS = {
  AGENT: 'test-agent',
  CLASSIFY: 'test-classify',
  EXTRACT: 'test-extract',
  JUDGE: 'test-judge',
} as const;

function agentRequest(text: string): LlmRequest {
  return { taskClass: 'AGENT', messages: [userText(text)], traceId: 'trace-1', shopId: 'shop-1' };
}

/** A stub `messages.create` that plays a scripted sequence of outcomes. */
function stubClient(outcomes: ReadonlyArray<() => unknown>): {
  client: Anthropic;
  calls: () => number;
} {
  let index = 0;
  const client = {
    messages: {
      create: async () => {
        const outcome = outcomes[Math.min(index, outcomes.length - 1)];
        index += 1;
        if (outcome === undefined) throw new Error('stub exhausted');
        const value = outcome();
        if (value instanceof Error) throw value;
        return value;
      },
      stream: () => ({ finalMessage: async () => okMessage('streamed') }),
    },
  } as unknown as Anthropic;

  return { client, calls: () => index };
}

function okMessage(text: string, toolUse?: { name: string; input: unknown }): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: MODELS.AGENT,
    stop_reason: toolUse === undefined ? 'end_turn' : 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 30 },
    content:
      toolUse === undefined
        ? [{ type: 'text', text, citations: null }]
        : [
            { type: 'text', text, citations: null },
            { type: 'tool_use', id: 'toolu_1', name: toolUse.name, input: toolUse.input },
          ],
  } as unknown as Anthropic.Message;
}

function rateLimited(): Error {
  return new Anthropic.APIError(
    429,
    { type: 'rate_limit_error' },
    'rate limited',
    new Headers({ 'retry-after': '0' }),
  );
}

function adapter(client: Anthropic, sleeps: number[]): AnthropicLlmAdapter {
  return new AnthropicLlmAdapter(
    {
      apiKey: 'k',
      baseUrl: 'https://example.invalid',
      models: MODELS,
      maxOutputTokens: 1024,
      timeoutMs: 5_000,
      retry: { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 100 },
    },
    {
      client,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.5,
    },
  );
}

describe('task classes', () => {
  it('resolves a model per class rather than per call site', () => {
    const { client } = stubClient([() => okMessage('hi')]);
    const llm = adapter(client, []);

    expect(llm.modelFor('AGENT')).toBe('test-agent');
    expect(llm.modelFor('JUDGE')).toBe('test-judge');
    expect(llm.modelFor('EXTRACT')).toBe('test-extract');
  });

  it('carries the task class back on the completion, for the usage row', async () => {
    const { client } = stubClient([() => okMessage('hi')]);
    const result = await adapter(client, []).complete(agentRequest('hello'));
    expect(result.taskClass).toBe('AGENT');
    expect(result.attempts).toBe(1);
  });
});

describe('retries', () => {
  it('retries a forced 429 and then succeeds', async () => {
    const sleeps: number[] = [];
    const { client, calls } = stubClient([
      () => rateLimited(),
      () => rateLimited(),
      () => okMessage('finally'),
    ]);

    const result = await adapter(client, sleeps).complete(agentRequest('hello'));

    expect(result.text).toBe('finally');
    expect(result.attempts).toBe(3);
    expect(calls()).toBe(3);
    expect(sleeps).toHaveLength(2);
  });

  it('never retries a refusal, an auth failure or a bad request', async () => {
    for (const status of [401, 400]) {
      const sleeps: number[] = [];
      const { client, calls } = stubClient([
        () => new Anthropic.APIError(status, { type: 'error' }, 'no', undefined),
      ]);

      await expect(adapter(client, sleeps).complete(agentRequest('hello'))).rejects.toBeInstanceOf(
        LlmError,
      );
      expect(calls()).toBe(1);
      expect(sleeps).toEqual([]);
    }
  });

  it('gives up after maxRetries and reports how many attempts it made', async () => {
    const sleeps: number[] = [];
    const { client, calls } = stubClient([() => rateLimited()]);

    await expect(
      adapter(client, sleeps).complete(agentRequest('hello')),
    ).rejects.toMatchObject({ kind: 'RATE_LIMITED' });

    // 1 initial attempt + 3 retries.
    expect(calls()).toBe(4);
  });

  it('prefers the provider retry-after header over its own backoff', () => {
    const withHeader = retryDelayMs(1, DEFAULT_RETRY_POLICY, 7_000, () => 0.9);
    expect(withHeader).toBe(7_000);

    // Full jitter: the delay is a random point below the exponential ceiling,
    // so a fleet of workers does not retry in lockstep.
    expect(retryDelayMs(1, DEFAULT_RETRY_POLICY, null, () => 0)).toBe(0);
    expect(retryDelayMs(3, DEFAULT_RETRY_POLICY, null, () => 0.999)).toBeGreaterThan(1_900);
  });

  it('reads retry-after from both header shapes the SDK uses', () => {
    expect(retryAfterFromHeaders({ 'retry-after': '2' })).toBe(2_000);
    expect(retryAfterFromHeaders(new Headers({ 'retry-after': '3' }))).toBe(3_000);
    expect(retryAfterFromHeaders(undefined)).toBeNull();
    expect(retryAfterFromHeaders({})).toBeNull();
  });
});

describe('tool calls', () => {
  const TOOL: LlmToolDefinition = {
    name: 'get_job_card',
    description: 'Read the job card',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  };

  it('returns the tools a model asked for, unvalidated', async () => {
    const { client } = stubClient([
      () => okMessage('let me look', { name: 'get_job_card', input: { jobCardId: 'jc-1' } }),
    ]);

    const result = await adapter(client, []).complete({
      ...agentRequest('what is on the card?'),
      tools: [TOOL],
      toolChoice: { kind: 'auto' },
    });

    expect(result.toolCalls).toEqual([
      { id: 'toolu_1', name: 'get_job_card', args: { jobCardId: 'jc-1' } },
    ]);
    expect(result.stopReason).toBe('tool_use');
  });

  it('folds the tool catalogue into the prompt hash', () => {
    const base = agentRequest('hello');
    expect(hashPrompt({ ...base, tools: [TOOL] })).not.toBe(hashPrompt(base));
  });
});

describe('zod → JSON schema', () => {
  it('produces a closed object with the right required set', () => {
    const schema = z.object({
      jobCardId: z.string().uuid().describe('The card to read'),
      lines: z.array(z.object({ id: z.string(), pricePaise: z.number().int().min(0) })),
      note: z.string().max(200).optional(),
      scope: z.enum(['full', 'partial']),
      followUpAt: z.string().datetime().nullable(),
    });

    const json = zodToJsonSchema(schema) as Record<string, unknown>;

    expect(json['type']).toBe('object');
    expect(json['additionalProperties']).toBe(false);
    expect(json['required']).toEqual(['jobCardId', 'lines', 'scope', 'followUpAt']);

    const properties = json['properties'] as Record<string, Record<string, unknown>>;
    expect(properties['jobCardId']).toMatchObject({
      type: 'string',
      format: 'uuid',
      description: 'The card to read',
    });
    expect(properties['scope']).toMatchObject({ type: 'string', enum: ['full', 'partial'] });
    expect(properties['followUpAt']).toMatchObject({
      anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
    });
  });

  it('refuses a schema it cannot express, rather than emitting a permissive one', () => {
    expect(() => zodToJsonSchema(z.object({ when: z.date() }))).toThrow(UnsupportedSchemaError);
    // A permissive fallback here would let a model invent argument shapes,
    // which is exactly what the typed tool layer exists to prevent.
    expect(() => zodToJsonSchema(z.string())).toThrow(UnsupportedSchemaError);
  });
});

describe('MockLlmAdapter', () => {
  const SCRIPT: RecordedScript = {
    name: 'approval-happy-path',
    description: 'read the card, compose, send',
    model: 'mock-model',
    turns: [
      { text: '', toolCalls: [{ name: 'get_job_card', args: { jobCardId: 'jc-1' } }], inputTokens: 100, outputTokens: 20 },
      {
        expect: 'brake pads',
        text: '',
        toolCalls: [{ name: 'compose_customer_message', args: { draft: 'hello' } }],
        inputTokens: 140,
        outputTokens: 40,
      },
    ],
  };

  it('replays turns in order and reports exhaustion', async () => {
    const llm = new MockLlmAdapter(SCRIPT);

    const first = await llm.complete(agentRequest('start'));
    expect(first.toolCalls[0]?.name).toBe('get_job_card');
    expect(llm.isExhausted()).toBe(false);

    const second = await llm.complete(agentRequest('the card lists brake pads at 2.1mm'));
    expect(second.toolCalls[0]?.name).toBe('compose_customer_message');
    expect(llm.isExhausted()).toBe(true);
  });

  it('raises rather than improvising when the script runs out', async () => {
    const llm = new MockLlmAdapter({ ...SCRIPT, turns: [SCRIPT.turns[0]!] });
    await llm.complete(agentRequest('start'));

    await expect(llm.complete(agentRequest('again'))).rejects.toMatchObject({
      kind: 'NO_RESPONDER',
    });
  });

  it('raises when a guard does not match, naming both sides', async () => {
    const llm = new MockLlmAdapter(SCRIPT);
    await llm.complete(agentRequest('start'));

    await expect(llm.complete(agentRequest('something else entirely'))).rejects.toThrow(
      /expects the prompt to contain "brake pads"/,
    );
  });

  it('records the exchanges a run produced', async () => {
    const llm = new MockLlmAdapter(SCRIPT);
    await llm.complete(agentRequest('start'));
    expect(llm.exchanges()).toHaveLength(1);
    expect(llm.exchanges()[0]?.taskClass).toBe('AGENT');
    expect(llm.exchanges()[0]?.promptHash).toHaveLength(64);
  });

  it('produces byte-identical tool-call ids across two replays', async () => {
    const first = new MockLlmAdapter(SCRIPT);
    const second = new MockLlmAdapter(SCRIPT);

    const a = await first.complete(agentRequest('start'));
    const b = await second.complete(agentRequest('start'));

    expect(a.toolCalls).toEqual(b.toolCalls);
    expect(a.promptHash).toBe(b.promptHash);
  });
});

describe('usage metering', () => {
  function metered(inner: LlmPort, sink: InMemoryLlmUsageSink): LlmPort {
    return new MeteredLlmPort(inner, sink, {
      pricing: { 'sandbox-agent': { inputPerMTokUsd: 3, outputPerMTokUsd: 15 } },
      clock: { now: () => new Date('2026-08-15T10:00:00.000Z') },
    });
  }

  it('writes a row for every successful call, with a cost estimate', async () => {
    const sink = new InMemoryLlmUsageSink();
    const llm = metered(new SandboxLlmAdapter(), sink);

    await llm.complete({ ...agentRequest('hello'), agentRunId: 'run-1' });

    const rows = sink.all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      shopId: 'shop-1',
      taskClass: 'AGENT',
      model: 'sandbox-agent',
      driver: 'sandbox',
      agentRunId: 'run-1',
      errorKind: null,
      traceId: 'trace-1',
      attempts: 1,
    });
    expect(rows[0]?.costUsdMicros).toBeGreaterThan(0);
    expect(rows[0]?.promptHash).toHaveLength(64);
  });

  it('meters a failed call too, with its error kind and attempt count', async () => {
    const sink = new InMemoryLlmUsageSink();
    const { client } = stubClient([() => rateLimited()]);
    const llm = new MeteredLlmPort(adapter(client, []), sink);

    await expect(llm.complete(agentRequest('hello'))).rejects.toMatchObject({
      kind: 'RATE_LIMITED',
    });

    expect(sink.all()).toHaveLength(1);
    expect(sink.all()[0]).toMatchObject({ errorKind: 'RATE_LIMITED', attempts: 4 });
    expect(sink.all()[0]?.costUsdMicros).toBeNull();
  });

  it('leaves the money column empty for an unpriced model rather than guessing', () => {
    expect(
      estimateCostUsdMicros({}, 'some-new-model', { inputTokens: 1000, outputTokens: 500 }),
    ).toBeNull();

    expect(
      estimateCostUsdMicros(
        { m: { inputPerMTokUsd: 3, outputPerMTokUsd: 15 } },
        'm',
        { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      ),
    ).toBe(18_000_000);
  });

  it('never fails a send because the meter was unavailable', async () => {
    const errors: unknown[] = [];
    const broken = {
      record: async () => {
        throw new Error('usage table unavailable');
      },
    };
    const llm = new MeteredLlmPort(
      new SandboxLlmAdapter(),
      new BestEffortUsageSink(broken, (error) => errors.push(error)),
    );

    const result = await llm.complete(agentRequest('hello'));
    expect(result.text).toContain('sandbox');
    expect(errors).toHaveLength(1);
  });
});

describe('SandboxLlmAdapter tool scripting', () => {
  it('lets a responder answer with tool calls, deterministically', async () => {
    const llm = new SandboxLlmAdapter({
      responders: [
        {
          name: 'scripted',
          matches: (request) => request.taskClass === 'AGENT',
          complete: () => ({
            text: 'reading the card',
            toolCalls: [{ name: 'get_job_card', args: { jobCardId: 'jc-1' } }],
          }),
        },
      ],
    });

    const a = await llm.complete(agentRequest('go'));
    llm.resetCalls();
    const b = await llm.complete(agentRequest('go'));

    expect(a.toolCalls[0]?.name).toBe('get_job_card');
    expect(a.stopReason).toBe('tool_use');
    expect(a.promptHash).toBe(b.promptHash);
  });
});
