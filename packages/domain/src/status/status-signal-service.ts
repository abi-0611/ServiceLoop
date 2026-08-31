import type { ShopConfig } from '@serviceloop/config';
import {
  systemClock,
  t,
  uuidv7,
  type Clock,
  type EventEnvelope,
  type JobCardEvent,
  type JobCardState,
  type Language,
  type StatusSignalRoute,
  type StatusSignalSource,
  type StatusSignalType,
} from '@serviceloop/shared';
import type { JobCardContext, JobCardContextReader } from '../agent/ports';
import type { Actor } from '../job-card/context';
import type { JobCardTransitionService } from '../job-card/transition-service';
import type { WorkItemTransitionService } from '../work-item/transition-service';
import type { OutboundGate } from '../messaging/outbound-gate';
import { STATUS_ACTION_IDS } from '../messaging/status-actions';
import type { OutboundButton, OutboundContent } from '../messaging/types';
import type { AuditAppender, OutboxWriter, UnitOfWork } from '../ports';
import { resolveCard, shouldAutoApply, type MatchOutcome } from './card-matching';
import type { EtaService } from './eta-service';
import type {
  CardCandidate,
  CardResolver,
  StatusSignalRecord,
  StatusSignalStore,
} from './ports';
import type { CaptureOutcome, ParsedStatusSignal } from './types';

/**
 * The status sentinel (phase 4.2).
 *
 * A technician says eight words into WhatsApp; this decides whether that is
 * enough to move a customer's job card on its own, and does it if so.
 *
 * The routing rule is the whole feature. At or above `AUTO_APPLY_CONFIDENCE`
 * with exactly one matching card, the signal applies itself: transitions,
 * audit, ETA recalculation, and the customer hears about it without anyone
 * touching a console. Below that, or with two cards in the running, it becomes
 * one tap for an advisor — *"Did Suresh mean: brake pads DONE on TN09BX4432?"*
 *
 * `issue_found` is the exception that proves the shape: it is not a status at
 * all. Finding new work needs the customer's money and therefore their consent,
 * so it leaves this module entirely and enters phase 3's evidence-bundle flow.
 */

export interface StatusSignalServiceDeps<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly signals: StatusSignalStore<Tx>;
  readonly resolver: CardResolver<Tx>;
  readonly cards: JobCardContextReader<Tx>;
  readonly jobCards: JobCardTransitionService<Tx>;
  readonly workItems: WorkItemTransitionService<Tx>;
  readonly eta: EtaService<Tx>;
  readonly gate: OutboundGate<Tx>;
  readonly audit: AuditAppender<Tx>;
  readonly outbox: OutboxWriter<Tx>;
  readonly loadConfig: (tx: Tx, shopId: string) => Promise<ShopConfig>;
  /**
   * Where an `issue_found` signal goes.
   *
   * Injected rather than called directly: the evidence-bundle builder lives in
   * `agent/`, which imports `OutboundGate` from `messaging/`, and a direct
   * import here would be one more edge in a graph that is currently acyclic.
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

export interface CaptureStatusSignalInput {
  readonly shopId: string;
  readonly parsed: ParsedStatusSignal;
  readonly source: StatusSignalSource;
  readonly transcript: string;
  readonly transcriptConfidence: number | null;
  readonly conversationId: string | null;
  readonly messageId: string | null;
  readonly mediaId: string | null;
  readonly senderStaffId: string | null;
  /** The staff-group message this note replied to, if any. */
  readonly replyToMessageId: string | null;
  readonly actor: Actor;
  readonly traceId: string;
}

export class StatusSignalService<Tx> {
  private readonly clock: Clock;

  constructor(private readonly deps: StatusSignalServiceDeps<Tx>) {
    this.clock = deps.clock ?? systemClock;
  }

