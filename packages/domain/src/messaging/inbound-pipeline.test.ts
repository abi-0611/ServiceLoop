import { defaultShopConfig, type ShopConfig } from '@serviceloop/config';
import {
  emptyJobCardDraft,
  JobCardDraftSchema,
  type ConfidentField,
  type JobCardDraft,
} from '@serviceloop/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DRAFT_ACTION_IDS,
  IntakePipeline,
  IntakeService,
  EntityResolutionService,
  type DraftExtractionPort,
  type ExtractedDraft,
} from '../intake';
import { JobCardTransitionService } from '../job-card/transition-service';
import {
  createDomainTestHarness,
  type DomainTestHarness,
  type MemoryTx,
} from '../testing/in-memory';
import {
  createIntakeWorld,
  InMemoryDraftStore,
  InMemoryEntityLookup,
  InMemoryJobCardWriter,
  type IntakeWorld,
} from '../testing/in-memory-intake';
import {
  InMemoryConsentStore,
  InMemoryConversationStore,
  InMemoryCustomerLookup,
  InMemoryMediaStore,
  InMemoryMessageStore,
  RecordingChannelSender,
  testBlindIndex,
} from '../testing/in-memory-messaging';
import { ConsentService } from './consent';
import { CONSENT_ACTION_IDS, ConsentCaptureService } from './consent-capture';
import { DeferredSendService } from './deferred';
import { InboundHandler, type FetchedMedia, type MediaFetchPort } from './inbound-handler';
import type {
  SlotReplyPort,
  StatusTapInput,
  TechnicianNoteCaptureInput,
  TechnicianNotePort,
  TechnicianNoteReadInput,
  TechnicianNoteReading,
} from './ports';
import { SLOT_ACTION_IDS, STATUS_ACTION_IDS } from './status-actions';
import type { CaptureOutcome, ParsedStatusSignal } from '../status/types';
import {
  MediaService,
  type MediaIngestOutcome,
  type MediaIngestPort,
  type MediaIngestRequest,
} from './media';
import { OutboundGate } from './outbound-gate';
import { InboundRouter } from './router';
import { ConversationSessionService } from './session';
import type { InboundMessage } from './types';

/**
 * The phase-2 acceptance path, end to end in memory.
 *
 * A photograph arrives in the staff group, is read, comes back as a numbered
 * summary, a technician corrects one line by typing `3 = TN 09 BX 4432`, taps
 * Confirm, and a job card exists. Everything in between — media ingest, the
 * router, the consent gate, the audit chain — is the real implementation; only
 * the byte-level pipeline and the model are doubles, because neither belongs in
 * a unit test.
 */

const SHOP = '01920000-0000-7000-8000-0000000000aa';
const CUSTOMER_ID = '01920000-0000-7000-8000-0000000000bb';
const CUSTOMER_PHONE = '+919841100001';
const TECHNICIAN_ID = '01920000-0000-7000-8000-0000000000cc';
const TECHNICIAN_PHONE = '+919840012003';
const STRANGER_PHONE = '+919845567788';
const STAFF_GROUP_ID = '120363000000000000';
const TRACE = 'trace-pipeline';
const T0 = new Date('2026-08-14T08:30:00.000Z');

const IMAGE = Buffer.from('fake-jpeg-bytes');

/* -------------------------------------------------------------------------- *
 * Doubles for the two things a unit test has no business running
 * -------------------------------------------------------------------------- */

function confident<T>(value: T, confidence: number): ConfidentField<T> {
  return { value, confidence, region: null };
}

function paperCardDraft(registrationConfidence = 0.35): JobCardDraft {
  return JobCardDraftSchema.parse({
    customer: { name: confident('Ravi Kumar', 0.92), phone: confident('98411 00001', 0.88) },
    vehicle: {
      // The plate is what handwriting gets wrong, so it is what the test
      // corrects: `1N09BX4432` is a plausible misread of `TN09BX4432`.
      registration: confident('1N09BX4432', registrationConfidence),
      make: confident('Maruti Suzuki', 0.72),
      model: confident('Swift VDi', 0.81),
      odometerKm: confident(64210, 0.6),
    },
    complaints: [confident('Front brake noise', 0.9)],
    estimateLines: [
      {
        description: confident('Front brake pad set', 0.87),
        quantityMilli: confident(1000, 0.9),
        unitPricePaise: confident(245000, 0.55),
      },
    ],
    advisorName: confident('Karthik', 0.7),
    promisedAt: confident('evening', 0.4),
    language: 'ta',
    notes: '',
  });
}

class ScriptedExtraction implements DraftExtractionPort {
  draft: JobCardDraft = paperCardDraft();
  failWith: Error | null = null;
  readonly calls: string[] = [];

  private result(source: string, sourceText: string | null): ExtractedDraft {
    this.calls.push(source);
    if (this.failWith !== null) throw this.failWith;
    return {
      draft: this.draft,
      model: 'test-vision-model',
      promptHash: 'sha256:test',
      latencyMs: 12,
      raw: JSON.stringify(this.draft),
      sourceText,
    };
  }

