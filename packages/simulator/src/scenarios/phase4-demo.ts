import {
  AdapterDraftExtraction,
  createMediaPipeline,
  createStoragePort,
  FixtureOcrAdapter,
  HeuristicStatusSignalParser,
  LlmTextDraftExtractor,
  MockPaymentsAdapter,
  MockSpeechAdapter,
  QrPngRenderer,
  ReactPdfInvoiceRenderer,
  SandboxLlmAdapter,
  SandboxWhatsAppAdapter,
  toInboundMessage,
  VoiceNoteDraftExtractor,
  WhatsAppChannelSender,
  WhatsAppMediaFetcher,
  type InboundEvent,
} from '@serviceloop/adapters';
import { createLoopRuntime, type LoopRuntime } from '@serviceloop/agent-core';
import { formatAdapterSelection, getEnv } from '@serviceloop/config';
import {
  AuditService,
  blindIndex,
  createDatabase,
  DEMO_SHOP_ID,
  decryptPii,
  OutboxService,
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
  CONSENT_ACTION_IDS,
  ConsentCaptureService,
  ConsentService,
  ConversationSessionService,
  EntityResolutionService,
  GuardrailService,
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
  type InboundOutcome,
} from '@serviceloop/domain';
import { formatPaise, uuidv7 } from '@serviceloop/shared';
import { sql } from 'drizzle-orm';
import IORedis from 'ioredis';
import { assert, assertEqual, ScenarioRunner } from '../runner';

/**
 * `pnpm demo:phase4`
 *
 * The middle and the end of the loop, in one continuous run against the **real
 * database**: a technician's five-second voice note moves a customer's job
 * card, the ETA slips and the customer is told why before they ask, the car is
 * announced ready with pickup times, the invoice is rendered with its evidence
 * appendix, a UPI payment arrives as a signed webhook, and a gate pass lets the
 * vehicle out exactly once.
 *
 * Two properties this demo has that the unit suites cannot:
 *
 *   - **Nothing is called directly that a message would have called.** The
 *     technician's note goes in through `SandboxWhatsAppAdapter` and comes out
 *     of `InboundHandler`; the payment arrives as bytes with a signature and
 *     travels the same verify → parse → reconcile path a real delivery takes.
 *     A demo that called `reconcile` itself would prove the reconcile service
 *     works and prove nothing about the endpoint.
 *   - **It is the phase-4 Postgres stores under test.** Every other suite
 *     replaces them with a double.
 */

const TRACE = `demo-phase4-${uuidv7().slice(0, 8)}`;
const STAFF_GROUP_ID = '120363000000000044';

/** Fresh numbers every run, so repeated demos never collide on a thread. */
const CUSTOMER_PHONE = `+9195${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`;

/**
 * The four digits the technician actually says out loud.
 *
 * Random per run, and that is not decoration. A fixed suffix means the second
 * demo run finds two open cards ending in the same four digits and the resolver
 * correctly refuses to guess between them — the guardrail working, and a demo
 * that fails for the right reason is still a demo that fails.
 */
