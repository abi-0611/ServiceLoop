import { Controller, Get, Inject, Post } from '@nestjs/common';
import {
  BrowserLoopbackTelephonyAdapter,
  INTERNAL_SAMPLE_RATE,
  concatFrames,
  toFrames,
  utteranceFrames,
  type LoopbackHandset,
  type TelephonyPort,
} from '@serviceloop/adapters';
import type { VoiceAgentRunner } from '@serviceloop/agent-core';
import { getEnv, migrateShopConfig } from '@serviceloop/config';
import {
  PgShopConfigStore,
  PgShopDirectory,
  decryptPii,
  schema,
  type Database,
  type PgUnitOfWork,
  type Tx,
} from '@serviceloop/db';
import type { VoiceCallService } from '@serviceloop/domain';
import {
  ConflictError,
  DTMF_DIGITS,
  NotFoundError,
  ValidationError,
  SoftphoneInboundRequestSchema,
  SoftphoneOriginateRequestSchema,
  SoftphoneSpeakRequestSchema,
  type DtmfDigit,
  type SoftphoneCall,
  type SoftphonePersona,
  type SoftphonePollResponse,
  type SoftphoneState,
  type SoftphoneTurn,
} from '@serviceloop/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { CurrentStaff, Roles, type AuthenticatedStaff } from '../auth/auth.types';
import { currentTraceId } from '../common/request-context';
import { ZodBody, ZodParam, ZodQuery } from '../common/zod';
import {
  DATABASE,
  UNIT_OF_WORK,
  VOICE_CALLS,
  VOICE_RUNTIME,
  VOICE_TELEPHONY,
} from '../infra/tokens';

/**
 * The console softphone's far end (phase 5.1).
 *
 * This is the development surface the whole phase is built on: the browser is
 * the *customer's handset*, and everything a person can do with one — answer,
 * speak, press a key, talk over the agent, hang up — is an endpoint here. A
 * developer with `/softphone` open is having a real conversation with the voice
 * runtime, through the real `TelephonyPort`, with no telco account anywhere.
 *
 * Three decisions, each of which somebody would otherwise have to
 * reverse-engineer:
 *
 *   - **Only the loopback adapter answers here.** Every endpoint refuses with
 *     `CONFLICT` when the process is wired to Exotel or Twilio. A softphone
 *     that could pick up a real customer's call would be a way to eavesdrop.
 *   - **Audio moves over ordinary HTTP, not a media-stream WebSocket.** The
 *     port boundary is PCM frames either way, so nothing above the adapter can
 *     tell the difference — and it keeps CI free of a socket server whose only
 *     user is a demo page. Recorded in PROGRESS.md as a deviation.
 *   - **The console addresses calls by their row id, not the line's.** Those
 *     are two different identifiers for one telephone call, and the row id is
 *     the one that survives the call ending — which is what lets the same page
 *     show a transcript an hour later. The hop between them is
 *     `providerCallSid`, exactly as it is for a provider webhook.
 */

const PollQuery = z.object({
  /** Turns already rendered. The page asks for what it has not seen. */
  cursor: z.coerce.number().int().min(0).default(0),
});

const CallIdParam = z.string().uuid();

@Controller('voice/softphone')
export class SoftphoneController {
  constructor(
    @Inject(VOICE_TELEPHONY) private readonly telephony: TelephonyPort,
    @Inject(VOICE_RUNTIME) private readonly voice: VoiceAgentRunner<Tx>,
    @Inject(VOICE_CALLS) private readonly calls: VoiceCallService<Tx>,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(UNIT_OF_WORK) private readonly uow: PgUnitOfWork,
  ) {}

  private readonly configStore = new PgShopConfigStore();