  async fromPhoto(input: { caption?: string | null }): Promise<ExtractedDraft> {
    return this.result('photo', input.caption ?? null);
  }

  async fromText(input: { text: string }): Promise<ExtractedDraft> {
    return this.result('text', input.text);
  }

  async fromVoice(): Promise<ExtractedDraft> {
    return this.result('voice', 'transcribed voice note');
  }
}

/** Stands in for the sharp/ffmpeg pipeline; the storage decisions are its own. */
class FakeMediaPipeline implements MediaIngestPort {
  maxBytes = 5 * 1024 * 1024;
  readonly ingested: MediaIngestRequest[] = [];
  private sequence = 0;

  async ingest(request: MediaIngestRequest): Promise<MediaIngestOutcome> {
    this.ingested.push(request);
    if (request.bytes.length > this.maxBytes) {
      return {
        ok: false,
        rejection: {
          code: 'TOO_LARGE',
          reason: 'too large',
          sizeBytes: request.bytes.length,
          limitBytes: this.maxBytes,
        },
      };
    }
    this.sequence += 1;
    const mediaId = `01920000-0000-7000-8000-00000000d0${String(this.sequence).padStart(2, '0')}`;
    return {
      ok: true,
      media: {
        mediaId,
        kind: request.declaredContentType?.startsWith('audio') === true ? 'AUDIO' : 'PHOTO',
        bucket: 'test-bucket',
        storageKey: `shops/${request.shopId}/job-cards/inbox/${mediaId}.jpg`,
        contentType: request.declaredContentType ?? 'image/jpeg',
        sizeBytes: request.bytes.length,
        checksumSha256: 'sha256:fake',
        thumbnailKey: null,
        widthPx: 1600,
        heightPx: 1200,
        durationMs: null,
        derivedKey: null,
        derivedContentType: null,
        providerMediaId: request.providerMediaId ?? null,
        warnings: [],
      },
    };
  }
}

class FakeMediaFetch implements MediaFetchPort {
  bytes = IMAGE;
  contentType = 'image/jpeg';

  async download(): Promise<FetchedMedia> {
    return {
      bytes: this.bytes,
      contentType: this.contentType,
      sizeBytes: this.bytes.length,
      filename: 'card.jpg',
    };
  }
}

/**
 * The status sentinel, scripted (phase 4.2).
 *
 * A double rather than the real `StatusSignalService` because what is under
 * test here is the *handler's* decision — is this note a status update or a new
 * car? — and the service's own routing has its own suite. What matters is that
 * `capture` is reached exactly when it should be and never when it should not.
 */
class ScriptedTechnicianNotes implements TechnicianNotePort {
  readonly reads: TechnicianNoteReadInput[] = [];
  readonly captures: TechnicianNoteCaptureInput[] = [];
  readonly confirms: StatusTapInput[] = [];
  readonly discards: StatusTapInput[] = [];

  /**
   * What the parser is pretending to have heard.
   *
   * Names no vehicle by default, which is the reading of an ordinary intake
   * caption — so every phase-2 test in this file still walks the intake path
   * with the sentinel wired, which is itself the property worth having.
   */
  parsed: ParsedStatusSignal = {
    signalType: 'progress',
    confidence: 0.5,
    registrationFragment: null,
    jobCardCode: null,
    workDescriptions: [],
    etaHint: null,
    summary: 'a new car came in',
    language: 'en',
  };

  transcript = 'a new car came in';
  route: CaptureOutcome['route'] = 'AUTO_APPLIED';
  jobCardId: string | null = '01920000-0000-7000-8000-0000000000dd';

  async read(input: TechnicianNoteReadInput): Promise<TechnicianNoteReading | null> {
    this.reads.push(input);
    return { transcript: this.transcript, transcriptConfidence: 0.9, parsed: this.parsed };
  }

  async capture(input: TechnicianNoteCaptureInput): Promise<CaptureOutcome> {
    this.captures.push(input);
    return {
      signalId: 'signal-1',
      route: this.route,
      jobCardId: this.jobCardId,
      workItemIds: [],
      detail: 'scripted',
      duplicate: false,
    };
  }

  async confirm(input: StatusTapInput): Promise<CaptureOutcome> {
    this.confirms.push(input);
    return {
      // The *stored* route becomes CONFIRMED; what comes back is what the
      // signal did, which is the same thing it would have done on its own.
      signalId: input.signalId,
      route: 'AUTO_APPLIED',
      jobCardId: input.jobCardId ?? this.jobCardId,
      workItemIds: [],
      detail: 'confirmed',
      duplicate: false,
    };
  }

  async discard(input: StatusTapInput): Promise<CaptureOutcome> {
    this.discards.push(input);
    return {
      signalId: input.signalId,
      route: 'DISCARDED',
      jobCardId: null,
      workItemIds: [],
      detail: 'discarded',
      duplicate: false,
    };
  }
}

