import type {
  BlockedCallInput,
  CallConsentEventRecord,
  CallConsentStore,
  CallDestinationReader,
  CallRecord,
  CallRecordingWriter,
  CallStore,
  CallTurnRecord,
  CallTurnStore,
  CallUsageRecord,
  CallUsageStore,
  FinishCallInput,
  GeneratedMediaWriter,
  OpenCallInput,
} from '@serviceloop/domain';
import type {
  CallConsentFact,
  CallDirection,
  CallEndReason,
  CallInputMode,
  CallOutcome,
  CallStatus,
  CallTurnRole,
  DtmfDigit,
  Language,
  Paise,
  VoiceIntent,
  VoiceLatencyStage,
} from '@serviceloop/shared';
import { uuidv7 } from '@serviceloop/shared';
import { sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { blindIndex, decryptPii, encryptPii } from '../crypto/pii';

/**
 * Postgres implementations of the phase-5 voice ports.
 *
 * Two conventions carried forward from phase 4 and worth restating, because
 * both were learned the hard way:
 *
 *   - **Idempotent writes return null.** `open`, `append`, `record` all use
 *     `on conflict do nothing` and report what happened as a value. A
 *     redelivered provider callback is an ordinary Tuesday, not an exception
 *     the caller has to classify by reading an error message.
 *   - **Timestamps are converted at this boundary.** The driver hands back a
 *     `Date` on some paths and a string on others, and phase 2's deviation 17(b)
 *     was a `sent_at` string that crashed the frequency cap on the second
 *     message to every customer.
 *
 * Confidence crosses as basis points for the same reason it does in the status
 * store: the domain speaks in the 0–1 fraction because that is what a threshold
 * reads like, and the column is an integer because a float gating a
 * customer-facing decision is a rounding argument waiting to happen.
 */

const BP = 10_000;

function toBp(fraction: number | null): number | null {
  if (fraction === null) return null;
  return Math.max(0, Math.min(BP, Math.round(fraction * BP)));
}

function fromBp(bp: number | null): number | null {
  return bp === null ? null : bp / BP;
}

function date(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function maybeDate(value: Date | string | null): Date | null {
  return value === null ? null : date(value);
}

type CallRow = {
  id: string;
  shop_id: string;
  direction: CallDirection;
  status: CallStatus;
  driver: string;
  provider_call_sid: string | null;
  to_masked: string;
  from_number: string;
  job_card_id: string | null;
  customer_id: string | null;
  conversation_id: string | null;
  approval_request_id: string | null;
  escalation_id: string | null;
  agent_run_id: string | null;
  objective: string;
  language: Language;
  intent: VoiceIntent | null;
  outcome: CallOutcome | null;
  end_reason: CallEndReason | null;
  blocked_reason: string | null;
  blocked_code: string | null;
  ringing_at: Date | string | null;
  answered_at: Date | string | null;
  ended_at: Date | string | null;
  duration_seconds: number;
  turn_count: number;
  handed_off: boolean;
  bridged_to_staff_id: string | null;
  whisper_text: string | null;
  advisor_task_id: string | null;
  degraded_to_ivr: boolean;
  poor_turn_count: number;
  barge_in_count: number;
  max_turn_latency_ms: number;
  recording_media_id: string | null;
  retention_until: Date | string | null;
  retry_of_call_id: string | null;
  trace_id: string;
  created_at: Date | string;
};

const CALL_COLUMNS = sql`
  id, shop_id, direction::text as direction, status::text as status, driver,
  provider_call_sid, to_masked, from_number, job_card_id, customer_id,
  conversation_id, approval_request_id, escalation_id, agent_run_id, objective,
  language::text as language, intent::text as intent, outcome::text as outcome,
  end_reason::text as end_reason, blocked_reason, blocked_code, ringing_at,
  answered_at, ended_at, duration_seconds, turn_count, handed_off,
  bridged_to_staff_id, whisper_text, advisor_task_id, degraded_to_ivr,
  poor_turn_count, barge_in_count, max_turn_latency_ms, recording_media_id,
  retention_until, retry_of_call_id, trace_id, created_at
`;

function toCallRecord(row: CallRow): CallRecord {
  return {
    id: row.id,
    shopId: row.shop_id,
    direction: row.direction,
    status: row.status,
    driver: row.driver,
    providerCallSid: row.provider_call_sid,
    toMasked: row.to_masked,
    fromNumber: row.from_number,
    jobCardId: row.job_card_id,
    customerId: row.customer_id,
    conversationId: row.conversation_id,
    approvalRequestId: row.approval_request_id,
    escalationId: row.escalation_id,
    agentRunId: row.agent_run_id,
    objective: row.objective,
    language: row.language,
    intent: row.intent,
    outcome: row.outcome,
    endReason: row.end_reason,
    blockedReason: row.blocked_reason,
    blockedCode: row.blocked_code,
    ringingAt: maybeDate(row.ringing_at),
    answeredAt: maybeDate(row.answered_at),
    endedAt: maybeDate(row.ended_at),
    durationSeconds: row.duration_seconds,
    turnCount: row.turn_count,
    handedOff: row.handed_off,
    bridgedToStaffId: row.bridged_to_staff_id,
    whisperText: row.whisper_text,
    advisorTaskId: row.advisor_task_id,
    degradedToIvr: row.degraded_to_ivr,
    poorTurnCount: row.poor_turn_count,
    bargeInCount: row.barge_in_count,
    maxTurnLatencyMs: row.max_turn_latency_ms,
    recordingMediaId: row.recording_media_id,
    retentionUntil: maybeDate(row.retention_until),
    retryOfCallId: row.retry_of_call_id,
    traceId: row.trace_id,
    createdAt: date(row.created_at),
  };
}

export class PgCallStore implements CallStore<Tx> {
  /**
   * Opens a call, or reports that one already exists for this provider sid.
   *
   * `on conflict do nothing` on `(shop_id, provider_call_sid)` is what makes a
   * redelivered `start` webhook a non-event — the same idempotency the payments
   * webhook has, and for the same reason: providers retry, and a second call
   * row for one telephone call would double-count in every metric phase 6 will
   * build.
   */
  async open(tx: Tx, input: OpenCallInput): Promise<string | null> {
    const result = await tx.execute<{ id: string }>(sql`
      insert into calls (
        id, shop_id, direction, status, driver, provider_call_sid,
        to_encrypted, to_masked, from_number, job_card_id, customer_id,
        conversation_id, approval_request_id, escalation_id, objective,
        language, ringing_at, retention_until, retry_of_call_id, trace_id,
        created_at, updated_at
      ) values (
        ${input.id}, ${input.shopId}, ${input.direction}::call_direction,
        ${input.direction === 'INBOUND' ? 'IN_PROGRESS' : 'ORIGINATING'}::call_status,
        ${input.driver}, ${input.providerCallSid},
        ${encryptedNumber(input.to)}, ${input.toMasked}, ${input.fromNumber},
        ${input.jobCardId}, ${input.customerId}, ${input.conversationId},
        ${input.approvalRequestId}, ${input.escalationId}, ${input.objective},
        ${input.language}::language, ${input.startedAt}, ${input.retentionUntil},
        ${input.retryOfCallId}, ${input.traceId}, ${input.startedAt}, ${input.startedAt}
      )
      on conflict do nothing
      returning id
    `);

    return result.rows[0]?.id ?? null;
  }

  /**
   * A call that was refused before dialling.
   *
   * Never `on conflict do nothing`: a second refusal of the same rung is a
   * second fact — the ladder tried again and was stopped again — and collapsing
   * them would hide how long a shop has been unable to call anybody.
   */
  async recordBlocked(tx: Tx, input: BlockedCallInput): Promise<string> {
    await tx.execute(sql`
      insert into calls (
        id, shop_id, direction, status, driver, to_encrypted, to_masked,
        from_number, job_card_id, customer_id, conversation_id,
        approval_request_id, escalation_id, objective, language,
        outcome, blocked_code, blocked_reason, ended_at, retention_until,
        retry_of_call_id, trace_id, created_at, updated_at
      ) values (
        ${input.id}, ${input.shopId}, ${input.direction}::call_direction,
        'BLOCKED'::call_status, ${input.driver}, ${encryptedNumber(input.to)},
        ${input.toMasked}, ${input.fromNumber}, ${input.jobCardId},
        ${input.customerId}, ${input.conversationId}, ${input.approvalRequestId},
        ${input.escalationId}, ${input.objective}, ${input.language}::language,
        'NOT_PLACED'::call_outcome, ${input.code}, ${input.reason},
        ${input.startedAt}, ${input.retentionUntil}, ${input.retryOfCallId},
        ${input.traceId}, ${input.startedAt}, ${input.startedAt}
      )
    `);

    return input.id;
  }

  async load(tx: Tx, shopId: string, callId: string): Promise<CallRecord | null> {
    const result = await tx.execute<CallRow>(sql`
      select ${CALL_COLUMNS} from calls where id = ${callId} and shop_id = ${shopId}
    `);
    const row = result.rows[0];
    return row === undefined ? null : toCallRecord(row);
  }

  async findByProviderSid(tx: Tx, shopId: string, sid: string): Promise<CallRecord | null> {
    const result = await tx.execute<CallRow>(sql`
      select ${CALL_COLUMNS} from calls
      where shop_id = ${shopId} and provider_call_sid = ${sid}
    `);
    const row = result.rows[0];
    return row === undefined ? null : toCallRecord(row);
  }

  async setStatus(
    tx: Tx,
    shopId: string,
    callId: string,
    status: CallStatus,
    at: Date,
    providerCallSid?: string | null,
  ): Promise<void> {
    await tx.execute(sql`
      update calls
      set status = ${status}::call_status,
          ringing_at = case when ${status} = 'RINGING' then coalesce(ringing_at, ${at}) else ringing_at end,
          provider_call_sid = coalesce(${providerCallSid ?? null}, provider_call_sid),
          updated_at = ${at}
      where id = ${callId} and shop_id = ${shopId}
    `);
  }

  async markAnswered(tx: Tx, shopId: string, callId: string, at: Date): Promise<void> {
    await tx.execute(sql`
      update calls
      set status = 'IN_PROGRESS'::call_status,
          answered_at = coalesce(answered_at, ${at}),
          updated_at = ${at}
      where id = ${callId} and shop_id = ${shopId}
    `);
  }

  async finish(tx: Tx, input: FinishCallInput): Promise<void> {
    await tx.execute(sql`
      update calls
      set status = ${input.status}::call_status,
          outcome = ${input.outcome}::call_outcome,
          end_reason = ${input.endReason}::call_end_reason,
          ended_at = ${input.endedAt},
          duration_seconds = ${input.durationSeconds},
          turn_count = ${input.turnCount},
          handed_off = ${input.handedOff},
          degraded_to_ivr = ${input.degradedToIvr},
          poor_turn_count = ${input.poorTurnCount},
          barge_in_count = ${input.bargeInCount},
          max_turn_latency_ms = ${input.maxTurnLatencyMs},
          intent = ${input.intent}::voice_intent,
          agent_run_id = coalesce(${input.agentRunId}, agent_run_id),
          updated_at = ${input.endedAt}
      where id = ${input.callId} and shop_id = ${input.shopId}
    `);
  }

  async attachRecording(
    tx: Tx,
    shopId: string,
    callId: string,
    mediaId: string,
    retentionUntil: Date,
  ): Promise<void> {
    await tx.execute(sql`
      update calls
      set recording_media_id = ${mediaId}, retention_until = ${retentionUntil}, updated_at = now()
      where id = ${callId} and shop_id = ${shopId}
    `);
  }

  async recordBridge(
    tx: Tx,
    input: {
      readonly shopId: string;
      readonly callId: string;
      readonly advisorStaffId: string | null;
      readonly whisperText: string;
      readonly at: Date;
    },
  ): Promise<void> {
    await tx.execute(sql`
      update calls
      set status = 'BRIDGING'::call_status,
          handed_off = true,
          bridged_to_staff_id = ${input.advisorStaffId},
          whisper_text = ${input.whisperText},
          updated_at = ${input.at}
      where id = ${input.callId} and shop_id = ${input.shopId}
    `);
  }

  async attachAdvisorTask(tx: Tx, shopId: string, callId: string, taskId: string): Promise<void> {
    await tx.execute(sql`
      update calls
      set advisor_task_id = ${taskId}, handed_off = true, updated_at = now()
      where id = ${callId} and shop_id = ${shopId}
    `);
  }

  async attachAgentRun(tx: Tx, shopId: string, callId: string, agentRunId: string): Promise<void> {
    await tx.execute(sql`
      update calls set agent_run_id = ${agentRunId}, updated_at = now()
      where id = ${callId} and shop_id = ${shopId}
    `);
  }

  /**
   * Blocked rows are excluded from both counts.
   *
   * A call the gate refused consumed no minute of anybody's time and rang no
   * phone; counting it against the per-customer cap would mean a revoked
   * customer's blocked attempts eventually stopped the shop calling *other*
   * people, which is a cap punishing the wrong party.
   */
  async countForCustomerSince(
    tx: Tx,
    shopId: string,
    customerId: string,
    since: Date,
  ): Promise<number> {
    const result = await tx.execute<{ count: string | number }>(sql`
      select count(*)::int as count from calls
      where shop_id = ${shopId} and customer_id = ${customerId}
        and created_at >= ${since} and status <> 'BLOCKED'
    `);
    return Number(result.rows[0]?.count ?? 0);
  }

  async countForShopSince(tx: Tx, shopId: string, since: Date): Promise<number> {
    const result = await tx.execute<{ count: string | number }>(sql`
      select count(*)::int as count from calls
      where shop_id = ${shopId} and created_at >= ${since}
        and status <> 'BLOCKED' and direction = 'OUTBOUND'
    `);
    return Number(result.rows[0]?.count ?? 0);
  }

  /**
   * Attempts made for one ladder rung.
   *
   * Blocked rows do not count: a rung the gate refused never rang anybody, and
   * counting it as an attempt would spend the single retry on a call that was
   * never placed.
   */
  async countForEscalation(tx: Tx, shopId: string, escalationId: string): Promise<number> {
    const result = await tx.execute<{ count: string | number }>(sql`
      select count(*)::int as count from calls
      where shop_id = ${shopId} and escalation_id = ${escalationId} and status <> 'BLOCKED'
    `);
    return Number(result.rows[0]?.count ?? 0);
  }

  async findExpiredRetention(
    tx: Tx,
    before: Date,
    limit: number,
  ): Promise<readonly CallRecord[]> {
    const result = await tx.execute<CallRow>(sql`
      select ${CALL_COLUMNS} from calls
      where retention_until is not null and retention_until < ${before}
        and (recording_media_id is not null or turn_count > 0)
      order by retention_until asc
      limit ${limit}
    `);
    return result.rows.map(toCallRecord);
  }
}

type TurnRow = {
  call_id: string;
  shop_id: string;
  turn_index: number;
  role: CallTurnRole;
  input_mode: CallInputMode;
  text: string;
  dtmf_digit: string | null;
  confidence_bp: number | null;
  language_tag: string | null;
  mandatory_segment: boolean;
  script_key: string | null;
  barged_in: boolean;
  played_ms: number | null;
  latency_ms: number | null;
  latency_stages: unknown;
  tool_calls: unknown;
  checker_verdicts: unknown;
  agent_run_id: string | null;
  started_at: Date | string;
};

export class PgCallTurnStore implements CallTurnStore<Tx> {
  async append(tx: Tx, turn: CallTurnRecord): Promise<string | null> {
    const id = uuidv7();
    const result = await tx.execute<{ id: string }>(sql`
      insert into call_turns (
        id, shop_id, call_id, turn_index, role, input_mode, text, dtmf_digit,
        confidence_bp, language_tag, mandatory_segment, script_key, barged_in,
        played_ms, latency_ms, latency_stages, tool_calls, checker_verdicts,
        agent_run_id, started_at
      ) values (
        ${id}, ${turn.shopId}, ${turn.callId}, ${turn.turnIndex},
        ${turn.role}::call_turn_role, ${turn.inputMode}::call_input_mode,
        ${turn.text}, ${turn.dtmfDigit}, ${toBp(turn.confidence)}, ${turn.languageTag},
        ${turn.mandatorySegment}, ${turn.scriptKey}, ${turn.bargedIn}, ${turn.playedMs},
        ${turn.latencyMs}, ${JSON.stringify(turn.latencyStages)}::jsonb,
        ${JSON.stringify(turn.toolCalls)}::jsonb,
        ${JSON.stringify(turn.checkerVerdicts)}::jsonb,
        ${turn.agentRunId}, ${turn.startedAt}
      )
      on conflict (call_id, turn_index) do nothing
      returning id
    `);

    if (result.rows[0] !== undefined) {
      await tx.execute(sql`
        update calls set turn_count = greatest(turn_count, ${turn.turnIndex + 1}), updated_at = now()
        where id = ${turn.callId} and shop_id = ${turn.shopId}
      `);
    }

    return result.rows[0]?.id ?? null;
  }

  async load(tx: Tx, shopId: string, callId: string): Promise<readonly CallTurnRecord[]> {
    const result = await tx.execute<TurnRow>(sql`
      select
        call_id, shop_id, turn_index, role::text as role,
        input_mode::text as input_mode, text, dtmf_digit, confidence_bp,
        language_tag, mandatory_segment, script_key, barged_in, played_ms,
        latency_ms, latency_stages, tool_calls, checker_verdicts, agent_run_id,
        started_at
      from call_turns
      where shop_id = ${shopId} and call_id = ${callId}
      order by turn_index asc
    `);

    return result.rows.map((row) => ({
      callId: row.call_id,
      shopId: row.shop_id,
      turnIndex: row.turn_index,
      role: row.role,
      inputMode: row.input_mode,
      text: row.text,
      dtmfDigit: (row.dtmf_digit as DtmfDigit | null) ?? null,
      confidence: fromBp(row.confidence_bp),
      languageTag: row.language_tag,
      mandatorySegment: row.mandatory_segment,
      scriptKey: row.script_key,
      bargedIn: row.barged_in,
      playedMs: row.played_ms,
      latencyMs: row.latency_ms,
      latencyStages: (row.latency_stages ?? {}) as Partial<Record<VoiceLatencyStage, number>>,
      toolCalls: (row.tool_calls ?? []) as readonly { name: string; args: unknown }[],
      checkerVerdicts: (row.checker_verdicts ?? []) as readonly {
        checker: string;
        ok: boolean;
        code: string | null;
        reason: string | null;
      }[],
      agentRunId: row.agent_run_id,
      startedAt: date(row.started_at),
    }));
  }
}

export class PgCallConsentStore implements CallConsentStore<Tx> {
  async record(tx: Tx, event: CallConsentEventRecord): Promise<string | null> {
    const id = uuidv7();
    const result = await tx.execute<{ id: string }>(sql`
      insert into call_consent_events (id, shop_id, call_id, fact, turn_index, detail, occurred_at)
      values (
        ${id}, ${event.shopId}, ${event.callId}, ${event.fact}::call_consent_fact,
        ${event.turnIndex}, ${event.detail}, ${event.occurredAt}
      )
      on conflict (call_id, fact) do nothing
      returning id
    `);
    return result.rows[0]?.id ?? null;
  }

  async load(
    tx: Tx,
    shopId: string,
    callId: string,
  ): Promise<readonly CallConsentEventRecord[]> {
    const result = await tx.execute<{
      call_id: string;
      shop_id: string;
      fact: CallConsentFact;
      turn_index: number | null;
      detail: string | null;
      occurred_at: Date | string;
    }>(sql`
      select call_id, shop_id, fact::text as fact, turn_index, detail, occurred_at
      from call_consent_events
      where shop_id = ${shopId} and call_id = ${callId}
      order by occurred_at asc
    `);

    return result.rows.map((row) => ({
      callId: row.call_id,
      shopId: row.shop_id,
      fact: row.fact,
      turnIndex: row.turn_index,
      detail: row.detail,
      occurredAt: date(row.occurred_at),
    }));
  }
}

export class PgCallUsageStore implements CallUsageStore<Tx> {
  async record(tx: Tx, usage: CallUsageRecord): Promise<string | null> {
    const id = uuidv7();
    const result = await tx.execute<{ id: string }>(sql`
      insert into call_usage (
        id, shop_id, call_id, telco_seconds, stt_seconds, tts_seconds,
        llm_input_tokens, llm_output_tokens, estimated_cost_paise, cap_breached, trace_id
      ) values (
        ${id}, ${usage.shopId}, ${usage.callId}, ${usage.telcoSeconds},
        ${usage.sttSeconds}, ${usage.ttsSeconds}, ${usage.llmInputTokens},
        ${usage.llmOutputTokens}, ${usage.estimatedCostPaise}, ${usage.capBreached},
        ${usage.traceId}
      )
      on conflict (call_id) do nothing
      returning id
    `);
    return result.rows[0]?.id ?? null;
  }

  async spendSince(tx: Tx, shopId: string, since: Date): Promise<Paise> {
    const result = await tx.execute<{ total: string | number }>(sql`
      select coalesce(sum(estimated_cost_paise), 0)::bigint as total
      from call_usage where shop_id = ${shopId} and created_at >= ${since}
    `);
    return Number(result.rows[0]?.total ?? 0);
  }

  async platformSpendSince(tx: Tx, since: Date): Promise<Paise> {
    const result = await tx.execute<{ total: string | number }>(sql`
      select coalesce(sum(estimated_cost_paise), 0)::bigint as total
      from call_usage where created_at >= ${since}
    `);
    return Number(result.rows[0]?.total ?? 0);
  }

  async load(tx: Tx, shopId: string, callId: string): Promise<CallUsageRecord | null> {
    const result = await tx.execute<{
      call_id: string;
      shop_id: string;
      telco_seconds: number;
      stt_seconds: number;
      tts_seconds: number;
      llm_input_tokens: number;
      llm_output_tokens: number;
      estimated_cost_paise: string | number;
      cap_breached: string | null;
      trace_id: string;
    }>(sql`
      select call_id, shop_id, telco_seconds, stt_seconds, tts_seconds,
             llm_input_tokens, llm_output_tokens, estimated_cost_paise,
             cap_breached, trace_id
      from call_usage where shop_id = ${shopId} and call_id = ${callId}
    `);

    const row = result.rows[0];
    if (row === undefined) return null;

    return {
      callId: row.call_id,
      shopId: row.shop_id,
      telcoSeconds: row.telco_seconds,
      sttSeconds: row.stt_seconds,
      ttsSeconds: row.tts_seconds,
      llmInputTokens: row.llm_input_tokens,
      llmOutputTokens: row.llm_output_tokens,
      estimatedCostPaise: Number(row.estimated_cost_paise),
      capBreached: (row.cap_breached as 'SHOP_DAILY' | 'PLATFORM_DAILY' | null) ?? null,
      traceId: row.trace_id,
    };
  }
}

/**
 * The numbers a call actually dials, decrypted at the last possible moment.
 *
 * A narrow port with a narrow implementation: three queries, all of which hand
 * back plaintext, and the only caller allowed to ask is the one about to dial.
 */
export class PgCallDestinationReader implements CallDestinationReader<Tx> {
  async loadCustomerPhone(tx: Tx, shopId: string, customerId: string): Promise<string | null> {
    const result = await tx.execute<{ phone_encrypted: string }>(sql`
      select phone_encrypted from customers
      where id = ${customerId} and shop_id = ${shopId} and deleted_at is null
    `);
    const stored = result.rows[0]?.phone_encrypted;
    // Raw SQL bypasses the column's `customType`, so the decryption that the
    // Drizzle query builder would have done has to happen here. Returning the
    // ciphertext would produce a call to a number that does not exist and a log
    // line that looked entirely normal.
    return stored === undefined ? null : decryptPii(stored);
  }

  /**
   * The advisor a warm handoff bridges to.
   *
   * The same choice `ShopDirectory.loadHandoffAdvisor` makes — the shop's owner
   * or its first active advisor — because a bridge that rang a technician on a
   * lift would be a worse outcome than the customer waiting for a call back.
   */
  async loadAdvisorPhone(
    tx: Tx,
    shopId: string,
  ): Promise<{ readonly staffId: string; readonly fullName: string; readonly phone: string } | null> {
    const result = await tx.execute<{ id: string; full_name: string; phone_encrypted: string }>(sql`
      select id, full_name, phone_encrypted from staff
      where shop_id = ${shopId} and is_active = true and deleted_at is null
        and role in ('ADVISOR', 'OWNER')
      order by case role when 'ADVISOR' then 0 else 1 end, created_at asc
      limit 1
    `);

    const row = result.rows[0];
    if (row === undefined) return null;
    return { staffId: row.id, fullName: row.full_name, phone: decryptPii(row.phone_encrypted) };
  }

  async findCustomerByPhone(tx: Tx, shopId: string, phone: string): Promise<string | null> {
    const result = await tx.execute<{ id: string }>(sql`
      select id from customers
      where shop_id = ${shopId} and phone_hash = ${blindIndex(shopId, phone)}
        and deleted_at is null
      limit 1
    `);
    return result.rows[0]?.id ?? null;
  }
}

/**
 * `to_encrypted` is a `customType` on the Drizzle table, so the query-builder
 * path encrypts it automatically. These stores write raw SQL — they need
 * `on conflict do nothing`, which the builder cannot express here — so the
 * encryption has to be explicit.
 *
 * The alternative is a plaintext phone number sitting in a column named
 * `_encrypted`, which is worse than having no column at all: everything about
 * it looks safe.
 */
function encryptedNumber(value: string): string {
  return encryptPii(value);
}


/**
 * Where a call recording lands.
 *
 * Through the same `media_assets` table and the same `StoragePort` as every
 * other generated artefact — an invoice PDF, a gate-pass QR — because a call
 * recording is subject to exactly the same retention and deletion machinery,
 * and a second place to keep customer media is a second place phase 7 has to
 * remember to erase.
 */
export class PgCallRecordingWriter implements CallRecordingWriter<Tx> {
  constructor(private readonly media: GeneratedMediaWriter) {}

  async store(
    _tx: Tx,
    input: {
      readonly shopId: string;
      readonly callId: string;
      readonly wav: Buffer;
      readonly durationMs: number;
      readonly at: Date;
    },
  ): Promise<string> {
    const stored = await this.media.store({
      shopId: input.shopId,
      jobCardId: null,
      contentType: 'audio/wav',
      bytes: input.wav,
      filename: `call-${input.callId}.wav`,
      caption: `Call recording (${Math.round(input.durationMs / 1000)}s)`,
      traceId: input.callId,
    });
    return stored.mediaId;
  }
}

export interface VoiceStores {
  readonly calls: PgCallStore;
  readonly turns: PgCallTurnStore;
  readonly consentEvents: PgCallConsentStore;
  readonly usage: PgCallUsageStore;
  readonly destinations: PgCallDestinationReader;
}

/**
 * Every phase-5 store, in one call.
 *
 * The same shape as `createAgentStores`: three processes want the identical set
 * — the API, the workers and the demo runner — and each assembling it by hand
 * is how one of them ends up a store short.
 */
export function createVoiceStores(): VoiceStores {
  return {
    calls: new PgCallStore(),
    turns: new PgCallTurnStore(),
    consentEvents: new PgCallConsentStore(),
    usage: new PgCallUsageStore(),
    destinations: new PgCallDestinationReader(),
  };
}
