import {
  AdapterDraftExtraction,
  BrowserLoopbackTelephonyAdapter,
  createMediaPipeline,
  createStoragePort,
  FixtureOcrAdapter,
  HeuristicStatusSignalParser,
  LlmTextDraftExtractor,
  MockPaymentsAdapter,
  MockSpeechAdapter,
  MockStreamingSpeechAdapter,
  QrPngRenderer,
  ReactPdfInvoiceRenderer,
  SandboxLlmAdapter,
  SandboxWhatsAppAdapter,
  ScriptedCaller,
  toInboundMessage,
  VoiceNoteDraftExtractor,
  WhatsAppChannelSender,
  WhatsAppMediaFetcher,
  deterministicJudge,
  type CallerAction,
  type InboundEvent,
  type LoopbackHandset,
} from '@serviceloop/adapters';
import {
  createAgentRuntime,
  createLoopRuntime,
  createRetentionRuntime,
  createVoiceRuntime,
  voiceSettingsFrom,
  type CallReport,
  type LoopRuntime,
} from '@serviceloop/agent-core';
import {
  defaultShopConfig,
  formatAdapterSelection,
  getEnv,
  migrateShopConfig,
} from '@serviceloop/config';
import {
  AuditService,
  blindIndex,
  createAgentStores,
  createDatabase,
  createRetentionStores,
  createVoiceStores,
  DEMO_SHOP_ID,
  jobCardLabels,
  openVisitsByVehicle,
  OutboxService,
  PgCallRecordingWriter,
  PgCardResolver,
  PgConsentStore,
  PgConversationStore,
  PgCustomerLookup,
  PgDeliveryBookingStore,
  PgDraftStore,
  PgEntityLookup,
  PgEtaStore,
  PgGatePassStore,
  PgGeneratedMediaWriter,
  PgInvoiceStore,
  PgJobCardContextReader,
  PgJobCardStore,
  PgJobCardWriter,
  PgMediaStore,
  PgMessageStore,
  PgPaymentStore,
  PgPriceListReader,
  PgShopConfigStore,
  PgShopDirectory,
  PgSilentBayStore,
  PgStatusCommsStore,
  PgStatusSignalStore,
  PgUnitOfWork,
  PgWorkItemStore,
  schema,
  type Database,
  type Tx,
} from '@serviceloop/db';
import {
  computeRollup,
  APPROVAL_ACTION_IDS,
  CONSENT_ACTION_IDS,
  ConsentCaptureService,
  ConsentService,
  DRAFT_ACTION_IDS,
  VoiceCallService,
  ConversationSessionService,
  EntityResolutionService,
  InboundHandler,
  InboundRouter,
  IntakePipeline,
  IntakeService,
  JobCardTransitionService,
  MediaService,
  OutboundGate,
  personThreadKey,
  SLOT_ACTION_IDS,
  WorkItemTransitionService,
  windowsFrom,
  type InboundOutcome,
  type RungScheduler,
} from '@serviceloop/domain';
import {
  formatPaise,
  localDay,
  parseEventEnvelope,
  uuidv7,
  type Clock,
  type EventEnvelope,
} from '@serviceloop/shared';
import { sql } from 'drizzle-orm';
import IORedis from 'ioredis';
import sharp from 'sharp';
import { CARD_FIXTURES } from '../ocr/fixtures';
import { groundTruthDraft, perturbDraft } from '../ocr/ground-truth';
import { assert, assertEqual, ScenarioRunner } from '../runner';
import { IntakeRepository } from '@serviceloop/db';

/**
 * `pnpm demo:journey` — the capstone (phase 7.9).
 *
 * One vehicle, one customer, one fake clock, from a photographed paper card to
 * the rupee recovered four months later. Every other demo proves one phase
 * works. **This is the only thing that proves they compose**, and the
 * distinction is not academic: each of the six phase demos can be green while
 * this is red, because each of them builds its own world and this one has to
 * live in the world the previous step left behind.
 *
 * The arc, which is the phase file's own list:
 *
 *   photo intake → confirm → technician evidence → approval bundle →
 *   price objection → concession within the floor → approval → parts delay →
 *   proactive ETA → inbound status call answered → ready + slot → invoice PDF →
 *   UPI payment → gate pass → positive feedback → review link →
 *   the brake pads declined in step 6 resurface on their horizon → convert →
 *   the digest shows the recovered rupees.
 *
 * Then four assertions over the whole run, which are the reason it exists:
 *
 *   1. **The final state is right** — the card delivered, the money settled,
 *      the vehicle out of the gate.
 *   2. **Every outbound passed the gate.** Not "we did not notice a bypass" —
 *      every message row is checked for a gate decision, and a message with
 *      none is a message that reached a customer outside consent and quiet
 *      hours.
 *   3. **The audit chain verifies** across everything the journey did.
 *   4. **The metric rollup is reproducible** — folded independently from the
 *      raw event log and compared with what the metrics service stored.
 *
 * Nothing here reaches a model, a telephone or a real WhatsApp. The one LLM
 * call site gets the deterministic judge, as every other demo does.
 */

const TRACE = `journey-${uuidv7().slice(0, 8)}`;
const STAFF_GROUP_ID = '120363000000000044';

const CUSTOMER_PHONE = `+9198${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`;
const PLATE_SUFFIX = String(Math.floor(1000 + Math.random() * 8999));

/** March. A Tuesday, mid-morning: working hours, outside quiet hours. */
const INTAKE = new Date('2026-03-10T10:15:00+05:30');
/**
 * July. Past the brake item's 90-day horizon *and* inside the shipped monsoon
 * window, which is the combination the season trigger requires: it refuses to
 * wake an item early, because using the weather to shorten a promise a
 * technician made is a pretext rather than care.
 */
const RAINS = new Date('2026-07-08T11:00:00+05:30');

class JourneyClock implements Clock {
  constructor(private at: Date) {}
  now(): Date {
    return new Date(this.at);
  }
  set(at: Date): void {
    this.at = at;
  }
  advanceHours(hours: number): void {
    this.at = new Date(this.at.getTime() + hours * 3_600_000);
  }
}

class InMemoryRungScheduler implements RungScheduler {
  private counter = 0;
  async enqueue(): Promise<string | null> {
    this.counter += 1;
    return `journey-rung-${this.counter}`;
  }
  async cancel(): Promise<void> {
    /* nothing to cancel: this run never lets a rung fire */
  }
}

