import {
  BrowserLoopbackTelephonyAdapter,
  MockStreamingSpeechAdapter,
  ScriptedCaller,
  deterministicJudge,
  type CallerAction,
  type LoopbackHandset,
} from '@serviceloop/adapters';
import {
  DeterministicExplanationWriter,
  createAgentRuntime,
  createVoiceRuntime,
  voiceSettingsFrom,
  type CallReport,
} from '@serviceloop/agent-core';
import {
  defaultShopConfig,
  formatAdapterSelection,
  getEnv,
  migrateShopConfig,
} from '@serviceloop/config';
import {
  AuditService,
  DEMO_SHOP_ID,
  OutboxService,
  PgCallRecordingWriter,
  PgConsentStore,
  PgConversationStore,
  PgGeneratedMediaWriter,
  PgJobCardStore,
  PgMessageStore,
  PgShopConfigStore,
  PgShopDirectory,
  PgUnitOfWork,
  PgWorkItemStore,
  blindIndex,
  createAgentStores,
  createDatabase,
  createVoiceStores,
  schema,
  type Database,
  type Tx,
} from '@serviceloop/db';
import { createStoragePort } from '@serviceloop/adapters';
import {
  JobCardTransitionService,
  OutboundGate,
  VoiceCallService,
  WorkItemTransitionService,
  type RungScheduler,
} from '@serviceloop/domain';
import { formatPaise, uuidv7 } from '@serviceloop/shared';
import { sql } from 'drizzle-orm';
import IORedis from 'ioredis';
import { assert, assertEqual, ScenarioRunner } from '../runner';

/**
 * `pnpm demo:phase5`
 *
 * One outbound approval call and one inbound call, end to end, **against the
 * real database and with no telco account of any kind**.
 *
 * The far end of both calls is `BrowserLoopbackTelephonyAdapter` — the same
 * adapter the console's softphone drives, behind the same `TelephonyPort` the
 * Exotel and Twilio adapters implement. Audio really is PCM frames, the
 * recogniser really decodes words out of them, and the recording really is a
 * WAV in object storage. What is simulated is the *wire*, not the pipeline.
 *
 * Against Postgres, deliberately, and for the same reason the phase-3 demo is:
 * the voice runtime has an in-memory suite of its own (`pnpm sim:voice`, five
 * personas, required in CI), so what this demo uniquely exercises is the
 * phase-5 Postgres stores — `calls`, `call_turns`, `call_consent_events`,
 * `call_usage` — which every other test replaces with a double.
 *
 * The delayed-job queue stays in memory, as in phase 3: a demo that needed a
 * BullMQ worker running to prove a rung was scheduled would be testing the
 * developer's terminal.
 */

const TRACE = `demo-phase5-${uuidv7().slice(0, 8)}`;

/** A fresh number every run, so repeated demos never collide on a thread. */
const CUSTOMER_PHONE = `+9197${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`;
const ADVISOR_PHONE = `+9198${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`;

const BRAKES_PAISE = 240_000;
const OIL_PAISE = 60_000;

/** Records what was scheduled without needing Redis. */
class InMemoryRungScheduler implements RungScheduler {
  readonly jobs = new Map<string, { escalationId: string; runAt: Date }>();
  private counter = 0;

  async enqueue(input: {
    readonly escalationId: string;
    readonly shopId: string;
    readonly subjectId: string;
    readonly runAt: Date;
  }): Promise<string | null> {
    this.counter += 1;
    const jobId = `demo5-job-${this.counter}`;
    this.jobs.set(jobId, { escalationId: input.escalationId, runAt: input.runAt });
    return jobId;
  }

  async cancel(jobId: string): Promise<void> {
    this.jobs.delete(jobId);
  }
}

