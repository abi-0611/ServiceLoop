import { relations } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, encryptedText, primaryId, timestamptz, updatedAt } from './columns';
import { conversations } from './comms';
import { customers, shops, staff } from './core';
import { approvalRequests, jobCards, mediaAssets } from './jobs';
import {
  callConsentFactEnum,
  callDirectionEnum,
  callEndReasonEnum,
  callInputModeEnum,
  callOutcomeEnum,
  callStatusEnum,
  callTurnRoleEnum,
  languageEnum,
  voiceIntentEnum,
} from './enums';

/**
 * Phase 5 — the voice layer's own record.
 *
 * The governing principle: **the audit story for a call must be as strong as
 * the one for a chat**. A WhatsApp approval leaves a thread anyone can read; a
 * telephone approval used to leave a recording nobody listens to and a note
 * saying "customer agreed". These tables close that gap — every turn, in both
 * directions, with its timings, how it was heard, and whether the readback
 * happened before the decision did.
 *
 * Three shapes are worth explaining before the columns:
 *
 *   - **`calls` holds a row for a call that never happened.** A `BLOCKED`
 *     status with a reason is what a rung that refused to dial leaves behind —
 *     revoked consent, a cost cap, the kill switch. Without it, "the ladder
 *     called them" and "the ladder decided not to" look identical from the
 *     outside, and only one of those is a system working.
 *   - **`call_consent_events` is ordered and timestamped, not a set of
 *     booleans.** The compliance question is never "was the recording notice
 *     given"; it is "was it given *before* the recorder started", and only a
 *     sequence can answer that.
 *   - **`call_usage` meters three currencies separately.** Telco seconds,
 *     speech seconds and model tokens fail independently, and a blended figure
 *     hides which cap a shop actually hit.
 */

/* -------------------------------------------------------------------------- *
 * 5.1 / 5.3 — the call and its turns
 * -------------------------------------------------------------------------- */