async function main(): Promise<void> {
  const env = getEnv();
  const database = createDatabase(env);
  const db = database.db;
  const redis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const storage = createStoragePort(env);

  const clock = new JourneyClock(INTAKE);
  const uow = new PgUnitOfWork(db);
  const audit = new AuditService(db, redis);
  const outbox = new OutboxService(db);
  const configStore = new PgShopConfigStore();
  const directory = new PgShopDirectory();

  /* ------------------------------------------------------------- adapters */

  const whatsapp = new SandboxWhatsAppAdapter({ deliveryMode: 'instant' });
  const speech = new MockSpeechAdapter();
  const llm = new SandboxLlmAdapter();
  const ocr = new FixtureOcrAdapter();
  const payments = new MockPaymentsAdapter({ webhookSecret: 'journey-secret' });
  const textExtractor = new LlmTextDraftExtractor(llm);

  /* --------------------------------------------------------------- domain */

  const conversations = new PgConversationStore();
  const messages = new PgMessageStore();
  const customers = new PgCustomerLookup();
  const consentStore = new PgConsentStore();
  const retentionStores = createRetentionStores();

  const gate = new OutboundGate<Tx>({
    uow,
    conversations,
    messages,
    consents: consentStore,
    config: configStore,
    audit,
    outbox,
    sender: new WhatsAppChannelSender(whatsapp),
    // The retention frequency reader, so the twenty-one-day floor and the
    // negative-feedback freeze are properties of the *send path* rather than of
    // whatever composed the message.
    retention: retentionStores.frequency,
    clock,
  });

  const jobCards = new JobCardTransitionService<Tx>({
    uow,
    cards: new PgJobCardStore(),
    config: configStore,
    audit,
    outbox,
    clock,
  });
  const workItems = new WorkItemTransitionService<Tx>({
    uow,
    items: new PgWorkItemStore(),
    audit,
    outbox,
    clock,
  });

  const agentStores = createAgentStores();
  const agent = createAgentRuntime<Tx>({
    stores: {
      uow,
      ...agentStores,
      conversations,
      messages,
      config: configStore,
      directory,
      audit,
      outbox,
    },
    gate,
    jobCards,
    workItems,
    scheduler: new InMemoryRungScheduler(),
    llm: deterministicJudge(),
    config: defaultShopConfig(env.DEFAULT_TIMEZONE),
    conversationTail: (tx, shopId, conversationId, limit) =>
      messages.recentForConversation(tx, shopId, conversationId, limit),
    loadHeld: (tx, shopId, messageId) => messages.loadHeld(tx, shopId, messageId),
    resolvePinnedCard: (tx, shopId, messageId) =>
      messages.jobCardForMessage(tx, shopId, messageId),
    scheduleFollowup: async () => 'journey-followup',
    openObjectionObjective: async () => undefined,
    clock,
  });

  const loop: LoopRuntime<Tx> = createLoopRuntime<Tx>({
    stores: {
      uow,
      eta: new PgEtaStore(),
      signals: new PgStatusSignalStore(),
      resolver: new PgCardResolver(),
      bays: new PgSilentBayStore(),
      comms: new PgStatusCommsStore(),
      bookings: new PgDeliveryBookingStore(),
      invoices: new PgInvoiceStore(),
      payments: new PgPaymentStore(),
      passes: new PgGatePassStore(),
      cards: new PgJobCardContextReader(),
      conversations,
      directory,
      config: configStore,
      audit,
      outbox,
    },
    gate,
    jobCards,
    workItems,
    payments,
    renderer: new ReactPdfInvoiceRenderer(),
    qr: new QrPngRenderer(),
    media: new PgGeneratedMediaWriter(storage, (work) => uow.transaction(work)),
    parser: new HeuristicStatusSignalParser(),
    speech,
    gatePassSecret: () => env.GATE_PASS_SECRET,
    amountDue,
    customerPhone,
    loadThumbnails: async () => new Map(),
    clock,
  });

  const retention = createRetentionRuntime<Tx>({
    stores: {
      uow,
      ledger: retentionStores.ledger,
      touches: retentionStores.touches,
      holds: retentionStores.holds,
      odometer: retentionStores.odometer,
      feedback: retentionStores.feedback,
      forecasts: retentionStores.forecasts,
      documents: retentionStores.documents,
      digests: retentionStores.digests,
      alerts: retentionStores.alerts,
      events: retentionStores.events,
      rollups: retentionStores.rollups,
      directory: retentionStores.directory,
      conversations,
      shops: directory,
      config: configStore,
      audit,
      outbox,
    },
    gate,
    consents: new ConsentService<Tx>({ uow, consents: consentStore, audit, outbox, clock }),
    openVisits: openVisitsByVehicle,
    cardLabels: jobCardLabels,
    tasks: agent.tasks,
    prices: new PgPriceListReader(),
    clock,
  });

  const intake = new IntakeService<Tx>({
    uow,
    drafts: new PgDraftStore(),
    writer: new PgJobCardWriter(),
    entities: new EntityResolutionService<Tx>({
      uow,
      lookup: new PgEntityLookup(),
      audit,
      outbox,
    }),
    config: configStore,
    audit,
    outbox,
    cards: jobCards,
  });

  const consents = new ConsentService<Tx>({ uow, consents: consentStore, audit, outbox, clock });

  const mediaService = new MediaService<Tx>({
    uow,
    store: new PgMediaStore(),
    pipeline: createMediaPipeline(env, storage),
    audit,
    outbox,
  });

  const handler = new InboundHandler<Tx>({
    uow,
    router: new InboundRouter<Tx>({
      uow,
      conversations,
      messages,
      customers,
      config: configStore,
      sessions: new ConversationSessionService<Tx>({
        uow,
        conversations,
        customers,
        audit,
        outbox,
        blindIndex,
      }),
      consents,
      audit,
      outbox,
    }),
    gate,
    intake,
    pipeline: new IntakePipeline<Tx>({
      uow,
      extraction: new AdapterDraftExtraction(
        ocr,
        textExtractor,
        new VoiceNoteDraftExtractor(speech, textExtractor),
      ),
      intake,
      config: configStore,
    }),
    media: mediaService,
    mediaFetch: new WhatsAppMediaFetcher(whatsapp),
    conversations,
    messages,
    customers,
    consents,
    config: configStore,
    directory,
    technicianNotes: loop.notes,
    slots: loop.delivery,
    retention: retention.replies,
    consoleUrl: env.CONSOLE_URL,
  });

  const firstContact = new ConsentCaptureService<Tx>({
    uow,
    gate,
    conversations,
    messages,
    customers,
    consents,
    config: configStore,
    directory,
    channel: 'WHATSAPP',
  });

  const intakeRepo = new IntakeRepository(db);

  /* ----------------------------------------------------------------- voice */

  const voiceStores = createVoiceStores();
  const settings = voiceSettingsFrom(defaultShopConfig(env.DEFAULT_TIMEZONE), {
    endpointSilenceMs: 250,
    noInputWaitMs: 1_500,
    ringTimeoutMs: 4_000,
  });
  const telephony = new BrowserLoopbackTelephonyAdapter({
    frameMs: settings.frameMs,
    playbackSpeed: 24,
  });
  const streamingSpeech = new MockStreamingSpeechAdapter({ frameMs: settings.frameMs });

  const voiceCalls = new VoiceCallService<Tx>({
    uow,
    calls: voiceStores.calls,
    turns: voiceStores.turns,
    consentEvents: voiceStores.consentEvents,
    usage: voiceStores.usage,
    consents: consentStore,
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
    platformKillSwitch: () => false,
    retentionDays: 180,
  });

  const voice = createVoiceRuntime<Tx>({
    runtime: agent,
    telephony,
    speech: streamingSpeech,
    calls: voiceCalls,
    destinations: voiceStores.destinations,
    gate,
    llm,
    stores: {
      uow,
      runs: agentStores.runs,
      cards: agentStores.cards,
      conversations,
      directory,
      config: configStore,
      audit,
      outbox,
    },
    settings,
  });

  /* --------------------------------------------------------------- helpers */

  const deliver = async (
    injection: Parameters<SandboxWhatsAppAdapter['injectInbound']>[0],
  ): Promise<InboundOutcome> => {
    const delivery = whatsapp.injectInbound(injection);
    const batch = await whatsapp.receive(delivery);
    const event = batch.events[0] as InboundEvent | undefined;
    assert(event !== undefined, 'the injection produced no inbound event');

    return handler.handle({
      shopId: DEMO_SHOP_ID,
      channel: 'WHATSAPP',
      message: toInboundMessage(event as InboundEvent),
      traceId: TRACE,
    });
  };

  /* -------------------------------------------------------------- scenario */

  let registration = '';
  let cardImage: Buffer = Buffer.alloc(0);
  let draftId = '';
  let jobCardId = '';
  let customerId = '';
  let vehicleId = '';
  let conversationId = '';
  let technicianId = '';
  let brakesItemId = '';
  let oilItemId = '';
  let bookingId = '';
  let gatePassCode = '';
  let ledgerItemId = '';
  let brakesEstimateLineId = '';
  let approvalId = '';
  let storedRecoveredPaise = 0;
  let secondCardId = '';
  let recoveredPaise = 0;
  let foldedDay = '';
  let webhook: { rawBody: Buffer; headers: Readonly<Record<string, string>> } | null = null;

  const runner = new ScenarioRunner(
    'ServiceLoop — the full journey',
    'A photographed paper card in March → the rupee recovered in July, on one fake clock',
  );

  for (const line of formatAdapterSelection(env)) process.stdout.write(`  ${line}\n`);

  runner
    .step('The shop is configured for the whole loop', async () => {
      const current = await uow.transaction(async (tx) => {
        const row = await configStore.load(tx, DEMO_SHOP_ID);
        const timezone =
          (await configStore.loadShopTimezone(tx, DEMO_SHOP_ID)) ?? env.DEFAULT_TIMEZONE;
        return migrateShopConfig(row?.raw ?? {}, timezone).config;
      });

      await uow.transaction((tx) =>
        configStore.save(
          tx,
          DEMO_SHOP_ID,
          {
            ...current,
            autonomy: {
              ...current.autonomy,
              approval: 'L2_CONVERSATIONAL',
              status: 'L2_CONVERSATIONAL',
              delivery: 'L2_CONVERSATIONAL',
              retention: 'L2_CONVERSATIONAL',
            },
            // A ceiling the journey's concession fits inside, and a floor it
            // does not go below. The objection step asserts both halves.
            pricing: { priceFloorPercent: 85, discountCeilingPercent: 10 },
            // The shipped default is 3 a day, and one ordinary day of this
            // product's own flow is more than that: the consent ask, the
            // approval bundle, the objection reply, the delay notice and the
            // ready message are five. The *interval* rule is left at sixty
            // minutes and obeyed by advancing the clock, because that one is
            // about not pestering somebody and the journey should have to
            // respect it. See PROGRESS.md open question 37.
            frequencyCaps: {
              ...current.frequencyCaps,
              maxOutboundPerCustomerPerDay: 8,
              maxOutboundPerCustomerPerWeek: 25,
            },
            messaging: { ...current.messaging, staffGroupId: STAFF_GROUP_ID },
            retention: { ...current.retention, enabled: true },
            feedback: {
              ...current.feedback,
              enabled: true,
              reviewLink: 'https://g.page/r/sri-murugan-auto-works/review',
              askForReviewOnPositive: true,
            },
            digest: { ...current.digest, enabled: true },
            // Longer than the shop's slowest horizon, so a brake item recovered
            // on the horizon it was given lands *inside* the cohort. See
            // PROGRESS.md open question 27: the shipped 90 collides with the
            // shipped 90-day brake horizon.
            analytics: { ...current.analytics, recoveryCohortDays: 180 },
            // A GSTIN and a legal name, because an invoice cannot be issued
            // without them — which is the guardrail working: a tax document
            // naming nobody is not a tax document.
            invoice: {
              ...current.invoice,
              legalName: 'Sri Murugan Auto Works Private Limited',
              gstin: '33AABCS1429B1Z1',
              addressLines: ['14 Nelson Manickam Road', 'Aminjikarai, Chennai 600029'],
              stateCode: '33',
              numberPrefix: 'INV',
            },
            quietHours: { timezone: env.DEFAULT_TIMEZONE, start: '21:00', end: '06:00' },
          },
          null,
        ),
      );

      return 'approval/status/delivery/retention at L2 · floor 85% · ceiling 10% · digest on';
    })

    /* ------------------------------------------------------- 1. photo intake */

    .step('March: a technician photographs a paper card into the workshop group', async () => {
      clock.set(INTAKE);

      const fixture = CARD_FIXTURES[0];
      assert(fixture !== undefined, 'the golden fixture set must not be empty');

      registration = `TN09JR${PLATE_SUFFIX}`;

      cardImage = await sharp({
        create: { width: 1240, height: 1754, channels: 3, background: '#f8f5ee' },
      })
        .jpeg({ quality: 82 })
        .toBuffer();

      // Deliberately misread, and *diffidently* so: the registration comes back
      // wrong at 0.35 confidence, which is exactly the case the confirmation
      // flow exists for. An extractor that was confidently wrong would be worse.
      const truth = groundTruthDraft(fixture);
      const misread = perturbDraft(fixture, { errorRate: 0.25, honesty: 1, seed: 'journey' });
      ocr.register(
        cardImage,
        {
          ...misread,
          customer: {
            ...truth.customer,
            phone: { value: CUSTOMER_PHONE, confidence: 0.9, region: null },
          },
          vehicle: {
            ...misread.vehicle,
            registration: {
              value: registration.replace('J', '1'),
              confidence: 0.35,
              region: null,
            },
          },
        },
        fixture.id,
      );

      const technician = await db.execute<{ id: string; phone: string }>(sql`
        select id, phone_encrypted as phone from staff
        where shop_id = ${DEMO_SHOP_ID} and role = 'TECHNICIAN' and deleted_at is null
        order by created_at asc limit 1
      `);
      technicianId = technician.rows[0]?.id ?? '';
      assert(technicianId !== '', 'the seed has no technician');

      const outcome = await deliver({
        kind: 'media',
        from: technician.rows[0]?.phone ?? '',
        groupId: STAFF_GROUP_ID,
        mediaKind: 'PHOTO',
        bytes: cardImage,
        contentType: 'image/jpeg',
        caption: '#jobcard',
        filename: 'card.jpg',
      });

      assert(outcome.draftId !== null, 'the photo must produce a job-card draft');
      draftId = outcome.draftId ?? '';

      const detail = await intakeRepo.detail(DEMO_SHOP_ID, draftId);
      assert(
        detail?.fields.some((field) => field.uncertain) === true,
        'the misread plate must be flagged rather than accepted',
      );

      return `draft ${draftId.slice(0, 8)}… · plate read as "${registration.replace('J', '1')}" at 0.35`;
    })

    .step('The technician corrects the plate and confirms; an OPEN card exists', async () => {
      const detail = await intakeRepo.detail(DEMO_SHOP_ID, draftId);
      const line = detail?.fields.find((field) => field.path === 'vehicle.registration');
      assert(line !== undefined, 'the draft has no registration line to correct');

      const technicianPhone = await db.execute<{ phone: string }>(sql`
        select phone_encrypted as phone from staff where id = ${technicianId}
      `);

      await deliver({
        kind: 'text',
        from: technicianPhone.rows[0]?.phone ?? '',
        groupId: STAFF_GROUP_ID,
        text: `${line?.index ?? 1} = ${registration}`,
      });

      const outcome = await deliver({
        kind: 'button_reply',
        from: technicianPhone.rows[0]?.phone ?? '',
        groupId: STAFF_GROUP_ID,
        replyId: DRAFT_ACTION_IDS.confirm(draftId),
        title: 'Confirm',
      });

      assert(outcome.jobCardId !== null, 'confirming must create a job card');
      jobCardId = outcome.jobCardId ?? '';

      const card = await db.execute<{ state: string; customer_id: string; vehicle_id: string }>(sql`
        select state, customer_id, vehicle_id from job_cards where id = ${jobCardId}
      `);
      assertEqual(card.rows[0]?.state, 'OPEN', 'the card must land on the board as OPEN');
      customerId = card.rows[0]?.customer_id ?? '';
      vehicleId = card.rows[0]?.vehicle_id ?? '';

      return `card ${jobCardId.slice(0, 8)}… OPEN · ${registration} · customer ${customerId.slice(0, 8)}…`;
    })

    /* -------------------------------------------- 2. the thread and consent */

    .step('The shop opens the thread by disclosing the AI and asking permission', async () => {
      conversationId = await openThread(db, customerId, clock);

      const opened = await firstContact.openFirstContact({
        shopId: DEMO_SHOP_ID,
        customerId,
        conversationId,
        customerName: 'Meena',
        vehicleLabel: `Maruti Swift ${registration}`,
        actor: { type: 'SYSTEM', id: null },
        traceId: TRACE,
      });
      assert(opened.sent, 'the first-contact message was not sent');

      await deliver({
        kind: 'button_reply',
        from: CUSTOMER_PHONE,
        replyId: CONSENT_ACTION_IDS.grantService,
        title: 'Yes',
      });

      const state = await firstContact.state(DEMO_SHOP_ID, customerId);
      assertEqual(state.service?.status ?? null, 'GRANTED', 'SERVICE consent must be recorded');

      return `thread ${conversationId.slice(0, 8)}… · disclosure sent · SERVICE granted`;
    })

    /* ------------------------------- 3. evidence and the approval bundle */

    .step('A technician photographs the wear and two work items are quoted', async () => {
      const seeded = await seedWork(db, jobCardId, technicianId);
      brakesItemId = seeded.brakesItemId;
      oilItemId = seeded.oilItemId;
      brakesEstimateLineId = seeded.brakesEstimateLineId;

      await jobCards.transition({
        shopId: DEMO_SHOP_ID,
        jobCardId,
        event: 'BEGIN_DIAGNOSIS',
        actor: { type: 'STAFF', id: technicianId },
        traceId: TRACE,
      });
      await jobCards.transition({
        shopId: DEMO_SHOP_ID,
        jobCardId,
        event: 'REQUEST_APPROVAL',
        actor: { type: 'STAFF', id: technicianId },
        traceId: TRACE,
      });

      return `brakes ${formatPaise(seeded.brakesPaise)} · oil ${formatPaise(seeded.oilPaise)} · card AWAITING_APPROVAL`;
    })

    .step('The bundle goes to the customer with the technician’s own words', async () => {
      // An hour of diagnosis. Also the shop's minimum interval between
      // messages, which the journey obeys rather than switches off.
      clock.advanceHours(1);

      const built = await agent.bundles.build({
        shopId: DEMO_SHOP_ID,
        anchor: { kind: 'explicit', jobCardId },
        note: 'Front pads worn to 2.1mm, minimum is 3mm. Metal to metal soon.',
        noteLanguage: 'en',
        authorStaffId: technicianId,
        mediaIds: [],
        workItemIds: [brakesItemId, oilItemId],
        traceId: TRACE,
        actor: { type: 'STAFF', id: technicianId },
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
        actor: { type: 'AGENT', id: null },
        traceId: TRACE,
      });
      assert(created.ok, `approval request failed: ${created.ok ? '' : created.reason}`);
      if (!created.ok) return '';
      approvalId = created.approvalId;
      assertEqual(created.gateStatus, 'SENT', 'the approval request did not go out');

      const body = await lastOutboundBody(db, conversationId);
      assert(
        /2\.1\s*mm/i.test(body) || body.toLowerCase().includes('pad'),
        `the bundle must quote the technician's finding: ${body.slice(0, 140)}`,
      );

      return `approval ${approvalId.slice(0, 8)}… sent with the technician's own words`;
    })

    /* --------------------------------- 4-6. objection, concession, decision */

    .step('The customer objects on price; the floor refuses a third off', async () => {
      clock.advanceHours(1);

      const outcome = await deliver({
        kind: 'text',
        from: CUSTOMER_PHONE,
        text: 'That is too much. Can you do it for 30% less?',
      });

      // The refusal must be *honest*: not a discount, and not an implication of
      // one either. Thirty per cent is below the 85% floor and the agent has no
      // authority to offer it, so what must not appear is the number.
      const said = `${outcome.replies.length} ${await lastOutboundBody(db, conversationId)}`;
      assert(
        !/\b(30|thirty)\s*%/.test(said),
        `a third off is below the floor and must not be offered: ${said.slice(0, 160)}`,
      );

      return 'objection answered without offering a discount below the floor';
    })

    .step('A partial decision: the oil approved, the brakes deferred on price', async () => {
      clock.advanceHours(1);

      // **PARTIAL**, not APPROVE, and this is the shape the journey turns on.
      // The customer wants the work and not the price today; approving the
      // bundle whole would leave nothing to recover in July, and declining it
      // whole would lose the oil change the shop actually did.
      const decision = await agent.approvals.recordCustomerDecision({
        shopId: DEMO_SHOP_ID,
        approvalId,
        decision: 'PARTIAL',
        approvedWorkItemIds: [oilItemId],
        note: 'Do the oil now; I will come back for the brakes.',
        decidedVia: APPROVAL_ACTION_IDS.partial,
        actor: { type: 'CUSTOMER', id: customerId },
        traceId: TRACE,
      });

      assert(decision.applied, 'the decision was not applied');
      assertEqual(
        decision.approvedWorkItemIds.join(','),
        oilItemId,
        'only the oil change was approved',
      );
      assert(
        decision.deferredWorkItemIds.includes(brakesItemId),
        'the brakes must be recorded as deferred, not merely unapproved',
      );

      // Customers tap twice when they are unsure it worked.
      const again = await agent.approvals.recordCustomerDecision({
        shopId: DEMO_SHOP_ID,
        approvalId,
        decision: 'PARTIAL',
        approvedWorkItemIds: [oilItemId],
        note: 'Do the oil now; I will come back for the brakes.',
        decidedVia: APPROVAL_ACTION_IDS.partial,
        actor: { type: 'CUSTOMER', id: customerId },
        traceId: TRACE,
      });
      assertEqual(again.applied, false, 'a second tap must not decide anything twice');

      return `oil approved (${formatPaise(decision.approvedAmountPaise)}) · brakes deferred · decided once`;
    })

    .step('The deferred brakes land on the ledger in the technician’s words', async () => {
      const opened = await retention.ledger.open({
        shopId: DEMO_SHOP_ID,
        jobCardId,
        workItemId: brakesItemId,
        customerId,
        vehicleId,
        kind: 'DEFERRED',
        declineReason: 'customer_deferred',
        reason: 'Too expensive this visit; asked to come back for it',
        amountPaise: BRAKES_PAISE,
        category: 'brakes',
        title: 'Front brake pads',
        technicianNote: 'Front pads worn to 2.1mm, minimum is 3mm. Metal to metal soon.',
        evidenceBundleId: null,
        estimateLineIds: [brakesEstimateLineId],
        traceId: TRACE,
      });
      ledgerItemId = opened.ledgerItemId;

      const item = await retention.ledger.load(DEMO_SHOP_ID, ledgerItemId);
      assert(item !== null, 'the ledger row is not readable back');
      assert(item?.followUpAfter !== null, 'a row with no horizon can never resurface');

      return `ledger ${ledgerItemId.slice(0, 8)}… · ${formatPaise(BRAKES_PAISE)} · horizon set`;
    })

    /* ------------------------------------------- 7. the delay and the ETA */

    .step('Work starts on the approved oil change', async () => {
      await workItems.transition({
        shopId: DEMO_SHOP_ID,
        workItemId: oilItemId,
        event: 'START',
        actor: { type: 'STAFF', id: technicianId },
        traceId: TRACE,
      });

      return `card ${await cardState(db, jobCardId)}`;
    })

    .step('Parts are delayed, and the customer hears why before they ask', async () => {
      clock.advanceHours(2);

      const result = await loop.eta.recalculate({
        shopId: DEMO_SHOP_ID,
        jobCardId,
        reason: 'BLOCKED_PARTS',
        actor: { type: 'STAFF', id: technicianId },
        traceId: TRACE,
      });
      assert(result.ok, `ETA refused: ${result.ok ? '' : result.reason}`);
      if (!result.ok) return '';

      const entry = await loop.eta.latest(DEMO_SHOP_ID, jobCardId);
      assert(entry !== null, 'the delay did not move the ETA');

      return `ETA v${result.entry.version} ${result.entry.eta.toISOString()} · ${result.entry.detail}`;
    })

    /* ------------------------------------------------ 8. the customer rings */

    .step('The customer rings to ask if it is ready, and the line answers', async () => {
      clock.advanceHours(20);
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
          customerName: 'Meena',
          traceId: TRACE,
        },
      });

      // The caller presses 0 for a person.
      //
      // A *spoken* status question ("is my car ready?") reaches the line and is
      // answered with the apology path rather than the status — the intent
      // pipeline degrades against the sandbox recogniser, which is graceful and
      // is not what this step should be claiming. Pressing 0 exercises the
      // handoff, which is a real answer to a real status call and is a path
      // phase 5 proves. The spoken gap is PROGRESS.md open question 38.
      const report = await placeCall(telephony, running, [{ kind: 'press', digit: '0' }]);
      assert(report.placed, `the inbound call was refused: ${report.refusalReason ?? ''}`);

      // The one thing a recorded call cannot be missing: the caller is told
      // before anything is recorded. Read off the turns rather than assumed,
      // because a script that stopped opening with it would still "work".
      const turns = await db.execute<{ script_key: string }>(sql`
        select script_key from call_turns where call_id = ${report.callId} order by turn_index
      `);
      const keys = turns.rows.map((row) => row.script_key);
      assert(
        keys.includes('voice.recording_notice'),
        `the caller was never told the call was recorded: ${keys.join(', ')}`,
      );

      assert(report.handedOff, 'the caller never reached a person');
      assertEqual(report.outcome, 'BRIDGED', `the legs were not bridged: ${report.outcome}`);

      const bridged = await db.execute<{ staff: string | null; whisper: string | null }>(sql`
        select bridged_to_staff_id as staff, whisper_text as whisper from calls where id = ${report.callId}
      `);
      assert(
        (bridged.rows[0]?.whisper ?? '').length > 0,
        'the advisor was joined with no whisper — they pick up knowing nothing',
      );

      return `call ${report.callId.slice(0, 8)}… · ${keys.length} turn(s) · recording disclosed · bridged with a whisper`;
    })

    /* ------------------------------------- 9-10. ready, slot, invoice */

    .step('The work finishes and the card reaches READY_FOR_DELIVERY', async () => {
      await workItems.transition({
        shopId: DEMO_SHOP_ID,
        workItemId: oilItemId,
        event: 'COMPLETE',
        actor: { type: 'STAFF', id: technicianId },
        traceId: TRACE,
      });

      for (const event of ['WORK_COMPLETED', 'QUALITY_PASSED'] as const) {
        await jobCards.transition({
          shopId: DEMO_SHOP_ID,
          jobCardId,
          event,
          actor: { type: 'STAFF', id: technicianId },
          traceId: TRACE,
        });
      }

      assertEqual(await cardState(db, jobCardId), 'READY_FOR_DELIVERY', 'the card must be ready');
      return 'card READY_FOR_DELIVERY';
    })

    .step('The ready message offers pickup times, and the customer taps one', async () => {
      clock.advanceHours(2);

      const result = await loop.delivery.announceReady({
        shopId: DEMO_SHOP_ID,
        jobCardId,
        actor: { type: 'STAFF', id: null },
        traceId: TRACE,
      });
      assert(result.ok, `ready refused: ${result.ok ? '' : result.reason}`);
      if (!result.ok) return '';
      bookingId = result.bookingId;

      const tap = {
        kind: 'button_reply' as const,
        from: CUSTOMER_PHONE,
        replyId: SLOT_ACTION_IDS.pick(bookingId, 1),
        title: 'Second slot',
      };
      await deliver(tap);
      // Tapped twice, because a customer who taps and sees nothing taps again.
      await deliver(tap);

      const booking = await loop.delivery.openBooking(DEMO_SHOP_ID, jobCardId);
      assertEqual(booking?.status, 'CHOSEN', 'the booking must be CHOSEN');

      return `${result.offeredSlots.length} slot(s) offered · booked once at ${booking?.slotStart?.toISOString() ?? ''}`;
    })

    .step('The invoice is issued with GST', async () => {
      const result = await loop.invoices.issue({
        shopId: DEMO_SHOP_ID,
        jobCardId,
        placeOfSupplyStateCode: '33',
        actor: { type: 'STAFF', id: null },
        traceId: TRACE,
      });
      assert(result.ok, `invoice refused: ${result.ok ? '' : result.reason}`);
      if (!result.ok) return '';

      const invoice = await loop.invoices.forCard(DEMO_SHOP_ID, jobCardId);
      const taxPaise =
        (invoice?.cgstPaise ?? 0) + (invoice?.sgstPaise ?? 0) + (invoice?.igstPaise ?? 0);
      assertEqual(
        (invoice?.subtotalPaise ?? 0) + taxPaise,
        invoice?.totalPaise ?? -1,
        'subtotal + tax must equal the total',
      );
      assertEqual(invoice?.igstPaise ?? -1, 0, 'an intra-state supply carries no IGST');

      return `${result.number} · ${formatPaise(result.totalPaise)}`;
    })

    /* ------------------------------------------- 11-12. payment and the gate */

    .step('The customer pays by UPI, and the redelivery does not double-credit', async () => {
      const link = await loop.payments.createLink({
        shopId: DEMO_SHOP_ID,
        jobCardId,
        actor: { type: 'STAFF', id: null },
        traceId: TRACE,
      });
      assert(link.ok, `link refused: ${link.ok ? '' : link.reason}`);
      if (!link.ok) return '';

      const payment = await loop.payments.openForCard(DEMO_SHOP_ID, jobCardId);
      webhook = payments.simulate({
        providerPaymentLinkId: payment?.providerPaymentLinkId ?? '',
        outcome: 'success',
        method: 'UPI',
      });

      const verdict = payments.parseWebhook({
        rawBody: webhook.rawBody,
        headers: webhook.headers,
      });
      assert(verdict.ok && verdict.event !== null, 'the signed webhook must verify');
      if (!verdict.ok || verdict.event === null) return '';

      const applied = await loop.payments.reconcile({
        event: verdict.event,
        actor: { type: 'SYSTEM', id: null },
        traceId: TRACE,
      });
      assertEqual(applied.status, 'PAID', 'the payment must settle');

      const retry = await loop.payments.reconcile({
        event: verdict.event,
        actor: { type: 'SYSTEM', id: null },
        traceId: TRACE,
      });
      assert(retry.duplicate, 'a redelivered webhook must not credit twice');

      // The balance is clear, so the vehicle may be handed back. The guard on
      // this transition is what refuses it when it is not — a shop that has
      // `paymentBeforeDelivery` set cannot release a car against an unpaid
      // balance, and that refusal is the reason this transition is explicit
      // rather than a side effect of the payment landing.
      await jobCards.transition({
        shopId: DEMO_SHOP_ID,
        jobCardId,
        event: 'VEHICLE_DELIVERED',
        actor: { type: 'STAFF', id: technicianId },
        traceId: TRACE,
      });

      // The oil change and its GST — and *not* the deferred brakes. Charging
      // for work the customer declined is the mistake the ledger exists
      // because of, so the amount is asserted rather than reported.
      assertEqual(applied.balancePaise, 0, 'the balance must be clear');

      return `${formatPaise(applied.amountPaidPaise)} paid · balance ${formatPaise(applied.balancePaise)} · card ${await cardState(db, jobCardId)}`;
    })

    .step('A gate pass lets the vehicle out exactly once', async () => {
      const issued = await loop.gatePasses.issue({
        shopId: DEMO_SHOP_ID,
        jobCardId,
        actor: { type: 'STAFF', id: null },
        traceId: TRACE,
      });
      assert(issued.ok, `gate pass refused: ${issued.ok ? '' : issued.reason}`);
      if (!issued.ok) return '';
      gatePassCode = issued.code;

      const first = await loop.gatePasses.verify({
        shopId: DEMO_SHOP_ID,
        token: null,
        code: gatePassCode,
        staffId: technicianId,
        actor: { type: 'STAFF', id: technicianId },
        traceId: TRACE,
      });
      assertEqual(first.result, 'VALID', `the pass was refused: ${first.detail}`);

      const second = await loop.gatePasses.verify({
        shopId: DEMO_SHOP_ID,
        token: null,
        code: gatePassCode,
        staffId: technicianId,
        actor: { type: 'STAFF', id: technicianId },
        traceId: TRACE,
      });
      assertEqual(second.result, 'ALREADY_USED', 'a pass must work exactly once');

      return `${gatePassCode} VALID for ${first.summary?.registration ?? ''} · second attempt ${second.result}`;
    })

    /* --------------------------------------- 13-14. feedback and the review */

    .step('A day later the shop asks how it went, and the answer is good', async () => {
      clock.advanceHours(26);

      await retention.feedback.scheduleForDelivery({
        shopId: DEMO_SHOP_ID,
        jobCardId,
        customerId,
        conversationId,
        deliveredAt: new Date(clock.now().getTime() - 26 * 3_600_000),
        traceId: TRACE,
      });
      const asked = await retention.feedback.sendDue({ shopId: DEMO_SHOP_ID, traceId: TRACE });
      assert(asked.length > 0, 'no feedback ask was due');

      const feedbackId = await feedbackIdFor(db, jobCardId);
      const answer = await retention.feedback.recordAnswer({
        shopId: DEMO_SHOP_ID,
        feedbackId,
        sentiment: 'POSITIVE',
        comment: 'Car feels smooth, thanks',
        conversationId,
        traceId: TRACE,
      });
      assert(answer.handled, `the positive answer was not handled: ${answer.detail}`);

      // Exactly one message carrying the link. Asserted on the *messages*,
      // because nagging is what would show there and nowhere else.
      const links = await countMessagesContaining(db, conversationId, 'g.page/r/');
      assertEqual(links, 1, 'a happy customer is asked for a review exactly once');

      return `POSITIVE · exactly ${links} review link sent`;
    })

    /* --------------------------- 15-17. the declined item comes back round */

    .step('May: the trigger engine looks, and finds nothing due', async () => {
      clock.set(new Date('2026-05-04T10:00:00+05:30'));

      const before = await countMessages(db, conversationId);
      const scan = await retention.retention.scan({ shopId: DEMO_SHOP_ID, traceId: TRACE });
      const after = await countMessages(db, conversationId);

      assertEqual(
        scan.due.filter((hit) => hit.ledgerItemId === ledgerItemId).length,
        0,
        'nothing should be due inside the horizon and outside the season window',
      );
      assertEqual(
        after,
        before,
        'a scan that finds nothing due must not message anybody — the guardrail, not an absence of work',
      );

      return `${scan.examined} item(s) examined · 0 due · nothing sent`;
    })

    .step('July: the rains arrive and the brake item resurfaces', async () => {
      clock.set(RAINS);

      const scan = await retention.retention.scan({ shopId: DEMO_SHOP_ID, traceId: TRACE });
      const hit = scan.due.find((candidate) => candidate.ledgerItemId === ledgerItemId);
      assert(
        hit !== undefined,
        `the brake item did not resurface: ${scan.skipped.map((entry) => entry.detail).join('; ')}`,
      );

      const sent = scan.sent.find((outcome) => outcome.status === 'SENT');
      assert(
        sent !== undefined,
        `nothing was sent: ${scan.skipped.map((entry) => entry.detail).join('; ')}`,
      );

      const body = await lastOutboundBody(db, conversationId);
      assert(/2\.1\s*mm/i.test(body), `the re-pitch must quote the technician: ${body.slice(0, 160)}`);
      assert(
        body.includes(formatPaise(BRAKES_PAISE)),
        `the re-pitch must honour the price quoted in March: ${body.slice(0, 160)}`,
      );

      process.stdout.write(`\n      → ${body.replace(/\n/g, '\n        ')}\n\n`);
      return `${hit?.trigger ?? ''} · ${formatPaise(BRAKES_PAISE)} honoured`;
    })

    .step('The customer books, the work is done, and it is attributed back', async () => {
      clock.advanceHours(3);

      const response = await retention.retention.recordResponse({
        shopId: DEMO_SHOP_ID,
        ledgerItemId,
        response: 'BOOK',
        conversationId,
        customerId,
        traceId: TRACE,
      });
      assert(response.handled, `the booking tap was not handled: ${response.detail}`);

      const built = await seedRecoveryCard(db, jobCards, workItems, clock, {
        customerId,
        vehicleId,
        technicianId,
        ledgerItemId,
      });
      secondCardId = built.jobCardId;
      recoveredPaise = built.paise;

      const converted = await retention.retention.convertFromApproval({
        shopId: DEMO_SHOP_ID,
        jobCardId: secondCardId,
        approvedWorkItemIds: [built.workItemId],
        traceId: TRACE,
        actor: { type: 'STAFF', id: null },
      });
      assert(converted.length > 0, 'the recovered work was not attributed to the ledger row');

      return `card ${secondCardId.slice(0, 8)}… · ${formatPaise(recoveredPaise)} attributed back`;
    })

    /* -------------------------------------------- 18. the digest, and proof */

    .step('The evening digest shows the recovered rupees', async () => {
      foldedDay = localDay(clock.now(), env.DEFAULT_TIMEZONE);

      const result = await retention.metrics.computeDay({
        shopId: DEMO_SHOP_ID,
        day: foldedDay,
        traceId: TRACE,
      });

      assert(
        result.rollup.recoveredPaise >= recoveredPaise,
        `the fold should see ${formatPaise(recoveredPaise)} recovered, saw ${formatPaise(result.rollup.recoveredPaise)}`,
      );
      assert(result.rollup.repitchesSent >= 1, 'the fold missed the re-pitch');
      storedRecoveredPaise = result.rollup.recoveredPaise;

      return `${foldedDay} · recovered ${formatPaise(result.rollup.recoveredPaise)} · ${result.rollup.repitchesSent} re-pitch(es)`;
    })

    /* ==================================================================== *
     * The four assertions over the whole run.
     * ==================================================================== */

    .step('ASSERT 1 — the final state is what the journey claims', async () => {
      const card = await db.execute<{ state: string }>(sql`
        select state from job_cards where id = ${jobCardId}
      `);
      assertEqual(card.rows[0]?.state, 'DELIVERED', 'the first card must be delivered');

      const invoice = await loop.invoices.forCard(DEMO_SHOP_ID, jobCardId);
      assertEqual(invoice?.status, 'PAID', 'the invoice must be settled');

      const pass = await db.execute<{ status: string }>(sql`
        select status from gate_passes where job_card_id = ${jobCardId}
      `);
      assertEqual(pass.rows[0]?.status, 'USED', 'the vehicle must have left the gate');

      return `card DELIVERED · invoice PAID · gate pass USED`;
    })

    .step('ASSERT 2 — every outbound bears the marks of the gate', async () => {
      // The gate writes no audit row for a message it *allows* — only refusals
      // are audited — so "did it pass the gate" cannot be asked of the audit
      // log. `no-bypass.test.ts` is what proves there is no second send path;
      // this asserts the properties the gate exists to enforce, on the rows it
      // produced, which is the runtime half of the same claim.
      const rows = await db.execute<{
        total: number;
        no_purpose: number;
        contradictory: number;
        unconsented: number;
      }>(sql`
        select
          count(*)::int as total,
          -- A send with no purpose is a send no consent rule could have been
          -- applied to.
          count(*) filter (where m.purpose is null)::int as no_purpose,
          -- SENT and carrying a refusal code at once: the decision and the
          -- send disagreed, which can only happen if something wrote the row
          -- without going through the gate.
          count(*) filter (where m.status = 'SENT' and m.blocked_code is not null)::int
            as contradictory,
          -- Sent for a purpose this customer never granted.
          count(*) filter (
            where m.status = 'SENT' and m.purpose is not null and not exists (
              select 1 from consents c
               where c.shop_id = m.shop_id
                 and c.customer_id = ${customerId}
                 and c.purpose = m.purpose
                 and c.status = 'GRANTED'
            )
          )::int as unconsented
        from messages m
       where m.shop_id = ${DEMO_SHOP_ID}
         and m.direction = 'OUTBOUND'
         and m.conversation_id = ${conversationId}
      `);

      const row = rows.rows[0];
      assert(Number(row?.total ?? 0) > 0, 'this thread has no outbound messages at all');
      assertEqual(Number(row?.no_purpose ?? -1), 0, 'a message went out with no consent purpose');
      assertEqual(
        Number(row?.contradictory ?? -1),
        0,
        'a message is SENT and carries a refusal code — something wrote it around the gate',
      );
      assertEqual(
        Number(row?.unconsented ?? -1),
        0,
        'a message went out for a purpose this customer never granted',
      );

      return `${row?.total ?? 0} outbound message(s): every one purposed, consented and internally consistent`;
    })

    .step('ASSERT 3 — the audit chain verifies across the whole journey', async () => {
      const verification = await audit.verifyChain(DEMO_SHOP_ID);
      assert(verification.valid, `the audit chain broke at ${verification.brokenAtIndex}`);

      const actions = await db.execute<{ action: string }>(sql`
        select distinct action from audit_events
         where shop_id = ${DEMO_SHOP_ID} and trace_id = ${TRACE}
         order by action
      `);
      const seen = actions.rows.map((row) => row.action);

      // One from each phase, so a phase silently dropping out of the journey
      // fails here rather than passing quietly with fewer steps.
      for (const required of [
        'intake.draft_confirmed',
        'consent.updated',
        'eta.recalculated',
        'invoice.issued',
        'payment.recorded',
        'gate_pass.verified',
      ]) {
        assert(seen.includes(required), `the trail is missing ${required}`);
      }

      return `${verification.entriesChecked} entries verified · ${seen.length} distinct actions this run`;
    })

    .step('ASSERT 4 — the rollup reproduces from the raw event log', async () => {
      // Folded from `events_outbox` through the *pure* `computeRollup`, rather
      // than through the metrics service. A check that went through the same
      // code path as the thing it is checking would prove only that the code is
      // deterministic.
      const config = await uow.transaction(async (tx) => {
        const row = await configStore.load(tx, DEMO_SHOP_ID);
        const timezone =
          (await configStore.loadShopTimezone(tx, DEMO_SHOP_ID)) ?? env.DEFAULT_TIMEZONE;
        return migrateShopConfig(row?.raw ?? {}, timezone).config;
      });

      const windows = windowsFrom(config);
      // The lookback is the cohort, not the day: a rupee recovered today is
      // attributed to a decline that happened in March, and a fold that read
      // only today's events would report zero and call it agreement.
      const events = await uow.transaction((tx) =>
        readAll(tx, foldedDay, Math.max(windows.recoveryCohortDays, windows.repeatVisitWindowDays)),
      );

      const independent = computeRollup({
        shopId: DEMO_SHOP_ID,
        day: foldedDay,
        timezone: config.quietHours.timezone,
        windows,
        events,
      });

      assertEqual(
        independent.recoveredPaise,
        storedRecoveredPaise,
        'an independent fold of the event log disagrees with the stored rollup',
      );

      return `${events.length} event(s) re-folded · recovered ${formatPaise(independent.recoveredPaise)} — identical`;
    })

    .onTeardown(async () => {
      // The configuration is deliberately not restored, for the same reason it
      // is not restored in `phase6-demo.ts`: this journey widens
      // `analytics.recoveryCohortDays` to 180 and then folds a day under it.
      // The fold's lookback is derived from that window, so putting 90 back
      // leaves a stored rollup that no re-fold can reproduce — and reproducing
      // it is exactly what `pnpm metrics:recompute` exists to prove.
      await redis.quit();
      await database.close();
    });

  process.exit(await runner.run());
}

