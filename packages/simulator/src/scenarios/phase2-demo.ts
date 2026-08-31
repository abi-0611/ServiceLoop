import {
  AdapterDraftExtraction,
  modelsByTaskClass,
  createMediaPipeline,
  createStoragePort,
  FixtureOcrAdapter,
  LlmTextDraftExtractor,
  MockSpeechAdapter,
  SandboxWhatsAppAdapter,
  SandboxLlmAdapter,
  toInboundMessage,
  VoiceNoteDraftExtractor,
  WhatsAppChannelSender,
  WhatsAppMediaFetcher,
  type InboundEvent,
} from '@serviceloop/adapters';
import { defaultShopConfig, formatAdapterSelection, getEnv } from '@serviceloop/config';
import {
  AuditService,
  blindIndex,
  ConversationRepository,
  createDatabase,
  DEMO_ADVISOR,
  DEMO_SHOP_ID,
  DEMO_TECHNICIAN,
  IntakeRepository,
  isAlreadySeeded,
  OutboxService,
  PgConsentStore,
  PgConversationStore,
  PgCustomerLookup,
  PgDraftStore,
  PgEntityLookup,
  PgJobCardStore,
  PgJobCardWriter,
  PgMediaStore,
  PgMessageStore,
  PgShopConfigStore,
  PgShopDirectory,
  PgUnitOfWork,
  runMigrations,
  schema,
  seedDemoShop,
  type Tx,
} from '@serviceloop/db';
import {
  ConsentCaptureService,
  ConsentService,
  ConversationSessionService,
  DeferredSendService,
  DRAFT_ACTION_IDS,
  EntityResolutionService,
  GuardrailService,
  InboundHandler,
  InboundRouter,
  IntakePipeline,
  IntakeService,
  JobCardTransitionService,
  MediaService,
  OutboundGate,
  type InboundOutcome,
} from '@serviceloop/domain';
import { type JobCardDraft, uuidv7 } from '@serviceloop/shared';
import { and, desc, eq } from 'drizzle-orm';
import IORedis from 'ioredis';
import sharp from 'sharp';
import { CARD_FIXTURES } from '../ocr/fixtures';
import { groundTruthDraft, perturbDraft } from '../ocr/ground-truth';
import { assert, assertEqual, ScenarioRunner } from '../runner';

/**
 * `pnpm demo:phase2`
 *
 * The phase-2 acceptance scenario, end to end against the sandbox adapters:
 *
 *   photo → OCR draft → correction → confirmed OPEN card
 *   forwarded text → draft · voice note → draft
 *   consent-gated outbound, opt-out, quiet-hours deferral and release
 *
 * Everything travels the production path. The simulator does not call the
 * router directly: it renders a signed Cloud API webhook envelope, pushes it
 * through `receive`, and lets the same `InboundHandler` the API uses take it
 * from there. A step that passes here is a step that works behind Meta.
 */

const TRACE = `demo-phase2-${uuidv7().slice(0, 8)}`;
const STAFF_GROUP_ID = '120363000000000042';
/**
 * A quiet window that does not contain *now*.
 *
 * The shipped default is 21:00–08:00, which means a demo run in the evening
 * would have its very first staff-group message deferred — and would look
 * broken while the guardrail was working exactly as designed. Step 14 narrows
 * the window around the current time deliberately, which is where the
 * quiet-hours rule is actually proved; everything before it just needs a window
 * it is not standing in.
 */
function quietHoursAwayFromNow(): { timezone: string; start: string; end: string } {
  const base = defaultShopConfig('Asia/Kolkata').quietHours;
  const now = new Date();
  return {
    timezone: base.timezone,
    start: shopClockHm(now, base.timezone, 120),
    end: shopClockHm(now, base.timezone, 180),
  };
}

/**
 * Distinct numbers so repeated demo runs never collide with seeded threads.
 *
 * `CUSTOMER_PHONE` is what the paper card says, so confirming the draft creates
 * a customer on it. `STRANGER_PHONE` is deliberately *not* that number: the
 * identification prompt only fires for a number the shop has never seen, and
 * reusing one would quietly turn that step into a no-op.
 */
