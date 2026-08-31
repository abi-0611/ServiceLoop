import { defaultShopConfig, type ShopConfig } from '@serviceloop/config';
import { uuidv7, type Clock, type Language, type Paise } from '@serviceloop/shared';
import { DeliveryService } from '../delivery/delivery-service';
import { GatePassService } from '../delivery/gate-pass-service';
import { InvoiceService } from '../delivery/invoice-service';
import { PaymentService } from '../delivery/payment-service';
import { JobCardTransitionService } from '../job-card/transition-service';
import { OutboundGate } from '../messaging/outbound-gate';
import { EtaService } from '../status/eta-service';
import { SilentBaySentinel } from '../status/silent-bay';
import { StatusCommsService } from '../status/status-comms';
import { StatusSignalService } from '../status/status-signal-service';
import { WorkItemTransitionService } from '../work-item/transition-service';
import { createAgentTestHarness, type AgentTestHarness } from './in-memory-agent';
import { createDomainTestHarness, type DomainTestHarness, type MemoryTx } from './in-memory';
import {
  InMemoryDeliveryBookingStore,
  InMemoryDeliveryWorld,
  InMemoryGatePassStore,
  InMemoryGeneratedMediaWriter,
  InMemoryInvoiceStore,
  InMemoryPaymentStore,
  StubInvoiceRenderer,
  StubPaymentGateway,
} from './in-memory-delivery';
import {
  InMemoryConsentStore,
  InMemoryConversationStore,
  InMemoryMessageStore,
  RecordingChannelSender,
} from './in-memory-messaging';
import {
  InMemoryCardResolver,
  InMemoryEtaStore,
  InMemorySilentBayStore,
  InMemoryStatusCommsStore,
  InMemoryStatusSignalStore,
  InMemoryStatusWorld,
} from './in-memory-status';

/**
 * The phase-4 services, wired to the in-memory doubles.
 *
 * The doubles were built with the stores and then left unused: the services
 * themselves were proved by `demo:phase4` against Postgres and by their pure
 * functions in isolation, and nothing drove the classes in between. This is
 * that seam — one harness, so a test about the ETA engine does not have to
 * assemble a payment gateway to get one.
 *
 * Everything runs on a fake clock, because half of what these services decide
 * is *when*: whether a slip is material, whether a bay has been quiet for three
 * working hours, whether a reminder rung is due. A suite on the wall clock would
 * assert those from whatever time the build happened to run at.
 */

export const LOOP_SHOP = '01920000-0000-7000-8000-0000000000aa';
export const LOOP_CUSTOMER = '01920000-0000-7000-8000-0000000000bb';
export const LOOP_CARD = '01920000-0000-7000-8000-0000000000dd';
export const LOOP_CONVERSATION = '01920000-0000-7000-8000-0000000000ff';
export const LOOP_ITEM_BRAKES = '01920000-0000-7000-8000-0000000000e1';
export const LOOP_ITEM_OIL = '01920000-0000-7000-8000-0000000000e2';
export const LOOP_TECHNICIAN = '01920000-0000-7000-8000-000000000a02';

/** 2026-08-17, 14:00 IST — a Monday, mid-afternoon, inside working hours. */
export const LOOP_T0 = new Date('2026-08-17T08:30:00.000Z');

export const BRAKES_PAISE = 320_000;
export const OIL_PAISE = 160_000;

export interface LoopHarness {
  readonly base: DomainTestHarness;
  readonly agent: AgentTestHarness;
  readonly statusWorld: InMemoryStatusWorld;
  readonly deliveryWorld: InMemoryDeliveryWorld;
  readonly sender: RecordingChannelSender;
  readonly gate: OutboundGate<MemoryTx>;
  readonly jobCards: JobCardTransitionService<MemoryTx>;
  readonly workItems: WorkItemTransitionService<MemoryTx>;
  readonly eta: EtaService<MemoryTx>;
  readonly signals: StatusSignalService<MemoryTx>;
  readonly comms: StatusCommsService<MemoryTx>;
  readonly silentBay: SilentBaySentinel<MemoryTx>;
  readonly delivery: DeliveryService<MemoryTx>;
  readonly invoices: InvoiceService<MemoryTx>;
  readonly payments: PaymentService<MemoryTx>;
  readonly gatePasses: GatePassService<MemoryTx>;
  readonly gateway: StubPaymentGateway;
  readonly resolver: InMemoryCardResolver;
  readonly signalStore: InMemoryStatusSignalStore;
  /** Everything that actually reached the customer or the staff group. */
  sentBodies(): readonly string[];
  now(): Date;
  setNow(at: Date): void;
  advanceMinutes(minutes: number): void;
  /** What the customer owes. Settable, because most tests do not care. */
  amountDuePaise: Paise;
}

