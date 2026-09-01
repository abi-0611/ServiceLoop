import type { ShopConfig } from '@serviceloop/config';
import {
  addLocalDays,
  formatPaise,
  localDay,
  systemClock,
  t,
  uuidv7,
  type Clock,
  type DigestKind,
  type EventEnvelope,
  type IsoDay,
  type Language,
  type Paise,
} from '@serviceloop/shared';
import type { Actor } from '../job-card/context';
import { SYSTEM_ACTOR } from '../job-card/context';
import type { OutboundGate } from '../messaging/outbound-gate';
import type { ConversationStore } from '../messaging/ports';
import { DIGEST_ACTION_IDS } from '../messaging/retention-actions';
import type { AdvisorTaskCreator } from '../delivery/ports';
import type { AuditAppender, OutboxWriter, ShopDirectory, UnitOfWork } from '../ports';
import type { MetricsService } from './metrics-service';
import { rollupKpis, type DailyRollup } from './metrics';
import type { OwnerDigestStore, RetentionDirectory } from './ports';

/**
 * The daily owner digest (phase 6.7).
 *
 * **Every number in it comes from the metrics rollup.** Not "mostly" — every
 * one, including the list of approvals waiting more than two hours, which looks
 * like a live query and is folded from the same event stream. That is the
 * phase's own instruction and it earns its keep twice: the golden-content test
 * can recompute the whole brief independently, and an owner who asks "where
 * does the ₹18,400 come from" gets an answer that survives being asked again
 * next year.
 *
 * The digest is the one phase-6 message that is **on** by default. It goes to
 * the owner's own number about their own shop — there is no customer to
 * protect, and an owner who upgrades into a build that can tell them their day
 * went badly should be told.
 *
 * Quiet hours still apply to it, and that is not an oversight. 20:30 is inside
 * nobody's quiet hours by default; a shop that sets its quiet window to start at
 * 20:00 has said something about when its people stop working, and a digest is
 * not urgent enough to argue.
 */

export interface DigestServiceDeps<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly digests: OwnerDigestStore<Tx>;
  readonly metrics: MetricsService<Tx>;
  readonly directory: RetentionDirectory<Tx>;
  readonly conversations: ConversationStore<Tx>;
  readonly shops: ShopDirectory<Tx>;
  readonly gate: OutboundGate<Tx>;
  readonly audit: AuditAppender<Tx>;
  readonly outbox: OutboxWriter<Tx>;
  readonly loadConfig: (tx: Tx, shopId: string) => Promise<ShopConfig>;
  /** Vehicle labels for the stuck-approval lines. Job card → label. */
  readonly cardLabels: (
    tx: Tx,
    shopId: string,
    jobCardIds: readonly string[],
  ) => Promise<ReadonlyMap<string, string>>;
  /**
   * Raises the follow-up an owner claimed with "I'll call" (6.7).
   *
   * Optional, like every task creator in this codebase: a deployment with no
   * task queue still sends a digest, it simply cannot record who took a line.
   */
  readonly tasks?: AdvisorTaskCreator;
  /**
   * Marks the matching alert incident over, so the 6.8 stream stops raising
   * something a person has taken responsibility for.
   *
   * Injected rather than imported for the same reason the feedback service's
   * alerter is: the digest does not depend on 6.8, it depends on "something
   * that can be told an incident has an owner now".
   */
  readonly resolveAlert?: (input: {
    readonly shopId: string;
    readonly incidentKey: string;
    readonly traceId: string;
  }) => Promise<boolean>;
  readonly clock?: Clock;
}

/** What one "I'll call" tap did. */
export interface DigestClaimResult {
  readonly claimed: boolean;
  readonly approvalId: string;
  readonly taskId: string | null;
  readonly alertResolved: boolean;
  readonly detail: string;
}

