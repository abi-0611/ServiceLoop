import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * The metric set (phase 7.4).
 *
 * One module shared by the API and the workers, because the alert rules in
 * `infra/prometheus/alerts.yml` name these series by string and a metric
 * declared twice with two different label sets produces a rule that silently
 * matches nothing.
 *
 * Every metric here answers a question somebody asks during an incident, and
 * the ones that were tempting and are absent are absent on purpose:
 *
 * - **No per-customer labels.** A `customer_id` label turns a counter into an
 *   unbounded cardinality explosion *and* puts an identifier in a system with
 *   no redaction policy. Shop is the finest granularity anything here carries,
 *   and even that is used sparingly.
 * - **No message bodies, obviously, and no template *text*** — template *name*
 *   is bounded and useful, so that one is a label.
 * - **Cost is a counter in paise, not a gauge in rupees.** A gauge cannot be
 *   summed over a window, and floating-point rupees accumulated over ten
 *   thousand conversations disagree with the invoice.
 */

export const registry = new Registry();

export function collectRuntimeMetrics(prefix: string): void {
  collectDefaultMetrics({ register: registry, prefix });
}

/* -------------------------------------------------------------------------- *
 * The spine: outbox, queues, webhooks
 * -------------------------------------------------------------------------- */

/**
 * Age of the oldest undispatched outbox row, in seconds.
 *
 * The single most important number in the system, and the one the first alert
 * fires on. Everything customer-facing goes out through the outbox, so this
 * climbing means messages are not being sent — and it climbs *before* anybody
 * complains, which no other signal does.
 */
export const outboxOldestPendingSeconds = new Gauge({
  name: 'serviceloop_outbox_oldest_pending_seconds',
  help: 'Age of the oldest PENDING outbox row',
  registers: [registry],
});

export const outboxBacklog = new Gauge({
  name: 'serviceloop_outbox_backlog',
  help: 'Outbox rows by status',
  labelNames: ['status'] as const,
  registers: [registry],
});

/**
 * The phase-1 worker metrics, moved here in phase 7.
 *
 * They lived in `apps/workers/src/metrics.ts` and were exported on a registry
 * only that process had. The alert rules name them, and an alert rule pointing
 * at a series nothing exports never fires — which looks exactly like a
 * condition that never happened. `observability.test.ts` now compares the two
 * files, so the drift that put them in different registries cannot recur.
 */
export const outboxDispatched = new Counter({
  name: 'serviceloop_outbox_dispatched_total',
  help: 'Outbox events successfully published to a queue',
  labelNames: ['queue', 'type'] as const,
  registers: [registry],
});

export const outboxFailed = new Counter({
  name: 'serviceloop_outbox_failed_total',
  help: 'Outbox events whose publish attempt failed',
  labelNames: ['type'] as const,
  registers: [registry],
});

export const outboxParked = new Counter({
  name: 'serviceloop_outbox_parked_total',
  help: 'Outbox events parked as FAILED after exhausting their attempts',
  labelNames: ['type'] as const,
  registers: [registry],
});

export const jobsProcessed = new Counter({
  name: 'serviceloop_queue_jobs_processed_total',
  help: 'Queue jobs processed, by queue, event type and outcome',
  labelNames: ['queue', 'type', 'outcome'] as const,
  registers: [registry],
});

export const jobDuration = new Histogram({
  name: 'serviceloop_queue_job_duration_seconds',
  help: 'Queue job handling duration',
  labelNames: ['queue', 'type'] as const,
  buckets: [0.005, 0.025, 0.1, 0.5, 1, 5, 15],
  registers: [registry],
});

export const deadLettered = new Counter({
  name: 'serviceloop_dead_lettered_total',
  help: 'Jobs moved to the dead-letter queue after exhausting their attempts',
  labelNames: ['queue', 'type'] as const,
  registers: [registry],
});

export const chainIntegrityFailures = new Counter({
  name: 'serviceloop_audit_chain_integrity_failures_total',
  help: 'Audit chain verifications that found a break',
  labelNames: ['shop'] as const,
  registers: [registry],
});

export const queueDepth = new Gauge({
  name: 'serviceloop_queue_depth',
  help: 'Jobs waiting on a queue',
  labelNames: ['queue', 'state'] as const,
  registers: [registry],
});

export const queueLagSeconds = new Gauge({
  name: 'serviceloop_queue_lag_seconds',
  help: 'Age of the oldest waiting job on a queue',
  labelNames: ['queue'] as const,
  registers: [registry],
});

export const webhookRequests = new Counter({
  name: 'serviceloop_webhook_requests_total',
  help: 'Provider webhook deliveries by provider and outcome',
  labelNames: ['provider', 'outcome'] as const,
  registers: [registry],
});

/* -------------------------------------------------------------------------- *
 * The model
 * -------------------------------------------------------------------------- */