class ScriptedSlots implements SlotReplyPort {
  readonly choices: { bookingId: string; slotIndex: number }[] = [];

  async chooseSlot(input: {
    readonly bookingId: string;
    readonly slotIndex: number;
  }): Promise<{ ok: boolean }> {
    this.choices.push({ bookingId: input.bookingId, slotIndex: input.slotIndex });
    return { ok: true };
  }
}

/* -------------------------------------------------------------------------- *
 * Harness
 * -------------------------------------------------------------------------- */

interface World {
  readonly harness: DomainTestHarness;
  readonly intakeWorld: IntakeWorld;
  readonly handler: InboundHandler<MemoryTx>;
  readonly firstContact: ConsentCaptureService<MemoryTx>;
  readonly consents: ConsentService<MemoryTx>;
  readonly extraction: ScriptedExtraction;
  readonly pipeline: FakeMediaPipeline;
  readonly fetch: FakeMediaFetch;
  readonly sender: RecordingChannelSender;
  readonly conversations: InMemoryConversationStore;
  readonly gate: OutboundGate<MemoryTx>;
  readonly deferred: DeferredSendService<MemoryTx>;
  readonly notes: ScriptedTechnicianNotes;
  readonly slots: ScriptedSlots;
  setNow(at: Date): void;
}

function build(configPatch: Partial<ShopConfig> = {}): World {
  let current = new Date(T0);
  const now = (): Date => new Date(current);
  const clock = { now };
  const harness = createDomainTestHarness(now);
  const intakeWorld = createIntakeWorld();

  harness.world.addShop(SHOP, 'Asia/Kolkata', 'Sri Murugan Auto Works');
  harness.world.configs.set(SHOP, {
    ...defaultShopConfig('Asia/Kolkata'),
    ...configPatch,
    messaging: {
      ...defaultShopConfig('Asia/Kolkata').messaging,
      staffGroupId: STAFF_GROUP_ID,
      ...(configPatch.messaging ?? {}),
    },
  });
  harness.world.addCustomer(SHOP, CUSTOMER_PHONE, CUSTOMER_ID, 'ta', 'Swift TN09BX4432');
  harness.world.addStaff(SHOP, TECHNICIAN_PHONE, TECHNICIAN_ID, 'Karthik R');

  const conversations = new InMemoryConversationStore(harness.world);
  const messages = new InMemoryMessageStore(harness.world);
  const consentStore = new InMemoryConsentStore(harness.world);
  const customers = new InMemoryCustomerLookup(harness.world);
  const mediaStore = new InMemoryMediaStore(harness.world);
  const sender = new RecordingChannelSender();

  const sessions = new ConversationSessionService<MemoryTx>({
    uow: harness.uow,
    conversations,
    customers,
    audit: harness.audit,
    outbox: harness.outbox,
    blindIndex: testBlindIndex,
    clock,
  });

  const consents = new ConsentService<MemoryTx>({
    uow: harness.uow,
    consents: consentStore,
    audit: harness.audit,
    outbox: harness.outbox,
    clock,
  });

  const router = new InboundRouter<MemoryTx>({
    uow: harness.uow,
    conversations,
    messages,
    customers,
    config: harness.config,
    sessions,
    consents,
    audit: harness.audit,
    outbox: harness.outbox,
    clock,
  });

  const gate = new OutboundGate<MemoryTx>({
    uow: harness.uow,
    conversations,
    messages,
    consents: consentStore,
    config: harness.config,
    audit: harness.audit,
    outbox: harness.outbox,
    sender,
    clock,
  });

  const entities = new EntityResolutionService<MemoryTx>({
    uow: harness.uow,
    lookup: new InMemoryEntityLookup(intakeWorld, harness.world),
    audit: harness.audit,
    outbox: harness.outbox,
    clock,
  });

  const cards = new JobCardTransitionService<MemoryTx>({
    uow: harness.uow,
    cards: harness.cards,
    config: harness.config,
    audit: harness.audit,
    outbox: harness.outbox,
    clock,
  });

  const intake = new IntakeService<MemoryTx>({
    uow: harness.uow,
    drafts: new InMemoryDraftStore(intakeWorld),
    writer: new InMemoryJobCardWriter(intakeWorld, harness.world),
    entities,
    config: harness.config,
    audit: harness.audit,
    outbox: harness.outbox,
    cards,
    clock,
  });

  const extraction = new ScriptedExtraction();
  const pipeline = new FakeMediaPipeline();
  const fetch = new FakeMediaFetch();

  const intakePipeline = new IntakePipeline<MemoryTx>({
    uow: harness.uow,
    extraction,
    intake,
    config: harness.config,
  });

  const media = new MediaService<MemoryTx>({
    uow: harness.uow,
    store: mediaStore,
    pipeline,
    audit: harness.audit,
    outbox: harness.outbox,
    clock,
  });

  const notes = new ScriptedTechnicianNotes();
  const slots = new ScriptedSlots();

  const handler = new InboundHandler<MemoryTx>({
    uow: harness.uow,
    router,
    gate,
    intake,
    pipeline: intakePipeline,
    media,
    mediaFetch: fetch,
    conversations,
    messages,
    customers,
    consents,
    config: harness.config,
    directory: harness.directory,
    technicianNotes: notes,
    slots,
    consoleUrl: 'http://localhost:3000',
    clock,
  });

  const firstContact = new ConsentCaptureService<MemoryTx>({
    uow: harness.uow,
    gate,
    conversations,
    messages,
    customers,
    consents,
    config: harness.config,
    directory: harness.directory,
    channel: 'WHATSAPP',
    clock,
  });

  return {
    harness,
    intakeWorld,
    handler,
    firstContact,
    consents,
    extraction,
    pipeline,
    fetch,
    sender,
    conversations,
    gate,
    notes,
    slots,
    deferred: new DeferredSendService<MemoryTx>({ uow: harness.uow, messages, gate, clock }),
    setNow: (at) => {
      current = new Date(at);
    },
  };
}