/** The assembled brief: lines to render, and every number behind them. */
export interface DigestPayload {
  readonly kind: DigestKind;
  readonly day: IsoDay;
  readonly shopId: string;
  readonly shopName: string;
  readonly lines: readonly string[];
  readonly numbers: {
    readonly vehiclesIn: number;
    readonly vehiclesOut: number;
    readonly approvedPaise: Paise;
    readonly recoveredPaise: Paise;
    readonly approvalsPending: number;
    readonly feedbackFlags: number;
    readonly silentBays: number;
  };
  readonly actions: readonly { readonly id: string; readonly title: string }[];
}

export interface DigestResult {
  readonly digestId: string | null;
  readonly payload: DigestPayload | null;
  readonly sent: boolean;
  readonly detail: string;
}

export class DigestService<Tx> {
  private readonly clock: Clock;

  constructor(private readonly deps: DigestServiceDeps<Tx>) {
    this.clock = deps.clock ?? systemClock;
  }

  /**
   * Composes and sends the brief for one shop, to every owner it has.
   *
   * Idempotent per (shop, kind, day, recipient) by unique index, which is what
   * lets the scheduler be a poll rather than a cron with a memory: a worker that
   * restarts at 20:31 finds the slot taken.
   */
  async sendDaily(input: {
    readonly shopId: string;
    readonly day?: IsoDay;
    readonly kind?: DigestKind;
    readonly traceId: string;
    readonly actor?: Actor;
  }): Promise<readonly DigestResult[]> {
    const actor = input.actor ?? SYSTEM_ACTOR;
    const now = this.clock.now();

    const setup = await this.deps.uow.transaction(async (tx) => {
      const config = await this.deps.loadConfig(tx, input.shopId);
      if (!config.digest.enabled) return null;
      const shopName = (await this.deps.shops.loadShopName(tx, input.shopId)) ?? 'the workshop';
      const owners = await this.deps.directory.owners(tx, input.shopId);
      return { config, shopName, owners };
    });

    if (setup === null) return [];

    const timezone = setup.config.quietHours.timezone;
    // The day the brief is *about* is the one that is ending, which is today in
    // the shop's own zone at 20:30. Passing it explicitly is what lets a demo
    // and a backfill render yesterday's.
    const day = input.day ?? localDay(now, timezone);
    const kind: DigestKind =
      input.kind ??
      (setup.config.digest.includeWeekly &&
      new Date(`${day}T00:00:00.000Z`).getUTCDay() === setup.config.digest.weeklyOn
        ? 'WEEKLY'
        : 'DAILY');

    const composed = await this.compose({
      shopId: input.shopId,
      shopName: setup.shopName,
      day,
      kind,
      config: setup.config,
    });

    const results: DigestResult[] = [];
    for (const owner of setup.owners) {
      results.push(
        await this.deliver({
          shopId: input.shopId,
          owner,
          payload: composed.payload,
          rollup: composed.rollup,
          day,
          kind,
          traceId: input.traceId,
          actor,
        }),
      );
    }

    // A shop with no owner on record still gets a digest row. It is the only
    // way an operator finds out that the reason nobody is reading the brief is
    // that nobody is configured to receive it.
    if (setup.owners.length === 0) {
      results.push(
        await this.deliver({
          shopId: input.shopId,
          owner: null,
          payload: composed.payload,
          rollup: composed.rollup,
          day,
          kind,
          traceId: input.traceId,
          actor,
        }),
      );
    }

    return results;
  }