const PLATE_SUFFIX = String(Math.floor(1000 + Math.random() * 8999));

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
  const speech = new MockSpeechAdapter();
  const llm = new SandboxLlmAdapter();
  const payments = new MockPaymentsAdapter({ webhookSecret: 'demo-phase4-secret' });
  const textExtractor = new LlmTextDraftExtractor(llm);

  /* --------------------------------------------------------------- domain */

  const conversations = new PgConversationStore();
  const messages = new PgMessageStore();
  const customers = new PgCustomerLookup();

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

  const jobCards = new JobCardTransitionService<Tx>({
    uow,
    cards: new PgJobCardStore(),
    config: configStore,
    audit,
    outbox,
  });
  const workItems = new WorkItemTransitionService<Tx>({
    uow,
    items: new PgWorkItemStore(),
    audit,
    outbox,
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
    // Deterministic, because the sandbox model cannot read a technician's
    // Tamil — the same choice the API and the worker make in DEMO_MODE.
    parser: new HeuristicStatusSignalParser(),
    speech,
    gatePassSecret: () => env.GATE_PASS_SECRET,
    amountDue,
    customerPhone,
    // The same read the API and the worker do: an erased object resolves to
    // null and the appendix prints a labelled placeholder rather than the
    // document disagreeing with itself about how many things were photographed.
    loadThumbnails: (tx, shopId, mediaIds) => loadThumbnails(storage, tx, shopId, mediaIds),
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

  const consents = new ConsentService<Tx>({
    uow,
    consents: new PgConsentStore(),
    audit,
    outbox,
  });

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
        new FixtureOcrAdapter(),
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
    // The join this phase exists to make: a staff-group note becomes a status
    // signal, and the pickup-slot tap comes back to the delivery service.
    technicianNotes: loop.notes,
    slots: loop.delivery,
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

  /* ---------------------------------------------------------- scenario -- */

  let jobCardId = '';
  let jobCardCode = '';
  let customerId = '';
  let registration = '';
  let conversationId = '';
  let brakesItemId = '';
  let oilItemId = '';
  let technicianId = '';
  let pendingSignalId = '';
  let bookingId = '';
  let invoiceMediaId: string | null = null;
  let paymentLinkId = '';
  let gatePassCode = '';
  let gatePassToken = '';
  let webhook: { rawBody: Buffer; headers: Readonly<Record<string, string>> } | null = null;
  let originalConfig: unknown = null;
  let totalPaise = 0;

  /** Pushes an injected WhatsApp message through the full production path. */
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

  const runner = new ScenarioRunner(
    'ServiceLoop — phase 4 acceptance demo',
    'voice note → transition → proactive update → ready → slot → invoice → UPI → gate pass',
  );

  for (const line of formatAdapterSelection(env)) {
    process.stdout.write(`  ${line}\n`);
  }

  runner
    .step('The shop is configured for the end of the loop', async () => {
      const stored = await db.execute<{ config: unknown }>(sql`
        select config from shop_config where shop_id = ${DEMO_SHOP_ID}
      `);
      originalConfig = stored.rows[0]?.config ?? null;

      // Quiet hours moved away from *now*, and working hours opened wide. The
      // deferral rules have their own suites; a demo that could only be run
      // between nine and seven would look broken at eight in the evening while
      // every guardrail was working exactly as designed.
      const patched = await describeValidation(() =>
        guardrails.validateAndPatch(
        DEMO_SHOP_ID,
        {
          // Both halves of the loop's second act: status updates and the
          // delivery flow are templated copy from the reviewed catalogue, which
          // is exactly what L1 means (master §6).
          autonomy: { status: 'L1_TEMPLATED', delivery: 'L1_TEMPLATED' },
          quietHours: quietHoursAwayFromNow(env.DEFAULT_TIMEZONE),
          workingHours: { days: [0, 1, 2, 3, 4, 5, 6], open: '00:00', close: '23:59' },
          messaging: { staffGroupId: STAFF_GROUP_ID },
          // A tax document cannot be printed with a placeholder on it, so the
          // invoice service refuses until an owner has filled these in.
          invoice: {
            legalName: 'Sri Murugan Auto Works Private Limited',
            gstin: '33AABCS1429B1Z1',
            addressLines: ['14 Nelson Manickam Road', 'Aminjikarai, Chennai 600029'],
            stateCode: '33',
            numberPrefix: 'INV',
          },
          frequencyCaps: { maxOutboundPerCustomerPerDay: 20, minMinutesBetweenMessages: 0 },
        },
        { type: 'STAFF', id: null },
        TRACE,
        ),
      );

      assertEqual(patched.config.autonomy.status, 'L1_TEMPLATED', 'status must be at L1');
      assertEqual(patched.config.autonomy.delivery, 'L1_TEMPLATED', 'delivery must be at L1');
      return `status + delivery L1 · staff group ${STAFF_GROUP_ID} · GSTIN ${patched.config.invoice.gstin ?? ''}`;
    })

    .step('A card is driven to IN_PROGRESS with approved work and a promise', async () => {
      const created = await createDemoCard(db, jobCards, workItems);
      jobCardId = created.jobCardId;
      jobCardCode = created.code;
      customerId = created.customerId;
      registration = created.registration;
      brakesItemId = created.brakesItemId;
      oilItemId = created.oilItemId;
      technicianId = created.technicianId;
      totalPaise = created.totalPaise;

      assert(registration.endsWith(PLATE_SUFFIX), 'the demo plate must end in the spoken fragment');

      // The photograph the caliper line was approved on. It is what turns that
      // line into "additional work" and what the invoice's evidence appendix
      // prints beside it — a customer asked to pay for a caliper gets the
      // picture of the caliper on the same document.
      const ingested = await mediaService.ingestInbound({
        shopId: DEMO_SHOP_ID,
        jobCardId,
        bytes: await evidencePhoto(),
        declaredContentType: 'image/png',
        filename: 'caliper.png',
        caption: 'Seized front caliper, before removal',
        origin: 'INBOUND_WHATSAPP',
        actor: { type: 'STAFF', id: technicianId },
        traceId: TRACE,
      });
      assert(ingested.ok, 'the evidence photo was refused');
      if (ingested.ok) {
        await db.execute(sql`
          update media_assets set work_item_id = ${brakesItemId} where id = ${ingested.asset.id}
        `);
      }

      return `${jobCardCode} · ${registration} · ${formatPaise(totalPaise)} approved · 1 evidence photo`;
    })

    .step('The shop opens the thread by disclosing the AI and asking permission', async () => {
      conversationId = await openThread(db, customerId);

      // The real first-contact path, not a consent row written by hand. It
      // matters here because *every* proactive message this demo goes on to
      // send is subject to the disclosure rule, and a demo that inserted
      // consent directly would have skipped the one message that satisfies it.
      const opened = await firstContact.openFirstContact({
        shopId: DEMO_SHOP_ID,
        customerId,
        conversationId,
        customerName: 'Lakshmi',
        vehicleLabel: `Maruti Swift ${registration}`,
        actor: { type: 'SYSTEM', id: null },
        traceId: TRACE,
      });

      assert(opened.sent, 'the first-contact message was not sent');
      assertEqual(opened.outcome.status, 'SENT', 'the consent ask did not leave');

      const body = await lastOutboundBody(db, conversationId);
      assert(
        /assistant|AI|உதவியாளர்|सहायक/i.test(body),
        'the first message must disclose that a machine is writing',
      );

      // The customer taps Yes, through the same inbound path a real tap takes.
      await deliver({
        kind: 'button_reply',
        from: CUSTOMER_PHONE,
        replyId: CONSENT_ACTION_IDS.grantService,
        title: 'Yes',
      });

      const state = await firstContact.state(DEMO_SHOP_ID, customerId);
      assertEqual(state.service?.status ?? null, 'GRANTED', 'the tap must record SERVICE consent');

      return `thread ${conversationId.slice(0, 8)}… · disclosure sent · SERVICE granted`;
    })

    .step('Approving the work sets an ETA the customer can be held to', async () => {
      const result = await loop.eta.recalculate({
        shopId: DEMO_SHOP_ID,
        jobCardId,
        reason: 'WORK_APPROVED',
        actor: { type: 'STAFF', id: null },
        traceId: TRACE,
      });

      assert(result.ok, `ETA refused: ${result.ok ? '' : result.reason}`);
      if (!result.ok) return '';

      assertEqual(result.entry.version, 1, 'the first ETA entry must be version 1');
      return `v1 ${result.entry.eta.toISOString()} · ${result.entry.detail}`;
    })

    .step('A technician sends five seconds of Tamil-English into the staff group', async () => {
      const audio = wavBytes(4.5);
      speech.register(audio, {
        // The phase's own example, with the plate the technician actually says.
        text: `caliper open irukku ${PLATE_SUFFIX}, part varum 4 maniku`,
        language: 'ta',
        confidence: 0.94,
      });

      const outcome = await deliver({
        kind: 'media',
        from: DEMO_TECHNICIAN_PHONE,
        displayName: 'Suresh',
        groupId: STAFF_GROUP_ID,
        mediaKind: 'AUDIO',
        bytes: audio,
        contentType: 'audio/wav',
        isVoiceNote: true,
        filename: 'note.wav',
      });

      const status = outcome.trace.find((step) => step.stage === 'status');
      assert(status !== undefined, 'the note must reach the status sentinel');
      assert(
        (status?.detail ?? '').includes('AUTO_APPLIED'),
        `the note should have applied itself: ${status?.detail ?? ''}`,
      );
      // Not an intake. A note about a car already in the workshop must not open
      // a second job card for it.
      assert(outcome.draftId === null, 'a status note must not produce a job-card draft');

      const state = await cardState(db, jobCardId);
      assertEqual(state, 'AWAITING_PARTS', 'blocked_parts must move the card');

      return `${status?.detail ?? ''} · card now ${state}`;
    })

    .step('The slip is material, so the customer hears it before they ask', async () => {
      const entry = await loop.eta.latest(DEMO_SHOP_ID, jobCardId);
      assert(entry !== null, 'the blocked note must have moved the ETA');
      if (entry === null) return '';

      assertEqual(entry.reason, 'BLOCKED_PARTS', 'the reason must name the part, not just a time');
      assertEqual(entry.materiality, 'MATERIAL_SLIP', 'a parts block is a material slip');

      const result = await loop.comms.announceEtaChange({
        shopId: DEMO_SHOP_ID,
        entry,
        actor: { type: 'SYSTEM', id: null },
        traceId: TRACE,
      });

      assert(result.sent, `the delay notice was not sent: ${result.reason}`);
      const body = await lastOutboundBody(db, conversationId);
      assert(body.length > 0, 'the customer received nothing');

      return `v${entry.version} +${entry.deltaMinutes}min · "${body.slice(0, 70)}…"`;
    })

    .step('A note the recogniser struggled with asks an advisor instead of guessing', async () => {
      // The same words, heard badly. A compressor running two bays away is the
      // ordinary case, and the recogniser's doubt is multiplied into the parse
      // — which is what drops this below the auto-apply bar and sends it to a
      // human rather than to a customer's job card.
      const noisy = wavBytes(3.5);
      speech.register(noisy, {
        text: `${PLATE_SUFFIX} caliper work mudinjidhu`,
        language: 'ta',
        confidence: 0.62,
      });

      const outcome = await deliver({
        kind: 'media',
        from: DEMO_TECHNICIAN_PHONE,
        groupId: STAFF_GROUP_ID,
        mediaKind: 'AUDIO',
        bytes: noisy,
        contentType: 'audio/wav',
        isVoiceNote: true,
        filename: 'noisy.wav',
      });

      const status = outcome.trace.find((step) => step.stage === 'status');
      assert(
        (status?.detail ?? '').includes('PENDING_CONFIRMATION'),
        `a fragment must ask a human: ${status?.detail ?? ''}`,
      );

      const pending = await loop.signals.pendingWithCards(DEMO_SHOP_ID, 10);
      const mine = pending.signals.find((signal) => signal.jobCardId === jobCardId);
      assert(mine !== undefined, 'the signal must be in the confirm queue');
      pendingSignalId = mine?.id ?? '';

      const card = pending.cards.get(jobCardId);
      assert(card !== undefined, 'the queue must be able to name the vehicle');

      return `signal ${pendingSignalId.slice(0, 8)}… on ${card?.registration ?? ''} at ${Math.round((mine?.confidence ?? 0) * 100)}%`;
    })

    .step('The advisor taps ✅ and the work item closes', async () => {
      // The part arrived, so the card is back in progress before the tap.
      await jobCards.transition({
        shopId: DEMO_SHOP_ID,
        jobCardId,
        event: 'PARTS_RECEIVED',
        actor: { type: 'STAFF', id: technicianId },
        traceId: TRACE,
      });

      const outcome = await loop.signals.confirm({
        shopId: DEMO_SHOP_ID,
        signalId: pendingSignalId,
        staffId: technicianId,
        actor: { type: 'STAFF', id: technicianId },
        traceId: TRACE,
      });

      assert(outcome.workItemIds.length > 0, `the tap closed nothing: ${outcome.detail}`);
      const done = await itemState(db, outcome.workItemIds[0] ?? '');
      assertEqual(done, 'DONE', 'the confirmed item must be DONE');

      return `${outcome.route} · ${outcome.workItemIds.length} item(s) · ${outcome.detail}`;
    })

    .step('The rest of the work finishes and the card reaches READY_FOR_DELIVERY', async () => {
      for (const itemId of [brakesItemId, oilItemId]) {
        const state = await itemState(db, itemId);
        if (state === 'APPROVED' || state === 'IN_PROGRESS') {
          if (state === 'APPROVED') {
            await workItems.transition({
              shopId: DEMO_SHOP_ID,
              workItemId: itemId,
              event: 'START',
              actor: { type: 'STAFF', id: technicianId },
              traceId: TRACE,
            });
          }
          await workItems.transition({
            shopId: DEMO_SHOP_ID,
            workItemId: itemId,
            event: 'COMPLETE',
            actor: { type: 'STAFF', id: technicianId },
            traceId: TRACE,
          });
        }
      }

      for (const event of ['WORK_COMPLETED', 'QUALITY_PASSED'] as const) {
        await jobCards.transition({
          shopId: DEMO_SHOP_ID,
          jobCardId,
          event,
          actor: { type: 'STAFF', id: technicianId },
          traceId: TRACE,
        });
      }

      const state = await cardState(db, jobCardId);
      assertEqual(state, 'READY_FOR_DELIVERY', 'the card must be ready');
      return `card ${state}`;
    })

    .step('The ready message offers three pickup times inside the shop’s hours', async () => {
      const result = await loop.delivery.announceReady({
        shopId: DEMO_SHOP_ID,
        jobCardId,
        actor: { type: 'STAFF', id: null },
        traceId: TRACE,
      });

      assert(result.ok, `ready refused: ${result.ok ? '' : result.reason}`);
      if (!result.ok) return '';

      bookingId = result.bookingId;
      assert(result.offeredSlots.length > 0, 'the customer was offered no times');
      assertEqual(result.gateStatus, 'SENT', 'the ready message did not leave');

      return `${result.offeredSlots.length} slot(s) · ${formatPaise(result.amountDuePaise)} due · booking ${bookingId.slice(0, 8)}…`;
    })

    .step('The customer taps a time, and it is booked once', async () => {
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
      assert(booking !== null, 'the booking vanished');
      assert(booking?.slotStart !== null, 'the tap did not book a slot');
      assertEqual(booking?.status, 'CHOSEN', 'the booking must be CHOSEN');

      return `${booking?.slotStart?.toISOString() ?? ''} via ${booking?.chosenVia ?? ''}`;
    })

    .step('The invoice is issued with GST and its evidence appendix', async () => {
      const result = await loop.invoices.issue({
        shopId: DEMO_SHOP_ID,
        jobCardId,
        placeOfSupplyStateCode: '33',
        actor: { type: 'STAFF', id: null },
        traceId: TRACE,
      });

      assert(result.ok, `invoice refused: ${result.ok ? '' : result.reason}`);
      if (!result.ok) return '';

      invoiceMediaId = result.mediaId;
      assert(result.number.startsWith('INV'), 'the invoice must carry the shop’s series');
      assert(result.evidenceBlocks > 0, 'the approved caliper line must carry its photograph');
      assert(invoiceMediaId !== null, 'the invoice PDF was not rendered');

      const invoice = await loop.invoices.forCard(DEMO_SHOP_ID, jobCardId);
      assert(invoice !== null, 'the invoice is not readable back');
      const taxPaise =
        (invoice?.cgstPaise ?? 0) + (invoice?.sgstPaise ?? 0) + (invoice?.igstPaise ?? 0);
      assertEqual(
        (invoice?.subtotalPaise ?? 0) + taxPaise,
        invoice?.totalPaise ?? -1,
        'subtotal + tax must equal the total',
      );
      // Intra-state supply: the tax splits between centre and state, and none
      // of it is IGST.
      assertEqual(invoice?.igstPaise ?? -1, 0, 'an intra-state invoice carries no IGST');
      assert((invoice?.cgstPaise ?? 0) > 0, 'CGST must be charged on an intra-state supply');
      assertEqual(
        invoice?.cgstPaise ?? -1,
        invoice?.sgstPaise ?? -2,
        'CGST and SGST must be equal halves',
      );

      // Re-issuing must not mint a second number for one visit.
      const again = await loop.invoices.issue({
        shopId: DEMO_SHOP_ID,
        jobCardId,
        placeOfSupplyStateCode: '33',
        actor: { type: 'STAFF', id: null },
        traceId: TRACE,
      });
      assert(again.ok && again.alreadyIssued, 'a second issue must return the same invoice');

      return `${result.number} · ${formatPaise(result.totalPaise)} · pdf ${invoiceMediaId === null ? 'unrendered' : invoiceMediaId.slice(0, 8) + '…'} · ${result.evidenceBlocks} evidence block(s)`;
    })

    .step('A payment link is created once, however many times the button is pressed', async () => {
      const first = await loop.payments.createLink({
        shopId: DEMO_SHOP_ID,
        jobCardId,
        actor: { type: 'STAFF', id: null },
        traceId: TRACE,
      });
      assert(first.ok, `link refused: ${first.ok ? '' : first.reason}`);
      if (!first.ok) return '';

      const second = await loop.payments.createLink({
        shopId: DEMO_SHOP_ID,
        jobCardId,
        actor: { type: 'STAFF', id: null },
        traceId: TRACE,
      });
      assert(second.ok && second.reused, 'a second press must re-use the live link');

      const payment = await loop.payments.openForCard(DEMO_SHOP_ID, jobCardId);
      paymentLinkId = payment?.providerPaymentLinkId ?? '';
      assert(paymentLinkId.length > 0, 'the provider link id was not stored');

      return `${first.shortUrl} · ${formatPaise(first.amountPaise)}`;
    })

    .step('A tampered webhook is refused before anything is read', async () => {
      // The customer's real payment, simulated once. The same bytes are
      // presented twice: here with the signature broken, and in the next step
      // untouched — so the only difference between "refused" and "applied" is
      // the signature, which is the property that matters.
      webhook = payments.simulate({
        providerPaymentLinkId: paymentLinkId,
        outcome: 'success',
        method: 'UPI',
      });

      const verdict = payments.parseWebhook({
        rawBody: webhook.rawBody,
        headers: { ...webhook.headers, 'x-razorpay-signature': 'deadbeef' },
      });

      assert(!verdict.ok, 'a forged signature must be refused');
      assertEqual(verdict.ok ? '' : verdict.code, 'BAD_SIGNATURE', 'the refusal must name why');
      return 'forged signature refused, no row touched';
    })

    .step('The customer pays by UPI and the same delivery is applied once', async () => {
      assert(webhook !== null, 'the previous step produced no webhook to replay');
      const verdict = payments.parseWebhook(webhook as NonNullable<typeof webhook>);
      assert(verdict.ok, 'the signed webhook must verify');
      if (!verdict.ok || verdict.event === null) return '';

      const applied = await loop.payments.reconcile({
        event: verdict.event,
        actor: { type: 'SYSTEM', id: null },
        traceId: TRACE,
      });
      assert(applied.handled, `reconcile refused: ${applied.detail}`);
      assertEqual(applied.status, 'PAID', 'the payment must be settled');

      // Razorpay retries anything it did not see a 200 for.
      const retry = await loop.payments.reconcile({
        event: verdict.event,
        actor: { type: 'SYSTEM', id: null },
        traceId: TRACE,
      });
      assert(retry.duplicate, 'a redelivered webhook must not credit the payment twice');

      const state = await cardState(db, jobCardId);
      // A fully paid card must not be left in AWAITING_PAYMENT: that is the one
      // state meaning "still owed", and the balance ladder reads it.
      assertEqual(state, 'DELIVERED', 'a settled card must leave AWAITING_PAYMENT');

      return `${formatPaise(applied.amountPaidPaise)} paid · balance ${formatPaise(applied.balancePaise)} · card ${state}`;
    })

    .step('A gate pass is issued with a scannable QR and a six-character code', async () => {
      const result = await loop.gatePasses.issue({
        shopId: DEMO_SHOP_ID,
        jobCardId,
        actor: { type: 'STAFF', id: null },
        traceId: TRACE,
      });

      assert(result.ok, `gate pass refused: ${result.ok ? '' : result.reason}`);
      if (!result.ok) return '';

      gatePassCode = result.code;
      gatePassToken = result.token;
      assert(/^[23467ACDEFGHJKMNPQRTUVWXYZ]{6}$/.test(gatePassCode), 'the code must be readable');

      const sent = await lastOutboundKind(db, conversationId);
      assertEqual(sent, 'IMAGE', 'the customer must receive the QR, not only the code');

      return `${gatePassCode} · expires ${result.expiresAt.toISOString()} · QR sent`;
    })

    .step('A forged token is rejected at the gate', async () => {
      const forged = `${gatePassToken.slice(0, -4)}0000`;
      const verdict = await loop.gatePasses.verify({
        shopId: DEMO_SHOP_ID,
        token: forged,
        code: null,
        staffId: technicianId,
        actor: { type: 'STAFF', id: technicianId },
        traceId: TRACE,
      });

      assert(verdict.result !== 'VALID', 'a forged token must not open the barrier');
      return `${verdict.result}: ${verdict.detail}`;
    })

    .step('The real pass opens the barrier once, and only once', async () => {
      const first = await loop.gatePasses.verify({
        shopId: DEMO_SHOP_ID,
        token: null,
        code: gatePassCode,
        staffId: technicianId,
        actor: { type: 'STAFF', id: technicianId },
        traceId: TRACE,
      });

      assertEqual(first.result, 'VALID', `the pass was refused: ${first.detail}`);
      assert(first.summary !== null, 'the gate person needs the vehicle on screen');
      assertEqual(
        first.summary?.registration,
        registration,
        'the summary must name the vehicle at the barrier',
      );

      const second = await loop.gatePasses.verify({
        shopId: DEMO_SHOP_ID,
        token: null,
        code: gatePassCode,
        staffId: technicianId,
        actor: { type: 'STAFF', id: technicianId },
        traceId: TRACE,
      });
      assertEqual(second.result, 'ALREADY_USED', 'a pass must work exactly once');

      return `VALID for ${first.summary?.registration ?? ''} · second attempt ${second.result}`;
    })

    .step('Every step of it is on the hash-chained audit trail', async () => {
      const verification = await audit.verifyChain(DEMO_SHOP_ID);
      assert(verification.valid, `the audit chain broke at ${verification.brokenAtIndex}`);

      const actions = await db.execute<{ action: string }>(sql`
        select distinct action from audit_events
        where shop_id = ${DEMO_SHOP_ID} and trace_id = ${TRACE}
        order by action
      `);
      const seen = actions.rows.map((row) => row.action);

      for (const required of [
        'status_signal.captured',
        'eta.recalculated',
        'invoice.issued',
        'payment.recorded',
        'gate_pass.issued',
        'gate_pass.verified',
      ]) {
        assert(seen.includes(required), `the trail is missing ${required}`);
      }

      return `${verification.entriesChecked} entries verified · ${seen.length} distinct actions this run`;
    })

    .onTeardown(async () => {
      if (originalConfig !== null) {
        await db.execute(sql`
          update shop_config
          set config = ${JSON.stringify(originalConfig)}::jsonb, updated_at = now()
          where shop_id = ${DEMO_SHOP_ID}
        `);
      }
      await redis.quit();
      await database.close();
    });

  const code = await runner.run();
  process.exit(code);
}

/* ---------------------------------------------------------------- helpers -- */

/** Thumbnails for the appendix, read from object storage exactly as the API does. */
async function loadThumbnails(
  storage: { get(key: string): Promise<{ body: Buffer }> },
  tx: Tx,
  shopId: string,
  mediaIds: readonly string[],
): Promise<ReadonlyMap<string, Buffer | null>> {
  const thumbnails = new Map<string, Buffer | null>();
  if (mediaIds.length === 0) return thumbnails;

  const result = await tx.execute<{
    id: string;
    thumbnail_key: string | null;
    storage_key: string;
  }>(sql`
    select id, thumbnail_key, storage_key from media_assets
    where shop_id = ${shopId} and deleted_at is null
      and id in (${sql.join(
        mediaIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
  `);

  for (const row of result.rows) {
    try {
      const object = await storage.get(row.thumbnail_key ?? row.storage_key);
      thumbnails.set(row.id, object.body);
    } catch {
      thumbnails.set(row.id, null);
    }
  }
  return thumbnails;
}

/** A small real PNG, so the media pipeline has something it can actually read. */
async function evidencePhoto(): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  return sharp({
    create: { width: 320, height: 240, channels: 3, background: { r: 90, g: 90, b: 96 } },
  })
    .png()
    .toBuffer();
}

