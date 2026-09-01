import { migrateShopConfig, type ShopConfig } from '@serviceloop/config';
import {
  AlertService,
  DigestService,
  FeedbackService,
  LedgerService,
  MarketingConsentService,
  MetricsService,
  ReminderService,
  RetentionService,
  type AdvisorTaskCreator,
  type AlertStore,
  type AuditAppender,
  type ConsentService,
  type ConversationStore,
  type EventLogReader,
  type FeedbackStore,
  type LedgerStore,
  type OdometerStore,
  type OutboundGate,
  type OutboxWriter,
  type OwnerDigestStore,
  type PriceListReader,
  type RetentionDirectory,
  type RetentionReplyPort,
  type RetentionHoldStore,
  type RetentionTouchStore,
  type RollupStore,
  type ServiceDueStore,
  type ShopConfigStore,
  type ShopDirectory,
  type UnitOfWork,
  type VehicleDocumentStore,
} from '@serviceloop/domain';
import type { Clock } from '@serviceloop/shared';

/**
 * The phase-6 composition root.
 *
 * Here for the reason `createAgentRuntime` and `createLoopRuntime` are: the
 * API, the workers and the demo runner all want the identical set of services,
 * and each assembling it by hand is how they drift — one process ends up with a
 * feedback service that has no alerter, and a shop's bad reviews stop waking
 * anybody in exactly one deployment.
 *
 * Two wirings inside it are worth naming, because both are cycles the type
 * system would otherwise have let somebody close by hand:
 *
 *   - **The feedback service alerts through the alert service**, injected as a
 *     `NegativeFeedbackAlerter` rather than imported. 6.4 does not depend on
 *     6.8; it depends on "something that can interrupt an owner", and there is
 *     exactly one of those.
 *   - **The digest reads the metrics service**, never the tables. That is the
 *     "one source of numeric truth" requirement made structural: there is no
 *     handle on `DigestService` that could reach a live query even if somebody
 *     wanted one.
 */

export interface RetentionStores<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly ledger: LedgerStore<Tx>;
  readonly touches: RetentionTouchStore<Tx>;
  readonly holds: RetentionHoldStore<Tx>;
  readonly odometer: OdometerStore<Tx>;
  readonly feedback: FeedbackStore<Tx>;
  readonly forecasts: ServiceDueStore<Tx>;
  readonly documents: VehicleDocumentStore<Tx>;
  readonly digests: OwnerDigestStore<Tx>;
  readonly alerts: AlertStore<Tx>;
  readonly events: EventLogReader<Tx>;
  readonly rollups: RollupStore<Tx>;
  readonly directory: RetentionDirectory<Tx>;
  readonly conversations: ConversationStore<Tx>;
  readonly shops: ShopDirectory<Tx>;
  readonly config: ShopConfigStore<Tx>;
  readonly audit: AuditAppender<Tx>;
  readonly outbox: OutboxWriter<Tx>;
}

export interface RetentionRuntimeInput<Tx> {
  readonly stores: RetentionStores<Tx>;
  readonly gate: OutboundGate<Tx>;
  readonly consents: ConsentService<Tx>;
  /** Cards open right now by vehicle — the next-visit trigger's only input. */
  readonly openVisits: (tx: Tx, shopId: string) => Promise<ReadonlyMap<string, string>>;
  /** Vehicle labels for the digest's stuck-approval lines. */
  readonly cardLabels: (
    tx: Tx,
    shopId: string,
    jobCardIds: readonly string[],
  ) => Promise<ReadonlyMap<string, string>>;
  /** Raises recovery and owner-exception tasks (L6). */
  readonly tasks?: AdvisorTaskCreator;
  /** The shop's live price list, so a moved price is stated rather than hidden. */
  readonly prices?: PriceListReader<Tx>;
  readonly clock?: Clock;
}

