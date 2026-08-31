import type { ShopConfig } from '@serviceloop/config';
import {
  systemClock,
  t,
  type Clock,
  type EtaReason,
  type JobCardState,
  type Language,
  type StringKey,
} from '@serviceloop/shared';
import type { JobCardContextReader } from '../agent/ports';
import { sourceId } from '../agent/types';
import type { Actor } from '../job-card/context';
import type { ConversationStore } from '../messaging/ports';
import type { OutboundGate } from '../messaging/outbound-gate';
import type { AuditAppender, ShopDirectory, UnitOfWork } from '../ports';
import type { EtaEntry, EtaStore, StatusCommsStore } from './ports';
import { requiresImmediateNotice } from './eta-rules';

/**
 * Proactive status comms (phase 4.4).
 *
 * The rule this exists to enforce is **bad news early**. A shop's incentive is
 * always to delay saying "the part hasn't come" — the customer might not ask,
 * and tomorrow it might have arrived. That instinct is what turns a two-hour
 * delay into a lost customer, so `blocked_parts` produces an immediate,
 * reasoned, apologetic message and there is no configuration that turns it off.
 *
 * Everything else is throttled hard. One coalesced update per card per
 * `coalesceWindowHours`, with three exemptions — approvals, ready alerts and
 * delay notices — which are precisely the three messages a customer is
 * *waiting* for rather than being interrupted by.
 *
 * ## Why this composes from the catalogue rather than through the agent
 *
 * The phase asks for these to be composed by `compose_customer_message` so the
 * post-checker applies, *and* for them to auto-send at L1, which master §6
 * defines as the templated class. Those two cannot both hold: a message a model
 * wrote is free-form by definition, and free-form is L2. Taking the
 * conservative reading (§10), the copy is built from the reviewed i18n
 * catalogue in the customer's language, and the anchoring half of the
 * post-checker — every factual sentence citing a real source — still runs, via
 * the gate's `checkClaimAnchoring`, over claims this service declares against
 * the ETA entry and the card's state. The judge layer is not run, because the
 * risk it exists to catch is a model inventing a claim, and no model wrote
 * this. Inbound status *answers* are a different matter and do go through the
 * agent and the full checker — that is the `answer_status` objective (4.5).
 */

export interface StatusCommsDeps<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly eta: EtaStore<Tx>;
  readonly comms: StatusCommsStore<Tx>;
  readonly cards: JobCardContextReader<Tx>;
  readonly conversations: ConversationStore<Tx>;
  readonly directory: ShopDirectory<Tx>;
  readonly gate: OutboundGate<Tx>;
  readonly audit: AuditAppender<Tx>;
  readonly loadConfig: (tx: Tx, shopId: string) => Promise<ShopConfig>;
  readonly clock?: Clock;
}

export interface AnnounceResult {
  readonly sent: boolean;
  readonly messageId: string | null;
  readonly status: string;
  readonly reason: string;
}

/**
 * The three events a customer is waiting for, and which therefore ignore the
 * coalescing window.
 */
const NEVER_COALESCED: ReadonlySet<JobCardState> = new Set<JobCardState>([
  'AWAITING_APPROVAL',
  'READY_FOR_DELIVERY',
  'AWAITING_PAYMENT',
]);

export class StatusCommsService<Tx> {
  private readonly clock: Clock;

  constructor(private readonly deps: StatusCommsDeps<Tx>) {
    this.clock = deps.clock ?? systemClock;
  }