async function main(): Promise<void> {
  const env = getEnv();
  const database = createDatabase(env);
  const db = database.db;
  const redis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

  const uow = new PgUnitOfWork(db);
  const audit = new AuditService(db, redis);
  const outbox = new OutboxService(db);
  const scheduler = new InMemoryRungScheduler();

  const messages = new PgMessageStore();
  const conversations = new PgConversationStore();
  const configStore = new PgShopConfigStore();
  const { createChannelPorts } = await import('@serviceloop/adapters');
  const channels = createChannelPorts(env, { redis });

  const gate = new OutboundGate<Tx>({
    uow,
    conversations,
    messages,
    consents: new PgConsentStore(),
    config: configStore,
    audit,
    outbox,
    sender: channels.sender,
  });

  const jobCardTransitions = new JobCardTransitionService<Tx>({
    uow,
    cards: new PgJobCardStore(),
    config: configStore,
    audit,
    outbox,
  });

  // No key required. The deterministic judge keeps the checker's third layer
  // honest without a credential, and the scripted personas never reach a model
  // for anything else — this demo's calls are completed on the keypad, which is
  // the path the acceptance gate names.
  const llm = deterministicJudge();
  const stores = createAgentStores();

  const agent = createAgentRuntime<Tx>({
    stores: {
      uow,
      ...stores,
      conversations,
      messages,
      config: configStore,
      directory: new PgShopDirectory(),
      audit,
      outbox,
    },
    gate,
    jobCards: jobCardTransitions,
    workItems: new WorkItemTransitionService<Tx>({
      uow,
      items: new PgWorkItemStore(),
      audit,
      outbox,
    }),
    scheduler,
    llm,
    config: defaultShopConfig(env.DEFAULT_TIMEZONE),
    conversationTail: (tx, shopId, conversationId, limit) =>
      messages.recentForConversation(tx, shopId, conversationId, limit),
    loadHeld: (tx, shopId, messageId) => messages.loadHeld(tx, shopId, messageId),
    resolvePinnedCard: (tx, shopId, messageId) =>
      messages.jobCardForMessage(tx, shopId, messageId),
    scheduleFollowup: async () => 'demo5-followup',
    openObjectionObjective: async () => undefined,
    explanations: new DeterministicExplanationWriter(),
  });

  /* ------------------------------------------------------------ the voice */

  const voiceStores = createVoiceStores();
  const storage = createStoragePort(env);

  // The kill switch as a live variable, so the demo can flip it mid-run without
  // a deploy — which is the property phase 5.7 actually asks for.
  let killSwitch = false;

  const calls = new VoiceCallService<Tx>({
    uow,
    calls: voiceStores.calls,
    turns: voiceStores.turns,
    consentEvents: voiceStores.consentEvents,
    usage: voiceStores.usage,
    consents: new PgConsentStore(),
    config: configStore,
    audit,
    outbox,
    recordings: new PgCallRecordingWriter(
      new PgGeneratedMediaWriter(storage, (work) => uow.transaction(work)),
    ),
    rates: {
      telcoPaisePerMinute: 60,
      sttPaisePerMinute: 30,
      ttsPaisePerMinute: 40,
      usdMicrosToPaise: 9,
    },
    platformCapPaise: env.VOICE_PLATFORM_DAILY_CAP_PAISE,
    alertRatio: 0.8,
    platformKillSwitch: () => killSwitch,
    retentionDays: 180,
  });

  const settings = voiceSettingsFrom(defaultShopConfig(env.DEFAULT_TIMEZONE), {
    // The demo is meant to be watched, so the line plays at a readable pace —
    // but not at real time, which would make one call take ninety seconds.
    endpointSilenceMs: 250,
    noInputWaitMs: 1_500,
    ringTimeoutMs: 4_000,
  });

  const telephony = new BrowserLoopbackTelephonyAdapter({ frameMs: settings.frameMs, playbackSpeed: 18 });
  const speech = new MockStreamingSpeechAdapter({ frameMs: settings.frameMs });

  const voice = createVoiceRuntime<Tx>({
    runtime: agent,
    telephony,
    speech,
    calls,
    destinations: voiceStores.destinations,
    gate,
    llm,
    stores: {
      uow,
      runs: stores.runs,
      cards: stores.cards,
      conversations,
      directory: new PgShopDirectory(),
      config: configStore,
      audit,
      outbox,
    },
    settings,
    onTrace: (line) => {
      if (line.stage === 'script' || line.stage === 'agent' || line.stage === 'caller') {
        process.stdout.write(`      ${line.stage === 'caller' ? '←' : '→'} ${line.detail}\n`);
      }
    },
  });

  /* ------------------------------------------------------------- scenario */

  let jobCardId = '';
  let jobCardCode = '';
  let customerId = '';
  let conversationId = '';
  let workItemIds: string[] = [];
  let approvalId = '';
  let outboundCallId = '';
  let inboundCallId = '';
  let originalConfig: unknown = null;

  const runner = new ScenarioRunner(
    'ServiceLoop — phase 5 acceptance demo',
    'outbound approval call → keypad approval → WhatsApp summary → inbound call → warm handoff',
  );

  for (const line of formatAdapterSelection(env)) {
    process.stdout.write(`  ${line}\n`);
  }

  runner
    .step('A job card is driven to AWAITING_APPROVAL', async () => {
      const found = await createDemoCard(db, jobCardTransitions);
      jobCardId = found.jobCardId;
      jobCardCode = found.code;
      customerId = found.customerId;
      workItemIds = found.workItemIds;
      return `${jobCardCode} · ${workItemIds.length} item(s) · ${formatPaise(BRAKES_PAISE + OIL_PAISE)}`;
    })

    .step('The shop switches voice on, inbound and outbound', async () => {
      const stored = await db.execute<{ config: unknown }>(sql`
        select config from shop_config where shop_id = ${DEMO_SHOP_ID}
      `);
      originalConfig = stored.rows[0]?.config ?? null;

      // Read, migrated, patched and written back as a whole document rather
      // than poked with `jsonb_set`. A seeded shop's config predates the phase-5
      // `voice` section entirely, and merging into a key that is not there
      // produces SQL NULL — which is how a demo ends up deleting the shop's
      // configuration instead of changing it.
      const current = await uow.transaction(async (tx) => {
        const row = await configStore.load(tx, DEMO_SHOP_ID);
        const timezone =
          (await configStore.loadShopTimezone(tx, DEMO_SHOP_ID)) ?? env.DEFAULT_TIMEZONE;
        return migrateShopConfig(row?.raw ?? {}, timezone).config;
      });

      // Quiet hours are moved away from *now*: a call is louder than a message
      // and the gate refuses one at 22:40, so a demo that could only be run in
      // the afternoon would prove nothing. Every other guardrail still applies.
      const quiet = quietHoursAwayFromNow(env.DEFAULT_TIMEZONE);

      await uow.transaction((tx) =>
        configStore.save(
          tx,
          DEMO_SHOP_ID,
          {
            ...current,
            autonomy: {
              ...current.autonomy,
              approval: 'L2_CONVERSATIONAL',
              // The post-call WhatsApp summary is sent *as* the voice flow, so a
              // shop left at L0 here would take a decision on the phone and then
              // hold its confirmation for an advisor to approve.
              voice: 'L2_CONVERSATIONAL',
            },
            voice: {
              ...current.voice,
              enabled: true,
              outboundEnabled: true,
              inboundEnabled: true,
            },
            quietHours: { timezone: env.DEFAULT_TIMEZONE, ...quiet },
          },
          null,
        ),
      );

      return `voice on · L2_CONVERSATIONAL · quiet ${quiet.start}–${quiet.end}`;
    })

    .step('The customer has an open thread, and an advisor has a phone', async () => {
      conversationId = await openThread(db, customerId);
      const advisor = await ensureAdvisor(db);
      return `thread ${conversationId.slice(0, 8)}… · advisor ${advisor}`;
    })

    .step('The technician’s evidence becomes an approval request', async () => {
      const built = await agent.bundles.build({
        shopId: DEMO_SHOP_ID,
        anchor: { kind: 'explicit', jobCardId },
        note: 'Front pads worn to 2.1mm, minimum is 3mm. Metal to metal soon.',
        noteLanguage: 'en',
        authorStaffId: null,
        mediaIds: [],
        workItemIds,
        traceId: TRACE,
        actor: { type: 'STAFF', id: null },
      });
      assert(built.ok, `bundle failed: ${built.ok ? '' : built.failure.reason}`);
      if (!built.ok) return '';

      const created = await agent.approvals.createApprovalRequest({
        shopId: DEMO_SHOP_ID,
        jobCardId,
        customerId,
        conversationId,
        bundle: built.bundle,
        ladderRef: 'APPROVAL',
        actor: { type: 'STAFF', id: null },
        traceId: TRACE,
      });
      assert(created.ok, `approval failed: ${created.ok ? '' : created.reason}`);
      if (!created.ok) return '';
      approvalId = created.approvalId;

      return `approval ${approvalId.slice(0, 8)}… · ${formatPaise(built.bundle.totalPaise)}`;
    })

    .step('The agent rings the customer, and the keypad approves', async () => {
      process.stdout.write('\n');
      const report = await placeCall(
        telephony,
        voice.runOutboundApproval({
          shopId: DEMO_SHOP_ID,
          jobCardId,
          customerId,
          conversationId,
          approvalRequestId: approvalId,
          escalationId: null,
          amountPaise: BRAKES_PAISE + OIL_PAISE,
          workSummary: 'front brake pads worn to 2.1mm and an engine oil change',
          traceId: TRACE,
        }),
        // The acceptance gate's own script: press 1 to approve, hear it read
        // back, press 1 to confirm.
        [
          { kind: 'press', digit: '1' },
          { kind: 'press', digit: '1' },
        ],
      );

      outboundCallId = report.callId;
      assert(report.placed, `the call was refused: ${report.refusalReason ?? ''}`);
      assertEqual(report.decision, 'FULL', 'the keypad approval was not recorded');
      assert(report.disclosurePlayed, 'the AI disclosure was never played');
      assert(report.recordingStartedAfterNotice, 'the recorder did not start after the notice');
      assert(report.summarySent, 'the WhatsApp summary did not land');

      return `call ${report.callId.slice(0, 8)}… · ${report.turns} turns · FULL · summary sent`;
    })

    .step('The transcript proves the disclosure came first, and the readback before the decision', async () => {
      const turns = await calls.loadTurns(DEMO_SHOP_ID, outboundCallId);
      assert(turns.length > 0, 'no turns were persisted');

      const first = turns[0];
      assert(first !== undefined && first.mandatorySegment, 'the first turn is not a ⚿ segment');
      assertEqual(first?.scriptKey ?? '', 'voice.disclosure', 'the call did not open with the disclosure');

      const notice = turns.find((turn) => turn.scriptKey === 'voice.recording_notice');
      assert(notice !== undefined, 'the recording notice is not in the transcript');

      const readback = turns.find((turn) => turn.scriptKey === 'voice.readback');
      assert(readback !== undefined, 'the decision was never read back');

      const facts = await db.execute<{ fact: string }>(sql`
        select fact from call_consent_events where call_id = ${outboundCallId}
        order by occurred_at asc, id asc
      `);
      const order = facts.rows.map((row) => row.fact);
      const noticeAt = order.indexOf('RECORDING_NOTICE_PLAYED');
      const startedAt = order.indexOf('RECORDING_STARTED');
      assert(noticeAt >= 0, 'the recording notice was not audited');
      assert(startedAt > noticeAt, 'the recorder started before the notice');

      return `${turns.length} turns · ⚿ first · readback at turn ${readback?.turnIndex ?? -1}`;
    })

    .step('The job card moved, and the call was metered', async () => {
      const items = await db.execute<{ state: string }>(sql`
        select state from work_items where job_card_id = ${jobCardId}
      `);
      const states = items.rows.map((row) => row.state);
      assert(
        states.every((state) => state === 'APPROVED'),
        `expected every item APPROVED, got ${states.join(', ')}`,
      );

      const usage = await db.execute<{ estimated_cost_paise: number; tts_seconds: number }>(sql`
        select estimated_cost_paise, tts_seconds from call_usage where call_id = ${outboundCallId}
      `);
      const row = usage.rows[0];
      assert(row !== undefined, 'no call_usage row was written');
      assert(Number(row?.estimated_cost_paise ?? 0) > 0, 'the call was metered at zero');

      return `${states.length} item(s) APPROVED · ${formatPaise(Number(row?.estimated_cost_paise ?? 0))} metered`;
    })

    .step('The customer rings the shop, and 0 reaches a person', async () => {
      process.stdout.write('\n');
      const running = voice.runInboundCall({
        shopId: DEMO_SHOP_ID,
        fromNumber: CUSTOMER_PHONE,
        traceId: TRACE,
      });

      await telephony.ringIn({
        from: CUSTOMER_PHONE,
        context: {
          shopId: DEMO_SHOP_ID,
          jobCardId,
          customerId,
          conversationId,
          approvalRequestId: null,
          escalationId: null,
          objective: 'answer_status',
          language: 'en',
          customerName: 'Ravi Kumar',
          traceId: TRACE,
        },
      });

      const report = await placeCall(telephony, running, [{ kind: 'press', digit: '0' }]);
      inboundCallId = report.callId;

      assert(report.placed, `the inbound call was refused: ${report.refusalReason ?? ''}`);
      assert(report.handedOff, 'the caller never reached a person');
      assertEqual(report.outcome, 'BRIDGED', 'the legs were not bridged');

      const bridged = await db.execute<{ bridged_to_staff_id: string | null; whisper_text: string | null }>(
        sql`select bridged_to_staff_id, whisper_text from calls where id = ${inboundCallId}`,
      );
      const row = bridged.rows[0];
      assert(row?.bridged_to_staff_id != null, 'no advisor is recorded on the bridge');
      assert((row?.whisper_text ?? '').length > 0, 'the advisor was joined with no whisper');

      return `call ${report.callId.slice(0, 8)}… bridged · whisper "${(row?.whisper_text ?? '').slice(0, 48)}…"`;
    })

    .step('The kill switch stops the next call without a deploy', async () => {
      killSwitch = true;

      const report = await voice.runOutboundApproval({
        shopId: DEMO_SHOP_ID,
        jobCardId,
        customerId,
        conversationId,
        approvalRequestId: approvalId,
        escalationId: null,
        amountPaise: BRAKES_PAISE,
        workSummary: 'a second call that must not happen',
        traceId: TRACE,
      });

      assert(!report.placed, 'the kill switch did not stop the call');
      assertEqual(report.refusalCode, 'KILL_SWITCH', 'the refusal named the wrong reason');
      assert(report.fallBackToAdvisor, 'the rung would have fallen silent instead of tasking a person');
      assertEqual(telephony.activeSessions().length, 0, 'a line was opened anyway');

      // A refusal is a row, not a silence: the ladder, the audit trail and
      // phase 6's containment metrics all need to see it.
      const blocked = await db.execute<{ status: string; blocked_code: string | null }>(sql`
        select status, blocked_code from calls where id = ${report.callId}
      `);
      assertEqual(blocked.rows[0]?.status ?? '', 'BLOCKED', 'no BLOCKED row was written');
      assertEqual(blocked.rows[0]?.blocked_code ?? '', 'KILL_SWITCH', 'the row named the wrong reason');

      killSwitch = false;
      return 'refused before a packet left · BLOCKED row written · advisor fallback';
    })

    .onTeardown(async () => {
      if (originalConfig !== null) {
        await db.execute(sql`
          update shop_config set config = ${JSON.stringify(originalConfig)}::jsonb
          where shop_id = ${DEMO_SHOP_ID}
        `);
      }
      await telephony.shutdown('demo finished');
      await redis.quit();
      await database.close();
    });

  process.exitCode = await runner.run();
}