export interface RetentionRuntime<Tx> {
  readonly ledger: LedgerService<Tx>;
  readonly retention: RetentionService<Tx>;
  readonly feedback: FeedbackService<Tx>;
  readonly reminders: ReminderService<Tx>;
  readonly marketing: MarketingConsentService<Tx>;
  readonly digest: DigestService<Tx>;
  readonly alerts: AlertService<Tx>;
  readonly metrics: MetricsService<Tx>;
  /**
   * What the five taps do, in the shape `InboundHandler` asks for.
   *
   * Assembled here rather than in the API's module so that the process which
   * *receives* the taps and the process which *sends* the messages carrying
   * them cannot disagree about what a button id means.
   */
  readonly replies: RetentionReplyPort;
}

export function createRetentionRuntime<Tx>(
  input: RetentionRuntimeInput<Tx>,
): RetentionRuntime<Tx> {
  const { stores, gate } = input;
  const withClock = input.clock === undefined ? {} : { clock: input.clock };

  /** The shop's own guardrail document, migrated forward on read, per call. */
  const loadConfig = async (tx: Tx, shopId: string): Promise<ShopConfig> => {
    const stored = await stores.config.load(tx, shopId);
    const timezone = (await stores.config.loadShopTimezone(tx, shopId)) ?? 'Asia/Kolkata';
    return migrateShopConfig(stored?.raw ?? {}, timezone).config;
  };

  const ledger = new LedgerService<Tx>({
    uow: stores.uow,
    ledger: stores.ledger,
    audit: stores.audit,
    outbox: stores.outbox,
    loadConfig,
    ...withClock,
  });

  const alerts = new AlertService<Tx>({
    uow: stores.uow,
    alerts: stores.alerts,
    directory: stores.directory,
    conversations: stores.conversations,
    shops: stores.shops,
    gate,
    audit: stores.audit,
    outbox: stores.outbox,
    loadConfig,
    ...(input.tasks === undefined ? {} : { tasks: input.tasks }),
    ...withClock,
  });

  const retention = new RetentionService<Tx>({
    uow: stores.uow,
    ledger: stores.ledger,
    ledgerService: ledger,
    touches: stores.touches,
    holds: stores.holds,
    odometer: stores.odometer,
    directory: stores.directory,
    conversations: stores.conversations,
    shops: stores.shops,
    gate,
    audit: stores.audit,
    outbox: stores.outbox,
    loadConfig,
    openVisits: input.openVisits,
    ...(input.prices === undefined ? {} : { prices: input.prices }),
    ...withClock,
  });

  const feedback = new FeedbackService<Tx>({
    uow: stores.uow,
    feedback: stores.feedback,
    holds: stores.holds,
    directory: stores.directory,
    conversations: stores.conversations,
    shops: stores.shops,
    gate,
    audit: stores.audit,
    outbox: stores.outbox,
    loadConfig,
    ...(input.tasks === undefined ? {} : { tasks: input.tasks }),
    // Injected, not imported: 6.4 depends on "something that can interrupt an
    // owner", and 6.8 is the one thing that can.
    alerts: {
      raise: async (raiseInput) =>
        alerts.negativeFeedback({
          shopId: raiseInput.shopId,
          incidentKey: raiseInput.incidentKey,
          subjectId: raiseInput.subjectId,
          detail: raiseInput.detail,
          customerId: raiseInput.customerId,
          jobCardId: raiseInput.jobCardId,
          traceId: raiseInput.traceId,
        }),
    },
    ...withClock,
  });

  const reminders = new ReminderService<Tx>({
    uow: stores.uow,
    forecasts: stores.forecasts,
    documents: stores.documents,
    touches: stores.touches,
    holds: stores.holds,
    odometer: stores.odometer,
    directory: stores.directory,
    conversations: stores.conversations,
    shops: stores.shops,
    gate,
    audit: stores.audit,
    outbox: stores.outbox,
    loadConfig,
    ...withClock,
  });

  const marketing = new MarketingConsentService<Tx>({
    uow: stores.uow,
    consents: input.consents,
    conversations: stores.conversations,
    directory: stores.directory,
    shops: stores.shops,
    gate,
    audit: stores.audit,
    loadConfig,
    ...withClock,
  });

  const metrics = new MetricsService<Tx>({
    uow: stores.uow,
    events: stores.events,
    rollups: stores.rollups,
    audit: stores.audit,
    outbox: stores.outbox,
    loadConfig,
    ...withClock,
  });

  const digest = new DigestService<Tx>({
    uow: stores.uow,
    digests: stores.digests,
    metrics,
    directory: stores.directory,
    conversations: stores.conversations,
    shops: stores.shops,
    gate,
    audit: stores.audit,
    outbox: stores.outbox,
    loadConfig,
    cardLabels: input.cardLabels,
    ...(input.tasks === undefined ? {} : { tasks: input.tasks }),
    // The other injected edge, and the same reasoning as the feedback service's
    // alerter: an owner claiming a line should stop the 6.8 stream raising it,
    // and 6.7 gets told how to do that rather than importing 6.8.
    resolveAlert: async (resolveInput) => alerts.resolve(resolveInput),
    ...withClock,
  });

  const replies: RetentionReplyPort = {
    answerRepitch: async (tap) =>
      retention.recordResponse({
        shopId: tap.shopId,
        ledgerItemId: tap.ledgerItemId,
        response: tap.response,
        conversationId: tap.conversationId,
        customerId: tap.customerId,
        traceId: tap.traceId,
        actor: tap.actor,
      }),

    answerFeedback: async (tap) => {
      const result = await feedback.recordAnswer({
        shopId: tap.shopId,
        feedbackId: tap.feedbackId,
        sentiment: tap.sentiment,
        // The face is the answer; the words, if any, arrive as the next message
        // and are attached then. Passing an empty string here would overwrite a
        // comment a customer had already left.
        comment: null,
        conversationId: tap.conversationId,
        traceId: tap.traceId,
        actor: tap.actor,
      });
      return { handled: result.handled, detail: result.detail };
    },

    attachFeedbackComment: async (tap) => feedback.attachComment(tap),

    answerDocumentEnrolment: async (tap) => {
      if (!tap.enrol) {
        const revoked = await reminders.revokeEnrolment({
          shopId: tap.shopId,
          vehicleId: tap.vehicleId,
          traceId: tap.traceId,
          actor: tap.actor,
        });
        // Declining an offer nobody accepted is not a failure — it is the
        // customer saying no to a question, which is exactly what the button
        // is for. `handled` says the tap was understood, not that a row moved.
        return { handled: true, detail: `Document tracking off (${revoked} revoked)` };
      }

      const enrolled = await reminders.enrol({
        shopId: tap.shopId,
        vehicleId: tap.vehicleId,
        customerId: tap.customerId,
        conversationId: tap.conversationId,
        via: 'interactive_reply',
        traceId: tap.traceId,
        actor: tap.actor,
      });
      return {
        handled: enrolled > 0,
        detail:
          enrolled > 0
            ? `Tracking ${enrolled} document(s)`
            : 'No expiry dates on record for this vehicle yet',
      };
    },

    answerMarketingConsent: async (tap) => {
      const result = await marketing.decide({
        shopId: tap.shopId,
        customerId: tap.customerId,
        conversationId: tap.conversationId,
        decision: tap.decision,
        evidence: tap.evidence,
        traceId: tap.traceId,
        actor: tap.actor,
      });
      return { handled: result.recorded, detail: `MARKETING ${result.status}` };
    },

    recordVolunteeredOdometer: async (tap) =>
      retention.tryRecordVolunteeredOdometer({
        shopId: tap.shopId,
        customerId: tap.customerId,
        text: tap.text,
        messageId: tap.messageId,
        traceId: tap.traceId,
        actor: tap.actor,
      }),

    claimDigestLine: async (tap) => {
      const result = await digest.claim({
        shopId: tap.shopId,
        approvalId: tap.approvalId,
        claimedByStaffId: tap.claimedByStaffId,
        conversationId: tap.conversationId,
        traceId: tap.traceId,
        actor: tap.actor,
      });
      return { handled: result.claimed, detail: result.detail };
    },
  };

  return {
    ledger,
    retention,
    feedback,
    reminders,
    marketing,
    digest,
    alerts,
    metrics,
    replies,
  };
}