const CUSTOMER_PHONE = `+9198${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`;
const STRANGER_PHONE = `+9197${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`;

async function main(): Promise<void> {
  const env = getEnv();
  const database = createDatabase(env);
  const db = database.db;
  const redis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const storage = createStoragePort(env);

  const uow = new PgUnitOfWork(db);
  const audit = new AuditService(db, redis);
  const outbox = new OutboxService(db);
  const configStore = new PgShopConfigStore();
  const directory = new PgShopDirectory();

  /* ------------------------------------------------------------- adapters */

  const whatsapp = new SandboxWhatsAppAdapter({ deliveryMode: 'instant' });
  const ocr = new FixtureOcrAdapter();
  const speech = new MockSpeechAdapter();
  const llm = new SandboxLlmAdapter({ models: modelsByTaskClass(env) });
  const textExtractor = new LlmTextDraftExtractor(llm);
  const extraction = new AdapterDraftExtraction(
    ocr,
    textExtractor,
    new VoiceNoteDraftExtractor(speech, textExtractor),
  );

  /* -------------------------------------------------------------- domain */

  const conversations = new PgConversationStore();
  const messages = new PgMessageStore();
  const customers = new PgCustomerLookup();

  const sessions = new ConversationSessionService<Tx>({
    uow,
    conversations,
    customers,
    audit,
    outbox,
    blindIndex,
  });
  const consents = new ConsentService<Tx>({
    uow,
    consents: new PgConsentStore(),
    audit,
    outbox,
  });
  const gate = new OutboundGate<Tx>({
    uow,
    conversations,
    messages,
    consents: new PgConsentStore(),
    config: configStore,
    audit,
    outbox,
    sender: new WhatsAppChannelSender(whatsapp),
  });
  const cards = new JobCardTransitionService<Tx>({
    uow,
    cards: new PgJobCardStore(),
    config: configStore,
    audit,
    outbox,
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
    cards,
  });
  const media = new MediaService<Tx>({
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
      sessions,
      consents,
      audit,
      outbox,
    }),
    gate,
    intake,
    pipeline: new IntakePipeline<Tx>({ uow, extraction, intake, config: configStore }),
    media,
    mediaFetch: new WhatsAppMediaFetcher(whatsapp),
    conversations,
    messages,
    customers,
    consents,
    config: configStore,
    directory,
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

  const guardrails = new GuardrailService({ uow, store: configStore, audit, outbox });
  const conversationRepo = new ConversationRepository(db);
  const intakeRepo = new IntakeRepository(db);

  /* ---------------------------------------------------------- scenario -- */

  let photoDraftId = '';
  let photoJobCardId = '';
  let customerConversationId = '';
  let customerId = '';
  let cardImage: Buffer = Buffer.alloc(0);
  let expectedRegistration = '';

  const runner = new ScenarioRunner(
    'ServiceLoop — Phase 2 acceptance demo',
    'Channel gateway & zero-migration intake: WhatsApp, media, OCR, consent, inbox.',
  );

  /** Pushes an injected message through the full production path. */
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

  runner
    .step('Sandbox adapters are selected and the schema is seeded', async () => {
      assert(env.DEMO_MODE, 'DEMO_MODE must be true for the demo');
      const lines = formatAdapterSelection(env);
      assert(
        lines.some((line) => line.startsWith('adapter[whatsapp] SANDBOX')),
        'WhatsApp must resolve to the sandbox adapter in DEMO_MODE',
      );

      await runMigrations(db);
      if (!(await isAlreadySeeded(db))) {
        await seedDemoShop(db, { env, storage, log: () => undefined });
      }
      await storage.ensureBucket();

      return lines.filter((line) => line.includes('whatsapp') || line.includes('ocr')).join(' · ');
    })

    .step('The shop is configured with a technician evidence group', async () => {
      // The staff group is what makes a photographed card an intake trigger
      // without a caption, so the demo sets it explicitly rather than assuming.
      //
      // Quiet hours are reset to the shop default at the *start* as well as in
      // teardown. Step 14 narrows them deliberately, and a run that dies
      // between the two would otherwise leave the shop permanently silent — and
      // the next run would fail somewhere confusing, three steps earlier.
      await guardrails.validateAndPatch(
        DEMO_SHOP_ID,
        { messaging: { staffGroupId: STAFF_GROUP_ID }, quietHours: quietHoursAwayFromNow() },
        { type: 'STAFF', id: DEMO_ADVISOR.id, displayName: DEMO_ADVISOR.fullName },
        TRACE,
      );
      const { config } = await guardrails.get(DEMO_SHOP_ID);
      assertEqual(config.messaging.staffGroupId, STAFF_GROUP_ID, 'the staff group must be set');
      return `staff group ${STAFF_GROUP_ID} · quiet hours ${config.quietHours.start}–${config.quietHours.end} · intake trigger "${config.intake.photoTrigger}" · confirm below ${config.intake.confirmationThreshold}`;
    })

    .step('A paper job card is rendered and registered with the OCR fixtures', async () => {
      const fixture = CARD_FIXTURES[0];
      assert(fixture !== undefined, 'the golden fixture set must not be empty');

      // A plate of this run's own. Entity resolution matches a vehicle on its
      // normalised registration and takes the customer from it — which is
      // exactly right, and exactly why reusing the fixture's plate would make
      // the second demo run reuse the first run's customer and its consent
      // history. The demo must not depend on being the first thing to run.
      expectedRegistration = `TN09BX${String(Math.floor(1000 + Math.random() * 8999))}`;

      // A JPEG the pipeline can actually sniff, resize and thumbnail. The
      // fixture adapter keys on the bytes' hash, so what the image *depicts*
      // does not matter here — `pnpm eval:ocr` is what measures reading a real
      // photograph, and it says so plainly when no vision model is configured.
      cardImage = await sharp({
        create: { width: 1240, height: 1754, channels: 3, background: '#f8f5ee' },
      })
        .jpeg({ quality: 82 })
        .toBuffer();

      // A deliberately imperfect reading: the registration comes back misread
      // and *diffident*, which is exactly the case the confirmation flow exists
      // for. An extractor that was confidently wrong would be worse.
      const misread: JobCardDraft = perturbDraft(fixture, {
        errorRate: 0.25,
        honesty: 1,
        seed: 'demo-phase2',
      });
      // `B` read as `8` is the confusion this actually is on a carbon copy.
      const misreadPlate = expectedRegistration.replace('B', '8');
      const truth = groundTruthDraft(fixture);
      const draft: JobCardDraft = {
        ...misread,
        customer: {
          ...truth.customer,
          phone: { value: CUSTOMER_PHONE, confidence: 0.9, region: null },
        },
        vehicle: {
          ...misread.vehicle,
          registration: { value: misreadPlate, confidence: 0.35, region: null },
        },
      };

      ocr.register(cardImage, draft, fixture.id);
      return `${fixture.id} · ${cardImage.byteLength} bytes · "${expectedRegistration}" read as "${misreadPlate}" at 0.35`;
    })

    .step('A technician photographs the card into the workshop group', async () => {
      const outcome = await deliver({
        kind: 'media',
        from: DEMO_TECHNICIAN.phone,
        displayName: DEMO_TECHNICIAN.fullName,
        groupId: STAFF_GROUP_ID,
        mediaKind: 'PHOTO',
        bytes: cardImage,
        contentType: 'image/jpeg',
        caption: '#jobcard',
        filename: 'card.jpg',
      });

      assert(outcome.mediaId !== null, 'the photo must be stored as a media asset');
      assert(outcome.draftId !== null, 'the photo must produce a job-card draft');
      photoDraftId = outcome.draftId;

      const stages = outcome.trace.map((step) => step.stage);
      assert(stages.includes('media'), 'the trace must show the media stage');
      assert(stages.includes('intake'), 'the trace must show the intake stage');
      assert(
        outcome.replies.some((reply) => reply.status === 'SENT'),
        'the numbered summary must go back to the group',
      );

      const detail = await intakeRepo.detail(DEMO_SHOP_ID, photoDraftId);
      assert(detail !== null, 'the draft must be readable by the console');
      assert(detail.fields.some((field) => field.uncertain), 'some field must be flagged ⚠');

      return `draft ${photoDraftId.slice(0, 8)}… · ${detail.fields.length} fields · ${detail.fields.filter((field) => field.uncertain).length} flagged`;
    })

    .step('A redelivered webhook produces no second draft', async () => {
      const before = await intakeRepo.list(DEMO_SHOP_ID, { status: 'AWAITING_CONFIRMATION' });

      // Meta redelivers anything it did not see a 200 for. The same provider
      // message id must not read the card twice.
      const delivery = whatsapp.injectInbound({
        kind: 'text',
        from: DEMO_TECHNICIAN.phone,
        groupId: STAFF_GROUP_ID,
        text: 'checking',
      });
      const batch = await whatsapp.receive(delivery);
      const event = batch.events[0] as InboundEvent;
      const message = toInboundMessage(event);

      const first = await handler.handle({
        shopId: DEMO_SHOP_ID,
        channel: 'WHATSAPP',
        message,
        traceId: TRACE,
      });
      const second = await handler.handle({
        shopId: DEMO_SHOP_ID,
        channel: 'WHATSAPP',
        message,
        traceId: TRACE,
      });

      assertEqual(first.duplicate, false, 'the first delivery must be processed');
      assertEqual(second.duplicate, true, 'the redelivery must be recognised');

      const after = await intakeRepo.list(DEMO_SHOP_ID, { status: 'AWAITING_CONFIRMATION' });
      assertEqual(after.drafts.length, before.drafts.length, 'no draft may be created twice');
      return 'same provider message id → one stored message, no second draft';
    })

    .step('The technician corrects the registration by typing a line number', async () => {
      const detail = await intakeRepo.detail(DEMO_SHOP_ID, photoDraftId);
      assert(detail !== null, 'the draft must exist');
      const line = detail.fields.find((field) => field.path === 'vehicle.registration');
      assert(line !== undefined, 'the summary must number the registration');

      await deliver({
        kind: 'text',
        from: DEMO_TECHNICIAN.phone,
        groupId: STAFF_GROUP_ID,
        text: `${line.index} = ${expectedRegistration}`,
      });

      const corrected = await intakeRepo.detail(DEMO_SHOP_ID, photoDraftId);
      const field = corrected?.fields.find((entry) => entry.path === 'vehicle.registration');
      assertEqual(field?.value, expectedRegistration, 'the correction must apply');
      assertEqual(field?.confidence, 1, 'a human correction is the highest-quality signal');
      assertEqual(corrected?.corrections.length, 1, 'the previous value must be recorded');

      return `line ${line.index}: "${corrected?.corrections[0]?.previousValue ?? ''}" → "${expectedRegistration}"`;
    })

    .step('Confirm creates an OPEN job card with the correction applied', async () => {
      const outcome = await deliver({
        kind: 'button_reply',
        from: DEMO_TECHNICIAN.phone,
        groupId: STAFF_GROUP_ID,
        replyId: DRAFT_ACTION_IDS.confirm(photoDraftId),
        title: 'Confirm',
      });

      assert(outcome.jobCardId !== null, 'confirming must create a job card');
      photoJobCardId = outcome.jobCardId;

      const [card] = await db
        .select()
        .from(schema.jobCards)
        .where(eq(schema.jobCards.id, photoJobCardId));
      assertEqual(card?.state, 'OPEN', 'the card must land on the board as OPEN');
      assertEqual(card?.source, 'PAPER_CARD', 'the card must record the paper on-ramp');

      const [vehicle] = await db
        .select()
        .from(schema.vehicles)
        .where(eq(schema.vehicles.id, card?.vehicleId ?? ''));
      assertEqual(
        vehicle?.registrationNormalised,
        expectedRegistration,
        'the corrected plate must be what the vehicle was created with',
      );

      customerId = card?.customerId ?? '';

      // Provenance: the audit trail names the extractor and the human's fix.
      const trail = await db
        .select()
        .from(schema.auditEvents)
        .where(
          and(
            eq(schema.auditEvents.shopId, DEMO_SHOP_ID),
            eq(schema.auditEvents.action, 'intake.draft_confirmed'),
          ),
        )
        .orderBy(desc(schema.auditEvents.seq))
        .limit(1);

      const payload = trail[0]?.payload as
        | { extractorModel?: string; correctedFields?: string[] }
        | undefined;
      assertEqual(
        payload?.correctedFields?.[0],
        'vehicle.registration',
        'the audit trail must record which field a human corrected',
      );

      return `${card?.code ?? ''} OPEN · ${vehicle?.registrationNormalised ?? ''} · read by ${payload?.extractorModel ?? 'unknown'}`;
    })

    .step('A forwarded message becomes the same kind of draft', async () => {
      const outcome = await deliver({
        kind: 'text',
        from: DEMO_TECHNICIAN.phone,
        groupId: STAFF_GROUP_ID,
        text: '#jobcard Ravi anna Swift MH12AB1234 brake pad + oil change 3500 evening delivery',
      });

      assert(outcome.draftId !== null, 'a forwarded card must produce a draft');
      const detail = await intakeRepo.detail(DEMO_SHOP_ID, outcome.draftId);
      assertEqual(detail?.source, 'FORWARDED_TEXT', 'the on-ramp must be recorded');
      assert(
        (detail?.rawInput ?? '').includes('brake pad'),
        'the forwarded text must be kept verbatim on the draft',
      );

      // Discard it: this step proves the parse, not a second job card.
      await deliver({
        kind: 'button_reply',
        from: DEMO_TECHNICIAN.phone,
        groupId: STAFF_GROUP_ID,
        replyId: DRAFT_ACTION_IDS.discard(outcome.draftId),
        title: 'Discard',
      });

      return `${detail?.registration ?? ''} · ${detail?.fields.length ?? 0} fields · discarded after checking`;
    })

    .step('A voice note is transcribed and parsed into a draft', async () => {
      const audio = wavBytes(1.5);
      speech.register(audio, {
        text: 'Meena madam Hyundai i20 TN 22 BZ 3344 AC not cooling, gas top up, evening delivery',
        language: 'en',
        confidence: 0.82,
      });

      const outcome = await deliver({
        kind: 'media',
        from: DEMO_TECHNICIAN.phone,
        groupId: STAFF_GROUP_ID,
        mediaKind: 'AUDIO',
        bytes: audio,
        contentType: 'audio/wav',
        isVoiceNote: true,
        filename: 'note.wav',
      });

      assert(outcome.draftId !== null, 'a voice note must produce a draft');
      const detail = await intakeRepo.detail(DEMO_SHOP_ID, outcome.draftId);
      assertEqual(detail?.source, 'VOICE_NOTE', 'the on-ramp must be recorded');
      assert(
        (detail?.rawInput ?? '').includes('AC not cooling'),
        'the transcript must be stored as evidence in its own right',
      );

      // The webhook stores the audio and leaves ffmpeg to the worker.
      const asset = await media.load(DEMO_SHOP_ID, outcome.mediaId as string);
      assertEqual(asset?.kind, 'AUDIO', 'the audio must be stored');
      assertEqual(asset?.derivedKey, null, 'the 16 kHz transcode belongs to the worker');

      await deliver({
        kind: 'button_reply',
        from: DEMO_TECHNICIAN.phone,
        groupId: STAFF_GROUP_ID,
        replyId: DRAFT_ACTION_IDS.discard(outcome.draftId),
        title: 'Discard',
      });

      return `transcript "${(detail?.rawInput ?? '').slice(0, 40)}…" · audio queued for transcode`;
    })

    .step('An unrecognised number is asked who it is, with the AI disclosed', async () => {
      const outcome = await deliver({
        kind: 'text',
        from: STRANGER_PHONE,
        displayName: 'Unknown caller',
        text: 'Is my car ready?',
      });

      assertEqual(outcome.routed?.conversationKind, 'UNKNOWN', 'the thread must be unidentified');
      customerConversationId = outcome.routed?.conversationId ?? '';

      const sent = whatsapp.transcript().at(-1);
      assert(sent !== undefined, 'a reply must have been sent');
      assert(
        sent.body.toLowerCase().includes('serviceloop assistant'),
        'first contact must disclose the AI (master §6)',
      );
      return `identification prompt sent · thread ${customerConversationId.slice(0, 8)}…`;
    })

    .step('First contact captures consent, and the gate blocks until it is given', async () => {
      // Attach the customer created by the confirmed card to this thread, so
      // the consent registry has someone to record against.
      await uow.transaction(async (tx: Tx) => {
        await conversations.attachCustomer(tx, {
          conversationId: customerConversationId,
          customerId,
          displayName: 'Demo customer',
        });
      });

      const before = whatsapp.transcript().length;
      const opened = await firstContact.openFirstContact({
        shopId: DEMO_SHOP_ID,
        customerId,
        conversationId: customerConversationId,
        customerName: 'Ravi',
        actor: { type: 'STAFF', id: DEMO_ADVISOR.id, displayName: DEMO_ADVISOR.fullName },
        traceId: TRACE,
      });

      assert(
        opened.sent,
        `the consent ask must go out, but the gate returned ${opened.outcome.status}${
          'code' in opened.outcome ? ` (${opened.outcome.code}): ${opened.outcome.reason}` : ''
        }`,
      );
      const ask = whatsapp.transcript().at(-1);
      assertEqual(ask?.kind, 'interactive', 'the consent ask must be tappable');
      assertEqual(
        whatsapp.transcript().length,
        before + 1,
        'first contact must be exactly one message',
      );

      const again = await firstContact.openFirstContact({
        shopId: DEMO_SHOP_ID,
        customerId,
        conversationId: customerConversationId,
        actor: { type: 'STAFF', id: DEMO_ADVISOR.id },
        traceId: TRACE,
      });
      assertEqual(again.sent, false, 'first contact happens once per thread');

      return `interactive consent ask sent; a second call was a no-op (${again.outcome.status === 'BLOCKED' ? again.outcome.code : ''})`;
    })

    .step('STOP revokes both purposes and is confirmed exactly once', async () => {
      const before = whatsapp.transcript().length;
      await deliver({ kind: 'text', from: STRANGER_PHONE, text: 'STOP' });

      const state = await consents.current(DEMO_SHOP_ID, customerId);
      assertEqual(state.service?.status, 'REVOKED', 'SERVICE consent must be revoked');
      assertEqual(
        state.marketing?.status,
        'REVOKED',
        'a blanket STOP revokes marketing too — nobody typing STOP means "only some"',
      );
      assertEqual(
        whatsapp.transcript().length,
        before + 1,
        'the opt-out is confirmed exactly once',
      );

      const blocked = await gate.send({
        shopId: DEMO_SHOP_ID,
        conversationId: customerConversationId,
        customerId,
        purpose: 'SERVICE',
        content: { kind: 'text', body: 'Your vehicle is ready.' },
        actor: { type: 'AGENT', id: null },
        traceId: TRACE,
        flow: 'status',
      });

      assertEqual(blocked.status, 'BLOCKED', 'a send after opt-out must be refused');
      assertEqual(
        blocked.status === 'BLOCKED' ? blocked.code : '',
        'CONSENT_REVOKED',
        'the refusal must name the reason',
      );
      assertEqual(
        whatsapp.transcript().length,
        before + 1,
        'nothing may reach a customer who opted out',
      );

      return 'SERVICE + MARKETING revoked · one acknowledgement · later send BLOCKED(CONSENT_REVOKED)';
    })

    .step('The blocked send is visible in the inbox rather than silently dropped', async () => {
      const thread = await conversationRepo.thread(DEMO_SHOP_ID, customerConversationId);
      assert(thread !== null, 'the thread must be readable by the console');

      const blocked = thread.messages.find((message) => message.status === 'BLOCKED');
      assert(blocked !== undefined, 'the refused message must appear in the thread');
      assertEqual(blocked.blockedCode, 'CONSENT_REVOKED', 'with its code');
      assert(
        (blocked.blockedReason ?? '').length > 0,
        'and a reason an advisor can read',
      );
      assertEqual(thread.conversation.serviceConsent, 'REVOKED', 'the badge must show the opt-out');

      return `${thread.messages.length} messages · blocked one carries "${(blocked.blockedReason ?? '').slice(0, 48)}…"`;
    })

    .step('Quiet hours defer a message, and the drain releases it', async () => {
      // A fresh thread, so the opt-out above does not mask the quiet-hours path.
      const quietPhone = `+9199${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`;
      await deliver({ kind: 'text', from: quietPhone, displayName: 'Quiet hours tester', text: 'Hello' });

      const threadId = await uow.transaction(async (tx: Tx) =>
        conversations.findByThreadKey(
          tx,
          DEMO_SHOP_ID,
          'WHATSAPP',
          `wa:${blindIndex(DEMO_SHOP_ID, quietPhone)}`,
        ),
      );
      assert(threadId !== null, 'the quiet-hours thread must exist');

      // A window that certainly contains "now" but is not the whole day: a
      // 24-hour quiet window has no instant outside it, and the gate rightly
      // sends rather than holding a message that could never be released.
      const original = (await guardrails.get(DEMO_SHOP_ID)).config.quietHours;
      const now = new Date();
      await guardrails.validateAndPatch(
        DEMO_SHOP_ID,
        {
          quietHours: {
            start: shopClockHm(now, original.timezone, -60),
            end: shopClockHm(now, original.timezone, 60),
          },
        },
        { type: 'STAFF', id: DEMO_ADVISOR.id },
        TRACE,
      );

      const held = await gate.send({
        shopId: DEMO_SHOP_ID,
        conversationId: threadId.id,
        customerId: null,
        purpose: 'SERVICE',
        content: { kind: 'text', body: 'ServiceLoop assistant here: your vehicle is ready.' },
        actor: { type: 'SYSTEM', id: null },
        traceId: TRACE,
        flow: 'status',
        systemReply: true,
      });
      assertEqual(held.status, 'DEFERRED', 'a message inside quiet hours must be held');

      const heldRows = await db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, held.messageId));
      assertEqual(heldRows[0]?.status, 'QUEUED', 'held, not dropped');
      assert(heldRows[0]?.scheduledFor !== null, 'and carrying its due time');

      // Reopen the shop and drain. The drain runs on a clock wound forward past
      // the hold's due time — the alternative is a demo that sleeps for an hour
      // — but the *gate* still runs on the real one, so what this proves is
      // that release re-checks consent, window and caps rather than trusting
      // the decision made when the message was composed.
      await guardrails.validateAndPatch(
        DEMO_SHOP_ID,
        { quietHours: { start: original.start, end: original.end } },
        { type: 'STAFF', id: DEMO_ADVISOR.id },
        TRACE,
      );

      const dueAt = heldRows[0]?.scheduledFor ?? new Date();
      const afterTheHold = new DeferredSendService<Tx>({
        uow,
        messages,
        gate,
        clock: { now: () => new Date(dueAt.getTime() + 60_000) },
      });
      const drained = await afterTheHold.drain({ shopId: DEMO_SHOP_ID, limit: 20 });
      assertEqual(drained.claimed, 1, 'the drain must claim exactly the held message');

      const releasedRows = await db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, held.messageId));
      assertEqual(releasedRows[0]?.status, 'SENT', 'the held message must be released, not lost');

      return `held until ${heldRows[0]?.scheduledFor?.toISOString() ?? ''} · drain claimed ${drained.claimed}, sent ${drained.sent}`;
    })

    .step('The inbox lists every thread with its window and consent state', async () => {
      const list = await conversationRepo.list(DEMO_SHOP_ID);
      assert(list.threads.length >= 3, 'the demo opened at least three threads');

      const group = list.threads.find((thread) => thread.kind === 'STAFF_GROUP');
      assert(group !== undefined, 'the workshop group must appear in the inbox');
      assertEqual(group.windowOpen, true, 'the staff group has no customer-service window');

      const customerThread = list.threads.find((thread) => thread.id === customerConversationId);
      assert(customerThread !== undefined, 'the customer thread must appear');
      assert(
        !customerThread.addressMasked.includes(STRANGER_PHONE.slice(-6)),
        'the inbox must not print a full phone number',
      );

      return `${list.threads.length} threads · ${list.unreadTotal} unread · group window always open`;
    })

    .step('The board shows the confirmed card and its audit chain verifies', async () => {
      const verification = await audit.verifyChain(DEMO_SHOP_ID);
      assert(verification.valid, `audit chain broken: ${verification.reason ?? 'unknown'}`);

      const drafts = await intakeRepo.list(DEMO_SHOP_ID, { status: 'CONFIRMED' });
      assert(
        drafts.drafts.some((draft) => draft.jobCardId === photoJobCardId),
        'the confirmed draft must point at the card it became',
      );

      return `chain valid over ${verification.entriesChecked} entries · card ${photoJobCardId.slice(0, 8)}… from draft ${photoDraftId.slice(0, 8)}…`;
    });

  runner.onTeardown(async () => {
    // Whatever happened above, the shop must not be left mute.
    await guardrails
      .validateAndPatch(
        DEMO_SHOP_ID,
        { quietHours: quietHoursAwayFromNow() },
        { type: 'STAFF', id: DEMO_ADVISOR.id },
        TRACE,
      )
      .catch(() => undefined);

    await redis.quit();
    await database.close();
  });

  process.exitCode = await runner.run();
}

