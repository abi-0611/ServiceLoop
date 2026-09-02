import { context, SpanStatusCode, trace, type Span, type Tracer } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { getEnv } from '@serviceloop/config';

/**
 * Distributed tracing (phase 7.4).
 *
 * The acceptance gate is "a traced sandbox conversation renders as one flame
 * graph", and that phrase is doing real work: a customer's message crosses an
 * HTTP webhook, a database transaction, an outbox row, a Redis queue, a worker
 * process, one or more model calls and a send back to Meta. Four of those are
 * process boundaries. Without propagation the operator gets six unrelated
 * traces and has to join them by eye on a timestamp.
 *
 * So this module does three things and stops:
 *
 *  1. Sets up a provider with the auto-instrumentations that cover the
 *     boundaries we do not own (HTTP, Postgres, Redis).
 *  2. Gives the code a `withSpan` helper carrying this product's own attributes
 *     — shop, conversation, job card, call — which are the four dimensions every
 *     operational question is asked along.
 *  3. Refuses to put anything identifying on a span. See `SPAN_ATTRIBUTE_RULE`.
 *
 * It is off by default (`OTEL_ENABLED=false`) and a no-op when off, so a
 * developer and CI pay nothing for it.
 */

let provider: NodeTracerProvider | null = null;

export interface TracingOptions {
  /** `api`, `workers`, `simulator`. Becomes `service.name`. */
  readonly component: string;
}

export function startTracing(options: TracingOptions): void {
  const env = getEnv();
  if (!env.OTEL_ENABLED || provider !== null) return;

  const exporterUrl = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const serviceName = env.OTEL_SERVICE_NAME ?? `${env.SERVICE_NAME}-${options.component}`;

  provider = new NodeTracerProvider({
    // `resourceFromAttributes` rather than `new Resource`: the SDK's 2.x line
    // made `Resource` a type and moved construction behind a factory, so that
    // an async-resolving resource and a literal one are the same shape to the
    // provider.
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: env.APP_VERSION,
      'deployment.environment.name': env.DEPLOY_ENV,
      'serviceloop.demo_mode': env.DEMO_MODE,
    }),
    /**
     * Parent-based, ratio at the root.
     *
     * A per-span ratio would sample the webhook and drop the worker span it
     * caused, producing exactly the broken half-traces this exists to avoid.
     * Parent-based means the root decides and everything downstream honours it,
     * so a trace is whole or absent.
     */
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(env.OTEL_TRACES_SAMPLER_RATIO),
    }),
    spanProcessors:
      exporterUrl === undefined
        ? []
        : [new BatchSpanProcessor(new OTLPTraceExporter({ url: `${exporterUrl}/v1/traces` }))],
  });

  // AsyncLocalStorage, matching the request-context middleware. Without an
  // explicit context manager the active span is lost across every `await`.
  provider.register({ contextManager: new AsyncLocalStorageContextManager().enable() });

  registerInstrumentations({
    instrumentations: [
      new HttpInstrumentation({
        // Health and metrics are scraped every few seconds by machines. Tracing
        // them buries the one trace an operator is looking for.
        ignoreIncomingRequestHook: (request) =>
          /^\/(health|metrics)/.test(request.url ?? ''),
      }),
      new PgInstrumentation({
        // Statement text can carry a phone number in a parameter position.
        // The span gets the operation and the table, never the values.
        enhancedDatabaseReporting: false,
      }),
      new IORedisInstrumentation({ requireParentSpan: true }),
    ],
  });
}

export async function stopTracing(): Promise<void> {
  if (provider === null) return;
  // Flush before exit, or the last few seconds of an incident — which is the
  // part anybody wants — are dropped with the process.
  await provider.shutdown();
  provider = null;
}

export function tracer(name = 'serviceloop'): Tracer {
  return trace.getTracer(name);
}

/**
 * The attribute policy (phase 7.4 / 7.1 together).
 *
 * Spans go to a third-party backend, are readable by anybody with access to
 * that backend, and are not covered by the pino redaction policy. So this is
 * the rule, and `span-attributes.test.ts` enforces it:
 *
 *   **Ids and enums, never content and never contact details.**
 *
 * `conversation.id` is fine. `customer.phone` is not. `message.kind` is fine.
 * `message.body` is not. The operational questions — which shop, which
 * conversation, which card, which call, how long, what failed — are all
 * answerable from ids, and an operator who needs the body has the conversation
 * id to look it up with, inside the console, with an audit row for having done
 * so.
 */
export const SPAN_ATTRIBUTE_RULE = 'ids and enums only; never message bodies or contact details';

export interface SpanAttributes {
  readonly shopId?: string;
  readonly conversationId?: string;
  readonly jobCardId?: string;
  readonly customerId?: string;
  readonly callId?: string;
  readonly agentRunId?: string;
  readonly messageId?: string;
  readonly objective?: string;
  readonly channel?: string;
  readonly outcome?: string;
  readonly [key: string]: string | number | boolean | undefined;
}

/**
 * Runs `work` inside a span carrying this product's attributes.
 *
 * A helper rather than raw `startActiveSpan` calls, for one reason that shows
 * up the first time somebody debugs a live incident: consistent attribute
 * *names*. A backend where half the spans say `shop_id` and half say `shopId`
 * cannot be queried, and that divergence happens within a week of the second
 * developer touching it.
 */
export async function withSpan<T>(
  name: string,
  attributes: SpanAttributes,
  work: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer().startActiveSpan(name, async (span) => {
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) span.setAttribute(`serviceloop.${key}`, value);
    }
    try {
      const result = await work(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      // `recordException` puts the stack on the span, not the message payload
      // that caused it. That distinction is the whole attribute policy.
      if (error instanceof Error) span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * The current trace id, for correlating a log line to a trace.
 *
 * Returns null rather than a fabricated id when tracing is off: a log field
 * that looks like a trace id and matches nothing in the backend is worse than
 * an absent one, because somebody will spend ten minutes searching for it.
 */
export function currentTraceId(): string | null {
  const span = trace.getSpan(context.active());
  const id = span?.spanContext().traceId;
  return id === undefined || id === '00000000000000000000000000000000' ? null : id;
}