/**
 * Re-throws a guardrail refusal with the field that caused it.
 *
 * A bare "configuration patch rejected" sends whoever runs this demo reading
 * the whole schema; naming the path turns it into a one-line fix.
 */
async function describeValidation<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const details = (error as { details?: { fieldErrors?: { path: string; message: string }[] } })
      .details;
    const fields = details?.fieldErrors ?? [];
    if (fields.length === 0) throw error;
    throw new Error(
      `guardrail patch refused: ${fields.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`,
    );
  }
}

/** The seeded technician, who is the one sending the notes. */
const DEMO_TECHNICIAN_PHONE = '+919840012003';

async function cardState(db: Database, jobCardId: string): Promise<string> {
  const result = await db.execute<{ state: string }>(sql`
    select state::text as state from job_cards where id = ${jobCardId}
  `);
  return result.rows[0]?.state ?? 'UNKNOWN';
}

async function itemState(db: Database, workItemId: string): Promise<string> {
  const result = await db.execute<{ state: string }>(sql`
    select state::text as state from work_items where id = ${workItemId}
  `);
  return result.rows[0]?.state ?? 'UNKNOWN';
}

async function lastOutboundBody(db: Database, conversationId: string): Promise<string> {
  const rows = await db.execute<{ body: string }>(sql`
    select body from messages
    where conversation_id = ${conversationId}
      and direction = 'OUTBOUND'
      and status in ('SENT', 'DELIVERED', 'READ')
    order by created_at desc
    limit 1
  `);
  return rows.rows[0]?.body ?? '';
}