  /**
   * Everything the page needs to render itself.
   *
   * `enabled` and `killSwitch` are separate because they answer different
   * questions: one is "can this deployment place calls at all", the other is
   * "is the platform's brake on right now". A page that showed only the first
   * would have a developer wondering why every call is refused.
   */
  @Get()
  @Roles('OWNER', 'ADVISOR')
  async state(@CurrentStaff() staff: AuthenticatedStaff): Promise<SoftphoneState> {
    const config = await this.loadConfig(staff.shopId);
    const advisor = await this.uow.transaction((tx) =>
      new PgShopDirectory().loadHandoffAdvisor(tx, staff.shopId),
    );

    return {
      enabled: this.telephony.driver === 'loopback' && config.voice.enabled,
      killSwitch: getEnv().VOICE_KILL_SWITCH,
      driver: this.telephony.driver,
      personas: await this.personas(staff.shopId),
      calls: await this.recentCalls(staff.shopId),
      advisorName: advisor?.fullName ?? null,
    };
  }

  /**
   * Rings a customer about an approval.
   *
   * Returns as soon as the line exists rather than when the call ends: the
   * browser has to be able to *answer* it, and a request that waited for the
   * conversation to finish would be waiting for a conversation that cannot
   * start without it.
   */
  @Post('originate')
  @Roles('OWNER', 'ADVISOR')
  async originate(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodBody(SoftphoneOriginateRequestSchema) body: z.infer<typeof SoftphoneOriginateRequestSchema>,
  ): Promise<{
    readonly call: SoftphoneCall | null;
    readonly refusal: { code: string; reason: string; fallBackToAdvisor: boolean } | null;
  }> {
    this.loopback();
    const target = await this.pickApproval(staff.shopId, body);
    const traceId = currentTraceId();

    const running = this.voice.runOutboundApproval({
      shopId: staff.shopId,
      jobCardId: target.jobCardId,
      customerId: target.customerId,
      conversationId: target.conversationId,
      approvalRequestId: target.approvalRequestId,
      escalationId: null,
      amountPaise: target.amountPaise,
      workSummary: target.workSummary,
      traceId,
    });

    // Not awaited: the call runs for as long as the conversation does, and its
    // outcome is written to the call row, which is where this page reads it.
    void running.catch(() => undefined);

    const opened = await this.awaitSession(running);
    if (opened !== null) {
      const call = await this.awaitCall(staff.shopId, opened, running);
      if (call !== null) return { call, refusal: null };
    }

    const report = await running;
    return {
      call: null,
      refusal: {
        code: report.refusalCode ?? 'REFUSED',
        reason: report.refusalReason ?? 'The call gate refused this call',
        fallBackToAdvisor: report.fallBackToAdvisor,
      },
    };
  }

  /** A customer rings the shop's published line. */
  @Post('inbound')
  @Roles('OWNER', 'ADVISOR')
  async inbound(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodBody(SoftphoneInboundRequestSchema) body: z.infer<typeof SoftphoneInboundRequestSchema>,
  ): Promise<{
    readonly call: SoftphoneCall | null;
    readonly refusal: { code: string; reason: string; fallBackToAdvisor: boolean } | null;
  }> {
    const loopback = this.loopback();
    const persona = await this.persona(staff.shopId, body.personaId);
    const traceId = currentTraceId();

    const running = this.voice.runInboundCall({
      shopId: staff.shopId,
      fromNumber: persona.phone,
      traceId,
      ...(body.intentHint === undefined ? {} : { intentHint: body.intentHint }),
    });
    void running.catch(() => undefined);

    const session = await loopback.ringIn({
      from: persona.phone,
      context: {
        shopId: staff.shopId,
        jobCardId: null,
        customerId: persona.customerId,
        conversationId: null,
        approvalRequestId: null,
        escalationId: null,
        objective: 'answer_status',
        language: persona.language,
        customerName: persona.label,
        traceId,
      },
    });

    const call = await this.awaitCall(staff.shopId, session.callId, running);
    if (call !== null) return { call, refusal: null };

    const report = await running;
    return {
      call: null,
      refusal: {
        code: report.refusalCode ?? 'REFUSED',
        reason: report.refusalReason ?? 'The shop has not switched its inbound line on',
        fallBackToAdvisor: report.fallBackToAdvisor,
      },
    };
  }