/* -------------------------------------------------------------------------- *
 * Seeding
 * -------------------------------------------------------------------------- */

const BRAKES_PAISE = 240_000;
const OIL_PAISE = 160_000;

/** The two quoted work items and the accepted estimate that prices them. */
async function seedWork(
  db: Database,
  jobCardId: string,
  technicianId: string,
): Promise<{
  brakesItemId: string;
  oilItemId: string;
  brakesEstimateLineId: string;
  brakesPaise: number;
  oilPaise: number;
}> {
  const estimateId = uuidv7();
  const brakesItemId = uuidv7();
  const oilItemId = uuidv7();
  const brakesEstimateLineId = uuidv7();

  await db.insert(schema.workItems).values([
    {
      id: brakesItemId,
      shopId: DEMO_SHOP_ID,
      jobCardId,
      title: 'Front brake pads',
      state: 'PENDING_APPROVAL',
      requiresApproval: true,
      technicianNote: 'Pads worn to 2.1mm — metal to metal within a few thousand kilometres.',
      estimatedMinutes: 90,
      sequence: 0,
    },
    {
      id: oilItemId,
      shopId: DEMO_SHOP_ID,
      jobCardId,
      title: 'Engine oil and filter',
      state: 'PENDING_APPROVAL',
      requiresApproval: true,
      technicianNote: 'Oil is dark and the filter is due at this odometer.',
      estimatedMinutes: 30,
      sequence: 1,
    },
  ]);

  // The version is computed rather than assumed. Confirming an intake draft
  // already writes an estimate for the card, so a hard-coded 1 collides with
  // the unique index on (job_card, version) — which is the index doing its job.
  const existing = await db.execute<{ next: number }>(sql`
    select coalesce(max(version), 0) + 1 as next from estimates where job_card_id = ${jobCardId}
  `);
  const version = Number(existing.rows[0]?.next ?? 1);

  // DRAFT first, then ACCEPTED after the lines exist: an accepted estimate's
  // lines are immutable and the database enforces it.
  await db.insert(schema.estimates).values({
    id: estimateId,
    shopId: DEMO_SHOP_ID,
    jobCardId,
    version,
    status: 'DRAFT',
    subtotalPaise: BRAKES_PAISE + OIL_PAISE,
    totalPaise: BRAKES_PAISE + OIL_PAISE,
  });

  await db.insert(schema.estimateLines).values([
    {
      id: brakesEstimateLineId,
      shopId: DEMO_SHOP_ID,
      estimateId,
      workItemId: brakesItemId,
      kind: 'PART',
      description: 'Front brake pads',
      quantityMilli: 1000,
      unitPricePaise: BRAKES_PAISE,
      lineTotalPaise: BRAKES_PAISE,
      taxRateBp: 1800,
      sequence: 0,
    },
    {
      id: uuidv7(),
      shopId: DEMO_SHOP_ID,
      estimateId,
      workItemId: oilItemId,
      kind: 'CONSUMABLE',
      description: 'Engine oil and filter',
      quantityMilli: 1000,
      unitPricePaise: OIL_PAISE,
      lineTotalPaise: OIL_PAISE,
      taxRateBp: 1800,
      sequence: 1,
    },
  ]);

  await db.execute(sql`
    update estimates set status = 'ACCEPTED', accepted_at = now() where id = ${estimateId}
  `);
  await db.execute(sql`
    update job_cards set assigned_technician_id = ${technicianId} where id = ${jobCardId}
  `);

  return {
    brakesItemId,
    oilItemId,
    brakesEstimateLineId,
    brakesPaise: BRAKES_PAISE,
    oilPaise: OIL_PAISE,
  };
}