  /**
   * The brief, as data.
   *
   * Public and side-effect free so the golden-content test can assert on it,
   * and so the console can render the same thing the owner received without a
   * second composer that might disagree.
   */
  async compose(input: {
    readonly shopId: string;
    readonly shopName: string;
    readonly day: IsoDay;
    readonly kind: DigestKind;
    readonly config: ShopConfig;
    readonly language?: Language;
  }): Promise<{ readonly payload: DigestPayload; readonly rollup: DailyRollup }> {
    const language = input.language ?? input.config.languages.default;

    const rollup =
      input.kind === 'WEEKLY'
        ? (await this.deps.metrics.range(input.shopId, addLocalDays(input.day, -6), input.day))
            .total
        : (await this.deps.metrics.load(input.shopId, input.day)).rollup;

    const labels = await this.deps.uow.transaction((tx) =>
      this.deps.cardLabels(
        tx,
        input.shopId,
        rollup.pendingApprovals.map((pending) => pending.jobCardId),
      ),
    );

    const lines: string[] = [
      input.kind === 'WEEKLY'
        ? t(language, 'digest.weekly_header', { shopName: input.shopName, date: input.day })
        : t(language, 'digest.header', { shopName: input.shopName, date: input.day }),
      t(language, 'digest.line.vehicles', {
        in: rollup.vehiclesIn,
        out: rollup.vehiclesOut,
      }),
      t(language, 'digest.line.approved', { amount: formatPaise(rollup.approvedValuePaise) }),
      // The headline. It is deliberately its own line and deliberately second
      // from the money: the whole product argument is that this number exists.
      t(language, 'digest.line.recovered', { amount: formatPaise(rollup.recoveredPaise) }),
    ];

    const shown = rollup.pendingApprovals.slice(0, input.config.digest.maxApprovalLines);
    lines.push(
      t(language, 'digest.line.approvals_pending', {
        hours: input.config.alerts.approvalStuckHours,
        count: rollup.pendingApprovals.length,
      }),
    );
    for (const pending of shown) {
      lines.push(
        t(language, 'digest.line.approval_item', {
          vehicle: labels.get(pending.jobCardId) ?? pending.jobCardId.slice(0, 8),
          amount: formatPaise(pending.amountPaise),
          waited: formatWaited(pending.waitedMinutes),
        }),
      );
    }

    lines.push(
      t(language, 'digest.line.feedback', { count: rollup.feedbackNegative }),
      t(language, 'digest.line.silent_bays', { count: rollup.silentBays }),
    );

    if (input.kind === 'WEEKLY') {
      const kpis = rollupKpis(rollup);
      const previous = await this.deps.metrics.range(
        input.shopId,
        addLocalDays(input.day, -13),
        addLocalDays(input.day, -7),
      );
      lines.push(...trendLines(language, kpis, rollupKpis(previous.total)));
    }

    if (
      rollup.vehiclesIn === 0 &&
      rollup.vehiclesOut === 0 &&
      rollup.pendingApprovals.length === 0 &&
      rollup.feedbackNegative === 0
    ) {
      lines.push(t(language, 'digest.line.none'));
    }

    return {
      rollup,
      payload: {
        kind: input.kind,
        day: input.day,
        shopId: input.shopId,
        shopName: input.shopName,
        lines,
        numbers: {
          vehiclesIn: rollup.vehiclesIn,
          vehiclesOut: rollup.vehiclesOut,
          approvedPaise: rollup.approvedValuePaise,
          recoveredPaise: rollup.recoveredPaise,
          approvalsPending: rollup.pendingApprovals.length,
          feedbackFlags: rollup.feedbackNegative,
          silentBays: rollup.silentBays,
        },
        // WhatsApp allows three buttons. The stuck approvals are what an owner
        // can actually *do* something about at 20:30, so they get the buttons,
        // longest wait first.
        actions: shown.slice(0, 3).map((pending) => ({
          id: DIGEST_ACTION_IDS.claim(pending.approvalId),
          title: t(language, 'digest.action.call', {
            vehicle: labels.get(pending.jobCardId) ?? 'this one',
          }).slice(0, 20),
        })),
      },
    };
  }