  /**
   * Tells a customer their ETA moved, when it is worth telling them.
   *
   * Immaterial changes are recorded as notified without a message being sent —
   * they have *ridden* the next natural touchpoint by not interrupting one. The
   * entry is marked either way so the worker does not re-examine it for ever.
   */
  async announceEtaChange(input: {
    readonly shopId: string;
    readonly entry: EtaEntry;
    readonly actor: Actor;
    readonly traceId: string;
  }): Promise<AnnounceResult> {
    const { entry } = input;
    const now = this.clock.now();

    const immediate = requiresImmediateNotice(entry.reason, entry.materiality);
    if (!immediate && entry.materiality !== 'MATERIAL_GAIN') {
      await this.deps.uow.transaction((tx) =>
        this.deps.eta.markNotified(tx, { entryId: entry.id, messageId: null, at: now }),
      );
      return {
        sent: false,
        messageId: null,
        status: 'BATCHED',
        reason:
          'The change was immaterial; it will ride the next natural touchpoint rather than interrupt anyone',
      };
    }

    const context = await this.deps.uow.transaction(async (tx) => {
      const card = await this.deps.cards.load(tx, input.shopId, entry.jobCardId);
      if (card === null) return null;
      const conversation = await this.deps.conversations.findByCustomer(
        tx,
        input.shopId,
        card.customerId,
        'WHATSAPP',
      );
      const config = await this.deps.loadConfig(tx, input.shopId);
      const shopName = (await this.deps.directory.loadShopName(tx, input.shopId)) ?? 'the workshop';
      const lastUpdateAt = await this.deps.comms.lastStatusUpdateAt(
        tx,
        input.shopId,
        entry.jobCardId,
      );
      return { card, conversation, config, shopName, lastUpdateAt };
    });

    if (context === null || context.conversation === null) {
      await this.deps.uow.transaction((tx) =>
        this.deps.eta.markNotified(tx, { entryId: entry.id, messageId: null, at: now }),
      );
      return {
        sent: false,
        messageId: null,
        status: 'NO_THREAD',
        reason: 'This customer has no WhatsApp thread to tell',
      };
    }

    // A delay notice is one of the three exemptions: it is bad news the
    // customer is owed as soon as the shop knows it, and holding it for two
    // hours to satisfy a throttle is exactly the behaviour 4.4 forbids.
    const throttled =
      !immediate &&
      this.withinCoalesceWindow(context.lastUpdateAt, context.config, now);
    if (throttled) {
      await this.deps.uow.transaction((tx) =>
        this.deps.eta.markNotified(tx, { entryId: entry.id, messageId: null, at: now }),
      );
      return {
        sent: false,
        messageId: null,
        status: 'THROTTLED',
        reason: `Another update went to this customer within the last ${context.config.statusComms.coalesceWindowHours}h`,
      };
    }

    const language = context.card.customerLanguage;
    const etaText = this.formatEta(entry.eta, context.config, language);
    const body = this.composeEtaBody({
      entry,
      language,
      vehicle: context.card.vehicleLabel,
      shopName: context.shopName,
      etaText,
    });

    const outcome = await this.deps.gate.send({
      shopId: input.shopId,
      conversationId: context.conversation.id,
      customerId: context.card.customerId,
      purpose: 'SERVICE',
      content: { kind: 'text', body },
      actor: input.actor,
      traceId: input.traceId,
      flow: 'status',
      language,
      jobCardId: entry.jobCardId,
      // The one factual sentence is the time, and it cites the history entry
      // that produced it. L7 holds for a message the shop wrote as much as for
      // one the agent wrote.
      claims: [{ text: etaText, evidence: [{ kind: 'ETA', id: etaSourceKey(entry) }] }],
      evidenceRefs: [sourceId({ kind: 'ETA', id: etaSourceKey(entry) })],
      templated: true,
    });

    await this.deps.uow.transaction(async (tx) => {
      await this.deps.eta.markNotified(tx, {
        entryId: entry.id,
        messageId: outcome.messageId,
        at: now,
      });
      await this.deps.audit.append(tx, {
        shopId: input.shopId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'status.eta_announced',
        entityType: 'job_card',
        entityId: entry.jobCardId,
        payload: {
          etaEntryId: entry.id,
          version: entry.version,
          materiality: entry.materiality,
          reason: entry.reason,
          gateStatus: outcome.status,
          messageId: outcome.messageId,
        },
        traceId: input.traceId,
      });
    });

    return {
      sent: outcome.status === 'SENT',
      messageId: outcome.messageId,
      status: outcome.status,
      reason: 'reason' in outcome ? outcome.reason : 'Delivered',
    };
  }