  /**
   * Records a parsed signal and routes it.
   *
   * The row is written **whatever** the outcome, including when no card could
   * be found at all. A parser that only records its successes cannot be
   * measured, and "what fraction of technician notes did we understand" is a
   * number a shop should be able to see before it trusts this with a customer.
   */
  async capture(input: CaptureStatusSignalInput): Promise<CaptureOutcome> {
    const now = this.clock.now();
    const parsed = input.parsed;

    const resolution = await this.deps.uow.transaction(async (tx) =>
      this.matchCard(tx, input, parsed),
    );

    const matchedCard = resolution.kind === 'matched' ? resolution.card : null;
    const candidates = resolution.kind === 'ambiguous' ? resolution.candidates : [];

    const cardContext =
      matchedCard === null
        ? null
        : await this.deps.uow.transaction((tx) =>
            this.deps.cards.load(tx, input.shopId, matchedCard.jobCardId),
          );

    const workItemIds =
      cardContext === null ? [] : resolveWorkItems(parsed, cardContext).workItemIds;

    const route = decideRoute({
      signalType: parsed.signalType,
      confidence: parsed.confidence,
      resolution,
      workItemIds,
      hasCardContext: cardContext !== null,
    });

    const signalId = uuidv7();
    const inserted = await this.deps.uow.transaction(async (tx) =>
      this.deps.signals.insert(tx, {
        id: signalId,
        shopId: input.shopId,
        jobCardId: matchedCard?.jobCardId ?? null,
        conversationId: input.conversationId,
        messageId: input.messageId,
        mediaId: input.mediaId,
        senderStaffId: input.senderStaffId,
        signalType: parsed.signalType,
        source: input.source,
        route,
        confidence: parsed.confidence,
        transcript: input.transcript,
        language: parsed.language,
        transcriptConfidence: input.transcriptConfidence,
        workItemIds,
        etaHint: parsed.etaHint,
        candidateJobCardIds: candidates.map((candidate) => candidate.jobCardId),
        matchBasis: matchedCard?.basis ?? null,
        appliedDetail: null,
        createdAt: now,
      }),
    );

    if (inserted === null) {
      // The same staff-group message arriving twice. Meta retries aggressively,
      // and the second delivery must not close the same work item again.
      return {
        signalId: null,
        route: 'DISCARDED',
        jobCardId: matchedCard?.jobCardId ?? null,
        workItemIds: [],
        detail: 'This message had already been captured as a status signal',
        duplicate: true,
      };
    }

    await this.audit(input, signalId, route, matchedCard, parsed);
    await this.emitCaptured(input, signalId, route, matchedCard, workItemIds, parsed, now);

    switch (route) {
      case 'AUTO_APPLIED':
        return this.applySignal({
          input,
          signalId,
          card: matchedCard as CardCandidate,
          context: cardContext as JobCardContext,
          workItemIds,
          parsed,
        });

      case 'ROUTED_TO_EVIDENCE':
        return this.routeIssue(input, signalId, matchedCard as CardCandidate, parsed);

      case 'AMBIGUOUS':
        return this.askWhichCard(input, signalId, candidates, parsed);

      case 'PENDING_CONFIRMATION':
        return this.askForConfirmation(
          input,
          signalId,
          matchedCard as CardCandidate,
          workItemIds,
          cardContext as JobCardContext,
          parsed,
        );

      default:
        return {
          signalId,
          route: 'NO_CARD_MATCH',
          jobCardId: null,
          workItemIds: [],
          detail:
            parsed.registrationFragment === null
              ? 'No open card could be matched to this note'
              : `No open card matches "${parsed.registrationFragment}"`,
          duplicate: false,
        };
    }
  }