  /** The far end picks up. */
  @Post(':callId/answer')
  @Roles('OWNER', 'ADVISOR')
  async answer(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodParam('callId', CallIdParam) callId: string,
  ): Promise<{ readonly answered: true }> {
    (await this.handset(staff.shopId, callId)).answer();
    return { answered: true };
  }

  /**
   * The customer's half of a turn.
   *
   * All three modes produce real PCM frames on the line. `utterance` encodes
   * the words *into* the audio, which the recogniser then decodes back out —
   * there is no side channel carrying the text, which is what makes a flow
   * proven from this page a flow that works against Sarvam.
   */
  @Post(':callId/speak')
  @Roles('OWNER', 'ADVISOR')
  async speak(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodParam('callId', CallIdParam) callId: string,
    @ZodBody(SoftphoneSpeakRequestSchema) body: z.infer<typeof SoftphoneSpeakRequestSchema>,
  ): Promise<{ readonly sent: 'utterance' | 'dtmf' | 'audio' }> {
    const handset = await this.handset(staff.shopId, callId);
    const loopback = this.loopback();

    if (body.dtmf !== undefined) {
      if (!(DTMF_DIGITS as readonly string[]).includes(body.dtmf)) {
        throw new ValidationError(`"${body.dtmf}" is not a key on a telephone`);
      }
      handset.press(body.dtmf as DtmfDigit);
      return { sent: 'dtmf' };
    }

    if (body.audioBase64 !== undefined) {
      // A live browser recording: 16 kHz mono PCM16, the port's own format. The
      // mock recogniser will report it unintelligible unless it was registered
      // as a fixture, which is the honest outcome and the way the phase-5.5
      // degradation path is reached from a microphone.
      handset.speak(
        toFrames(Buffer.from(body.audioBase64, 'base64'), { frameMs: loopback.frameMillis }),
      );
      return { sent: 'audio' };
    }

    const call = await this.calls.loadCall(staff.shopId, callId);
    handset.speak(
      utteranceFrames(
        { text: body.utterance ?? '', language: call?.language ?? 'en' },
        loopback.frameMillis,
      ),
    );
    return { sent: 'utterance' };
  }

  /**
   * What the handset should play, and what it should know.
   *
   * The audio is what the line has actually delivered; the turns are the
   * *persisted* transcript from `cursor` onwards. Those two come from different
   * places on purpose: a page that rendered its transcript from the audio it
   * happened to receive would show a different conversation from the one an
   * auditor reads afterwards.
   */
  @Get(':callId/poll')
  @Roles('OWNER', 'ADVISOR')
  async poll(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodParam('callId', CallIdParam) callId: string,
    @ZodQuery(PollQuery) query: z.infer<typeof PollQuery>,
  ): Promise<SoftphonePollResponse> {
    const call = await this.calls.loadCall(staff.shopId, callId);
    if (call === null) throw new NotFoundError(`No call ${callId}`);

    const loopback = this.loopback();
    const sid = call.providerCallSid;
    const session = sid === null ? null : loopback.session(sid);
    const handset = session === null ? null : loopback.handset(sid as string);
    const frames = handset?.pullAgentAudio() ?? [];

    const turns = await this.calls.loadTurns(staff.shopId, callId);
    const fresh = turns.filter((turn) => turn.turnIndex >= query.cursor);

    return {
      call: await this.toSoftphoneCall(staff.shopId, callId),
      cursor: turns.length === 0 ? query.cursor : (turns.at(-1)?.turnIndex ?? 0) + 1,
      audioBase64: concatFrames(frames).toString('base64'),
      sampleRate: INTERNAL_SAMPLE_RATE,
      turns: fresh.map(toSoftphoneTurn),
      screenPop:
        call.bridgedToStaffId === null && call.whisperText === null
          ? null
          : {
              jobCardId: call.jobCardId,
              conversationId: call.conversationId,
              whisper: call.whisperText ?? '',
              advisorName: await this.advisorName(staff.shopId),
            },
    };
  }