let sequence = 0;

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  sequence += 1;
  return {
    channel: 'WHATSAPP',
    kind: 'TEXT',
    providerMessageId: `wamid.PIPE${sequence}`,
    from: CUSTOMER_PHONE,
    fromDisplayName: 'Ravi',
    groupId: null,
    timestamp: new Date(T0),
    text: '',
    caption: null,
    media: null,
    replyId: null,
    replyTitle: null,
    contextProviderMessageId: null,
    location: null,
    reaction: null,
    ...overrides,
  };
}

function staffPhoto(caption = '#jobcard'): InboundMessage {
  return inbound({
    kind: 'IMAGE',
    from: TECHNICIAN_PHONE,
    groupId: STAFF_GROUP_ID,
    text: '',
    caption,
    media: {
      providerMediaId: 'wamedia-1',
      mimeType: 'image/jpeg',
      kind: 'PHOTO',
      sha256: null,
      fileSizeBytes: IMAGE.length,
      filename: 'card.jpg',
      isVoiceNote: false,
    },
  });
}

async function run(world: World, message: InboundMessage): ReturnType<InboundHandler<MemoryTx>['handle']> {
  return world.handler.handle({ shopId: SHOP, channel: 'WHATSAPP', message, traceId: TRACE });
}

/* -------------------------------------------------------------------------- *
 * Tests
 * -------------------------------------------------------------------------- */