  /**
   * An advisor tapped ✅ on a confirmation card.
   *
   * The signal row is locked first: two advisors tapping the same card — which
   * happens, because the confirmation goes to a group — must apply it once.
   */
  async confirm(input: {
    readonly shopId: string;
    readonly signalId: string;
    readonly staffId: string | null;
    readonly jobCardId?: string | null;
    readonly actor: Actor;
    readonly traceId: string;
  }): Promise<CaptureOutcome> {
    const now = this.clock.now();

    const claimed = await this.deps.uow.transaction(async (tx) => {
      const signal = await this.deps.signals.lockPending(tx, input.shopId, input.signalId);
      if (signal === null) return null;
      return signal;
    });

    if (claimed === null) {
      return {
        signalId: input.signalId,
        route: 'DISCARDED',
        jobCardId: null,
        workItemIds: [],
        detail: 'That signal has already been actioned',
        duplicate: true,
      };
    }

    const jobCardId = input.jobCardId ?? claimed.jobCardId;
    if (jobCardId === null) {
      return {
        signalId: input.signalId,
        route: 'NO_CARD_MATCH',
        jobCardId: null,
        workItemIds: [],
        detail: 'Confirming this signal needs a job card to apply it to',
        duplicate: false,
      };
    }

    const context = await this.deps.uow.transaction((tx) =>
      this.deps.cards.load(tx, input.shopId, jobCardId),
    );
    if (context === null) {
      return {
        signalId: input.signalId,
        route: 'NO_CARD_MATCH',
        jobCardId,
        workItemIds: [],
        detail: 'That job card is not in this shop',
        duplicate: false,
      };
    }

    const parsed: ParsedStatusSignal = {
      signalType: claimed.signalType,
      confidence: 1,
      registrationFragment: null,
      jobCardCode: null,
      workDescriptions: [],
      etaHint: claimed.etaHint,
      summary: claimed.transcript,
      language: claimed.language,
    };

    const workItemIds =
      claimed.workItemIds.length > 0
        ? claimed.workItemIds
        : resolveWorkItems(parsed, context).workItemIds;

    await this.deps.uow.transaction(async (tx) => {
      await this.deps.signals.resolve(tx, {
        signalId: input.signalId,
        // A human confirmed it, which is a different fact from the parser
        // having been sure — the graduation question is "how often was it
        // right", and collapsing the two would erase the answer.
        route: input.jobCardId != null && input.jobCardId !== claimed.jobCardId
          ? 'CORRECTED'
          : 'CONFIRMED',
        jobCardId,
        workItemIds,
        staffId: input.staffId,
        appliedDetail: 'Confirmed by an advisor',
        at: now,
      });
    });

    return this.applySignal({
      input: {
        shopId: input.shopId,
        parsed,
        source: 'CONSOLE',
        transcript: claimed.transcript,
        transcriptConfidence: claimed.transcriptConfidence,
        conversationId: claimed.conversationId,
        messageId: null,
        mediaId: claimed.mediaId,
        senderStaffId: claimed.senderStaffId,
        replyToMessageId: null,
        actor: input.actor,
        traceId: input.traceId,
      },
      signalId: input.signalId,
      card: {
        jobCardId,
        code: context.code,
        registration: context.registration,
        vehicleLabel: context.vehicleLabel,
        state: context.state as JobCardState,
        basis: 'CODE',
        assignedTechnicianId: null,
        lastTouchedAt: now,
      },
      context,
      workItemIds,
      parsed,
    });
  }

  async discard(input: {
    readonly shopId: string;
    readonly signalId: string;
    readonly staffId: string | null;
    readonly actor: Actor;
    readonly traceId: string;
  }): Promise<CaptureOutcome> {
    const now = this.clock.now();

    await this.deps.uow.transaction(async (tx) => {
      const signal = await this.deps.signals.lockPending(tx, input.shopId, input.signalId);
      if (signal === null) return;
      await this.deps.signals.resolve(tx, {
        signalId: input.signalId,
        route: 'DISCARDED',
        jobCardId: signal.jobCardId,
        workItemIds: [],
        staffId: input.staffId,
        appliedDetail: 'Discarded by an advisor',
        at: now,
      });
      await this.deps.audit.append(tx, {
        shopId: input.shopId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'status_signal.discarded',
        entityType: 'status_signal',
        entityId: input.signalId,
        payload: { signalType: signal.signalType, transcript: signal.transcript },
        traceId: input.traceId,
      });
    });

    return {
      signalId: input.signalId,
      route: 'DISCARDED',
      jobCardId: null,
      workItemIds: [],
      detail: 'Signal discarded',
      duplicate: false,
    };
  }

  async pending(shopId: string, limit = 25) {
    return this.deps.uow.transaction((tx) => this.deps.signals.pending(tx, shopId, limit));
  }

  /**
   * The confirm queue, with the vehicles named.
   *
   * The labels are fetched in one read alongside the signals rather than per
   * row: the question on the card is *"did Suresh mean brake pads DONE on
   * TN09BX4432?"*, and a queue that could not say TN09BX4432 would be asking an
   * advisor to go and look it up before they could answer.
   */
  async pendingWithCards(
    shopId: string,
    limit = 25,
  ): Promise<{
    readonly signals: readonly StatusSignalRecord[];
    readonly cards: ReadonlyMap<string, CardCandidate>;
  }> {
    return this.deps.uow.transaction(async (tx) => {
      const signals = await this.deps.signals.pending(tx, shopId, limit);

      const ids = new Set<string>();
      for (const signal of signals) {
        if (signal.jobCardId !== null) ids.add(signal.jobCardId);
        for (const candidate of signal.candidateJobCardIds) ids.add(candidate);
      }

      const cards = await this.deps.resolver.byIds(tx, shopId, [...ids]);
      return { signals, cards: new Map(cards.map((card) => [card.jobCardId, card])) };
    });
  }

