import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, primaryId, timestamptz, updatedAt } from './columns';
import { customers, shops, staff } from './core';
import { conversations, messages } from './comms';
import { approvalRequests, jobCards } from './jobs';
import {
  advisorTaskKindEnum,
  advisorTaskStatusEnum,
  agentObjectiveEnum,
  agentRunOutcomeEnum,
  agentRunStatusEnum,
  llmTaskClassEnum,
  reviewActionEnum,
  taskUrgencyEnum,
} from './enums';

/**
 * Phase 3 — the agent's own record.
 *
 * Master §6 requires every agent step (prompt hash, tool calls, outputs, checker
 * verdicts) to land in the audit log. These tables are the *operational* side of
 * that: the audit chain proves what happened and cannot be edited, while
 * `agent_runs`/`agent_steps` are what a console screen renders and what a replay
 * reads back. The two are written in the same transaction.
 */

/**
 * Cost and latency metering for every model call (phase 3.1).
 *
 * `cost_usd_micros` is nullable on purpose: a model with no configured price
 * meters its tokens honestly and leaves the money column empty, rather than
 * reporting a number derived from a stale hardcoded rate.
 */
export const llmUsage = pgTable(
  'llm_usage',
  {
    id: primaryId(),
    shopId: uuid('shop_id').references(() => shops.id, { onDelete: 'cascade' }),
    taskClass: llmTaskClassEnum('task_class').notNull(),
    model: text('model').notNull(),
    driver: text('driver').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    latencyMs: integer('latency_ms').notNull().default(0),
    /** How many attempts the call took, retries included. 1 = first try. */
    attempts: integer('attempts').notNull().default(1),
    /** Micro-USD keeps the estimate exact in integer arithmetic. Null = unpriced. */
    costUsdMicros: bigint('cost_usd_micros', { mode: 'number' }),
    /** Null on success; the `LlmError.kind` when the call ultimately failed. */
    errorKind: text('error_kind'),
    agentRunId: uuid('agent_run_id'),
    promptHash: text('prompt_hash').notNull(),
    traceId: text('trace_id').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('llm_usage_shop_created_idx').on(table.shopId, table.createdAt),
    index('llm_usage_run_idx').on(table.agentRunId),
  ],
);

/**
 * One pass of the deterministic outer loop over one objective.
 *
 * `aborted_reason` exists because a human arriving mid-run is not a failure:
 * it is the system working (L6). Recording it as `FAILED` would poison the
 * graduation report with something the agent never did wrong.
 */
export const agentRuns = pgTable(
  'agent_runs',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    objective: agentObjectiveEnum('objective').notNull(),
    status: agentRunStatusEnum('status').notNull().default('RUNNING'),
    outcome: agentRunOutcomeEnum('outcome'),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    jobCardId: uuid('job_card_id').references(() => jobCards.id, { onDelete: 'set null' }),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    approvalRequestId: uuid('approval_request_id').references(() => approvalRequests.id, {
      onDelete: 'set null',
    }),
    /**
     * The message that triggered this run. Unique per shop, so two deliveries of
     * the same customer reply cannot start two runs answering it.
     */
    triggerMessageId: uuid('trigger_message_id').references(() => messages.id, {
      onDelete: 'set null',
    }),
    stepCount: integer('step_count').notNull().default(0),
    maxSteps: integer('max_steps').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    /** Set when the run ended in `blocked`, or when a human aborted it. */
    reason: text('reason'),
    /**
     * Everything the prompt was assembled from, minus the customer's own words:
     * section names, their hashes, the model id and the caps in force. This is
     * what makes a run replayable months later without storing PII twice.
     */
    promptContext: jsonb('prompt_context').notNull().default({}),
    model: text('model').notNull(),
    startedAt: timestamptz('started_at').notNull().defaultNow(),
    finishedAt: timestamptz('finished_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('agent_runs_shop_status_idx').on(table.shopId, table.status),
    index('agent_runs_conversation_idx').on(table.conversationId, table.startedAt),
    index('agent_runs_approval_idx').on(table.approvalRequestId),
    uniqueIndex('agent_runs_trigger_message_key').on(table.shopId, table.triggerMessageId),
  ],
);