/**
 * Runs a call with a scripted customer on the other end.
 *
 * Both parties run concurrently, which is not an implementation detail: the
 * caller's turn exists only in the gap the runtime is waiting in, and a demo
 * that drove them in sequence would be demonstrating something a telephone
 * cannot do.
 */
async function placeCall(
  telephony: BrowserLoopbackTelephonyAdapter,
  running: Promise<CallReport>,
  actions: readonly CallerAction[],
): Promise<CallReport> {
  const handset = await awaitHandset(telephony, running);
  if (handset === null) return running;

  const caller = new ScriptedCaller(handset, actions, {
    pollMs: 4,
    quietMs: 150,
    timeoutMs: 30_000,
  });

  const [report] = await Promise.all([running, caller.run()]);
  return report;
}

async function awaitHandset(
  telephony: BrowserLoopbackTelephonyAdapter,
  running: Promise<unknown>,
): Promise<LoopbackHandset | null> {
  let settled = false;
  void running.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  for (let attempt = 0; attempt < 4_000; attempt += 1) {
    const session = telephony.activeSessions()[0];
    if (session !== undefined) return telephony.handset(session.callId);
    if (settled) return null;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return null;
}

/** Quiet hours placed a long way from now, so a demo can run at any hour. */
function quietHoursAwayFromNow(timezone: string): { start: string; end: string } {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hour12: false }).format(
      new Date(),
    ),
  );
  const start = (hour + 3) % 24;
  const end = (hour + 5) % 24;
  return {
    start: `${String(start).padStart(2, '0')}:00`,
    end: `${String(end).padStart(2, '0')}:00`,
  };
}