async function lastOutboundKind(db: Database, conversationId: string): Promise<string> {
  const rows = await db.execute<{ kind: string }>(sql`
    select kind::text as kind from messages
    where conversation_id = ${conversationId}
      and direction = 'OUTBOUND'
      and status in ('SENT', 'DELIVERED', 'READ')
    order by created_at desc
    limit 1
  `);
  return rows.rows[0]?.kind ?? 'UNKNOWN';
}

/** What the customer owes, the same read the API and the worker use. */
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

  const estimate = await tx.execute<{ total_paise: string | number }>(sql`
    select total_paise from estimates
    where shop_id = ${shopId} and job_card_id = ${jobCardId} and status in ('ACCEPTED', 'SENT')
    order by version desc limit 1
  `);
  return Number(estimate.rows[0]?.total_paise ?? 0);
}

async function customerPhone(tx: Tx, shopId: string, customerId: string): Promise<string | null> {
  const result = await tx.execute<{ phone_encrypted: string }>(sql`
    select phone_encrypted from customers where shop_id = ${shopId} and id = ${customerId}
  `);
  const encrypted = result.rows[0]?.phone_encrypted;
  return encrypted === undefined ? null : decryptPii(encrypted);
}

/**
 * A one-hour quiet window that does not contain the current local time.
 *
 * The quiet-hours rule is proved by phase 2's demo and by the gate's own tests;
 * this exists so phase 4 can be run at 22:00 without appearing to be broken.
 */
