import { defaultShopConfig, type ShopConfig } from '@serviceloop/config';
import { uuidv7, type Clock, type Language } from '@serviceloop/shared';
import type { AdvisorTaskCreator } from '../delivery/ports';
import { ConsentService } from '../messaging/consent';
import { AlertService } from '../retention/alert-service';
import { DigestService } from '../retention/digest-service';
import { FeedbackService } from '../retention/feedback-service';
import { LedgerService } from '../retention/ledger-service';
import { MarketingConsentService } from '../retention/marketing-consent';
import { MetricsService } from '../retention/metrics-service';
import { ReminderService } from '../retention/reminder-service';
import { RetentionService } from '../retention/retention-service';
import { createLoopHarness, LOOP_CUSTOMER, LOOP_SHOP, type LoopHarness } from './loop-harness';
import type { MemoryTx } from './in-memory';
import {
  InMemoryAlertStore,
  InMemoryEventLogReader,
  InMemoryFeedbackStore,
  InMemoryLedgerStore,
  InMemoryOdometerStore,
  InMemoryOwnerDigestStore,
  InMemoryRetentionDirectory,
  InMemoryRetentionFrequencyReader,
  InMemoryRetentionHoldStore,
  InMemoryRetentionTouchStore,
  InMemoryRollupStore,
  InMemoryServiceDueStore,
  InMemoryVehicleDocumentStore,
  RetentionWorld,
} from './in-memory-retention';
import { InMemoryConsentStore, InMemoryConversationStore } from './in-memory-messaging';

/**
 * The phase-6 services, wired to the in-memory doubles (phase 6).
 *
 * Built on `createLoopHarness` rather than beside it, and that reuse is the
 * point: retention is the *end* of the same loop, so a test about a re-pitch
 * runs against the same shop, the same customer, the same thread and the same
 * gate that phases 2 to 4 wrote to. A separate world would let a re-pitch pass
 * a consent check no real customer had ever answered.
 *
 * Everything is on a fake clock, and here that is not a nicety — three of the
 * four triggers are *about* time. The season trigger has to be testable in
 * August; the horizon has to be reachable without waiting seventy-five days.
 */

export const RETENTION_VEHICLE = '01920000-0000-7000-8000-0000000000c1';
export const RETENTION_OWNER = '01920000-0000-7000-8000-000000000a01';
export const OWNER_CONVERSATION = '01920000-0000-7000-8000-000000000f01';

export interface RetentionHarness {
  readonly loop: LoopHarness;
  readonly world: RetentionWorld;
  readonly ledger: LedgerService<MemoryTx>;
  readonly retention: RetentionService<MemoryTx>;
  readonly feedback: FeedbackService<MemoryTx>;
  readonly reminders: ReminderService<MemoryTx>;
  readonly marketing: MarketingConsentService<MemoryTx>;
  readonly digest: DigestService<MemoryTx>;
  readonly alerts: AlertService<MemoryTx>;
  readonly metrics: MetricsService<MemoryTx>;
  readonly ledgerStore: InMemoryLedgerStore;
  readonly touchStore: InMemoryRetentionTouchStore;
  readonly holdStore: InMemoryRetentionHoldStore;
  readonly odometerStore: InMemoryOdometerStore;
  readonly feedbackStore: InMemoryFeedbackStore;
  readonly documentStore: InMemoryVehicleDocumentStore;
  readonly forecastStore: InMemoryServiceDueStore;
  /** Tasks the recovery and alert paths raised, in order. */
  readonly tasks: { id: string; kind: string; brief: string; dedupeKey: string | null }[];
  now(): Date;
  setNow(at: Date): void;
  advanceDays(days: number): void;
  sentBodies(): readonly string[];
}

export interface RetentionHarnessOptions {
  readonly configPatch?: Partial<ShopConfig>;
  readonly language?: Language;
}

/**
 * Retention on, feedback on, and the autonomy that lets templated copy out.
 *
 * A harness that shipped the production defaults would test one sentence over
 * and over — "retention is disabled" — which is worth exactly one assertion and
 * has one, in the suite. Everything else needs the shop to have opted in, which
 * is the state a shop running this feature is actually in.
 */