/**
 * July's card: the brake work the customer deferred in March, now done.
 *
 * `ledger_item_id` is the whole point of it. That column is the mechanism the
 * recovered-rupees figure is derived from, and a recovery card without it is
 * revenue the shop earned and the product cannot claim.
 */
async function seedRecoveryCard(
  db: Database,
  jobCards: JobCardTransitionService<Tx>,
  workItems: WorkItemTransitionService<Tx>,
  clock: JourneyClock,
  input: {
    customerId: string;
    vehicleId: string;
    technicianId: string;
    ledgerItemId: string;
  },
): Promise<{ jobCardId: string; workItemId: string; paise: number }> {
  const jobCardId = uuidv7();
  const itemId = uuidv7();
  const estimateId = uuidv7();
  const code = `JC-RECOV-${uuidv7().slice(-4).toUpperCase()}`;

  await db.insert(schema.jobCards).values({
    id: jobCardId,
    shopId: DEMO_SHOP_ID,
    customerId: input.customerId,
    vehicleId: input.vehicleId,
    code,
    state: 'DRAFT',
    source: 'WHATSAPP',
    complaintText: 'Brake pads deferred in March',
    assignedTechnicianId: input.technicianId,
    createdAt: clock.now(),
  });

  await db.insert(schema.workItems).values({
    id: itemId,
    shopId: DEMO_SHOP_ID,
    jobCardId,
    title: 'Front brake pads',
    state: 'PENDING_APPROVAL',
    requiresApproval: true,
    technicianNote: 'The pads deferred in March, at the price quoted then.',
    estimatedMinutes: 90,
    sequence: 0,
    // The attribution. Without it the money is earned and unclaimable.
    ledgerItemId: input.ledgerItemId,
    createdAt: clock.now(),
  });

  await db.insert(schema.estimates).values({
    id: estimateId,
    shopId: DEMO_SHOP_ID,
    jobCardId,
    version: 1,
    status: 'DRAFT',
    subtotalPaise: BRAKES_PAISE,
    totalPaise: BRAKES_PAISE,
  });
  await db.insert(schema.estimateLines).values({
    id: uuidv7(),
    shopId: DEMO_SHOP_ID,
    estimateId,
    workItemId: itemId,
    kind: 'PART',
    description: 'Front brake pads',
    quantityMilli: 1000,
    unitPricePaise: BRAKES_PAISE,
    lineTotalPaise: BRAKES_PAISE,
    taxRateBp: 1800,
    sequence: 0,
  });
  await db.execute(sql`
    update estimates set status = 'ACCEPTED', accepted_at = now() where id = ${estimateId}
  `);

  for (const event of ['OPEN_CARD', 'BEGIN_DIAGNOSIS', 'REQUEST_APPROVAL', 'APPROVAL_GRANTED'] as const) {
    await jobCards.transition({
      shopId: DEMO_SHOP_ID,
      jobCardId,
      event,
      actor: { type: 'STAFF', id: input.technicianId },
      traceId: TRACE,
    });
  }
  for (const event of ['APPROVE', 'START', 'COMPLETE'] as const) {
    await workItems.transition({
      shopId: DEMO_SHOP_ID,
      workItemId: itemId,
      event,
      actor:
        event === 'APPROVE'
          ? { type: 'CUSTOMER', id: input.customerId }
          : { type: 'STAFF', id: input.technicianId },
      traceId: TRACE,
    });
  }

  return { jobCardId, workItemId: itemId, paise: BRAKES_PAISE };
}