export interface LoopHarnessOptions {
  readonly configPatch?: Partial<ShopConfig>;
  readonly language?: Language;
}

export function createLoopHarness(options: LoopHarnessOptions = {}): LoopHarness {
  let current = new Date(LOOP_T0);
  const now = (): Date => new Date(current);
  const clock: Clock = { now };
  const language = options.language ?? 'en';

  const base = createDomainTestHarness(now);
  const agent = createAgentTestHarness(base.world);
  const statusWorld = new InMemoryStatusWorld();
  const deliveryWorld = new InMemoryDeliveryWorld();

  const config: ShopConfig = {
    ...defaultShopConfig('Asia/Kolkata'),
    // The end of the loop is templated copy from the reviewed catalogue, which
    // is what L1 means. At L0 every assertion below would be "nothing was sent".
    autonomy: {
      ...defaultShopConfig().autonomy,
      status: 'L1_TEMPLATED',
      delivery: 'L1_TEMPLATED',
    },
    languages: { enabled: ['en', 'ta', 'hi'], default: language },
    // Quiet hours pushed to the small hours, so a fake clock at 14:00 IST is
    // not accidentally testing the deferral path. It has its own suite.
    quietHours: { timezone: 'Asia/Kolkata', start: '02:00', end: '03:00' },
    ...options.configPatch,
  };

  base.world.addShop(LOOP_SHOP, 'Asia/Kolkata', 'Sri Murugan Auto Works');
  base.world.configs.set(LOOP_SHOP, config);
  base.world.addCustomer(LOOP_SHOP, '+919841100077', LOOP_CUSTOMER, language, 'Maruti Swift');
  base.world.addStaff(LOOP_SHOP, '+919840012003', LOOP_TECHNICIAN, 'Suresh');

  base.world.cards.set(LOOP_CARD, {
    id: LOOP_CARD,
    shopId: LOOP_SHOP,
    state: 'IN_PROGRESS',
    version: 1,
    stateChangedAt: new Date(LOOP_T0),
  });
  for (const id of [LOOP_ITEM_BRAKES, LOOP_ITEM_OIL]) {
    base.world.items.set(id, {
      id,
      shopId: LOOP_SHOP,
      jobCardId: LOOP_CARD,
      state: 'APPROVED',
      requiresApproval: true,
    });
  }

  agent.agentWorld.putCard({
    jobCardId: LOOP_CARD,
    code: 'JC-2026-0077',
    state: 'IN_PROGRESS',
    customerId: LOOP_CUSTOMER,
    customerName: 'Lakshmi',
    customerLanguage: language,
    vehicleLabel: 'Maruti Swift',
    registration: 'TN09BX4432',
    odometerKm: 58_400,
    promisedAt: new Date(LOOP_T0.getTime() + 3 * 60 * 60_000),
    complaint: 'Grinding noise when braking',
    workItems: [
      {
        id: LOOP_ITEM_BRAKES,
        title: 'Front brake caliper and pads',
        state: 'APPROVED',
        requiresApproval: true,
        technicianNote: 'Caliper seized, pads worn to 2.1mm.',
        estimatedMinutes: 90,
      },
      {
        id: LOOP_ITEM_OIL,
        title: 'Engine oil and filter',
        state: 'APPROVED',
        requiresApproval: true,
        technicianNote: 'Oil is dark and the filter is due.',
        estimatedMinutes: 30,
      },
    ],
    estimate: {
      id: 'est-1',
      version: 1,
      status: 'ACCEPTED',
      totalPaise: BRAKES_PAISE + OIL_PAISE,
      lines: [
        {
          id: 'line-brakes',
          workItemId: LOOP_ITEM_BRAKES,
          description: 'Front brake caliper (rebuilt) and pads',
          kind: 'PART',
          quantityMilli: 1000,
          unitPricePaise: BRAKES_PAISE,
          lineTotalPaise: BRAKES_PAISE,
          taxRateBp: 1800,
          listPricePaise: BRAKES_PAISE,
        },
        {
          id: 'line-oil',
          workItemId: LOOP_ITEM_OIL,
          description: 'Engine oil and filter',
          kind: 'CONSUMABLE',
          quantityMilli: 1000,
          unitPricePaise: OIL_PAISE,
          lineTotalPaise: OIL_PAISE,
          taxRateBp: 1800,
          listPricePaise: OIL_PAISE,
        },
      ],
    },
    media: [],
    advisorName: 'Meena',
  });

  statusWorld.seedCard({
    jobCardId: LOOP_CARD,
    version: 0,
    currentEta: null,
    promisedAt: new Date(LOOP_T0.getTime() + 3 * 60 * 60_000),
    state: 'IN_PROGRESS',
  });
  statusWorld.cards.push({
    jobCardId: LOOP_CARD,
    code: 'JC-2026-0077',
    registration: 'TN09BX4432',
    vehicleLabel: 'Maruti Swift',
    state: 'IN_PROGRESS',
    basis: 'REGISTRATION',
    assignedTechnicianId: LOOP_TECHNICIAN,
    lastTouchedAt: new Date(LOOP_T0),
  });

  base.world.conversations.set(LOOP_CONVERSATION, {
    id: LOOP_CONVERSATION,
    shopId: LOOP_SHOP,
    kind: 'CUSTOMER',
    channel: 'WHATSAPP',
    customerId: LOOP_CUSTOMER,
    externalThreadId: 'wa:loop',
    externalAddress: '+919841100077',
    displayName: 'Lakshmi',
    state: 'OPEN',
    language,
    lastInboundAt: new Date(LOOP_T0.getTime() - 60_000),
    lastOutboundAt: null,
    // A month, not a day. The 24-hour window has its own suite; a harness that
    // closed it would make every test more than a day past T0 an assertion
    // about the window rather than about the service under test. The one place
    // that genuinely matters — the balance ladder, whose first rung falls a day
    // later — is recorded as open question 21.
    windowExpiresAt: new Date(LOOP_T0.getTime() + 30 * 24 * 60 * 60 * 1000),
    unreadCount: 0,
    humanOverrideAt: null,
  });
  base.world.consents.push({
    id: uuidv7(),
    shopId: LOOP_SHOP,
    customerId: LOOP_CUSTOMER,
    purpose: 'SERVICE',
    status: 'GRANTED',
    channel: 'WHATSAPP',
    source: 'SEED',
    evidence: null,
    grantedAt: new Date(LOOP_T0.getTime() - 86_400_000),
    revokedAt: null,
    createdAt: new Date(LOOP_T0.getTime() - 86_400_000),
  });

  // The intake confirmation the shop already sent. Without it every proactive
  // message below is the *first* thing this shop has ever said to the customer,
  // and the gate correctly refuses any first contact that does not carry the AI
  // disclosure — which would make this harness test the disclosure rule over and
  // over instead of the thing under test. A card in progress has been written to.
  base.world.messages.push({
    id: uuidv7(),
    shopId: LOOP_SHOP,
    conversationId: LOOP_CONVERSATION,
    direction: 'OUTBOUND',
    status: 'READ',
    kind: 'TEXT',
    purpose: 'SERVICE',
    body: 'Your job card JC-2026-0077 is open. This is the ServiceLoop assistant.',
    templateName: null,
    templateLanguage: null,
    templateVariables: null,
    conversationCategory: null,
    interactive: null,
    language,
    providerMessageId: 'wamid.LOOPSEED',
    mediaId: null,
    jobCardId: LOOP_CARD,
    senderStaffId: null,
    createdByAgent: false,
    isHumanReply: false,
    agentRunId: null,
    approvedByStaffId: null,
    scheduledFor: null,
    blockedCode: null,
    blockedReason: null,
    errorCode: null,
    failureReason: null,
    // A day ago, so it does not itself trip the minimum interval.
    sentAt: new Date(LOOP_T0.getTime() - 24 * 60 * 60_000),
    createdAt: new Date(LOOP_T0.getTime() - 24 * 60 * 60_000),
  });

  const conversations = new InMemoryConversationStore(base.world);
  const messages = new InMemoryMessageStore(base.world);
  const sender = new RecordingChannelSender();

  const gate = new OutboundGate<MemoryTx>({
    uow: base.uow,
    conversations,
    messages,
    consents: new InMemoryConsentStore(base.world),
    config: base.config,
    audit: base.audit,
    outbox: base.outbox,
    sender,
    clock,
  });

  const jobCards = new JobCardTransitionService<MemoryTx>({
    uow: base.uow,
    cards: base.cards,
    config: base.config,
    audit: base.audit,
    outbox: base.outbox,
    clock,
  });
  const workItems = new WorkItemTransitionService<MemoryTx>({
    uow: base.uow,
    items: base.items,
    audit: base.audit,
    outbox: base.outbox,
    clock,
  });

  const loadConfig = async (): Promise<ShopConfig> =>
    (base.world.configs.get(LOOP_SHOP) as ShopConfig | undefined) ??
    defaultShopConfig('Asia/Kolkata');

  const eta = new EtaService<MemoryTx>({
    uow: base.uow,
    eta: new InMemoryEtaStore(statusWorld),
    cards: agent.cards,
    audit: base.audit,
    outbox: base.outbox,
    loadConfig,
    clock,
  });

  const signalStore = new InMemoryStatusSignalStore(statusWorld);
  const resolver = new InMemoryCardResolver(statusWorld);

  const signals = new StatusSignalService<MemoryTx>({
    uow: base.uow,
    signals: signalStore,
    resolver,
    cards: agent.cards,
    jobCards,
    workItems,
    eta,
    gate,
    audit: base.audit,
    outbox: base.outbox,
    loadConfig,
    clock,
  });

  const comms = new StatusCommsService<MemoryTx>({
    uow: base.uow,
    eta: new InMemoryEtaStore(statusWorld),
    comms: new InMemoryStatusCommsStore(statusWorld),
    cards: agent.cards,
    conversations,
    directory: base.directory,
    gate,
    audit: base.audit,
    loadConfig,
    clock,
  });

  const silentBay = new SilentBaySentinel<MemoryTx>({
    uow: base.uow,
    bays: new InMemorySilentBayStore(statusWorld),
    conversations,
    gate,
    audit: base.audit,
    outbox: base.outbox,
    loadConfig,
    clock,
  });

  const gateway = new StubPaymentGateway();
  const invoiceStore = new InMemoryInvoiceStore(deliveryWorld);
  const paymentStore = new InMemoryPaymentStore(deliveryWorld);
  let amountDuePaise: Paise = BRAKES_PAISE + OIL_PAISE;

  const harness: LoopHarness = {
    base,
    agent,
    statusWorld,
    deliveryWorld,
    sender,
    gate,
    jobCards,
    workItems,
    eta,
    signals,
    comms,
    silentBay,
    resolver,
    signalStore,
    get amountDuePaise(): Paise {
      return amountDuePaise;
    },
    set amountDuePaise(value: Paise) {
      amountDuePaise = value;
    },
    delivery: new DeliveryService<MemoryTx>({
      uow: base.uow,
      bookings: new InMemoryDeliveryBookingStore(deliveryWorld),
      cards: agent.cards,
      conversations,
      directory: base.directory,
      gate,
      audit: base.audit,
      outbox: base.outbox,
      loadConfig,
      amountDue: async () => amountDuePaise,
      clock,
    }),
    invoices: new InvoiceService<MemoryTx>({
      uow: base.uow,
      invoices: invoiceStore,
      cards: agent.cards,
      directory: base.directory,
      renderer: new StubInvoiceRenderer(),
      media: new InMemoryGeneratedMediaWriter(deliveryWorld),
      audit: base.audit,
      outbox: base.outbox,
      loadConfig,
      loadThumbnails: async () => new Map(),
      clock,
    }),
    payments: new PaymentService<MemoryTx>({
      uow: base.uow,
      payments: paymentStore,
      invoices: invoiceStore,
      cards: agent.cards,
      conversations,
      jobCards,
      gate,
      gateway,
      audit: base.audit,
      outbox: base.outbox,
      loadConfig,
      customerPhone: async () => '+919841100077',
      // The ladder's last rung is a person. `AdvisorTaskCreator` is the narrow
      // structural slice the delivery module declares; the agent's store speaks
      // the wider store contract, so the adapter is one line rather than a
      // second double.
      tasks: {
        create: async (input) =>
          base.uow.transaction((tx) =>
            agent.tasks.create(tx, uuidv7(), input as never, now()),
          ),
      },
      clock,
    }),
    gatePasses: new GatePassService<MemoryTx>({
      uow: base.uow,
      passes: new InMemoryGatePassStore(deliveryWorld),
      payments: paymentStore,
      cards: agent.cards,
      conversations,
      directory: base.directory,
      gate,
      audit: base.audit,
      outbox: base.outbox,
      loadConfig,
      secret: () => 'loop-harness-secret',
      clock,
    }),
    gateway,
    sentBodies: () =>
      sender.sent.map((message) =>
        message.content.kind === 'text'
          ? message.content.body
          : message.content.kind === 'interactive'
            ? message.content.body
            : (message.content.kind === 'media' ? (message.content.caption ?? '') : ''),
      ),
    now,
    setNow: (at) => {
      current = new Date(at);
    },
    advanceMinutes: (minutes) => {
      current = new Date(current.getTime() + minutes * 60_000);
    },
  };

  return harness;
}