describe('paper job-card intake, end to end', () => {
  let world: World;
  beforeEach(() => {
    world = build();
  });

  it('turns a photographed card into a confirmable draft and, on Confirm, a job card', async () => {
    const first = await run(world, staffPhoto());

    expect(first.mediaId).not.toBeNull();
    expect(first.draftId).not.toBeNull();
    expect(world.extraction.calls).toEqual(['photo']);

    // The summary went back to the group as an interactive with three buttons.
    const summary = world.sender.sent.at(-1);
    expect(summary?.content.kind).toBe('interactive');
    const buttons =
      summary?.content.kind === 'interactive' ? (summary.content.buttons ?? []) : [];
    expect(buttons.map((button) => button.id)).toEqual([
      DRAFT_ACTION_IDS.confirm(first.draftId as string),
      DRAFT_ACTION_IDS.edit(first.draftId as string),
      DRAFT_ACTION_IDS.discard(first.draftId as string),
    ]);

    // The registration was read at 0.35, so it is one of the ⚠ lines.
    const body = summary?.content.kind === 'interactive' ? summary.content.body : '';
    expect(body).toContain('⚠');
    expect(body).toContain('1N09BX4432');

    // A technician corrects line 3 (the registration) by typing it.
    const corrected = await run(
      world,
      inbound({ from: TECHNICIAN_PHONE, groupId: STAFF_GROUP_ID, text: '3 = TN 09 BX 4432' }),
    );
    expect(corrected.draftId).toBe(first.draftId);

    const afterCorrection = world.sender.sent.at(-1);
    const correctedBody =
      afterCorrection?.content.kind === 'interactive' ? afterCorrection.content.body : '';
    expect(correctedBody).toContain('TN 09 BX 4432');

    // Confirm.
    const confirmed = await run(
      world,
      inbound({
        kind: 'BUTTON_REPLY',
        from: TECHNICIAN_PHONE,
        groupId: STAFF_GROUP_ID,
        replyId: DRAFT_ACTION_IDS.confirm(first.draftId as string),
        replyTitle: 'Confirm',
      }),
    );

    expect(confirmed.jobCardId).not.toBeNull();
    const card = world.intakeWorld.jobCards.get(confirmed.jobCardId as string);
    expect(card?.source).toBe('PAPER_CARD');

    // The correction reached the vehicle that was actually created.
    const vehicle = [...world.intakeWorld.vehicles.values()].at(-1);
    expect(vehicle?.registrationNormalised).toBe('TN09BX4432');

    // Provenance: the audit trail names the extractor and the corrected field.
    const confirmAudit = world.harness.world
      .auditFor(SHOP)
      .find((entry) => entry.action === 'intake.draft_confirmed');
    expect(confirmAudit?.payload).toMatchObject({
      extractorModel: 'test-vision-model',
      correctedFields: ['vehicle.registration'],
    });
  });

  it('records the trace a simulator can render', async () => {
    const outcome = await run(world, staffPhoto());
    const stages = outcome.trace.map((step) => step.stage);
    // `status` is phase 4 asking "is this note about a car we already have?"
    // before the intake extractor is allowed to spend a model call on it.
    expect(stages).toEqual(['webhook', 'media', 'router', 'session', 'status', 'intake', 'gate']);
    expect(outcome.trace.every((step) => step.ok)).toBe(true);
    // A trace is rendered in a browser; it must not carry a full phone number.
    expect(JSON.stringify(outcome.trace)).not.toContain(TECHNICIAN_PHONE);
  });

  it('is idempotent when Meta redelivers the same photo', async () => {
    const message = staffPhoto();
    const first = await run(world, message);
    const second = await run(world, message);

    expect(second.duplicate).toBe(true);
    expect(second.draftId).toBeNull();
    expect(world.extraction.calls).toEqual(['photo']);
    expect([...world.intakeWorld.drafts.values()]).toHaveLength(1);
    expect(first.draftId).not.toBeNull();
  });

  it('tells the sender when the file was refused, and reads nothing', async () => {
    world.pipeline.maxBytes = 4;
    const outcome = await run(world, staffPhoto());

    expect(outcome.draftId).toBeNull();
    expect(world.extraction.calls).toEqual([]);
    const reply = world.sender.sent.at(-1);
    expect(reply?.content.kind === 'text' ? reply.content.body : '').toContain('larger than');
  });

  it('says so when the card could not be read, rather than going quiet', async () => {
    world.extraction.failWith = new Error('the model returned nothing usable');
    const outcome = await run(world, staffPhoto());

    expect(outcome.draftId).toBeNull();
    // The staff group runs in the shop's default language, not the customer's.
    const reply = world.sender.sent.at(-1);
    expect(reply?.content.kind === 'text' ? reply.content.body : '').toContain(
      'could not read that job card',
    );
  });

  it('discards a draft on the Discard tap and creates nothing', async () => {
    const first = await run(world, staffPhoto());
    await run(
      world,
      inbound({
        kind: 'BUTTON_REPLY',
        from: TECHNICIAN_PHONE,
        groupId: STAFF_GROUP_ID,
        replyId: DRAFT_ACTION_IDS.discard(first.draftId as string),
        replyTitle: 'Discard',
      }),
    );

    const draft = world.intakeWorld.drafts.get(first.draftId as string);
    expect(draft?.status).toBe('DISCARDED');
    expect(world.intakeWorld.jobCards.size).toBe(0);
  });

  it('parses a forwarded text into the same draft shape', async () => {
    const outcome = await run(
      world,
      inbound({
        from: TECHNICIAN_PHONE,
        groupId: STAFF_GROUP_ID,
        text: '#jobcard Ravi anna Swift MH12 brake pad + oil change 3500 evening delivery',
      }),
    );

    expect(world.extraction.calls).toEqual(['text']);
    expect(outcome.draftId).not.toBeNull();
  });

  it('queues a customer-sent card for an advisor instead of asking them to proofread', async () => {
    const outcome = await run(
      world,
      inbound({
        kind: 'IMAGE',
        caption: '#jobcard',
        media: {
          providerMediaId: 'wamedia-cust',
          mimeType: 'image/jpeg',
          kind: 'PHOTO',
          sha256: null,
          fileSizeBytes: IMAGE.length,
          filename: 'card.jpg',
          isVoiceNote: false,
        },
      }),
    );

    expect(outcome.draftId).not.toBeNull();
    // Nothing numbered went to the customer.
    expect(world.sender.sent).toHaveLength(0);
  });

  it('leaves audio transcoding to the worker', async () => {
    world.fetch.contentType = 'audio/ogg';
    await run(
      world,
      inbound({
        kind: 'AUDIO',
        from: TECHNICIAN_PHONE,
        groupId: STAFF_GROUP_ID,
        media: {
          providerMediaId: 'wamedia-voice',
          mimeType: 'audio/ogg',
          kind: 'AUDIO',
          sha256: null,
          fileSizeBytes: 2048,
          filename: 'voice.ogg',
          isVoiceNote: true,
        },
      }),
    );

    expect(world.pipeline.ingested.at(-1)?.deferAudio).toBe(true);
    // Phase 4 reads every staff voice note before intake does, so the extractor
    // is handed words rather than bytes. The transcoding decision — which is
    // what this test is about — is unchanged.
    expect(world.extraction.calls).toEqual(['text']);
  });
});