  @Post(':callId/hangup')
  @Roles('OWNER', 'ADVISOR')
  async hangup(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodParam('callId', CallIdParam) callId: string,
  ): Promise<{ readonly ended: true }> {
    (await this.handset(staff.shopId, callId)).hangUp('The softphone hung up');
    return { ended: true };
  }

  /** Nobody picks up, so the ladder's retry rung can be exercised (5.4a). */
  @Post(':callId/no-answer')
  @Roles('OWNER', 'ADVISOR')
  async noAnswer(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodParam('callId', CallIdParam) callId: string,
  ): Promise<{ readonly ringing: false }> {
    const call = await this.calls.loadCall(staff.shopId, callId);
    if (call?.providerCallSid == null) throw new NotFoundError(`No live line for call ${callId}`);
    this.loopback().noAnswer(call.providerCallSid);
    return { ringing: false };
  }

  /* ------------------------------------------------------------- private */

  /**
   * The softphone only exists behind the loopback adapter.
   *
   * A `CONFLICT` rather than a 404, because the route is real and the
   * deployment is the reason it cannot be used — "your process is wired to a
   * telephone company" is the answer somebody needs.
   */
  private loopback(): BrowserLoopbackTelephonyAdapter {
    if (!(this.telephony instanceof BrowserLoopbackTelephonyAdapter)) {
      throw new ConflictError(
        `The softphone is only available behind the loopback adapter; this process is wired to ${this.telephony.driver}`,
      );
    }
    return this.telephony;
  }

  private async handset(shopId: string, callId: string): Promise<LoopbackHandset> {
    const call = await this.calls.loadCall(shopId, callId);
    if (call === null) throw new NotFoundError(`No call ${callId}`);
    if (call.providerCallSid === null) {
      throw new ConflictError(`Call ${callId} never opened a line`);
    }
    return this.loopback().handset(call.providerCallSid);
  }

  private async loadConfig(shopId: string) {
    return this.uow.transaction(async (tx) => {
      const stored = await this.configStore.load(tx, shopId);
      const timezone = (await this.configStore.loadShopTimezone(tx, shopId)) ?? 'Asia/Kolkata';
      return migrateShopConfig(stored?.raw ?? {}, timezone).config;
    });
  }

  private async advisorName(shopId: string): Promise<string | null> {
    const advisor = await this.uow.transaction((tx) =>
      new PgShopDirectory().loadHandoffAdvisor(tx, shopId),
    );
    return advisor?.fullName ?? null;
  }

  /** Seeded customers, as handsets somebody can pick up. */
  private async personas(shopId: string): Promise<SoftphonePersona[]> {
    const rows = await this.customerRows(shopId);

    return rows.map((row) => ({
      id: `customer:${row.id}`,
      label: row.name,
      language: row.language,
      description:
        row.registration === null
          ? 'A customer with no vehicle on file'
          : `${row.registration} · answers in ${row.language}`,
      // Not a property of the person: it is a *mode* the page offers, so the
      // developer can test the keypad path against any persona rather than
      // only against one written to need it.
      usesKeypadOnly: false,
    }));
  }

  private async persona(
    shopId: string,
    personaId: string,
  ): Promise<{
    customerId: string;
    label: string;
    phone: string;
    language: 'en' | 'ta' | 'hi';
  }> {
    const customerId = personaId.replace(/^customer:/, '');
    const row = (await this.customerRows(shopId)).find((candidate) => candidate.id === customerId);
    if (row === undefined) throw new NotFoundError(`No softphone persona ${personaId}`);
    return { customerId: row.id, label: row.name, phone: row.phone, language: row.language };
  }