  /**
   * "I'll call" on a digest line (phase 6.7).
   *
   * What claiming *is*, precisely, because the word could mean three things and
   * only one of them is honest here: the owner has taken personal
   * responsibility for one waiting approval. So the tap raises a `CALL_CUSTOMER`
   * task against their own name and resolves the `approval_stuck` incident, and
   * the alert stream stops raising something a person is now holding.
   *
   * What it deliberately does **not** do is remove the approval from tomorrow's
   * pending list. That list is folded from the event log — requested, never
   * decided — and an approval nobody has answered is still an approval nobody
   * has answered, whoever promised to ring about it. A claim that quietly
   * emptied the line would be the one failure mode this brief exists to
   * prevent: a customer waiting three days on a decision that stopped being
   * visible to anyone the evening somebody meant well.
   *
   * Idempotent through the task's dedupe key, so a second tap on last night's
   * message raises nothing new.
   */
  async claim(input: {
    readonly shopId: string;
    readonly approvalId: string;
    readonly claimedByStaffId: string | null;
    readonly conversationId: string | null;
    readonly traceId: string;
    readonly actor?: Actor;
  }): Promise<DigestClaimResult> {
    const actor = input.actor ?? SYSTEM_ACTOR;
    const now = this.clock.now();

    // Read outside a transaction of our own: `stuckApprovals` opens one, and a
    // nested `BEGIN` is a different thing in every driver.
    const pending = await this.deps.metrics.stuckApprovals({ shopId: input.shopId, now });
    const match = pending.find((row) => row.approvalId === input.approvalId) ?? null;

    const context = await this.deps.uow.transaction(async (tx) => {
      const config = await this.deps.loadConfig(tx, input.shopId);
      const labels =
        match === null
          ? new Map<string, string>()
          : await this.deps.cardLabels(tx, input.shopId, [match.jobCardId]);
      return { config, label: match === null ? null : (labels.get(match.jobCardId) ?? null) };
    });

    if (match === null) {
      // Answered between the brief going out and the tap landing, which is the
      // outcome everybody wanted. Saying so beats a silent no-op.
      return {
        claimed: false,
        approvalId: input.approvalId,
        taskId: null,
        alertResolved: false,
        detail: 'That approval is no longer waiting',
      };
    }

    const vehicle = context.label ?? 'the vehicle';
    const language = context.config.languages.default;

    const taskId =
      this.deps.tasks === undefined
        ? null
        : await this.deps.tasks.create({
            shopId: input.shopId,
            kind: 'CALL_CUSTOMER',
            urgency: 'HIGH',
            brief: t(language, 'alert.approval_stuck', {
              vehicle,
              amount: formatPaise(match.amountPaise),
              waited: `${Math.floor(match.waitedMinutes / 60)}h ${match.waitedMinutes % 60}m`,
            }),
            context: {
              approvalId: input.approvalId,
              claimedByStaffId: input.claimedByStaffId,
              claimedVia: 'owner_digest',
              waitedMinutes: match.waitedMinutes,
            },
            jobCardId: match.jobCardId,
            // One task per approval however many times the button is pressed.
            dedupeKey: `digest_claim:${input.approvalId}`,
            actor,
            traceId: input.traceId,
          });

    const alertResolved =
      this.deps.resolveAlert === undefined
        ? false
        : await this.deps.resolveAlert({
            shopId: input.shopId,
            incidentKey: `approval_stuck:${input.approvalId}`,
            traceId: input.traceId,
          });

    await this.deps.uow.transaction(async (tx) => {
      await this.deps.audit.append(tx, {
        shopId: input.shopId,
        actorType: actor.type,
        actorId: actor.id,
        action: 'owner_digest.claimed',
        entityType: 'ApprovalRequest',
        entityId: input.approvalId,
        payload: {
          claimedByStaffId: input.claimedByStaffId,
          taskId,
          alertResolved,
          waitedMinutes: match.waitedMinutes,
        },
        traceId: input.traceId,
      });
    });

    if (input.conversationId !== null) {
      await this.deps.gate.send({
        shopId: input.shopId,
        conversationId: input.conversationId,
        customerId: null,
        purpose: 'SERVICE',
        content: { kind: 'text', body: t(language, 'digest.claimed_ack', { vehicle }) },
        actor,
        traceId: input.traceId,
        flow: 'status',
        language,
        systemReply: true,
        isAcknowledgement: true,
        templated: true,
      });
    }

    return {
      claimed: true,
      approvalId: input.approvalId,
      taskId,
      alertResolved,
      detail: `Claimed ${vehicle}`,
    };
  }