export const llmCalls = new Counter({
  name: 'serviceloop_llm_calls_total',
  help: 'Model calls by task class and outcome',
  labelNames: ['task_class', 'model', 'outcome'] as const,
  registers: [registry],
});

export const llmLatency = new Histogram({
  name: 'serviceloop_llm_latency_seconds',
  help: 'Model call latency',
  labelNames: ['task_class'] as const,
  // Buckets chosen for the p95 the alert reads. A default bucket set tops out
  // at 10s, and the interesting question about an agent run is whether it took
  // twenty seconds or sixty.
  buckets: [0.25, 0.5, 1, 2, 5, 10, 20, 45, 90],
  registers: [registry],
});

/** Micro-USD, integer, summed. Rupees as a float would not reconcile. */
export const llmCostMicros = new Counter({
  name: 'serviceloop_llm_cost_usd_micros_total',
  help: 'Estimated model spend in micro-USD',
  labelNames: ['task_class', 'model'] as const,
  registers: [registry],
});

/* -------------------------------------------------------------------------- *
 * Speech and the telephone
 * -------------------------------------------------------------------------- */

export const speechLatency = new Histogram({
  name: 'serviceloop_speech_latency_seconds',
  help: 'Speech pipeline latency by stage',
  // `stage` is stt|tts|endpointing — the three places a voice turn goes slow,
  // and an operator debugging dead air needs to know which.
  labelNames: ['stage', 'driver'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 0.8, 1.2, 2, 5],
  registers: [registry],
});

export const voiceTurnLatency = new Histogram({
  name: 'serviceloop_voice_turn_latency_seconds',
  help: 'End-to-end latency of a voice turn, customer silence to first audio',
  buckets: [0.3, 0.6, 0.9, 1.2, 1.8, 3, 5],
  registers: [registry],
});

export const callsTotal = new Counter({
  name: 'serviceloop_calls_total',
  help: 'Calls by direction and outcome',
  labelNames: ['direction', 'outcome'] as const,
  registers: [registry],
});

/* -------------------------------------------------------------------------- *
 * The guardrails
 * -------------------------------------------------------------------------- */

/**
 * Outbound sends the gate refused, by reason.
 *
 * The most *interesting* metric here rather than the most urgent. A rising
 * `CONSENT_REVOKED` is the system working; a rising
 * `WINDOW_CLOSED_NEEDS_TEMPLATE` means a template was rejected or paused, which
 * is an outage nobody would otherwise notice until a shop asked why their
 * customers had gone quiet.
 */
export const outboundBlocked = new Counter({
  name: 'serviceloop_outbound_blocked_total',
  help: 'Messages the OutboundGate refused, by reason',
  labelNames: ['code', 'purpose', 'flow'] as const,
  registers: [registry],
});

export const outboundSent = new Counter({
  name: 'serviceloop_outbound_sent_total',
  help: 'Messages sent, by channel and purpose',
  labelNames: ['channel', 'purpose', 'templated'] as const,
  registers: [registry],
});

export const ladderRungDelaySeconds = new Histogram({
  name: 'serviceloop_ladder_rung_delay_seconds',
  help: 'How late an escalation rung fired against its scheduled time',
  labelNames: ['objective', 'rung_type'] as const,
  buckets: [1, 5, 15, 30, 60, 300, 900],
  registers: [registry],
});

/* -------------------------------------------------------------------------- *
 * Cost
 * -------------------------------------------------------------------------- */

export const channelCostPaise = new Counter({
  name: 'serviceloop_channel_cost_paise_total',
  help: 'Messaging spend in paise, by channel and category',
  labelNames: ['channel', 'category'] as const,
  registers: [registry],
});

export const channelFailover = new Counter({
  name: 'serviceloop_channel_failover_total',
  help: 'Transitions of the primary channel circuit breaker',
  labelNames: ['channel', 'state'] as const,
  registers: [registry],
});

/* -------------------------------------------------------------------------- *
 * Integrity and privacy
 * -------------------------------------------------------------------------- */

export const auditChainVerifications = new Counter({
  name: 'serviceloop_audit_chain_verifications_total',
  help: 'Audit chain verification runs by outcome',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

export const dataRequests = new Counter({
  name: 'serviceloop_data_requests_total',
  help: 'DPDP data-principal requests by kind and terminal status',
  labelNames: ['kind', 'status'] as const,
  registers: [registry],
});

/**
 * Requests past their scheduled execution time and still not run.
 *
 * A statutory clock, so it gets a gauge and an alert of its own. Nothing else
 * in the system would notice a stuck deletion: it fails quietly, the customer
 * is not told, and the shop finds out when the regulator asks.
 */
export const dataRequestsOverdue = new Gauge({
  name: 'serviceloop_data_requests_overdue',
  help: 'Approved data requests past their scheduled execution time',
  registers: [registry],
});

export async function renderMetrics(): Promise<string> {
  return registry.metrics();
}

export const metricsContentType = registry.contentType;
