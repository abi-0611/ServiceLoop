import type { LlmPort } from '@serviceloop/adapters';
import { migrateShopConfig, type ShopConfig } from '@serviceloop/config';
import {
  AdvisorTaskService,
  ApprovalReplyHandler,
  ApprovalService,
  APPROVAL_SUBJECT_TYPE,
  EscalationLadderEngine,
  EvidenceBundleBuilder,
  ReviewService,
  type Actor,
  type AdvisorTaskStore,
  type AgentRunStore,
  type ApprovalStore,
  type AuditAppender,
  type ChannelSender,
  type ConversationStore,
  type EscalationStore,
  type EtaStore,
  type EvidenceBundleStore,
  type ExplanationWriter,
  type JobCardContextReader,
  type JobCardTransitionService,
  type MediaBytesLoader,
  type MessageSnapshot,
  type MessageStore,
  type OutboundGate,
  type OutboxWriter,
  type PriceListReader,
  type ReviewStore,
  type RungScheduler,
  type ScheduledMessage,
  type ShopConfigStore,
  type ShopDirectory,
  type UnitOfWork,
  type WorkItemTransitionService,
} from '@serviceloop/domain';
import type { Clock } from '@serviceloop/shared';
import { DeterministicExplanationWriter, LlmExplanationWriter } from './explanation-writer';
import { PostChecker } from './post-checker';
import { AgentRunner } from './runner';
import { buildToolRegistry } from './tools';
import type { ToolRegistry } from './tool-registry';

/**
 * The phase-3 composition root.
 *
 * Three processes want the identical set — the API, the workers and the demo
 * runner — and each assembling it by hand is how they drift: one ends up with
 * the deterministic explanation writer while another is on the live one, and a
 * bug reproduces in only one of them. This is the same reasoning that put
 * `createChannelPorts` in `packages/adapters` in phase 2.
 *
 * What it deliberately does *not* own: the transaction handle, the channel
 * sender, the delayed-job queue and the stores. Those are the caller's, because
 * they are the things that differ between a worker with a BullMQ connection and
 * a demo runner with an in-memory one.
 */

export interface AgentRuntimeStores<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly runs: AgentRunStore<Tx>;
  readonly cards: JobCardContextReader<Tx>;
  readonly prices: PriceListReader<Tx>;
  readonly bundles: EvidenceBundleStore<Tx>;
  readonly approvals: ApprovalStore<Tx>;
  readonly escalations: EscalationStore<Tx>;
  readonly tasks: AdvisorTaskStore<Tx>;
  readonly reviews: ReviewStore<Tx>;
  readonly conversations: ConversationStore<Tx>;
  readonly messages: MessageStore<Tx>;
  readonly config: ShopConfigStore<Tx>;
  readonly directory: ShopDirectory<Tx>;
  readonly audit: AuditAppender<Tx>;
  readonly outbox: OutboxWriter<Tx>;
  /** Phase 4.3's history, for the `answer_status` objective's grounding. */
  readonly eta?: EtaStore<Tx>;
}

export interface AgentRuntimeInput<Tx> {
  readonly stores: AgentRuntimeStores<Tx>;
  readonly gate: OutboundGate<Tx>;
  readonly jobCards: JobCardTransitionService<Tx>;
  readonly workItems: WorkItemTransitionService<Tx>;
  readonly scheduler: RungScheduler;
  readonly llm: LlmPort;
  /**
   * A fallback guardrail document, used only where a shop context is absent.
   *
   * Tools load the shop's own document per call; this is what the runtime
   * reports in its prompt when no row exists yet.
   */
  readonly config: ShopConfig;
  /** The last few turns of a thread, for the prompt and the context tool. */
  readonly conversationTail: (
    tx: Tx,
    shopId: string,
    conversationId: string,
    limit: number,
  ) => Promise<readonly MessageSnapshot[]>;
  /** Reloads a held message so the review queue re-sends the audited words. */
  readonly loadHeld: (
    tx: Tx,
    shopId: string,
    messageId: string,
  ) => Promise<ScheduledMessage | null>;
  readonly resolvePinnedCard: (
    tx: Tx,
    shopId: string,
    messageId: string,
  ) => Promise<string | null>;
  readonly scheduleFollowup: (input: {
    readonly shopId: string;
    readonly conversationId: string;
    readonly at: Date;
    readonly objective: string;
    readonly traceId: string;
  }) => Promise<string>;
  readonly openObjectionObjective: (input: {
    readonly shopId: string;
    readonly conversationId: string;
    readonly customerId: string | null;
    readonly jobCardId: string | null;
    readonly approvalId: string;
    readonly triggerMessageId: string | null;
    readonly traceId: string;
  }) => Promise<void>;
  readonly channelSender?: ChannelSender;
  readonly media?: MediaBytesLoader;
  /**
   * Overrides the explanation writer. The default is the live one when a model
   * is configured and the deterministic one otherwise, so CI and the demo
   * produce a real, correctly-anchored bundle with no key.
   */
  readonly explanations?: ExplanationWriter;
  readonly clock?: Clock;
}

export interface AgentRuntime<Tx> {
  readonly runner: AgentRunner<Tx>;
  readonly registry: ToolRegistry;
  readonly checker: PostChecker;
  readonly approvals: ApprovalService<Tx>;
  readonly replies: ApprovalReplyHandler<Tx>;
  readonly ladder: EscalationLadderEngine<Tx>;
  readonly bundles: EvidenceBundleBuilder<Tx>;
  readonly reviews: ReviewService<Tx>;
  readonly tasks: AdvisorTaskService<Tx>;
}

