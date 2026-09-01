import { Controller, Get, Inject } from '@nestjs/common';
import type { Tx, Database } from '@serviceloop/db';
import { PgJobCardContextReader } from '@serviceloop/db';
import type { VoiceCallService } from '@serviceloop/domain';
import { NotFoundError } from '@serviceloop/shared';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { CurrentStaff, Roles, type AuthenticatedStaff } from '../auth/auth.types';
import { ZodParam, ZodQuery } from '../common/zod';
import { DATABASE, UNIT_OF_WORK, VOICE_CALLS } from '../infra/tokens';
import type { PgUnitOfWork } from '@serviceloop/db';

/**
 * What the console shows about a call (phase 5.4c).
 *
 * Two reads, and the second one is the screen-pop: when the agent bridges a
 * caller to an advisor, the advisor's console has about eight seconds — the
 * length of the whisper — to put the card and the transcript in front of them.
 * Everything on this endpoint is chosen for what a person needs in those eight
 * seconds: who is on the line, which vehicle, what has been said so far, and
 * what the agent was trying to get agreed.
 *
 * The transcript is the persisted one, not a live buffer. A call that ended an
 * hour ago reads exactly the same way, which is the property that makes the
 * audit story on a phone as strong as in a thread.
 */

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /** Live calls only. What the ringing UI and the screen-pop poll. */
  active: z.coerce.boolean().default(false),
});

interface CallRow extends Record<string, unknown> {
  readonly id: string;
  readonly direction: string;
  readonly status: string;
  readonly outcome: string | null;
  readonly to_masked: string;
  readonly job_card_id: string | null;
  readonly customer_id: string | null;
  readonly objective: string;
  readonly language: string;
  readonly handed_off: boolean;
  readonly bridged_to_staff_id: string | null;
  readonly whisper_text: string | null;
  readonly degraded_to_ivr: boolean;
  readonly turn_count: number;
  readonly duration_seconds: number;
  readonly blocked_code: string | null;
  readonly created_at: Date;
  readonly answered_at: Date | null;
  readonly ended_at: Date | null;
}

@Controller('voice/calls')
export class CallsController {
  constructor(
    @Inject(VOICE_CALLS) private readonly calls: VoiceCallService<Tx>,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(UNIT_OF_WORK) private readonly uow: PgUnitOfWork,
  ) {}

  /** The shop's calls, newest first. */
  @Get()
  @Roles('OWNER', 'ADVISOR')
  async list(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodQuery(ListQuery) query: z.infer<typeof ListQuery>,
  ) {
    const rows = await this.db.execute<CallRow>(sql`
      select id, direction, status, outcome, to_masked, job_card_id, customer_id,
             objective, language, handed_off, bridged_to_staff_id, whisper_text,
             degraded_to_ivr, turn_count, duration_seconds, blocked_code,
             created_at, answered_at, ended_at
      from calls
      where shop_id = ${staff.shopId}
        ${query.active ? sql`and ended_at is null and status <> 'BLOCKED'` : sql``}
      order by created_at desc
      limit ${query.limit}
    `);

    return { calls: rows.rows.map(toSummary) };
  }

  /**
   * One call, with everything a screen-pop needs.
   *
   * The job card is loaded through the same reader the agent uses, so what the
   * advisor sees is what the agent was reading from — an advisor and an agent
   * disagreeing about the estimate in front of a customer is the specific
   * failure this endpoint exists to prevent.
   */
  @Get(':callId')
  @Roles('OWNER', 'ADVISOR')
  async detail(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodParam('callId', z.string().uuid()) callId: string,
  ) {
    const call = await this.calls.loadCall(staff.shopId, callId);
    if (call === null) throw new NotFoundError(`No call ${callId}`);

    const turns = await this.calls.loadTurns(staff.shopId, callId);
    const card =
      call.jobCardId === null
        ? null
        : await this.uow.transaction((tx) =>
            new PgJobCardContextReader().load(tx, staff.shopId, call.jobCardId as string),
          );

    return {
      call: {
        callId: call.id,
        direction: call.direction,
        status: call.status,
        outcome: call.outcome,
        endReason: call.endReason,
        toMasked: call.toMasked,
        objective: call.objective,
        language: call.language,
        intent: call.intent,
        handedOff: call.handedOff,
        bridgedToStaffId: call.bridgedToStaffId,
        /** The eight seconds the advisor was whispered before the legs joined. */
        whisperText: call.whisperText,
        degradedToIvr: call.degradedToIvr,
        bargeInCount: call.bargeInCount,
        maxTurnLatencyMs: call.maxTurnLatencyMs,
        turnCount: call.turnCount,
        durationSeconds: call.durationSeconds,
        recordingMediaId: call.recordingMediaId,
        advisorTaskId: call.advisorTaskId,
        blockedCode: call.blockedCode,
        blockedReason: call.blockedReason,
        createdAt: call.createdAt.toISOString(),
        answeredAt: call.answeredAt?.toISOString() ?? null,
        endedAt: call.endedAt?.toISOString() ?? null,
      },
      transcript: turns.map((turn) => ({
        turnIndex: turn.turnIndex,
        role: turn.role,
        inputMode: turn.inputMode,
        text: turn.text,
        dtmfDigit: turn.dtmfDigit,
        confidence: turn.confidence,
        // The two ⚿ segments and the readback are the turns an auditor looks
        // for, so they are named rather than left to be inferred from the copy.
        scriptKey: turn.scriptKey,
        mandatory: turn.mandatorySegment,
        bargedIn: turn.bargedIn,
        latencyMs: turn.latencyMs,
        at: turn.startedAt.toISOString(),
      })),
      card:
        card === null
          ? null
          : {
              jobCardId: card.jobCardId,
              code: card.code,
              state: card.state,
              customerName: card.customerName,
              vehicle: card.vehicleLabel,
              registration: card.registration,
              complaint: card.complaint,
              totalPaise: card.estimate?.totalPaise ?? null,
              workItems: card.workItems.map((item) => ({
                id: item.id,
                title: item.title,
                state: item.state,
              })),
            },
    };
  }
}

function toSummary(row: CallRow) {
  return {
    callId: row.id,
    direction: row.direction,
    status: row.status,
    outcome: row.outcome,
    toMasked: row.to_masked,
    jobCardId: row.job_card_id,
    customerId: row.customer_id,
    objective: row.objective,
    language: row.language,
    handedOff: row.handed_off,
    bridgedToStaffId: row.bridged_to_staff_id,
    whisperText: row.whisper_text,
    degradedToIvr: row.degraded_to_ivr,
    turnCount: Number(row.turn_count),
    durationSeconds: Number(row.duration_seconds),
    blockedCode: row.blocked_code,
    createdAt: new Date(row.created_at).toISOString(),
    answeredAt: row.answered_at === null ? null : new Date(row.answered_at).toISOString(),
    endedAt: row.ended_at === null ? null : new Date(row.ended_at).toISOString(),
  };
}