export const calls = pgTable(
  'calls',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    direction: callDirectionEnum('direction').notNull(),
    status: callStatusEnum('status').notNull().default('ORIGINATING'),
    /** Which telephony adapter placed or answered it. */
    driver: text('driver').notNull(),
    /** The provider's own call id, for reconciling a status callback. */
    providerCallSid: text('provider_call_sid'),
    /**
     * The number dialled, encrypted at rest.
     *
     * The same reasoning as `customers.phone_encrypted`: a call log is a list of
     * who a shop rang and when, which is exactly the kind of thing a database
     * dump must not hand over. `to_masked` is what every console screen and log
     * line renders instead.
     */
    toEncrypted: encryptedText('to_encrypted'),
    toMasked: text('to_masked').notNull(),
    fromNumber: text('from_number').notNull(),

    jobCardId: uuid('job_card_id').references(() => jobCards.id, { onDelete: 'set null' }),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    approvalRequestId: uuid('approval_request_id').references(() => approvalRequests.id, {
      onDelete: 'set null',
    }),
    /** The ladder rung that placed this call, when one did. */
    escalationId: uuid('escalation_id'),
    /** The phase-3 run this call's turns were planned by. */
    agentRunId: uuid('agent_run_id'),

    objective: text('objective').notNull(),
    language: languageEnum('language').notNull().default('en'),
    /** What an inbound caller turned out to want (phase 5.4b). */
    intent: voiceIntentEnum('intent'),

    outcome: callOutcomeEnum('outcome'),
    endReason: callEndReasonEnum('end_reason'),
    /** Set on a `BLOCKED` row: why no call was placed. Never null on one. */
    blockedReason: text('blocked_reason'),
    blockedCode: text('blocked_code'),

    ringingAt: timestamptz('ringing_at'),
    answeredAt: timestamptz('answered_at'),
    endedAt: timestamptz('ended_at'),
    durationSeconds: integer('duration_seconds').notNull().default(0),
    turnCount: integer('turn_count').notNull().default(0),

    /** True once the call reached a person: a bridge or an advisor task. */
    handedOff: boolean('handed_off').notNull().default(false),
    bridgedToStaffId: uuid('bridged_to_staff_id').references(() => staff.id, {
      onDelete: 'set null',
    }),
    /** The eight seconds whispered to the advisor leg before joining. */
    whisperText: text('whisper_text'),
    advisorTaskId: uuid('advisor_task_id'),

    /**
     * The call fell back to pure IVR after two poor turns (phase 5.5).
     *
     * Recorded rather than inferred from the turns, because "how often does the
     * recogniser give up on our customers" is a question about the speech
     * provider that the shop should be able to ask directly.
     */
    degradedToIvr: boolean('degraded_to_ivr').notNull().default(false),
    /** Turns whose transcript came back under the confidence floor. */
    poorTurnCount: integer('poor_turn_count').notNull().default(0),
    /** Turns the customer talked over. A quality signal about the copy. */
    bargeInCount: integer('barge_in_count').notNull().default(0),
    /** Worst speech-end → speech-start observed. The budget's own evidence. */
    maxTurnLatencyMs: integer('max_turn_latency_ms').notNull().default(0),

    /** The stored recording, once the call ends. Null until it does. */
    recordingMediaId: uuid('recording_media_id').references(() => mediaAssets.id, {
      onDelete: 'set null',
    }),
    /** When the retention policy may delete the recording and the transcript. */
    retentionUntil: timestamptz('retention_until'),

    /** The retry a no-answer scheduled, so the pair can be read as one attempt. */
    retryOfCallId: uuid('retry_of_call_id'),

    traceId: text('trace_id').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('calls_shop_created_idx').on(table.shopId, table.createdAt),
    index('calls_shop_status_idx').on(table.shopId, table.status),
    index('calls_job_card_idx').on(table.shopId, table.jobCardId),
    index('calls_customer_idx').on(table.shopId, table.customerId, table.createdAt),
    index('calls_approval_idx').on(table.approvalRequestId),
    index('calls_retention_idx').on(table.retentionUntil),
    /**
     * One call per provider sid. A redelivered status callback finds the row it
     * already wrote rather than opening a second call record for one telephone
     * call — the same idempotency the payments webhook has.
     */
    uniqueIndex('calls_provider_sid_key').on(table.shopId, table.providerCallSid),
  ],
);

/**
 * One turn of a conversation, in either direction.
 *
 * The append-only transcript that makes a phone approval auditable. `text` on
 * an agent turn is the composed copy *after* the post-checker passed it and
 * before it was synthesised, which is the thing that actually went down the
 * wire; on a caller turn it is the recogniser's final transcript, with the
 * confidence it reported.
 */
export const callTurns = pgTable(
  'call_turns',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    callId: uuid('call_id')
      .notNull()
      .references(() => calls.id, { onDelete: 'cascade' }),
    turnIndex: integer('turn_index').notNull(),
    role: callTurnRoleEnum('role').notNull(),
    inputMode: callInputModeEnum('input_mode').notNull().default('NONE'),
    text: text('text').notNull(),
    /** The keypad press, when this turn was one. */
    dtmfDigit: text('dtmf_digit'),
    /** Recogniser confidence on a caller turn; null on an agent turn. */
    confidence: integer('confidence_bp'),
    languageTag: text('language_tag'),

    /**
     * A non-removable script segment: the AI disclosure or the recording
     * notice.
     *
     * Flagged on the row rather than matched by text at report time, because
     * the copy is translated into three languages and a compliance check that
     * works by string comparison breaks the first time somebody improves a
     * Tamil sentence.
     */
    mandatorySegment: boolean('mandatory_segment').notNull().default(false),
    /** Which catalogue key produced this turn, when a catalogue did. */
    scriptKey: text('script_key'),

    /** The customer talked over this turn and the synthesis was cut. */
    bargedIn: boolean('barged_in').notNull().default(false),
    /** Milliseconds of audio actually played before the cut, when one happened. */
    playedMs: integer('played_ms'),

    /** Speech-end → speech-start for this turn. The budget's per-turn evidence. */
    latencyMs: integer('latency_ms'),
    /** Per-stage markers, so "the call felt slow" has four separable causes. */
    latencyStages: jsonb('latency_stages').notNull().default({}),

    /** Tool calls this turn made, for the same reason `agent_steps` records them. */
    toolCalls: jsonb('tool_calls').notNull().default([]),
    checkerVerdicts: jsonb('checker_verdicts').notNull().default([]),
    agentRunId: uuid('agent_run_id'),

    startedAt: timestamptz('started_at').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('call_turns_call_index_key').on(table.callId, table.turnIndex),
    index('call_turns_shop_created_idx').on(table.shopId, table.createdAt),
  ],
);