  /* ------------------------------------------------------------------ apply */

  /**
   * Turns a signal into state.
   *
   * Every transition goes through the domain services, so the audit chain, the
   * outbox and the guards all behave exactly as they do when an advisor clicks
   * the same button. A transition that is illegal from the card's current state
   * is *recorded and skipped*, not forced — a technician saying "done" on a
   * card still awaiting approval has told the shop something true about the
   * world, and nothing true about what the card may do next.
   */
  private async applySignal(args: {
    readonly input: CaptureStatusSignalInput;
    readonly signalId: string;
    readonly card: CardCandidate;
    readonly context: JobCardContext;
    readonly workItemIds: readonly string[];
    readonly parsed: ParsedStatusSignal;
  }): Promise<CaptureOutcome> {
    const { input, card, context, workItemIds, parsed } = args;
    const applied: string[] = [];
    const skipped: string[] = [];

    const byId = new Map(context.workItems.map((item) => [item.id, item]));

    if (parsed.signalType === 'done') {
      for (const workItemId of workItemIds) {
        const item = byId.get(workItemId);
        if (item === undefined) continue;
        // A technician who never sent a "started" note still leaves a
        // consistent ledger: APPROVED walks through IN_PROGRESS to DONE.
        if (item.state === 'APPROVED') {
          await this.tryWorkItem(input, workItemId, 'START', applied, skipped);
        }
        await this.tryWorkItem(input, workItemId, 'COMPLETE', applied, skipped);
      }
    } else if (parsed.signalType === 'progress') {
      for (const workItemId of workItemIds) {
        const item = byId.get(workItemId);
        if (item?.state === 'APPROVED') {
          await this.tryWorkItem(input, workItemId, 'START', applied, skipped);
        }
      }
    }

    const cardEvent = cardEventFor(parsed.signalType, card.state, context, workItemIds);
    let cardMoved = false;
    if (cardEvent !== null) {
      cardMoved = await this.tryCard(input, card.jobCardId, cardEvent, applied, skipped);
    }

    const etaReason = etaReasonFor(parsed.signalType, cardEvent, parsed.etaHint !== null);
    if (etaReason !== null && (cardMoved || applied.length > 0 || parsed.etaHint !== null)) {
      await this.deps.eta.recalculate({
        shopId: input.shopId,
        jobCardId: card.jobCardId,
        reason: etaReason,
        actor: input.actor,
        traceId: input.traceId,
        statusSignalId: args.signalId,
        partsAvailableAt: parsed.etaHint,
        note: parsed.summary,
      });
    }

    const detail =
      applied.length === 0
        ? `Nothing changed: ${skipped.join('; ') || 'no legal transition from the current state'}`
        : applied.join('; ');

    await this.deps.uow.transaction(async (tx) => {
      await this.deps.signals.resolve(tx, {
        signalId: args.signalId,
        route: 'AUTO_APPLIED',
        jobCardId: card.jobCardId,
        workItemIds,
        staffId: null,
        appliedDetail: detail,
        at: this.clock.now(),
      });
    });

    return {
      signalId: args.signalId,
      route: 'AUTO_APPLIED',
      jobCardId: card.jobCardId,
      workItemIds,
      detail,
      duplicate: false,
    };
  }

  private async tryWorkItem(
    input: CaptureStatusSignalInput,
    workItemId: string,
    event: 'START' | 'COMPLETE',
    applied: string[],
    skipped: string[],
  ): Promise<void> {
    try {
      const result = await this.deps.workItems.transition({
        shopId: input.shopId,
        workItemId,
        event,
        actor: input.actor,
        traceId: input.traceId,
        meta: { source: 'status_signal' },
      });
      applied.push(`work item ${result.from} → ${result.to}`);
    } catch (error) {
      skipped.push(`${event} refused: ${errorText(error)}`);
    }
  }