  /**
   * The multi-shop view (phase 6.7).
   *
   * An owner with three shops gets one message: a consolidated head, then a
   * block per shop. Three separate digests at 20:30 would be three
   * notifications about the same evening, and the first thing that owner would
   * do is mute all of them.
   */
  async composeConsolidated(input: {
    readonly staffId: string;
    readonly day: IsoDay;
    readonly language: Language;
    readonly traceId: string;
  }): Promise<{ readonly lines: readonly string[]; readonly shops: number }> {
    const shops = await this.deps.uow.transaction((tx) =>
      this.deps.directory.shopsForOwner(tx, input.staffId),
    );

    const lines: string[] = [
      t(input.language, 'digest.multi_shop_header', { date: input.day }),
    ];
    let totalIn = 0;
    let totalOut = 0;
    let totalApproved = 0;
    let totalRecovered = 0;

    for (const shop of shops) {
      const config = await this.deps.uow.transaction((tx) =>
        this.deps.loadConfig(tx, shop.shopId),
      );
      const composed = await this.compose({
        shopId: shop.shopId,
        shopName: shop.name,
        day: input.day,
        kind: 'DAILY',
        config,
        language: input.language,
      });
      totalIn += composed.rollup.vehiclesIn;
      totalOut += composed.rollup.vehiclesOut;
      totalApproved += composed.rollup.approvedValuePaise;
      totalRecovered += composed.rollup.recoveredPaise;
      lines.push('', ...composed.payload.lines);
    }

    // The consolidated totals go at the top, where somebody reading one screen
    // will see them, which is why they are spliced rather than appended.
    lines.splice(
      1,
      0,
      t(input.language, 'digest.line.vehicles', { in: totalIn, out: totalOut }),
      t(input.language, 'digest.line.approved', { amount: formatPaise(totalApproved) }),
      t(input.language, 'digest.line.recovered', { amount: formatPaise(totalRecovered) }),
    );

    return { lines, shops: shops.length };
  }

  /* --------------------------------------------------------------- private */

  private async deliver(input: {
    readonly shopId: string;
    readonly owner: { readonly staffId: string; readonly name: string; readonly language: Language } | null;
    readonly payload: DigestPayload;
    readonly rollup: DailyRollup;
    readonly day: IsoDay;
    readonly kind: DigestKind;
    readonly traceId: string;
    readonly actor: Actor;
  }): Promise<DigestResult> {
    const now = this.clock.now();
    const language = input.owner?.language ?? 'en';

    const digestId = uuidv7();
    const claimed = await this.deps.uow.transaction(async (tx) => {
      const conversation =
        input.owner === null
          ? null
          : await this.deps.conversations.findByThreadKey(
              tx,
              input.shopId,
              'WHATSAPP',
              `staff:${input.owner.staffId}`,
            );
      const id = await this.deps.digests.claim(tx, {
        id: digestId,
        shopId: input.shopId,
        kind: input.kind,
        day: input.day,
        recipientStaffId: input.owner?.staffId ?? null,
        conversationId: conversation?.id ?? null,
        language,
        payload: input.payload as unknown,
        traceId: input.traceId,
      });
      return id === null ? null : { id, conversationId: conversation?.id ?? null };
    });

    if (claimed === null) {
      return {
        digestId: null,
        payload: input.payload,
        sent: false,
        detail: 'A digest for this shop, kind, day and recipient already exists',
      };
    }

    if (claimed.conversationId === null) {
      await this.settle(input.shopId, claimed.id, null, 'No owner thread to deliver on', now);
      return {
        digestId: claimed.id,
        payload: input.payload,
        sent: false,
        detail: 'NO_OWNER_THREAD: the digest was composed and stored but not delivered',
      };
    }

    const outcome = await this.deps.gate.send({
      shopId: input.shopId,
      conversationId: claimed.conversationId,
      // An owner is staff, not a customer: there is no consent record and none
      // is needed. The gate treats a null customer on an in-window thread
      // accordingly, and quiet hours still apply.
      customerId: null,
      purpose: 'SERVICE',
      content:
        input.payload.actions.length === 0
          ? { kind: 'text', body: input.payload.lines.join('\n') }
          : {
              kind: 'interactive',
              body: input.payload.lines.join('\n'),
              buttons: input.payload.actions,
            },
      actor: input.actor,
      traceId: input.traceId,
      flow: 'status',
      language,
      systemReply: true,
      templated: true,
    });

    await this.settle(
      input.shopId,
      claimed.id,
      outcome.status === 'SENT' ? outcome.messageId : null,
      outcome.status === 'SENT' ? null : outcome.status,
      now,
    );

    if (outcome.status === 'SENT') {
      await this.deps.uow.transaction(async (tx) => {
        const envelope: EventEnvelope = {
          id: uuidv7(),
          type: 'owner_digest.sent',
          occurredAt: now.toISOString(),
          shopId: input.shopId,
          traceId: input.traceId,
          payload: {
            digestId: claimed.id,
            kind: input.kind,
            day: input.day,
            recipientStaffId: input.owner?.staffId ?? null,
            messageId: outcome.messageId,
            vehiclesIn: input.payload.numbers.vehiclesIn,
            vehiclesOut: input.payload.numbers.vehiclesOut,
            approvalsPending: input.payload.numbers.approvalsPending,
            approvedPaise: input.payload.numbers.approvedPaise,
            recoveredPaise: input.payload.numbers.recoveredPaise,
            feedbackFlags: input.payload.numbers.feedbackFlags,
            silentBays: input.payload.numbers.silentBays,
            actor: { type: input.actor.type, id: input.actor.id },
          },
        };
        await this.deps.outbox.enqueue(tx, envelope);
      });
    }

    return {
      digestId: claimed.id,
      payload: input.payload,
      sent: outcome.status === 'SENT',
      detail:
        outcome.status === 'SENT'
          ? `message ${outcome.messageId}`
          : `${outcome.status}: ${'reason' in outcome ? outcome.reason : ''}`,
    };
  }