/**
 * One step of one run, persisted **before** the next step begins.
 *
 * That ordering is the replay guarantee: a process that dies between steps
 * leaves a complete record of everything it had already decided, and a replay
 * of a persisted run reproduces the identical tool calls.
 */
export const agentSteps = pgTable(
  'agent_steps',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    stepIndex: integer('step_index').notNull(),
    /** sha256 of the assembled prompt for this step. */
    promptHash: text('prompt_hash').notNull(),
    model: text('model').notNull(),
    /** The model's own prose for the step, if any. Tool calls are separate. */
    responseText: text('response_text'),
    /** `[{name, args}]` exactly as the model asked for them, before validation. */
    toolCalls: jsonb('tool_calls').notNull().default([]),
    /** `[{name, ok, result | failure}]` — including typed refusals. */
    toolResults: jsonb('tool_results').notNull().default([]),
    /** Post-checker verdicts for this step: `[{checker, ok, code, reason}]`. */
    checkerVerdicts: jsonb('checker_verdicts').notNull().default([]),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    latencyMs: integer('latency_ms').notNull().default(0),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('agent_steps_run_index_key').on(table.runId, table.stepIndex)],
);

/**
 * Work queued for a person (L6).
 *
 * The `brief` is a one-line summary an advisor can act on from a phone screen;
 * `context` carries the structured links the console turns into a deep link.
 * A handoff that arrives without context is a handoff that gets ignored.
 */
export const advisorTasks = pgTable(
  'advisor_tasks',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    kind: advisorTaskKindEnum('kind').notNull(),
    status: advisorTaskStatusEnum('status').notNull().default('OPEN'),
    urgency: taskUrgencyEnum('urgency').notNull().default('NORMAL'),
    brief: text('brief').notNull(),
    context: jsonb('context').notNull().default({}),
    jobCardId: uuid('job_card_id').references(() => jobCards.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'cascade',
    }),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    approvalRequestId: uuid('approval_request_id').references(() => approvalRequests.id, {
      onDelete: 'cascade',
    }),
    agentRunId: uuid('agent_run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    assignedStaffId: uuid('assigned_staff_id').references(() => staff.id, { onDelete: 'set null' }),
    /**
     * Dedupe key for a task a ladder rung raises. Unique per shop, so a
     * redelivered rung job re-uses the existing task rather than filling an
     * advisor's list with copies of the same call.
     */
    dedupeKey: text('dedupe_key'),
    dueAt: timestamptz('due_at'),
    resolvedAt: timestamptz('resolved_at'),
    resolvedByStaffId: uuid('resolved_by_staff_id').references(() => staff.id, {
      onDelete: 'set null',
    }),
    resolutionNote: text('resolution_note'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('advisor_tasks_shop_status_idx').on(table.shopId, table.status, table.urgency),
    index('advisor_tasks_job_card_idx').on(table.jobCardId),
    uniqueIndex('advisor_tasks_dedupe_key').on(table.shopId, table.dedupeKey),
  ],
);

/**
 * What an advisor did with a candidate the agent drafted (phase 3.9).
 *
 * The `before`/`after` pair is the preference-training data the graduation
 * report is built from: "approved without edit" is the number an owner is shown
 * before being asked whether to raise autonomy, and it can only be computed if
 * every edit is stored rather than overwritten.
 */
export const messageReviews = pgTable(
  'message_reviews',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    agentRunId: uuid('agent_run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    action: reviewActionEnum('action').notNull(),
    reviewerStaffId: uuid('reviewer_staff_id').references(() => staff.id, { onDelete: 'set null' }),
    bodyBefore: text('body_before').notNull(),
    bodyAfter: text('body_after'),
    /** Unified-diff-ish hunks, precomputed so the console renders without a lib. */
    diff: jsonb('diff').notNull().default([]),
    /** Why the advisor rejected it. Required on REJECT by a check constraint. */
    rejectionReason: text('rejection_reason'),
    /** The checker annotations the advisor was looking at when they decided. */
    checkerReasons: jsonb('checker_reasons').notNull().default([]),
    /** Seconds the candidate waited in the queue — the HITL cost, measured. */
    waitedMs: integer('waited_ms').notNull().default(0),
    createdAt: createdAt(),
  },
  (table) => [
    index('message_reviews_shop_created_idx').on(table.shopId, table.createdAt),
    uniqueIndex('message_reviews_message_key').on(table.messageId),
  ],
);