/* -------------------------------------------------------------------------- *
 * 5.6 — consent, disclosure and recording
 * -------------------------------------------------------------------------- */

/**
 * The ordered compliance record for one call.
 *
 * Every row is a fact with a time. The property the phase demands — recording
 * starts only after the notice — is a comparison between two rows here, which
 * is why this is a table and not five boolean columns on `calls`.
 */
export const callConsentEvents = pgTable(
  'call_consent_events',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    callId: uuid('call_id')
      .notNull()
      .references(() => calls.id, { onDelete: 'cascade' }),
    fact: callConsentFactEnum('fact').notNull(),
    /** The turn that carried it, for a notice or a disclosure. */
    turnIndex: integer('turn_index'),
    detail: text('detail'),
    occurredAt: timestamptz('occurred_at').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('call_consent_events_call_fact_key').on(table.callId, table.fact),
    index('call_consent_events_shop_idx').on(table.shopId, table.occurredAt),
  ],
);

/* -------------------------------------------------------------------------- *
 * 5.7 — cost metering
 * -------------------------------------------------------------------------- */

/**
 * What one call cost, in the three currencies that fail separately.
 *
 * `estimated_cost_paise` is named honestly: the authoritative figure arrives on
 * a provider invoice weeks later, while the daily cap has to decide *now*
 * whether this shop may place another call. A meter that waited for the true
 * number would be a meter that never stopped anything.
 */
export const callUsage = pgTable(
  'call_usage',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    callId: uuid('call_id')
      .notNull()
      .references(() => calls.id, { onDelete: 'cascade' }),
    telcoSeconds: integer('telco_seconds').notNull().default(0),
    sttSeconds: integer('stt_seconds').notNull().default(0),
    ttsSeconds: integer('tts_seconds').notNull().default(0),
    llmInputTokens: integer('llm_input_tokens').notNull().default(0),
    llmOutputTokens: integer('llm_output_tokens').notNull().default(0),
    estimatedCostPaise: bigint('estimated_cost_paise', { mode: 'number' }).notNull().default(0),
    /** Which cap this call took the shop past, when it did. */
    capBreached: text('cap_breached'),
    traceId: text('trace_id').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    /** One usage row per call: a redelivered `call.ended` must not double-bill. */
    uniqueIndex('call_usage_call_key').on(table.callId),
    index('call_usage_shop_created_idx').on(table.shopId, table.createdAt),
  ],
);

/* -------------------------------------------------------------------------- *
 * relations
 * -------------------------------------------------------------------------- */

export const callsRelations = relations(calls, ({ one, many }) => ({
  shop: one(shops, { fields: [calls.shopId], references: [shops.id] }),
  jobCard: one(jobCards, { fields: [calls.jobCardId], references: [jobCards.id] }),
  customer: one(customers, { fields: [calls.customerId], references: [customers.id] }),
  turns: many(callTurns),
  consentEvents: many(callConsentEvents),
}));

export const callTurnsRelations = relations(callTurns, ({ one }) => ({
  call: one(calls, { fields: [callTurns.callId], references: [calls.id] }),
}));

export const callConsentEventsRelations = relations(callConsentEvents, ({ one }) => ({
  call: one(calls, { fields: [callConsentEvents.callId], references: [calls.id] }),
}));

export const callUsageRelations = relations(callUsage, ({ one }) => ({
  call: one(calls, { fields: [callUsage.callId], references: [calls.id] }),
}));
