import type { PaymentsPort, SpeechPort } from '@serviceloop/adapters';
import { migrateShopConfig, type ShopConfig } from '@serviceloop/config';
import {
  DeliveryService,
  EtaService,
  GatePassService,
  InvoiceService,
  PaymentService,
  SilentBaySentinel,
  StatusCommsService,
  StatusSignalService,
  type AdvisorTaskCreator,
  type AuditAppender,
  type CardResolver,
  type ConversationStore,
  type DeliveryBookingStore,
  type EtaStore,
  type GatePassStore,
  type GeneratedMediaWriter,
  type InvoiceRenderer,
  type InvoiceStore,
  type JobCardContextReader,
  type JobCardTransitionService,
  type OutboundGate,
  type OutboxWriter,
  type PaymentStore,
  type QrRenderer,
  type ShopConfigStore,
  type ShopDirectory,
  type SilentBayStore,
  type StatusCommsStore,
  type StatusSignalParser,
  type StatusSignalStore,
  type TechnicianNotePort,
  type UnitOfWork,
  type WorkItemTransitionService,
} from '@serviceloop/domain';
import type { Clock, Language, Paise } from '@serviceloop/shared';
import { TechnicianNoteIngestor } from './technician-notes';

/**
 * The phase-4 composition root.
 *
 * Here for the same reason `createAgentRuntime` is (and `createChannelPorts`
 * before it): the API, the workers and the demo runner all want the identical
 * set of services, and each assembling it by hand is how they drift — one ends
 * up on the mock payments adapter while another is on Razorpay, and a bug
 * reproduces in only one of them.
 *
 * It lives in `agent-core` rather than in `domain` because it needs the
 * *adapter* ports — a payments gateway, a PDF renderer, a status parser — and
 * `packages/domain` deliberately depends on nothing but `shared` and `config`.
 * `agent-core` is already the package that may see both sides.
 *
 * What it does not own: the transaction handle, the stores, the channel sender
 * and the queue. Those differ between a worker with a BullMQ connection and a
 * demo runner with an in-memory one, so they arrive as input.
 */

export interface LoopStores<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly eta: EtaStore<Tx>;
  readonly signals: StatusSignalStore<Tx>;
  readonly resolver: CardResolver<Tx>;
  readonly bays: SilentBayStore<Tx>;
  readonly comms: StatusCommsStore<Tx>;
  readonly bookings: DeliveryBookingStore<Tx>;
  readonly invoices: InvoiceStore<Tx>;
  readonly payments: PaymentStore<Tx>;
  readonly passes: GatePassStore<Tx>;
  readonly cards: JobCardContextReader<Tx>;
  readonly conversations: ConversationStore<Tx>;
  readonly directory: ShopDirectory<Tx>;
  readonly config: ShopConfigStore<Tx>;
  readonly audit: AuditAppender<Tx>;
  readonly outbox: OutboxWriter<Tx>;
}

export interface LoopRuntimeInput<Tx> {
  readonly stores: LoopStores<Tx>;
  readonly gate: OutboundGate<Tx>;
  readonly jobCards: JobCardTransitionService<Tx>;
  readonly workItems: WorkItemTransitionService<Tx>;
  readonly payments: PaymentsPort;
  readonly renderer: InvoiceRenderer;
  readonly media: GeneratedMediaWriter;
  /** Renders the gate-pass token as a scannable image. Optional (4.10). */
  readonly qr?: QrRenderer;
  readonly parser: StatusSignalParser;
  /** Turns a technician's voice note into words (4.1). */
  readonly speech: SpeechPort;
  /** HMAC key for gate-pass tokens. A function so a rotation is a config change. */
  readonly gatePassSecret: () => string;

  /* --- the reads that are pure SQL, supplied by the caller ---------------- */

  /** What the customer owes: the invoice total when one exists, else the estimate. */
  readonly amountDue: (tx: Tx, shopId: string, jobCardId: string) => Promise<Paise>;
  readonly customerPhone: (tx: Tx, shopId: string, customerId: string) => Promise<string | null>;
  readonly loadThumbnails: (
    tx: Tx,
    shopId: string,
    mediaIds: readonly string[],
  ) => Promise<ReadonlyMap<string, Buffer | null>>;

  /** Raises the advisor task the balance ladder ends in (L6). */
  readonly tasks?: AdvisorTaskCreator;
  /**
   * Where an `issue_found` technician signal goes.
   *
   * Injected rather than imported: the evidence-bundle builder lives behind
   * `AgentRuntime`, and wiring it here keeps the status module from depending
   * on the agent.
   */
  readonly routeToEvidence?: (input: {
    readonly shopId: string;
    readonly jobCardId: string;
    readonly conversationId: string | null;
    readonly messageId: string | null;
    readonly mediaId: string | null;
    readonly senderStaffId: string | null;
    readonly transcript: string;
    readonly language: Language;
    readonly traceId: string;
  }) => Promise<{ readonly bundleId: string | null; readonly detail: string }>;
  readonly clock?: Clock;
}