export function retentionConfig(patch: Partial<ShopConfig> = {}): Partial<ShopConfig> {
  const base = defaultShopConfig('Asia/Kolkata');
  return {
    autonomy: { ...base.autonomy, status: 'L1_TEMPLATED', delivery: 'L1_TEMPLATED', retention: 'L1_TEMPLATED' },
    retention: {
      ...base.retention,
      enabled: true,
      serviceDue: { ...base.retention.serviceDue, enabled: true },
      documents: { ...base.retention.documents, enabled: true },
      winBack: { ...base.retention.winBack, enabled: true },
    },
    feedback: {
      ...base.feedback,
      enabled: true,
      reviewLink: 'https://g.page/r/sri-murugan-auto/review',
      askForReviewOnPositive: true,
    },
    // A registered re-engagement template, because a shop running retention has
    // one. A re-pitch is business-initiated and usually months late, so the
    // 24-hour window is shut and the template is the only shape WhatsApp will
    // carry — a harness without one would test a shop that cannot re-pitch.
    messaging: { ...base.messaging, templates: { ...base.messaging.templates, reengagement: 'retention_repitch' } },
    ...patch,
  };
}

export function createRetentionHarness(
  options: RetentionHarnessOptions = {},
): RetentionHarness {
  const world = new RetentionWorld();
  const reader = new InMemoryRetentionFrequencyReader(world);

  const loop = createLoopHarness({
    configPatch: retentionConfig(options.configPatch),
    ...(options.language === undefined ? {} : { language: options.language }),
    retention: reader,
  });

  const base = loop.base;
  const clock: Clock = { now: () => loop.now() };
  const conversations = new InMemoryConversationStore(base.world);

  const ledgerStore = new InMemoryLedgerStore(world);
  const touchStore = new InMemoryRetentionTouchStore(world);
  const holdStore = new InMemoryRetentionHoldStore(world);
  const odometerStore = new InMemoryOdometerStore(world);
  const feedbackStore = new InMemoryFeedbackStore(world);
  const documentStore = new InMemoryVehicleDocumentStore(world);
  const forecastStore = new InMemoryServiceDueStore(world);
  const digestStore = new InMemoryOwnerDigestStore(world);
  const alertStore = new InMemoryAlertStore(world);
  const rollupStore = new InMemoryRollupStore(world);
  const directory = new InMemoryRetentionDirectory(world);
  const events = new InMemoryEventLogReader(() => base.world.outbox);

  const loadConfig = async (): Promise<ShopConfig> =>
    (base.world.configs.get(LOOP_SHOP) as ShopConfig | undefined) ??
    defaultShopConfig('Asia/Kolkata');

  const tasks: RetentionHarness['tasks'] = [];
  const taskCreator: AdvisorTaskCreator = {
    create: async (input) => {
      // The `advisor_tasks_dedupe_key` unique index, in miniature: a recovery
      // task raised twice for one complaint is one task.
      const existing = tasks.find(
        (task) => input.dedupeKey != null && task.dedupeKey === input.dedupeKey,
      );
      if (existing !== undefined) return existing.id;
      const id = uuidv7();
      tasks.push({
        id,
        kind: input.kind,
        brief: input.brief,
        dedupeKey: input.dedupeKey ?? null,
      });
      return id;
    },
  };

  const ledger = new LedgerService<MemoryTx>({
    uow: base.uow,
    ledger: ledgerStore,
    audit: base.audit,
    outbox: base.outbox,
    loadConfig,
    clock,
  });

  const retention = new RetentionService<MemoryTx>({
    uow: base.uow,
    ledger: ledgerStore,
    ledgerService: ledger,
    touches: touchStore,
    holds: holdStore,
    odometer: odometerStore,
    directory,
    conversations,
    shops: base.directory,
    gate: loop.gate,
    audit: base.audit,
    outbox: base.outbox,
    loadConfig,
    openVisits: async () => world.openVisits,
    clock,
  });

  const alerts = new AlertService<MemoryTx>({
    uow: base.uow,
    alerts: alertStore,
    directory,
    conversations,
    shops: base.directory,
    gate: loop.gate,
    audit: base.audit,
    outbox: base.outbox,
    loadConfig,
    tasks: taskCreator,
    clock,
  });

  const feedback = new FeedbackService<MemoryTx>({
    uow: base.uow,
    feedback: feedbackStore,
    holds: holdStore,
    directory,
    conversations,
    shops: base.directory,
    gate: loop.gate,
    audit: base.audit,
    outbox: base.outbox,
    loadConfig,
    tasks: taskCreator,
    alerts: {
      raise: async (input) =>
        alerts.negativeFeedback({
          shopId: input.shopId,
          incidentKey: input.incidentKey,
          subjectId: input.subjectId,
          detail: input.detail,
          customerId: input.customerId,
          jobCardId: input.jobCardId,
          traceId: input.traceId,
        }),
    },
    clock,
  });

  const reminders = new ReminderService<MemoryTx>({
    uow: base.uow,
    forecasts: forecastStore,
    documents: documentStore,
    touches: touchStore,
    holds: holdStore,
    odometer: odometerStore,
    directory,
    conversations,
    shops: base.directory,
    gate: loop.gate,
    audit: base.audit,
    outbox: base.outbox,
    loadConfig,
    clock,
  });

  const marketing = new MarketingConsentService<MemoryTx>({
    uow: base.uow,
    consents: new ConsentService<MemoryTx>({
      uow: base.uow,
      consents: new InMemoryConsentStore(base.world),
      audit: base.audit,
      outbox: base.outbox,
      clock,
    }),
    conversations,
    directory,
    shops: base.directory,
    gate: loop.gate,
    audit: base.audit,
    loadConfig,
    clock,
  });

  const metrics = new MetricsService<MemoryTx>({
    uow: base.uow,
    events,
    rollups: rollupStore,
    audit: base.audit,
    outbox: base.outbox,
    loadConfig,
    clock,
  });

  const digest = new DigestService<MemoryTx>({
    uow: base.uow,
    digests: digestStore,
    metrics,
    directory,
    conversations,
    shops: base.directory,
    gate: loop.gate,
    audit: base.audit,
    outbox: base.outbox,
    loadConfig,
    cardLabels: async (_tx, _shopId, jobCardIds) => {
      const labels = new Map<string, string>();
      for (const jobCardId of jobCardIds) {
        const vehicleId = world.vehicleByJobCard.get(jobCardId);
        const vehicle = vehicleId === undefined ? undefined : world.vehicleRows.get(vehicleId);
        labels.set(jobCardId, vehicle?.label ?? 'Unknown vehicle');
      }
      return labels;
    },
    tasks: taskCreator,
    // The same injection the composition root makes, so the harness proves the
    // wiring the API and the worker actually get rather than a simpler one.
    resolveAlert: async (input) => alerts.resolve(input),
    clock,
  });

  /* --- the world the services read ------------------------------------- */

  world.customerRows.set(LOOP_CUSTOMER, {
    id: LOOP_CUSTOMER,
    name: 'Lakshmi',
    language: options.language ?? 'en',
    lastVisitAt: loop.now(),
  });
  world.vehicleRows.set(RETENTION_VEHICLE, {
    id: RETENTION_VEHICLE,
    label: 'Maruti Swift',
    registration: 'TN09BX4432',
    customerId: LOOP_CUSTOMER,
    modelYear: 2019,
  });
  world.ownerRows.push({
    shopId: LOOP_SHOP,
    staffId: RETENTION_OWNER,
    name: 'Kumar',
    language: 'en',
  });
  world.ownerShops.set(RETENTION_OWNER, [{ shopId: LOOP_SHOP, name: 'Sri Murugan Auto Works' }]);

  // The owner's own thread. A digest and an alert both need somewhere to land,
  // and `staff:<id>` is the thread key the digest service looks them up by.
  base.world.conversations.set(OWNER_CONVERSATION, {
    id: OWNER_CONVERSATION,
    shopId: LOOP_SHOP,
    kind: 'STAFF_GROUP',
    channel: 'WHATSAPP',
    customerId: null,
    externalThreadId: `staff:${RETENTION_OWNER}`,
    externalAddress: '+919840012001',
    displayName: 'Kumar (owner)',
    state: 'OPEN',
    language: 'en',
    lastInboundAt: null,
    lastOutboundAt: null,
    windowExpiresAt: new Date(loop.now().getTime() + 365 * 24 * 60 * 60 * 1000),
    unreadCount: 0,
    humanOverrideAt: null,
  });

  return {
    loop,
    world,
    ledger,
    retention,
    feedback,
    reminders,
    marketing,
    digest,
    alerts,
    metrics,
    ledgerStore,
    touchStore,
    holdStore,
    odometerStore,
    feedbackStore,
    documentStore,
    forecastStore,
    tasks,
    now: () => loop.now(),
    setNow: (at) => loop.setNow(at),
    advanceDays: (days) => loop.advanceMinutes(days * 24 * 60),
    sentBodies: () => loop.sentBodies(),
  };
}