export function createAgentRuntime<Tx>(input: AgentRuntimeInput<Tx>): AgentRuntime<Tx> {
  const { stores, gate, llm, clock } = input;
  const withClock = clock === undefined ? {} : { clock };

  const tasks = new AdvisorTaskService<Tx>({
    uow: stores.uow,
    tasks: stores.tasks,
    audit: stores.audit,
    outbox: stores.outbox,
    ...withClock,
  });

  const bundles = new EvidenceBundleBuilder<Tx>({
    uow: stores.uow,
    bundles: stores.bundles,
    cards: stores.cards,
    explanations:
      input.explanations ??
      // The sandbox adapter cannot write prose worth reading, so a sandboxed
      // deployment gets the deterministic writer rather than an echo dressed up
      // as an explanation.
      (llm.driver === 'anthropic'
        ? new LlmExplanationWriter(llm)
        : new DeterministicExplanationWriter()),
    audit: stores.audit,
    outbox: stores.outbox,
    resolvePinnedCard: input.resolvePinnedCard,
    ...withClock,
  });

  const ladder = new EscalationLadderEngine<Tx>({
    uow: stores.uow,
    escalations: stores.escalations,
    approvals: stores.approvals,
    bundles: stores.bundles,
    cards: stores.cards,
    tasks: stores.tasks,
    conversations: stores.conversations,
    config: stores.config,
    gate,
    scheduler: input.scheduler,
    audit: stores.audit,
    outbox: stores.outbox,
    ...withClock,
  });

  const approvals = new ApprovalService<Tx>({
    uow: stores.uow,
    approvals: stores.approvals,
    bundles: stores.bundles,
    cards: stores.cards,
    messages: stores.messages,
    gate,
    jobCards: input.jobCards,
    workItems: input.workItems,
    directory: stores.directory,
    audit: stores.audit,
    outbox: stores.outbox,
    // A decision must stop the chase *and* clear the advisor's list: a customer
    // who approved at 14:05 leaving a "call now" task at 14:30 spends the one
    // thing the queue runs on, which is an advisor's trust in it.
    cancelLadder: async (cancel: {
      shopId: string;
      approvalId: string;
      reason: string;
      actor: Actor;
      traceId: string;
    }) => {
      await ladder.cancelForSubject({
        shopId: cancel.shopId,
        subjectType: APPROVAL_SUBJECT_TYPE,
        subjectId: cancel.approvalId,
        reason: cancel.reason,
        actor: cancel.actor,
        traceId: cancel.traceId,
      });
      await tasks.cancelForApproval({
        shopId: cancel.shopId,
        approvalId: cancel.approvalId,
        traceId: cancel.traceId,
      });
    },
    ...withClock,
  });

  const replies = new ApprovalReplyHandler<Tx>({
    uow: stores.uow,
    approvals,
    approvalStore: stores.approvals,
    cards: stores.cards,
    conversations: stores.conversations,
    tasks,
    directory: stores.directory,
    gate,
    openObjectionObjective: input.openObjectionObjective,
    ...withClock,
  });

  const reviews = new ReviewService<Tx>({
    uow: stores.uow,
    reviews: stores.reviews,
    messages: stores.messages,
    gate,
    config: stores.config,
    audit: stores.audit,
    outbox: stores.outbox,
    loadHeld: input.loadHeld,
    ...(input.media === undefined ? {} : { media: input.media }),
    ...withClock,
  });

  const checker = new PostChecker(llm);

  const registry = buildToolRegistry<Tx>({
    uow: stores.uow,
    cards: stores.cards,
    bundles: stores.bundles,
    bundleBuilder: bundles,
    approvals,
    tasks,
    gate,
    prices: stores.prices,
    checker,
    // Loaded per call from the shop's own document, migrated forward on read —
    // the same path the outbound gate takes.
    loadConfig: async (tx, shopId) => {
      const stored = await stores.config.load(tx, shopId);
      const timezone = (await stores.config.loadShopTimezone(tx, shopId)) ?? 'Asia/Kolkata';
      return migrateShopConfig(stored?.raw ?? {}, timezone).config;
    },
    // The bundle the agent may cite: the newest one for this card.
    activeBundle: (tx, shopId, jobCardId) =>
      stores.bundles.findLatestForJobCard(tx, shopId, jobCardId),
    conversationTail: input.conversationTail,
    // Phase 4.5. Optional: a deployment without the ETA engine keeps the
    // phase-3 objectives and `get_eta` refuses honestly rather than
    // reassuring a customer from an empty history.
    ...(stores.eta === undefined
      ? {}
      : {
          etaHistory: (tx: Tx, shopId: string, jobCardId: string, limit: number) =>
            stores.eta?.history(tx, shopId, jobCardId, limit) ?? Promise.resolve([]),
        }),
    scheduleFollowup: input.scheduleFollowup,
  });

  const runner = new AgentRunner<Tx>({
    uow: stores.uow,
    llm,
    runs: stores.runs,
    conversations: stores.conversations,
    registry,
    audit: stores.audit,
    outbox: stores.outbox,
    ...withClock,
  });

  return { runner, registry, checker, approvals, replies, ladder, bundles, reviews, tasks };
}