describe('identification, consent and handoff', () => {
  let world: World;
  beforeEach(() => {
    world = build();
  });

  it('asks an unrecognised number who it is, and discloses the AI in the same breath', async () => {
    await run(world, inbound({ from: STRANGER_PHONE, text: 'Is my car ready?' }));

    const reply = world.sender.sent.at(-1);
    const body = reply?.content.kind === 'text' ? reply.content.body : '';
    expect(body).toContain('Sri Murugan Auto Works');
    expect(body.toLowerCase()).toContain('serviceloop assistant');
  });

  it('revokes both purposes on STOP and confirms exactly once', async () => {
    await run(world, inbound({ text: 'STOP' }));

    const state = await world.consents.current(SHOP, CUSTOMER_ID);
    expect(state.service?.status).toBe('REVOKED');
    expect(state.marketing?.status).toBe('REVOKED');
    expect(world.sender.sent).toHaveLength(1);

    // A later message is blocked by the gate, with the reason recorded.
    const blocked = await world.gate.send({
      shopId: SHOP,
      conversationId: (await conversationIdFor(world)) as string,
      customerId: CUSTOMER_ID,
      purpose: 'SERVICE',
      content: { kind: 'text', body: 'Your vehicle is ready.' },
      actor: { type: 'AGENT', id: null },
      traceId: TRACE,
      flow: 'status',
    });
    expect(blocked.status).toBe('BLOCKED');
    expect(blocked.status === 'BLOCKED' ? blocked.code : '').toBe('CONSENT_REVOKED');
    expect(world.sender.sent).toHaveLength(1);
  });

  it('opens first contact with disclosure plus a tappable consent ask, once', async () => {
    // A thread has to exist before the shop can write to it.
    await run(world, inbound({ text: 'Hello' }));
    const conversationId = (await conversationIdFor(world)) as string;
    world.sender.reset();

    const first = await world.firstContact.openFirstContact({
      shopId: SHOP,
      customerId: CUSTOMER_ID,
      conversationId,
      customerName: 'Ravi',
      actor: { type: 'STAFF', id: TECHNICIAN_ID },
      traceId: TRACE,
    });
    expect(first.sent).toBe(true);

    const sent = world.sender.sent.at(-1);
    expect(sent?.content.kind).toBe('interactive');
    const buttons = sent?.content.kind === 'interactive' ? (sent.content.buttons ?? []) : [];
    expect(buttons.map((button) => button.id)).toEqual([
      CONSENT_ACTION_IDS.grantService,
      CONSENT_ACTION_IDS.revokeService,
    ]);

    // A second call is a no-op: first contact happens once per thread.
    const again = await world.firstContact.openFirstContact({
      shopId: SHOP,
      customerId: CUSTOMER_ID,
      conversationId,
      actor: { type: 'STAFF', id: TECHNICIAN_ID },
      traceId: TRACE,
    });
    expect(again.sent).toBe(false);
    expect(world.sender.sent).toHaveLength(1);
  });

  it('records a Yes tap as an INTERACTIVE_REPLY consent grant', async () => {
    await run(world, inbound({ text: 'Hello' }));
    await run(
      world,
      inbound({
        kind: 'BUTTON_REPLY',
        replyId: CONSENT_ACTION_IDS.grantService,
        replyTitle: 'Yes, send updates',
      }),
    );

    const state = await world.consents.current(SHOP, CUSTOMER_ID);
    expect(state.service?.status).toBe('GRANTED');
    const consentAudit = world.harness.world
      .auditFor(SHOP)
      .filter((entry) => entry.action === 'consent.updated');
    expect(consentAudit.at(-1)?.payload).toMatchObject({ source: 'INTERACTIVE_REPLY' });
  });

  it('flags the thread for a human and names the advisor on HUMAN', async () => {
    await run(world, inbound({ text: 'HUMAN' }));

    const conversationId = (await conversationIdFor(world)) as string;
    const conversation = world.harness.world.conversations.get(conversationId);
    expect(conversation?.humanOverrideAt).not.toBeNull();

    const reply = world.sender.sent.at(-1);
    expect(reply?.content.kind === 'text' ? reply.content.body : '').toContain('Karthik R');
  });
});