function quietHoursAwayFromNow(timezone: string): {
  timezone: string;
  start: string;
  end: string;
} {
  const local = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    hour12: false,
  }).format(new Date());

  const hour = Number(local.slice(0, 2));
  const pad = (value: number): string => String(value).padStart(2, '0');
  return { timezone, start: `${pad((hour + 2) % 24)}:00`, end: `${pad((hour + 3) % 24)}:00` };
}

/** A silent 16 kHz mono WAV of the given length, as a voice note stands in. */
function wavBytes(seconds: number): Buffer {
  const sampleRate = 16_000;
  const samples = Math.round(sampleRate * seconds);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + samples * 2, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(samples * 2, 40);
  // A distinct tail per run, so the fixture hash never collides between demos.
  const body = Buffer.alloc(samples * 2);
  body.write(uuidv7(), 0, 'utf8');
  return Buffer.concat([header, body]);
}

/**
 * The demo's own customer, vehicle and job card, driven to IN_PROGRESS.
 *
 * Created rather than borrowed, for the reason phase 3's demo creates its own:
 * a demo that consumed a seeded card would hit the shop's frequency cap on the
 * customer it had already messaged, and would look broken while the guardrail
 * was working exactly as intended.
 *
 * The registration ends in the fragment the technician says out loud, because
 * that is the whole point — a technician shouts "4432", never a job-card id.
 */