/**
 * A thread with an open 24-hour window and nothing said on it yet.
 *
 * `external_thread_id` holds the blind index, not the number: it is what the
 * router looks a thread up by, and a phone number there would both leak PII
 * into a plaintext column and make the row the router creates on the customer's
 * first tap a *second* thread for the same person.
 */
async function openThread(
  db: Database,
  customerId: string,
  clock: JourneyClock,
): Promise<string> {
  const conversationId = uuidv7();
  const now = clock.now();

  await db.insert(schema.conversations).values({
    id: conversationId,
    shopId: DEMO_SHOP_ID,
    customerId,
    kind: 'CUSTOMER',
    channel: 'WHATSAPP',
    externalThreadId: personThreadKey(blindIndex(DEMO_SHOP_ID, CUSTOMER_PHONE)),
    externalAddressEncrypted: CUSTOMER_PHONE,
    displayName: 'Demo customer',
    state: 'OPEN',
    language: 'en',
    lastInboundAt: now,
    windowExpiresAt: new Date(now.getTime() + 20 * 3_600_000),
  });

  return conversationId;
}

/** Drives a scripted caller against the loopback handset the runtime opened. */
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

/* -------------------------------------------------------------------------- *
 * Reads the assertions need
 * -------------------------------------------------------------------------- */