describe('quiet hours', () => {
  /** 23:30 IST — inside the default 21:00–08:00 quiet window. */
  const NIGHT = new Date('2026-08-14T18:00:00.000Z');
  /** 09:00 IST the next morning. */
  const MORNING = new Date('2026-08-15T03:30:00.000Z');

  async function heldMessage(world: World): Promise<{ conversationId: string; messageId: string }> {
    world.setNow(NIGHT);
    await run(world, inbound({ text: 'Hello', timestamp: NIGHT }));
    const conversationId = (await conversationIdFor(world)) as string;

    const outcome = await world.gate.send({
      shopId: SHOP,
      conversationId,
      customerId: CUSTOMER_ID,
      purpose: 'SERVICE',
      content: {
        kind: 'text',
        body: 'I am an AI assistant from Sri Murugan Auto Works. Your vehicle is ready.',
      },
      actor: { type: 'AGENT', id: null },
      traceId: TRACE,
      flow: 'status',
      systemReply: true,
    });

    expect(outcome.status).toBe('DEFERRED');
    return { conversationId, messageId: outcome.messageId };
  }

  it('defers rather than drops, and the held message keeps its due time', async () => {
    const world = build();
    const { messageId } = await heldMessage(world);

    const held = world.harness.world.messages.find((row) => row.id === messageId);
    expect(held?.status).toBe('QUEUED');
    expect(held?.scheduledFor).not.toBeNull();
  });

  it('releases the hold once the window opens', async () => {
    const world = build();
    const { messageId } = await heldMessage(world);
    world.sender.reset();

    world.setNow(MORNING);
    const result = await world.deferred.drain({ shopId: SHOP });

    expect(result).toMatchObject({ claimed: 1, sent: 1, blocked: 0 });
    expect(world.sender.sent).toHaveLength(1);
    expect(world.harness.world.messages.find((row) => row.id === messageId)?.status).toBe('SENT');
  });

  it('does not release a message to someone who opted out during the hold', async () => {
    const world = build();
    const { messageId } = await heldMessage(world);

    // The customer types STOP at midnight, while the message is still held.
    await run(world, inbound({ text: 'STOP', timestamp: NIGHT }));
    world.sender.reset();

    world.setNow(MORNING);
    const result = await world.deferred.drain({ shopId: SHOP });

    expect(result).toMatchObject({ claimed: 1, sent: 0, blocked: 1 });
    // Blocked, not dropped: the row records why, and nothing reached them.
    const row = world.harness.world.messages.find((entry) => entry.id === messageId);
    expect(row?.status).toBe('FAILED');
    expect(row?.errorCode).toBe('CONSENT_REVOKED');
    expect(world.sender.sent).toHaveLength(0);
  });

  it('claims nothing before the hold is due', async () => {
    const world = build();
    await heldMessage(world);

    // Still 23:30; the message is not due until morning.
    const result = await world.deferred.drain({ shopId: SHOP });
    expect(result.claimed).toBe(0);
  });
});

async function conversationIdFor(world: World): Promise<string | null> {
  for (const row of world.harness.world.conversations.values()) {
    if (row.shopId === SHOP && row.kind !== 'STAFF_GROUP') return row.id;
  }
  return null;
}

/* -------------------------------------------------------------------------- *
 * 4.2 — a technician's note, and the fork it arrives at
 * -------------------------------------------------------------------------- */