  /**
   * Tells a customer their card moved state.
   *
   * Only a handful of transitions are worth a message. `IN_DIAGNOSIS` is not
   * one of them: nobody wants to be told their car is being looked at, and a
   * shop that says so has spent one of its three daily messages on nothing.
   */
  async announceStateChange(input: {
    readonly shopId: string;
    readonly jobCardId: string;
    readonly to: JobCardState;
    readonly actor: Actor;
    readonly traceId: string;
  }): Promise<AnnounceResult> {
    const key = STATE_COPY[input.to];
    if (key === null) {
      return {
        sent: false,
        messageId: null,
        status: 'NOT_ANNOUNCED',
        reason: `${input.to} is not a state a customer needs to hear about`,
      };
    }

    const now = this.clock.now();
    const context = await this.deps.uow.transaction(async (tx) => {
      const card = await this.deps.cards.load(tx, input.shopId, input.jobCardId);
      if (card === null) return null;
      const conversation = await this.deps.conversations.findByCustomer(
        tx,
        input.shopId,
        card.customerId,
        'WHATSAPP',
      );
      const config = await this.deps.loadConfig(tx, input.shopId);
      const shopName = (await this.deps.directory.loadShopName(tx, input.shopId)) ?? 'the workshop';
      const lastUpdateAt = await this.deps.comms.lastStatusUpdateAt(
        tx,
        input.shopId,
        input.jobCardId,
      );
      const latestEta = await this.deps.eta.latest(tx, input.shopId, input.jobCardId);
      return { card, conversation, config, shopName, lastUpdateAt, latestEta };
    });

    if (context === null || context.conversation === null) {
      return {
        sent: false,
        messageId: null,
        status: 'NO_THREAD',
        reason: 'This customer has no WhatsApp thread to tell',
      };
    }

    if (
      !NEVER_COALESCED.has(input.to) &&
      this.withinCoalesceWindow(context.lastUpdateAt, context.config, now)
    ) {
      return {
        sent: false,
        messageId: null,
        status: 'THROTTLED',
        reason: `Another update went to this customer within the last ${context.config.statusComms.coalesceWindowHours}h`,
      };
    }

    const language = context.card.customerLanguage;
    const eta = context.latestEta;
    const etaText =
      eta === null ? null : this.formatEta(eta.eta, context.config, language);

    const body = [
      t(language, key, {
        vehicle: context.card.vehicleLabel,
        shopName: context.shopName,
      }),
      etaText === null ? '' : etaText,
    ]
      .filter((line) => line.length > 0)
      .join(' ');

    const claims = [
      {
        text: t(language, key, {
          vehicle: context.card.vehicleLabel,
          shopName: context.shopName,
        }),
        evidence: [{ kind: 'JOB_CARD_STATE' as const, id: `${input.jobCardId}#${input.to}` }],
      },
      ...(eta === null || etaText === null
        ? []
        : [{ text: etaText, evidence: [{ kind: 'ETA' as const, id: etaSourceKey(eta) }] }]),
    ];

    const outcome = await this.deps.gate.send({
      shopId: input.shopId,
      conversationId: context.conversation.id,
      customerId: context.card.customerId,
      purpose: 'SERVICE',
      content: { kind: 'text', body },
      actor: input.actor,
      traceId: input.traceId,
      flow: 'status',
      language,
      jobCardId: input.jobCardId,
      claims,
      evidenceRefs: claims.flatMap((claim) => claim.evidence.map(sourceId)),
      templated: true,
    });

    return {
      sent: outcome.status === 'SENT',
      messageId: outcome.messageId,
      status: outcome.status,
      reason: 'reason' in outcome ? outcome.reason : 'Delivered',
    };
  }