  private async settle(
    shopId: string,
    digestId: string,
    messageId: string | null,
    blockedReason: string | null,
    at: Date,
  ): Promise<void> {
    await this.deps.uow.transaction((tx) =>
      this.deps.digests.settle(tx, { shopId, digestId, messageId, blockedReason, at }),
    );
  }
}

/** "3h 20m" — a duration an owner reads at a glance, not an ISO interval. */
function formatWaited(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours === 0 ? `${rest}m` : `${hours}h ${rest}m`;
}

/**
 * The weekly edition's trend lines.
 *
 * Only for KPIs that exist in both weeks. A trend against a week with no data
 * is not a trend, and printing "+100%" because last week's denominator was zero
 * is the kind of number that makes an owner stop believing the rest of them.
 */
function trendLines(
  language: Language,
  current: ReturnType<typeof rollupKpis>,
  previous: ReturnType<typeof rollupKpis>,
): string[] {
  const rows: { label: string; now: number | null; before: number | null }[] = [
    {
      label: 'Approval conversion',
      now: current.approvalConversionRate,
      before: previous.approvalConversionRate,
    },
    {
      label: 'Declined-work recovery',
      now: current.declinedWorkRecoveryRate,
      before: previous.declinedWorkRecoveryRate,
    },
    {
      label: 'On-time delivery',
      now: current.onTimeDeliveryRate,
      before: previous.onTimeDeliveryRate,
    },
  ];

  const lines: string[] = [];
  for (const row of rows) {
    if (row.now === null) continue;
    const value = `${Math.round(row.now * 100)}%`;
    if (row.before === null) {
      lines.push(t(language, 'digest.trend.flat', { label: row.label, value }));
      continue;
    }
    const deltaPoints = Math.round((row.now - row.before) * 100);
    lines.push(
      deltaPoints === 0
        ? t(language, 'digest.trend.flat', { label: row.label, value })
        : t(language, 'digest.trend.up', {
            label: row.label,
            value,
            change: `${deltaPoints > 0 ? '+' : ''}${deltaPoints} pts`,
          }),
    );
  }
  return lines;
}