async function createDemoCard(
  db: Database,
  transitions: JobCardTransitionService<Tx>,
): Promise<{
  jobCardId: string;
  code: string;
  customerId: string;
  workItemIds: string[];
}> {
  const suffix = uuidv7().slice(-8).toUpperCase();
  const customerId = uuidv7();
  const vehicleId = uuidv7();
  const jobCardId = uuidv7();
  const estimateId = uuidv7();
  const brakesId = uuidv7();
  const oilId = uuidv7();
  const code = `JC-DEMO5-${suffix.slice(0, 4)}`;

  // Through drizzle: `full_name_encrypted` and `phone_encrypted` are PII
  // columns, and a raw insert would store them in the clear.
  await db.insert(schema.customers).values({
    id: customerId,
    shopId: DEMO_SHOP_ID,
    fullNameEncrypted: 'Ravi Kumar',
    phoneEncrypted: CUSTOMER_PHONE,
    phoneHash: blindIndex(DEMO_SHOP_ID, CUSTOMER_PHONE),
    preferredLanguage: 'en',
    whatsappOptIn: true,
  });

  await db.insert(schema.vehicles).values({
    id: vehicleId,
    shopId: DEMO_SHOP_ID,
    customerId,
    registrationRaw: `TN 09 D5 ${suffix.slice(0, 4)}`,
    registrationNormalised: `TN09D5${suffix.slice(0, 4)}`,
    make: 'Maruti Suzuki',
    model: 'Swift',
    odometerKm: 62_000,
  });

  await db.insert(schema.jobCards).values({
    id: jobCardId,
    shopId: DEMO_SHOP_ID,
    customerId,
    vehicleId,
    code,
    state: 'DRAFT',
    source: 'WALK_IN',
    complaintText: 'Grinding noise when braking',
    odometerKm: 62_000,
  });

  await db.insert(schema.workItems).values([
    {
      id: brakesId,
      shopId: DEMO_SHOP_ID,
      jobCardId,
      title: 'Front brake pad replacement',
      state: 'PENDING_APPROVAL',
      requiresApproval: true,
      technicianNote: 'Front pads worn to 2.1mm, minimum is 3mm.',
      sequence: 0,
    },
    {
      id: oilId,
      shopId: DEMO_SHOP_ID,
      jobCardId,
      title: 'Engine oil and filter',
      state: 'PENDING_APPROVAL',
      requiresApproval: true,
      technicianNote: 'Oil is dark and the filter is due at this odometer.',
      sequence: 1,
    },
  ]);

  await db.insert(schema.estimates).values({
    id: estimateId,
    shopId: DEMO_SHOP_ID,
    jobCardId,
    version: 1,
    status: 'DRAFT',
    subtotalPaise: BRAKES_PAISE + OIL_PAISE,
    totalPaise: BRAKES_PAISE + OIL_PAISE,
  });

  await db.insert(schema.estimateLines).values([
    {
      id: uuidv7(),
      shopId: DEMO_SHOP_ID,
      estimateId,
      workItemId: brakesId,
      kind: 'PART',
      description: 'Front brake pads (set)',
      quantityMilli: 1000,
      unitPricePaise: BRAKES_PAISE,
      lineTotalPaise: BRAKES_PAISE,
      sequence: 0,
    },
    {
      id: uuidv7(),
      shopId: DEMO_SHOP_ID,
      estimateId,
      workItemId: oilId,
      kind: 'CONSUMABLE',
      description: 'Engine oil and filter',
      quantityMilli: 1000,
      unitPricePaise: OIL_PAISE,
      lineTotalPaise: OIL_PAISE,
      sequence: 1,
    },
  ]);

  // Driven, not inserted: the audit chain and the outbox see a real lifecycle.
  for (const event of ['OPEN_CARD', 'BEGIN_DIAGNOSIS', 'REQUEST_APPROVAL'] as const) {
    await transitions.transition({
      shopId: DEMO_SHOP_ID,
      jobCardId,
      event,
      actor: { type: 'STAFF', id: null },
      traceId: TRACE,
    });
  }

  return { jobCardId, code, customerId, workItemIds: [brakesId, oilId] };
}