  private async tryCard(
    input: CaptureStatusSignalInput,
    jobCardId: string,
    event: JobCardEvent,
    applied: string[],
    skipped: string[],
  ): Promise<boolean> {
    try {
      const result = await this.deps.jobCards.transition({
        shopId: input.shopId,
        jobCardId,
        event,
        actor: input.actor,
        traceId: input.traceId,
        meta: { source: 'status_signal' },
      });
      applied.push(`card ${result.from} → ${result.to}`);
      return true;
    } catch (error) {
      skipped.push(`${event} refused: ${errorText(error)}`);
      return false;
    }
  }

  /* ------------------------------------------------------------- ask a human */

  private async askForConfirmation(
    input: CaptureStatusSignalInput,
    signalId: string,
    card: CardCandidate,
    workItemIds: readonly string[],
    context: JobCardContext,
    parsed: ParsedStatusSignal,
  ): Promise<CaptureOutcome> {
    const titles = context.workItems
      .filter((item) => workItemIds.includes(item.id))
      .map((item) => item.title);

    const body = t(parsed.language, 'staff.status_confirm', {
      what: titles.length > 0 ? titles.join(', ') : parsed.summary,
      signal: SIGNAL_WORD[parsed.signalType],
      registration: card.registration,
    });

    const buttons: readonly OutboundButton[] = [
      { id: STATUS_ACTION_IDS.confirm(signalId), title: t(parsed.language, 'staff.status_yes') },
      { id: STATUS_ACTION_IDS.edit(signalId), title: t(parsed.language, 'staff.status_edit') },
    ];

    await this.sendToStaff(input, { kind: 'interactive', body, buttons });

    return {
      signalId,
      route: 'PENDING_CONFIRMATION',
      jobCardId: card.jobCardId,
      workItemIds,
      detail: `Asked the staff group to confirm: ${body}`,
      duplicate: false,
    };
  }

  private async askWhichCard(
    input: CaptureStatusSignalInput,
    signalId: string,
    candidates: readonly CardCandidate[],
    parsed: ParsedStatusSignal,
  ): Promise<CaptureOutcome> {
    const body = t(parsed.language, 'staff.status_ambiguous', {
      signal: SIGNAL_WORD[parsed.signalType],
      count: candidates.length,
    });

    // At most three, because that is what a WhatsApp button row holds and
    // because a technician scrolling a list of eight cars will pick the wrong
    // one. More than three is a question for the console, not the group.
    const buttons: readonly OutboundButton[] = candidates.slice(0, 3).map((candidate) => ({
      id: STATUS_ACTION_IDS.confirm(signalId, candidate.jobCardId),
      title: candidate.registration.slice(0, 20),
    }));

    await this.sendToStaff(input, { kind: 'interactive', body, buttons });

    return {
      signalId,
      route: 'AMBIGUOUS',
      jobCardId: null,
      workItemIds: [],
      detail: `${candidates.length} cards matched; asked the staff group which`,
      duplicate: false,
    };
  }

  private async routeIssue(
    input: CaptureStatusSignalInput,
    signalId: string,
    card: CardCandidate,
    parsed: ParsedStatusSignal,
  ): Promise<CaptureOutcome> {
    const routed = await this.deps.routeToEvidence?.({
      shopId: input.shopId,
      jobCardId: card.jobCardId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      mediaId: input.mediaId,
      senderStaffId: input.senderStaffId,
      transcript: input.transcript,
      language: parsed.language,
      traceId: input.traceId,
    });

    const detail =
      routed?.detail ??
      'New work found; recorded for an advisor to turn into an evidence bundle';

    await this.deps.uow.transaction(async (tx) => {
      await this.deps.signals.resolve(tx, {
        signalId,
        route: 'ROUTED_TO_EVIDENCE',
        jobCardId: card.jobCardId,
        workItemIds: [],
        staffId: null,
        appliedDetail: detail,
        at: this.clock.now(),
      });
    });

    return {
      signalId,
      route: 'ROUTED_TO_EVIDENCE',
      jobCardId: card.jobCardId,
      workItemIds: [],
      detail,
      duplicate: false,
    };
  }