describe('staff-group technician notes', () => {
  let world: World;

  beforeEach(() => {
    world = build();
  });

  /** A five-second note that names the car. */
  function staffVoiceNote(): InboundMessage {
    return inbound({
      kind: 'AUDIO',
      from: TECHNICIAN_PHONE,
      groupId: STAFF_GROUP_ID,
      text: '',
      caption: null,
      media: {
        providerMediaId: 'wamedia-voice',
        mimeType: 'audio/ogg',
        kind: 'AUDIO',
        sha256: null,
        fileSizeBytes: IMAGE.length,
        filename: 'note.ogg',
        isVoiceNote: true,
      },
    });
  }

  function namesTheVehicle(): void {
    world.notes.parsed = {
      signalType: 'done',
      confidence: 0.92,
      registrationFragment: '4432',
      jobCardCode: null,
      workDescriptions: ['brake pad'],
      etaHint: null,
      summary: '4432 brake pad mudinjidhu',
      language: 'ta',
    };
    world.notes.transcript = '4432 brake pad mudinjidhu';
  }

  it('turns a voice note that names a plate into a status signal, not a job card', async () => {
    namesTheVehicle();
    const outcome = await run(world, staffVoiceNote());

    expect(world.notes.captures).toHaveLength(1);
    expect(world.notes.captures[0]).toMatchObject({
      source: 'VOICE_NOTE',
      transcript: '4432 brake pad mudinjidhu',
      transcriptConfidence: 0.9,
      senderStaffId: TECHNICIAN_ID,
      actor: { type: 'STAFF', id: TECHNICIAN_ID },
    });

    // The whole point of the fork: no draft, no model call, no second job card
    // for a vehicle that is already in the workshop.
    expect(outcome.draftId).toBeNull();
    expect(world.extraction.calls).toEqual([]);
    expect([...world.intakeWorld.drafts.values()]).toHaveLength(0);

    const status = outcome.trace.find((step) => step.stage === 'status');
    expect(status?.detail).toContain('AUTO_APPLIED');
  });

  it('falls through to intake when the plate is one the shop does not have open', async () => {
    namesTheVehicle();
    world.notes.route = 'NO_CARD_MATCH';
    world.notes.jobCardId = null;

    const outcome = await run(world, staffVoiceNote());

    // The attempt is recorded — it belongs in the denominator of "how often did
    // we understand a note" — and a job card is still opened for the new car.
    expect(world.notes.captures).toHaveLength(1);
    expect(outcome.draftId).not.toBeNull();
  });

  it('hands the transcript to intake rather than paying to hear it twice', async () => {
    const outcome = await run(world, staffVoiceNote());

    expect(outcome.draftId).not.toBeNull();
    // The extractor read *text*, not audio: the words came from the sentinel.
    expect(world.extraction.calls).toEqual(['text']);
  });

  it('sends a note that names nothing down the intake path instead', async () => {
    // The default reading: "a new car came in" — a signal type and no vehicle.
    const outcome = await run(world, staffVoiceNote());

    expect(world.notes.reads).toHaveLength(1);
    // Nothing was written. A queue of status signals that filled up with new
    // arrivals could not answer "how often was the parser right?".
    expect(world.notes.captures).toEqual([]);
    expect(outcome.draftId).not.toBeNull();

    const status = outcome.trace.find((step) => step.stage === 'status');
    expect(status?.detail).toContain('No vehicle named');
  });

  it('accepts a typed line in the staff group, which phase 2 dropped on the floor', async () => {
    namesTheVehicle();
    const outcome = await run(
      world,
      inbound({
        kind: 'TEXT',
        from: TECHNICIAN_PHONE,
        groupId: STAFF_GROUP_ID,
        text: '4432 brake pad done',
      }),
    );

    expect(world.notes.captures).toHaveLength(1);
    expect(world.notes.captures[0]?.source).toBe('TEXT');
    expect(outcome.draftId).toBeNull();
  });

  it("reads a reply to the card's own message as naming the vehicle", async () => {
    // Nothing in the words identifies a car; the reply context does.
    const first = await run(
      world,
      inbound({
        kind: 'TEXT',
        from: TECHNICIAN_PHONE,
        groupId: STAFF_GROUP_ID,
        text: 'starting on it',
      }),
    );
    expect(world.notes.captures).toEqual([]);

    const priorMessageId = first.routed?.messageId;
    const providerId = world.harness.world.messages.find(
      (row) => row.id === priorMessageId,
    )?.providerMessageId;

    await run(
      world,
      inbound({
        kind: 'TEXT',
        from: TECHNICIAN_PHONE,
        groupId: STAFF_GROUP_ID,
        text: 'mudinjidhu',
        contextProviderMessageId: providerId ?? 'wamid.PIPE-unknown',
      }),
    );

    expect(world.notes.captures).toHaveLength(1);
    expect(world.notes.captures[0]?.replyToMessageId).toBe(priorMessageId);
  });

  it("does not read a customer's voice note as a technician note", async () => {
    namesTheVehicle();
    await run(
      world,
      inbound({
        kind: 'AUDIO',
        from: CUSTOMER_PHONE,
        text: '',
        media: {
          providerMediaId: 'wamedia-cust',
          mimeType: 'audio/ogg',
          kind: 'AUDIO',
          sha256: null,
          fileSizeBytes: 4,
          filename: 'note.ogg',
          isVoiceNote: true,
        },
      }),
    );

    expect(world.notes.reads).toEqual([]);
    expect(world.notes.captures).toEqual([]);
  });

  it('applies a ✅ tap on the confirmation card, and records a ✏️ as a discard', async () => {
    await run(
      world,
      inbound({
        kind: 'INTERACTIVE',
        from: TECHNICIAN_PHONE,
        groupId: STAFF_GROUP_ID,
        replyId: STATUS_ACTION_IDS.confirm('signal-7', 'card-9'),
        replyTitle: 'Yes',
      }),
    );

    expect(world.notes.confirms).toHaveLength(1);
    expect(world.notes.confirms[0]).toMatchObject({ signalId: 'signal-7', jobCardId: 'card-9' });

    await run(
      world,
      inbound({
        kind: 'INTERACTIVE',
        from: TECHNICIAN_PHONE,
        groupId: STAFF_GROUP_ID,
        replyId: STATUS_ACTION_IDS.discard('signal-7'),
        replyTitle: 'No',
      }),
    );

    expect(world.notes.discards).toHaveLength(1);
    expect(world.notes.discards[0]?.signalId).toBe('signal-7');
  });

  it('books the pickup slot a customer tapped', async () => {
    await run(
      world,
      inbound({
        replyId: SLOT_ACTION_IDS.pick('booking-3', 1),
        replyTitle: 'Tomorrow 11:00',
        kind: 'INTERACTIVE',
      }),
    );

    expect(world.slots.choices).toEqual([{ bookingId: 'booking-3', slotIndex: 1 }]);
  });
});

/** Guards the shape the console form depends on. */
describe('empty draft', () => {
  it('validates and has no confident fields', () => {
    const draft = emptyJobCardDraft();
    expect(JobCardDraftSchema.safeParse(draft).success).toBe(true);
    expect(draft.vehicle.registration.confidence).toBe(0);
  });
});