/**
 * A thread with an open 24-hour window and SERVICE consent on record.
 *
 * Written directly because phase 2 already proves the inbound path that would
 * otherwise create it, and re-proving it here would make this demo about
 * something else.
 */
async function openThread(db: Database, customerId: string): Promise<string> {
  const conversationId = uuidv7();
  const now = new Date();

  await db.insert(schema.conversations).values({
    id: conversationId,
    shopId: DEMO_SHOP_ID,
    customerId,
    kind: 'CUSTOMER',
    channel: 'WHATSAPP',
    externalThreadId: `wa:${conversationId}`,
    externalAddressEncrypted: CUSTOMER_PHONE,
    displayName: 'Ravi Kumar',
    state: 'OPEN',
    language: 'en',
    lastInboundAt: new Date(now.getTime() - 60_000),
    windowExpiresAt: new Date(now.getTime() + 23 * 60 * 60 * 1000),
  });

  await db.insert(schema.consents).values({
    id: uuidv7(),
    shopId: DEMO_SHOP_ID,
    customerId,
    purpose: 'SERVICE',
    status: 'GRANTED',
    channel: 'WHATSAPP',
    source: 'SEED',
    grantedAt: new Date(now.getTime() - 86_400_000),
  });

  return conversationId;
}

/**
 * Somebody for a warm handoff to reach.
 *
 * A bridge with nobody on the other end degrades to an advisor task, which is
 * correct behaviour and the wrong thing for this demo to show.
 */
async function ensureAdvisor(db: Database): Promise<string> {
  const existing = await db.execute<{ id: string; full_name: string }>(sql`
    select id, full_name from staff
    where shop_id = ${DEMO_SHOP_ID} and is_active = true and deleted_at is null
      and role in ('ADVISOR', 'OWNER')
    limit 1
  `);
  const found = existing.rows[0];
  if (found !== undefined) return found.full_name;

  const staffId = uuidv7();
  await db.insert(schema.staff).values({
    id: staffId,
    shopId: DEMO_SHOP_ID,
    fullName: 'Meena',
    phoneEncrypted: ADVISOR_PHONE,
    phoneHash: blindIndex(DEMO_SHOP_ID, ADVISOR_PHONE),
    role: 'ADVISOR',
    isActive: true,
  });
  return 'Meena';
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