  /**
   * Anything the staff group is told goes through the gate like everything
   * else.
   *
   * `customerId: null` marks it internal — there is no consent to check on a
   * shop's own technicians — but quiet hours and the audit row still apply, and
   * `no-bypass.test.ts` would fail the build if this reached the channel any
   * other way.
   */
  private async sendToStaff(
    input: CaptureStatusSignalInput,
    content: OutboundContent,
  ): Promise<void> {
    if (input.conversationId === null) return;
    await this.deps.gate.send({
      shopId: input.shopId,
      conversationId: input.conversationId,
      customerId: null,
      purpose: 'SERVICE',
      content,
      actor: input.actor,
      traceId: input.traceId,
      flow: 'status',
      language: input.parsed.language,
      // A question the shop has no discretion over: the alternative to asking
      // is guessing which car a technician meant.
      systemReply: true,
    });
  }

  /* ------------------------------------------------------------ bookkeeping */

  private async audit(
    input: CaptureStatusSignalInput,
    signalId: string,
    route: StatusSignalRoute,
    card: CardCandidate | null,
    parsed: ParsedStatusSignal,
  ): Promise<void> {
    await this.deps.uow.transaction(async (tx) => {
      await this.deps.audit.append(tx, {
        shopId: input.shopId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'status_signal.captured',
        entityType: 'status_signal',
        entityId: signalId,
        payload: {
          signalType: parsed.signalType,
          confidence: parsed.confidence,
          route,
          jobCardId: card?.jobCardId ?? null,
          matchBasis: card?.basis ?? null,
          registrationFragment: parsed.registrationFragment,
          transcript: input.transcript,
          language: parsed.language,
          etaHint: parsed.etaHint?.toISOString() ?? null,
        },
        traceId: input.traceId,
      });
    });
  }

  private async emitCaptured(
    input: CaptureStatusSignalInput,
    signalId: string,
    route: StatusSignalRoute,
    card: CardCandidate | null,
    workItemIds: readonly string[],
    parsed: ParsedStatusSignal,
    now: Date,
  ): Promise<void> {
    const envelope: EventEnvelope = {
      id: uuidv7(),
      occurredAt: now.toISOString(),
      shopId: input.shopId,
      traceId: input.traceId,
      type: 'status_signal.captured',
      payload: {
        signalId,
        jobCardId: card?.jobCardId ?? null,
        workItemIds: [...workItemIds],
        signalType: parsed.signalType,
        source: input.source,
        route,
        confidence: parsed.confidence,
        senderStaffId: input.senderStaffId,
        etaHint: parsed.etaHint?.toISOString() ?? null,
        actor: { type: input.actor.type, id: input.actor.id },
      },
    };
    await this.deps.uow.transaction((tx) => this.deps.outbox.enqueue(tx, envelope));
  }

  private async matchCard(
    tx: Tx,
    input: CaptureStatusSignalInput,
    parsed: ParsedStatusSignal,
  ): Promise<MatchOutcome> {
    const byCode =
      parsed.jobCardCode === null
        ? null
        : await this.deps.resolver.byCode(tx, input.shopId, parsed.jobCardCode);

    const byRegistration =
      parsed.registrationFragment === null
        ? []
        : await this.deps.resolver.byRegistrationFragment(
            tx,
            input.shopId,
            parsed.registrationFragment,
          );

    const assigned =
      input.senderStaffId === null
        ? []
        : await this.deps.resolver.byTechnician(tx, input.shopId, input.senderStaffId);

    const replyContext =
      input.replyToMessageId === null
        ? null
        : await this.deps.resolver.byReplyContext(tx, input.shopId, input.replyToMessageId);

    return resolveCard({
      registrationFragment: parsed.registrationFragment,
      jobCardCode: parsed.jobCardCode,
      replyContext,
      assigned,
      byRegistration,
      byCode,
    });
  }
}

/* ---------------------------------------------------------------- helpers -- */

/**
 * Which work items a note is about.
 *
 * Description matching first, because a technician who says "brake pads" has
 * told us. Falling back to "the single open item" is safe on a one-job card and
 * is the common case; falling back to *all* items on a multi-item card would
 * mean one word closing three jobs, so it deliberately resolves to nothing and
 * lets the routing downgrade to a confirmation.
 */