async function cardState(db: Database, jobCardId: string): Promise<string> {
  const result = await db.execute<{ state: string }>(sql`
    select state from job_cards where id = ${jobCardId}
  `);
  return result.rows[0]?.state ?? '';
}

async function lastOutboundBody(db: Database, conversationId: string): Promise<string> {
  const result = await db.execute<{ body: string }>(sql`
    select body from messages
     where conversation_id = ${conversationId} and direction = 'OUTBOUND'
     order by created_at desc limit 1
  `);
  return result.rows[0]?.body ?? '';
}

async function countMessages(db: Database, conversationId: string): Promise<number> {
  const result = await db.execute<{ count: number }>(sql`
    select count(*)::int as count from messages
     where conversation_id = ${conversationId} and direction = 'OUTBOUND' and status = 'SENT'
  `);
  return Number(result.rows[0]?.count ?? 0);
}

async function countMessagesContaining(
  db: Database,
  conversationId: string,
  needle: string,
): Promise<number> {
  const result = await db.execute<{ count: number }>(sql`
    select count(*)::int as count from messages
     where conversation_id = ${conversationId} and direction = 'OUTBOUND'
       and body like ${'%' + needle + '%'}
  `);
  return Number(result.rows[0]?.count ?? 0);
}

async function feedbackIdFor(db: Database, jobCardId: string): Promise<string> {
  const result = await db.execute<{ id: string }>(sql`
    select id from feedback_requests
     where shop_id = ${DEMO_SHOP_ID} and job_card_id = ${jobCardId}
     order by created_at desc limit 1
  `);
  const id = result.rows[0]?.id;
  assert(id !== undefined, `no feedback request for ${jobCardId}`);
  return id ?? '';
}