async function createDemoCard(
  db: Database,
  jobCards: JobCardTransitionService<Tx>,
  workItems: WorkItemTransitionService<Tx>,
): Promise<{
  jobCardId: string;
  code: string;
  customerId: string;
  registration: string;
  brakesItemId: string;
  oilItemId: string;
  technicianId: string;
  totalPaise: number;
}> {
  const suffix = uuidv7().slice(-4).toUpperCase().replace(/[^A-Z]/g, 'K').padEnd(2, 'K').slice(0, 2);
  const customerId = uuidv7();
  const vehicleId = uuidv7();
  const jobCardId = uuidv7();
  const estimateId = uuidv7();
  const brakesItemId = uuidv7();
  const oilItemId = uuidv7();
  const code = `JC-DEMO4-${uuidv7().slice(-4).toUpperCase()}`;
  const registration = `TN09${suffix}${PLATE_SUFFIX}`;

  const BRAKES_PAISE = 320_000;
  const OIL_PAISE = 160_000;
  const totalPaise = BRAKES_PAISE + OIL_PAISE;

  const technician = await db.execute<{ id: string }>(sql`
    select id from staff
    where shop_id = ${DEMO_SHOP_ID} and role = 'TECHNICIAN' and deleted_at is null
    order by created_at asc limit 1
  `);
  const technicianId = technician.rows[0]?.id ?? null;
  if (technicianId === null) throw new Error('the seed has no technician to send the note');

  await db.insert(schema.customers).values({
    id: customerId,
    shopId: DEMO_SHOP_ID,
    fullNameEncrypted: 'Lakshmi Narayanan',
    phoneEncrypted: CUSTOMER_PHONE,
    phoneHash: blindIndex(DEMO_SHOP_ID, CUSTOMER_PHONE),
    preferredLanguage: 'en',
    whatsappOptIn: true,
  });

  await db.insert(schema.vehicles).values({
    id: vehicleId,
    shopId: DEMO_SHOP_ID,
    customerId,
    registrationRaw: registration,
    registrationNormalised: registration,
    make: 'Maruti Suzuki',
    model: 'Swift',
    odometerKm: 58_400,
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
    odometerKm: 58_400,
    assignedTechnicianId: technicianId,
    // What the customer was told at the counter. It never moves; the ETA
    // history carries every change since.
    promisedAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
  });

  await db.insert(schema.workItems).values([
    {
      id: brakesItemId,
      shopId: DEMO_SHOP_ID,
      jobCardId,
      title: 'Front brake caliper and pads',
      state: 'PENDING_APPROVAL',
      requiresApproval: true,
      technicianNote: 'Caliper seized, pads worn to 2.1mm.',
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

  // Inserted as a DRAFT and accepted after its lines exist: an accepted
  // estimate's lines are immutable, enforced by a trigger, and inserting the
  // lines under an ACCEPTED header is refused by the database — which is the
  // guardrail working, in a demo that has to work with it rather than around it.
  await db.insert(schema.estimates).values({
    id: estimateId,
    shopId: DEMO_SHOP_ID,
    jobCardId,
    version: 1,
    status: 'DRAFT',
    subtotalPaise: totalPaise,
    totalPaise,
  });

  await db.insert(schema.estimateLines).values([
    {
      id: uuidv7(),
      shopId: DEMO_SHOP_ID,
      estimateId,
      workItemId: brakesItemId,
      kind: 'PART',
      description: 'Front brake caliper (rebuilt) and pads',
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

  // Driven, not inserted: the audit chain and the outbox see a real lifecycle.
  for (const event of [
    'OPEN_CARD',
    'BEGIN_DIAGNOSIS',
    'REQUEST_APPROVAL',
    'APPROVAL_GRANTED',
  ] as const) {
    await jobCards.transition({
      shopId: DEMO_SHOP_ID,
      jobCardId,
      event,
      actor: { type: 'STAFF', id: technicianId },
      traceId: TRACE,
    });
  }

  for (const itemId of [brakesItemId, oilItemId]) {
    await workItems.transition({
      shopId: DEMO_SHOP_ID,
      workItemId: itemId,
      event: 'APPROVE',
      actor: { type: 'CUSTOMER', id: customerId },
      traceId: TRACE,
    });
  }

  return {
    jobCardId,
    code,
    customerId,
    registration,
    brakesItemId,
    oilItemId,
    technicianId,
    totalPaise,
  };
}

/**
 * A thread with an open 24-hour window and nothing said on it yet.
 *
 * The conversation row is written directly because phase 2 already proves the
 * inbound path that creates it; consent is *not*, because the message that asks
 * for it is the one that carries the AI disclosure, and every proactive message
 * this demo sends afterwards depends on that having happened.
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
    // The blind index, not the number: `external_thread_id` is what the router
    // looks a thread up by, and putting a phone number in it would both leak
    // PII into a plaintext column and make the row the router creates on the
    // customer's first tap a *second* thread for the same person.
    externalThreadId: personThreadKey(blindIndex(DEMO_SHOP_ID, CUSTOMER_PHONE)),
    externalAddressEncrypted: CUSTOMER_PHONE,
    displayName: 'Demo customer',
    state: 'OPEN',
    language: 'en',
    lastInboundAt: now,
    windowExpiresAt: new Date(now.getTime() + 20 * 60 * 60 * 1000),
  });

  return conversationId;
}

main().catch((error: unknown) => {
  console.error('[demo:phase4] failed');
  console.error(error);
  process.exit(1);
});