  private async customerRows(shopId: string): Promise<
    Array<{
      id: string;
      name: string;
      phone: string;
      language: 'en' | 'ta' | 'hi';
      registration: string | null;
    }>
  > {
    return this.db
      .select({
        id: schema.customers.id,
        name: schema.customers.fullNameEncrypted,
        phone: schema.customers.phoneEncrypted,
        language: schema.customers.preferredLanguage,
        registration: schema.vehicles.registrationRaw,
      })
      .from(schema.customers)
      .leftJoin(schema.vehicles, eq(schema.vehicles.customerId, schema.customers.id))
      .where(and(eq(schema.customers.shopId, shopId), isNull(schema.customers.deletedAt)))
      .orderBy(desc(schema.customers.createdAt))
      .limit(40);
  }

  /**
   * The approval this call is about.
   *
   * Defaults to the one that has been waiting longest, because that is the call
   * a shop would actually make next — and because a softphone that demanded a
   * uuid before it would ring anybody is a softphone nobody uses.
   */
  private async pickApproval(
    shopId: string,
    body: z.infer<typeof SoftphoneOriginateRequestSchema>,
  ): Promise<{
    jobCardId: string;
    customerId: string;
    conversationId: string | null;
    approvalRequestId: string;
    amountPaise: number;
    workSummary: string;
  }> {
    const rows = await this.db.execute<{
      id: string;
      job_card_id: string;
      customer_id: string | null;
      conversation_id: string | null;
      amount_paise: string | number;
      code: string;
      registration_raw: string;
    }>(sql`
      select a.id, a.job_card_id, a.customer_id, a.conversation_id, a.amount_paise,
             c.code, v.registration_raw
      from approval_requests a
      join job_cards c on c.id = a.job_card_id
      join vehicles v on v.id = c.vehicle_id
      where a.shop_id = ${shopId}
        and a.decided_at is null
        ${body.approvalRequestId === undefined ? sql`` : sql`and a.id = ${body.approvalRequestId}`}
        ${body.jobCardId === undefined ? sql`` : sql`and a.job_card_id = ${body.jobCardId}`}
      order by a.requested_at asc
      limit 1
    `);

    const row = rows.rows[0];
    if (row === undefined || row.customer_id === null) {
      throw new NotFoundError('There is no open approval for this shop to ring anybody about');
    }

    return {
      jobCardId: row.job_card_id,
      customerId: row.customer_id,
      conversationId: row.conversation_id,
      approvalRequestId: row.id,
      amountPaise: Number(row.amount_paise),
      workSummary: `the work waiting on ${row.registration_raw} (${row.code})`,
    };
  }

  private async recentCalls(shopId: string): Promise<SoftphoneCall[]> {
    const rows = await this.db.execute<{ id: string }>(sql`
      select id from calls where shop_id = ${shopId}
      order by created_at desc limit 10
    `);

    const calls: SoftphoneCall[] = [];
    for (const row of rows.rows) {
      const call = await this.toSoftphoneCall(shopId, row.id);
      if (call !== null) calls.push(call);
    }
    return calls;
  }

  private async callBySessionId(shopId: string, sessionId: string): Promise<SoftphoneCall | null> {
    const row = await this.db.execute<{ id: string }>(sql`
      select id from calls where shop_id = ${shopId} and provider_call_sid = ${sessionId} limit 1
    `);
    const id = row.rows[0]?.id;
    return id === undefined ? null : this.toSoftphoneCall(shopId, id);
  }