export interface LoopRuntime<Tx> {
  readonly eta: EtaService<Tx>;
  readonly signals: StatusSignalService<Tx>;
  readonly comms: StatusCommsService<Tx>;
  readonly silentBay: SilentBaySentinel<Tx>;
  readonly delivery: DeliveryService<Tx>;
  readonly invoices: InvoiceService<Tx>;
  readonly payments: PaymentService<Tx>;
  readonly gatePasses: GatePassService<Tx>;
  /** The provider, so the webhook controller can verify a signature. */
  readonly paymentsPort: PaymentsPort;
  readonly parser: StatusSignalParser;
  /**
   * What `InboundHandler` calls when a note lands in the staff group.
   *
   * Assembled here so the API's webhook, the console's sandbox and the demo
   * runner all read a technician's note through the same recogniser, the same
   * parser and the same routing rules.
   */
  readonly notes: TechnicianNotePort;
}

export function createLoopRuntime<Tx>(input: LoopRuntimeInput<Tx>): LoopRuntime<Tx> {
  const { stores, gate } = input;
  const withClock = input.clock === undefined ? {} : { clock: input.clock };

  /**
   * The shop's own guardrail document, migrated forward on read.
   *
   * Every service loads it per call rather than closing over a value — the same
   * correction phase 3 had to make when `adjust_offer` was judging every shop
   * against the defaults (deviation, bug 2).
   */
  const loadConfig = async (tx: Tx, shopId: string): Promise<ShopConfig> => {
    const stored = await stores.config.load(tx, shopId);
    const timezone = (await stores.config.loadShopTimezone(tx, shopId)) ?? 'Asia/Kolkata';
    return migrateShopConfig(stored?.raw ?? {}, timezone).config;
  };

  const eta = new EtaService<Tx>({
    uow: stores.uow,
    eta: stores.eta,
    cards: stores.cards,
    audit: stores.audit,
    outbox: stores.outbox,
    loadConfig,
    ...withClock,
  });

  const signals = new StatusSignalService<Tx>({
    uow: stores.uow,
    signals: stores.signals,
    resolver: stores.resolver,
    cards: stores.cards,
    jobCards: input.jobCards,
    workItems: input.workItems,
    eta,
    gate,
    audit: stores.audit,
    outbox: stores.outbox,
    loadConfig,
    ...(input.routeToEvidence === undefined
      ? {}
      : { routeToEvidence: input.routeToEvidence }),
    ...withClock,
  });

  const comms = new StatusCommsService<Tx>({
    uow: stores.uow,
    eta: stores.eta,
    comms: stores.comms,
    cards: stores.cards,
    conversations: stores.conversations,
    directory: stores.directory,
    gate,
    audit: stores.audit,
    loadConfig,
    ...withClock,
  });

  const silentBay = new SilentBaySentinel<Tx>({
    uow: stores.uow,
    bays: stores.bays,
    conversations: stores.conversations,
    gate,
    audit: stores.audit,
    outbox: stores.outbox,
    loadConfig,
    ...withClock,
  });

  const delivery = new DeliveryService<Tx>({
    uow: stores.uow,
    bookings: stores.bookings,
    cards: stores.cards,
    conversations: stores.conversations,
    directory: stores.directory,
    gate,
    audit: stores.audit,
    outbox: stores.outbox,
    loadConfig,
    amountDue: input.amountDue,
    ...withClock,
  });

  const invoices = new InvoiceService<Tx>({
    uow: stores.uow,
    invoices: stores.invoices,
    cards: stores.cards,
    directory: stores.directory,
    renderer: input.renderer,
    media: input.media,
    audit: stores.audit,
    outbox: stores.outbox,
    loadConfig,
    loadThumbnails: input.loadThumbnails,
    ...withClock,
  });

  const payments = new PaymentService<Tx>({
    uow: stores.uow,
    payments: stores.payments,
    invoices: stores.invoices,
    cards: stores.cards,
    conversations: stores.conversations,
    jobCards: input.jobCards,
    gate,
    gateway: input.payments,
    audit: stores.audit,
    outbox: stores.outbox,
    loadConfig,
    customerPhone: input.customerPhone,
    ...(input.tasks === undefined ? {} : { tasks: input.tasks }),
    ...withClock,
  });

  const gatePasses = new GatePassService<Tx>({
    uow: stores.uow,
    passes: stores.passes,
    payments: stores.payments,
    cards: stores.cards,
    conversations: stores.conversations,
    directory: stores.directory,
    gate,
    audit: stores.audit,
    outbox: stores.outbox,
    loadConfig,
    secret: input.gatePassSecret,
    media: input.media,
    ...(input.qr === undefined ? {} : { qr: input.qr }),
    ...withClock,
  });

  /**
   * Registrations of the cars in the workshop right now, as recogniser hints.
   *
   * Sourced from the silent-bay store's active-card scan rather than a new
   * query: "which cards are open and being worked on" is a question this system
   * already asks every few minutes, and asking it a second way is how two
   * answers start to disagree.
   */
  const hints = async (shopId: string): Promise<readonly string[]> => {
    const cards = await stores.uow.transaction((tx) => stores.bays.activeCards(tx, shopId));
    return cards.map((card) => card.registration);
  };

  const notes = new TechnicianNoteIngestor<Tx>({
    speech: input.speech,
    parser: input.parser,
    signals,
    hints,
    timezone: async (shopId) =>
      (await stores.uow.transaction((tx) => stores.config.loadShopTimezone(tx, shopId))) ??
      'Asia/Kolkata',
    ...withClock,
  });

  return {
    eta,
    signals,
    comms,
    silentBay,
    delivery,
    invoices,
    payments,
    gatePasses,
    paymentsPort: input.payments,
    parser: input.parser,
    notes,
  };
}