/**
 * `HH:MM` on the shop's own clock, offset by some minutes.
 *
 * Quiet hours are wall-clock times in an IANA zone, so a demo that wants a
 * window around "now" has to ask what time it is *there* — computing it from
 * the process's local zone would pass in Chennai and fail in CI.
 */
function shopClockHm(at: Date, timezone: string, offsetMinutes: number): string {
  const shifted = new Date(at.getTime() + offsetMinutes * 60_000);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(shifted);

  const hour = parts.find((part) => part.type === 'hour')?.value ?? '00';
  const minute = parts.find((part) => part.type === 'minute')?.value ?? '00';
  return `${hour === '24' ? '00' : hour}:${minute}`;
}

/**
 * A silent WAV of the requested length.
 *
 * `MockSpeechAdapter` reads the real duration off the RIFF header, so the
 * fixture has to be a genuine WAV rather than arbitrary bytes — a transcript
 * whose segments run past the end of the audio is a bug worth catching here.
 */
function wavBytes(seconds: number): Buffer {
  const sampleRate = 16_000;
  const samples = Math.floor(sampleRate * seconds);
  const dataBytes = samples * 2;
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);

  // A faint tone rather than digital silence: some decoders discard an
  // all-zero stream, and the point is to exercise the real path.
  for (let index = 0; index < samples; index += 1) {
    buffer.writeInt16LE(Math.round(Math.sin(index / 40) * 120), 44 + index * 2);
  }
  return buffer;
}

main().catch((error: unknown) => {
  console.error('\n[demo:phase2] the scenario crashed before it could finish');
  console.error(error);
  process.exit(1);
});