  private withinCoalesceWindow(
    lastAt: Date | null,
    config: ShopConfig,
    now: Date,
  ): boolean {
    if (lastAt === null) return false;
    const windowMs = config.statusComms.coalesceWindowHours * 60 * 60 * 1000;
    return now.getTime() - lastAt.getTime() < windowMs;
  }

  /**
   * The customer-facing sentence.
   *
   * A slip opens with an apology and *always* states the reason, because "your
   * car will be ready at six instead of four" without a because is the sentence
   * that makes someone phone the shop — which is the call this whole feature
   * exists to prevent.
   */
  private composeEtaBody(input: {
    readonly entry: EtaEntry;
    readonly language: Language;
    readonly vehicle: string;
    readonly shopName: string;
    readonly etaText: string;
  }): string {
    const { entry, language } = input;

    const opener =
      entry.materiality === 'MATERIAL_SLIP'
        ? t(language, 'status.delay_apology', { vehicle: input.vehicle })
        : t(language, 'status.earlier_intro', { vehicle: input.vehicle });

    const reason = t(language, REASON_COPY[entry.reason], { shopName: input.shopName });

    return [opener, input.etaText, reason].join(' ');
  }

  private formatEta(eta: Date, config: ShopConfig, language: Language): string {
    return t(language, 'status.eta_line', {
      eta: formatLocalTime(eta, config.quietHours.timezone),
    });
  }
}

/**
 * The id an ETA claim cites.
 *
 * Card plus version, not the entry's uuid: the console renders the history by
 * version, an advisor reading an audit row can find the entry from it, and a
 * customer asking "you said four o'clock" is answered by pointing at a number
 * that appears on the screen in front of the advisor.
 */
export function etaSourceKey(entry: EtaEntry): string {
  return `${entry.jobCardId}#${entry.version}`;
}

/** Local wall-clock rendering, e.g. `Mon 4:30 pm`. */
export function formatLocalTime(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(instant);
}

/**
 * Which states earn a message.
 *
 * `null` means "the customer does not need to know". Most of the machine is in
 * that category: `IN_DIAGNOSIS`, `QUALITY_CHECK` and `CLOSED` are internal
 * milestones, and telling someone about each of them spends the shop's three
 * daily messages on nothing they can act on.
 */
const STATE_COPY: Readonly<Record<JobCardState, StringKey | null>> = {
  DRAFT: null,
  OPEN: null,
  IN_DIAGNOSIS: null,
  AWAITING_APPROVAL: null,
  IN_PROGRESS: 'status.work_started',
  AWAITING_PARTS: 'status.awaiting_parts_notice',
  QUALITY_CHECK: null,
  READY_FOR_DELIVERY: null,
  AWAITING_PAYMENT: null,
  DELIVERED: null,
  CLOSED: null,
  CANCELLED: null,
};

/**
 * Why the time moved, in the customer's language.
 *
 * One key per reason so the sentence is generated rather than concatenated, and
 * so a translator sees a whole sentence to translate rather than a fragment.
 */
const REASON_COPY: Readonly<Record<EtaReason, StringKey>> = {
  INTAKE_PROMISE: 'eta.reason.intake',
  WORK_APPROVED: 'eta.reason.work_approved',
  WORK_DECLINED: 'eta.reason.work_declined',
  BLOCKED_PARTS: 'eta.reason.blocked_parts',
  PARTS_RECEIVED: 'eta.reason.parts_received',
  TECHNICIAN_HINT: 'eta.reason.technician_hint',
  WORK_DONE: 'eta.reason.work_done',
  QUALITY_PASSED: 'eta.reason.quality_passed',
  ADVISOR_OVERRIDE: 'eta.reason.advisor_override',
};