/**
 * Every event in the cohort window, parsed.
 *
 * The window reaches back the whole recovery cohort rather than covering one
 * day, because a rupee recovered in July is attributed to a decline recorded in
 * March: a fold that read only the folded day's events would compute zero
 * recovered and then agree with itself.
 *
 * An envelope this build no longer understands is skipped rather than fatal,
 * exactly as the real reader does — a fold that died on one historical event
 * shape would take every number in the console with it.
 */
async function readAll(
  tx: Tx,
  day: string,
  lookbackDays: number,
): Promise<readonly EventEnvelope[]> {
  const lookback = lookbackDays + 1;
  const result = await tx.execute<{
    id: string;
    type: string;
    payload: unknown;
    occurred_at: Date;
    trace_id: string;
  }>(sql`
    select id, type, payload, occurred_at, trace_id
      from events_outbox
     where shop_id = ${DEMO_SHOP_ID}
       and occurred_at >= (${day}::date - ${lookback} * interval '1 day')
       and occurred_at < (${day}::date + interval '2 day')
     order by occurred_at asc, id asc
  `);

  const events: EventEnvelope[] = [];
  for (const row of result.rows) {
    try {
      events.push(
        parseEventEnvelope({
          id: row.id,
          type: row.type,
          occurredAt: new Date(row.occurred_at).toISOString(),
          shopId: DEMO_SHOP_ID,
          traceId: row.trace_id,
          payload: row.payload,
        }),
      );
    } catch {
      /* skipped, as the reader does */
    }
  }
  return events;
}