export function resolveWorkItems(
  parsed: ParsedStatusSignal,
  context: JobCardContext,
): { readonly workItemIds: readonly string[]; readonly basis: 'DESCRIPTION' | 'SOLE' | 'NONE' } {
  const live = context.workItems.filter(
    (item) => item.state === 'APPROVED' || item.state === 'IN_PROGRESS',
  );

  const matched = live.filter((item) =>
    parsed.workDescriptions.some((description) => titleMatches(description, item.title)),
  );
  if (matched.length > 0) {
    return { workItemIds: matched.map((item) => item.id), basis: 'DESCRIPTION' };
  }

  if (live.length === 1) return { workItemIds: [live[0]?.id as string], basis: 'SOLE' };
  return { workItemIds: [], basis: 'NONE' };
}

/**
 * Loose containment either way, on lowercased words.
 *
 * "brake pads" matches "Front brake pad replacement" and vice versa. Not a
 * fuzzy distance: a technician's word for a part is either in the title or it
 * is not, and edit distance on short automotive words matches "belt" to "bolt".
 */
export function titleMatches(description: string, title: string): boolean {
  const needle = description.trim().toLowerCase();
  const hay = title.trim().toLowerCase();
  if (needle.length < 3 || hay.length === 0) return false;
  if (hay.includes(needle) || needle.includes(hay)) return true;

  const words = needle.split(/\s+/).filter((word) => word.length >= 4);
  return words.length > 0 && words.every((word) => hay.includes(word));
}

export function decideRoute(input: {
  readonly signalType: StatusSignalType;
  readonly confidence: number;
  readonly resolution: MatchOutcome;
  readonly workItemIds: readonly string[];
  readonly hasCardContext: boolean;
}): StatusSignalRoute {
  if (input.resolution.kind === 'ambiguous') return 'AMBIGUOUS';
  if (input.resolution.kind === 'none' || !input.hasCardContext) return 'NO_CARD_MATCH';

  // New work is never a status. It needs the customer's money, so it needs
  // their consent, so it belongs to the approval flow (phase 3.4).
  if (input.signalType === 'issue_found') return 'ROUTED_TO_EVIDENCE';

  if (!shouldAutoApply(input.confidence, input.resolution)) return 'PENDING_CONFIRMATION';

  // "Done" that cannot say what is done cannot close anything. On a card with
  // one open item `resolveWorkItems` has already answered; reaching here means
  // several are open and the note named none of them.
  if (input.signalType === 'done' && input.workItemIds.length === 0) {
    return 'PENDING_CONFIRMATION';
  }

  return 'AUTO_APPLIED';
}

/** The card-level transition a signal implies, if any. */
export function cardEventFor(
  signalType: StatusSignalType,
  state: JobCardState,
  context: JobCardContext,
  workItemIds: readonly string[],
): JobCardEvent | null {
  switch (signalType) {
    case 'blocked_parts':
      return state === 'IN_PROGRESS' ? 'PARTS_AWAITED' : null;

    case 'progress':
      // A technician reporting work on a blocked card is telling the shop the
      // part arrived — that is what "I've started on it" means when the card
      // has been sitting in AWAITING_PARTS.
      return state === 'AWAITING_PARTS' ? 'PARTS_RECEIVED' : null;

    case 'done': {
      if (state !== 'IN_PROGRESS') return null;
      const remaining = context.workItems.filter(
        (item) =>
          (item.state === 'APPROVED' || item.state === 'IN_PROGRESS') &&
          !workItemIds.includes(item.id),
      );
      // Only the *last* item finishing moves the card. A card with three jobs
      // and one of them done is still in progress.
      return remaining.length === 0 ? 'WORK_COMPLETED' : null;
    }

    case 'issue_found':
      return null;
  }
}

export function etaReasonFor(
  signalType: StatusSignalType,
  cardEvent: JobCardEvent | null,
  hasHint: boolean,
) {
  switch (signalType) {
    case 'blocked_parts':
      return 'BLOCKED_PARTS' as const;
    case 'done':
      return cardEvent === 'WORK_COMPLETED' ? ('QUALITY_PASSED' as const) : ('WORK_DONE' as const);
    case 'progress':
      if (cardEvent === 'PARTS_RECEIVED') return 'PARTS_RECEIVED' as const;
      return hasHint ? ('TECHNICIAN_HINT' as const) : null;
    case 'issue_found':
      return null;
  }
}

const SIGNAL_WORD: Readonly<Record<StatusSignalType, string>> = {
  progress: 'STARTED',
  blocked_parts: 'WAITING FOR PARTS',
  done: 'DONE',
  issue_found: 'ISSUE FOUND',
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