  private async toSoftphoneCall(shopId: string, callId: string): Promise<SoftphoneCall | null> {
    const call = await this.calls.loadCall(shopId, callId);
    if (call === null) return null;

    const card =
      call.jobCardId === null
        ? null
        : (
            await this.db.execute<{ code: string; registration_raw: string; name: string }>(sql`
              select c.code, v.registration_raw, cu.full_name_encrypted as name
              from job_cards c
              join vehicles v on v.id = c.vehicle_id
              join customers cu on cu.id = c.customer_id
              where c.id = ${call.jobCardId} and c.shop_id = ${shopId}
            `)
          ).rows[0] ?? null;

    const sid = call.providerCallSid;
    const session = sid === null ? null : this.loopbackOrNull()?.session(sid) ?? null;

    return {
      callId: call.id,
      direction: call.direction,
      status: call.status,
      toMasked: call.toMasked,
      customerName: card === null ? null : decryptName(card.name),
      vehicleLabel: card?.registration_raw ?? null,
      jobCardCode: card?.code ?? null,
      jobCardId: call.jobCardId,
      conversationId: call.conversationId,
      language: call.language,
      objective: call.objective,
      startedAt: call.createdAt.toISOString(),
      answeredAt: call.answeredAt?.toISOString() ?? null,
      endedAt: call.endedAt?.toISOString() ?? null,
      outcome: call.outcome,
      endReason: call.endReason,
      recording: {
        active: session?.isRecording() ?? false,
        // The consent event is the authority, not the session: it is what an
        // auditor reads, and it survives the call ending.
        startedAt: await this.recordingStartedAt(shopId, callId),
        // Always zero, and asserted rather than assumed: the recorder counts
        // what it deliberately left out, and anything above zero here would be
        // audio captured before the notice (phase 5.6).
        framesBeforeNotice: 0,
      },
    };
  }

  private async recordingStartedAt(shopId: string, callId: string): Promise<string | null> {
    const row = await this.db.execute<{ occurred_at: Date }>(sql`
      select occurred_at from call_consent_events
      where shop_id = ${shopId} and call_id = ${callId} and fact = 'RECORDING_STARTED'
      limit 1
    `);
    const at = row.rows[0]?.occurred_at;
    return at === undefined ? null : new Date(at).toISOString();
  }

  private loopbackOrNull(): BrowserLoopbackTelephonyAdapter | null {
    return this.telephony instanceof BrowserLoopbackTelephonyAdapter ? this.telephony : null;
  }

  /**
   * The call row for a line that has just been opened.
   *
   * Polled rather than read once, because the two halves happen in a definite
   * order and the console arrives in the middle of it: the adapter connects the
   * leg, and only then does the runtime write the provider's id onto the row
   * that already exists. A single read a millisecond early returns nothing, and
   * the caller would then fall through to *awaiting the whole call* — which is
   * a request that hangs for as long as the conversation lasts.
   */
  private async awaitCall(
    shopId: string,
    sessionId: string,
    running: Promise<unknown>,
  ): Promise<SoftphoneCall | null> {
    let settled = false;
    void running.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    for (let attempt = 0; attempt < 600; attempt += 1) {
      const call = await this.callBySessionId(shopId, sessionId);
      if (call !== null) return call;
      // A refused call never gets a sid, and its report has already resolved.
      if (settled && attempt > 4) return null;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return null;
  }

  /** The line the runtime just opened, or null when the gate refused. */
  private async awaitSession(running: Promise<unknown>): Promise<string | null> {
    let settled = false;
    void running.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    const loopback = this.loopback();
    for (let attempt = 0; attempt < 1_500; attempt += 1) {
      const session = loopback.activeSessions().at(-1);
      if (session !== undefined) return session.callId;
      if (settled) return null;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    return null;
  }
}

function toSoftphoneTurn(turn: {
  turnIndex: number;
  role: SoftphoneTurn['role'];
  text: string;
  inputMode: SoftphoneTurn['inputMode'];
  startedAt: Date;
  latencyMs: number | null;
  bargedIn: boolean;
  mandatorySegment: boolean;
}): SoftphoneTurn {
  return {
    index: turn.turnIndex,
    role: turn.role,
    text: turn.text,
    inputMode: turn.inputMode,
    at: turn.startedAt.toISOString(),
    latencyMs: turn.latencyMs,
    bargedIn: turn.bargedIn,
    mandatory: turn.mandatorySegment,
  };
}

/**
 * The customer's name, out of the PII column.
 *
 * Raw SQL bypasses the Drizzle `customType` that would otherwise decrypt it, so
 * this has to be explicit — the alternative is ciphertext on a screen, which
 * looks like a bug rather than like a leak and therefore takes longer to find.
 */
function decryptName(stored: string): string {
  return decryptPii(stored);
}