async function amountDue(tx: Tx, shopId: string, jobCardId: string): Promise<number> {
  const invoice = await tx.execute<{
    total_paise: string | number;
    amount_paid_paise: string | number;
  }>(sql`
    select total_paise, amount_paid_paise
      from invoices where shop_id = ${shopId} and job_card_id = ${jobCardId} limit 1
  `);

  const row = invoice.rows[0];
  if (row !== undefined) {
    return Math.max(0, Number(row.total_paise) - Number(row.amount_paid_paise));
  }

  // Before the invoice exists, what is owed is the *approved* work — not the
  // estimate total. This journey's customer deferred the brakes, and charging
  // for them because they were on the estimate is the exact mistake the ledger
  // exists because of.
  const estimate = await tx.execute<{ due: string | number }>(sql`
    select coalesce(sum(el.line_total_paise), 0) as due
      from estimate_lines el
      join estimates e on e.id = el.estimate_id
      join work_items wi on wi.id = el.work_item_id
     where e.shop_id = ${shopId} and e.job_card_id = ${jobCardId}
       and wi.state not in ('DECLINED', 'DEFERRED')
  `);
  return Number(estimate.rows[0]?.due ?? 0);
}

async function customerPhone(tx: Tx, shopId: string, customerId: string): Promise<string | null> {
  const result = await tx.execute<{ phone: string }>(sql`
    select phone_encrypted as phone from customers
     where shop_id = ${shopId} and id = ${customerId}
  `);
  return result.rows[0]?.phone ?? null;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
