import type { ShopConfig } from '@serviceloop/config';
import {
  formatPaise,
  systemClock,
  t,
  uuidv7,
  type AlertKind,
  type Clock,
  type EventEnvelope,
  type Language,
  type Paise,
  type TaskUrgency,
} from '@serviceloop/shared';
import type { AdvisorTaskCreator } from '../delivery/ports';
import { evaluateQuietHours } from '../guardrails/policies';
import type { Actor } from '../job-card/context';
import { SYSTEM_ACTOR } from '../job-card/context';
import type { OutboundGate } from '../messaging/outbound-gate';
import type { ConversationStore } from '../messaging/ports';
import type { AuditAppender, OutboxWriter, ShopDirectory, UnitOfWork } from '../ports';
import type { AlertStore, RetentionDirectory } from './ports';

/**
 * Realtime exception alerts (phase 6.8).
 *
 * Five kinds and no more, because an alert stream that fires for everything is
 * one an owner mutes — and a muted stream is worse than none, since the shop
 * believes it has one.
 *
 * Two properties are the whole feature:
 *
 *   - **One alert per incident.** The dedupe identity is `incidentKey`, which
 *     names the *incident* and not the observation: `approval_stuck:<id>`, not
 *     `approval_stuck:<id>:<timestamp>`. A scan every two minutes re-observes
 *     one stuck approval thirty times an hour, and the owner hears once.
 *   - **Quiet hours are overridden per kind, deliberately.** An owner is not a
 *     customer, but they are still a person asleep at 23:00. The shipped
 *     override list is two of the five: a bad review, whose recovery window is
 *     hours long, and the voice kill switch, which means the shop's telephone
 *     has stopped working. The other three keep until morning, and a held alert
 *     is stored with its reason rather than dropped.
 */

export interface AlertServiceDeps<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly alerts: AlertStore<Tx>;
  readonly directory: RetentionDirectory<Tx>;
  readonly conversations: ConversationStore<Tx>;
  readonly shops: ShopDirectory<Tx>;
  readonly gate: OutboundGate<Tx>;
  readonly audit: AuditAppender<Tx>;
  readonly outbox: OutboxWriter<Tx>;
  readonly loadConfig: (tx: Tx, shopId: string) => Promise<ShopConfig>;
  /** Raises the owner-exception task that outlives the notification. */
  readonly tasks?: AdvisorTaskCreator;
  readonly clock?: Clock;
}

export interface RaiseAlertInput {
  readonly shopId: string;
  readonly kind: AlertKind;
  readonly incidentKey: string;
  readonly subjectType: string;
  readonly subjectId: string | null;
  readonly detail: string;
  readonly urgency?: TaskUrgency;
  readonly jobCardId?: string | null;
  readonly customerId?: string | null;
  readonly traceId: string;
  readonly actor?: Actor;
}

export interface AlertResult {
  readonly alertId: string | null;
  readonly delivered: boolean;
  readonly detail: string;
}

export class AlertService<Tx> {
  private readonly clock: Clock;

  constructor(private readonly deps: AlertServiceDeps<Tx>) {
    this.clock = deps.clock ?? systemClock;
  }

  /**
   * Raises one incident, once.
   *
   * The claim happens before anything is composed, so two workers observing the
   * same incident race on a unique index rather than on WhatsApp. A loser
   * returns `alertId: null` and says so, which is a normal outcome and not an
   * error — the incident *was* reported, by the other one.
   */
  async raise(input: RaiseAlertInput): Promise<AlertResult> {
    const actor = input.actor ?? SYSTEM_ACTOR;
    const now = this.clock.now();
    const alertId = uuidv7();

    const claimed = await this.deps.uow.transaction(async (tx) => {
      const config = await this.deps.loadConfig(tx, input.shopId);
      if (!config.alerts.enabled) return null;

      const owners = await this.deps.directory.owners(tx, input.shopId);
      const owner = owners[0] ?? null;

      const id = await this.deps.alerts.claim(tx, {
        id: alertId,
        shopId: input.shopId,
        kind: input.kind,
        incidentKey: input.incidentKey,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        urgency: input.urgency ?? 'HIGH',
        detail: input.detail,
        recipientStaffId: owner?.staffId ?? null,
        raisedAt: now,
        traceId: input.traceId,
      });
      if (id === null) return null;

      const conversation =
        owner === null
          ? null
          : await this.deps.conversations.findByThreadKey(
              tx,
              input.shopId,
              'WHATSAPP',
              `staff:${owner.staffId}`,
            );

      await this.deps.audit.append(tx, {
        shopId: input.shopId,
        actorType: actor.type,
        actorId: actor.id,
        action: 'alert.raised',
        entityType: input.subjectType,
        entityId: input.subjectId,
        payload: {
          alertId: id,
          kind: input.kind,
          incidentKey: input.incidentKey,
          detail: input.detail,
        },
        traceId: input.traceId,
      });

      return { id, config, owner, conversationId: conversation?.id ?? null };
    });

    if (claimed === null) {
      return {
        alertId: null,
        delivered: false,
        detail: 'Already alerted on this incident, or alerts are off for this shop',
      };
    }

    // The task first. A notification is a thing somebody might miss; a task is a
    // thing somebody has to close, and the phase's whole point is that
    // exceptions close rather than notify (L3).
    let taskId: string | null = null;
    const tasks = this.deps.tasks;
    if (tasks !== undefined) {
      taskId = await tasks.create({
        shopId: input.shopId,
        kind: 'OWNER_EXCEPTION',
        urgency: input.urgency ?? 'HIGH',
        brief: input.detail,
        context: {
          alertId: claimed.id,
          alertKind: input.kind,
          incidentKey: input.incidentKey,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
        },
        jobCardId: input.jobCardId ?? null,
        customerId: input.customerId ?? null,
        dedupeKey: `alert:${input.incidentKey}`,
        actor: { type: actor.type, id: actor.id },
        traceId: input.traceId,
      });
    }

    const held = this.quietHoursHold(claimed.config, input.kind, now);
    if (held !== null || claimed.conversationId === null) {
      const reason = held ?? 'No owner thread to deliver on';
      await this.settle(input.shopId, claimed.id, null, taskId, reason);
      await this.emit(input, claimed.id, null, now, actor);
      return { alertId: claimed.id, delivered: false, detail: reason };
    }

    const language = claimed.owner?.language ?? 'en';
    const outcome = await this.deps.gate.send({
      shopId: input.shopId,
      conversationId: claimed.conversationId,
      customerId: null,
      purpose: 'SERVICE',
      content: { kind: 'text', body: input.detail },
      actor,
      traceId: input.traceId,
      flow: 'status',
      language,
      // A staff notification, not agent prose: it goes out at any autonomy
      // level, because an owner who has the agent in shadow mode still needs to
      // be told their customer is unhappy.
      systemReply: true,
      templated: true,
    });

    await this.settle(
      input.shopId,
      claimed.id,
      outcome.status === 'SENT' ? outcome.messageId : null,
      taskId,
      outcome.status === 'SENT' ? null : outcome.status,
    );
    await this.emit(
      input,
      claimed.id,
      outcome.status === 'SENT' ? outcome.messageId : null,
      now,
      actor,
    );

    return {
      alertId: claimed.id,
      delivered: outcome.status === 'SENT',
      detail:
        outcome.status === 'SENT'
          ? `message ${outcome.messageId}`
          : `${outcome.status}: ${'reason' in outcome ? outcome.reason : ''}`,
    };
  }

  /** Marks an incident over. A resolved incident may be raised again later. */
  async resolve(input: {
    readonly shopId: string;
    readonly incidentKey: string;
    readonly traceId: string;
  }): Promise<boolean> {
    const now = this.clock.now();
    return this.deps.uow.transaction((tx) =>
      this.deps.alerts.resolve(tx, input.shopId, input.incidentKey, now),
    );
  }

  /* --- the five kinds, each with the copy that names it ------------------ */

  async approvalStuck(input: {
    readonly shopId: string;
    readonly approvalId: string;
    readonly jobCardId: string;
    readonly vehicleLabel: string;
    readonly amountPaise: Paise;
    readonly waitedMinutes: number;
    readonly language?: Language;
    readonly traceId: string;
  }): Promise<AlertResult> {
    const language = input.language ?? 'en';
    return this.raise({
      shopId: input.shopId,
      kind: 'APPROVAL_STUCK',
      incidentKey: `approval_stuck:${input.approvalId}`,
      subjectType: 'ApprovalRequest',
      subjectId: input.approvalId,
      jobCardId: input.jobCardId,
      detail: t(language, 'alert.approval_stuck', {
        vehicle: input.vehicleLabel,
        amount: formatPaise(input.amountPaise),
        waited: `${Math.floor(input.waitedMinutes / 60)}h ${input.waitedMinutes % 60}m`,
      }),
      traceId: input.traceId,
    });
  }

  async paymentFailedTwice(input: {
    readonly shopId: string;
    readonly paymentId: string;
    readonly jobCardId: string;
    readonly vehicleLabel: string;
    readonly amountPaise: Paise;
    readonly language?: Language;
    readonly traceId: string;
  }): Promise<AlertResult> {
    const language = input.language ?? 'en';
    return this.raise({
      shopId: input.shopId,
      kind: 'PAYMENT_FAILED_TWICE',
      incidentKey: `payment_failed:${input.paymentId}`,
      subjectType: 'Payment',
      subjectId: input.paymentId,
      jobCardId: input.jobCardId,
      detail: t(language, 'alert.payment_failed', {
        vehicle: input.vehicleLabel,
        amount: formatPaise(input.amountPaise),
      }),
      traceId: input.traceId,
    });
  }

  async voiceKillSwitch(input: {
    readonly shopId: string;
    readonly shopName: string;
    readonly language?: Language;
    readonly traceId: string;
  }): Promise<AlertResult> {
    const language = input.language ?? 'en';
    return this.raise({
      shopId: input.shopId,
      kind: 'VOICE_KILL_SWITCH',
      // Keyed by the day, not by the switch: a kill switch flipped again next
      // month is a new incident an owner needs to hear about.
      incidentKey: `voice_kill_switch:${this.clock.now().toISOString().slice(0, 10)}`,
      subjectType: 'Shop',
      subjectId: null,
      detail: t(language, 'alert.voice_kill_switch', { shopName: input.shopName }),
      traceId: input.traceId,
    });
  }

  async silentBayRepeat(input: {
    readonly shopId: string;
    readonly jobCardId: string;
    readonly vehicleLabel: string;
    readonly windows: number;
    readonly language?: Language;
    readonly traceId: string;
  }): Promise<AlertResult> {
    const language = input.language ?? 'en';
    return this.raise({
      shopId: input.shopId,
      kind: 'SILENT_BAY_REPEAT',
      // The window count is in the key: three silent windows and five are
      // different facts, and an owner told about the third should hear again if
      // it reaches five.
      incidentKey: `silent_bay:${input.jobCardId}:${input.windows}`,
      subjectType: 'JobCard',
      subjectId: input.jobCardId,
      jobCardId: input.jobCardId,
      urgency: 'NORMAL',
      detail: t(language, 'alert.silent_bay_repeat', {
        vehicle: input.vehicleLabel,
        windows: input.windows,
      }),
      traceId: input.traceId,
    });
  }

  async negativeFeedback(input: {
    readonly shopId: string;
    readonly incidentKey: string;
    readonly subjectId: string;
    readonly detail: string;
    readonly customerId: string;
    readonly jobCardId: string;
    readonly traceId: string;
  }): Promise<{ readonly alertId: string | null }> {
    const result = await this.raise({
      shopId: input.shopId,
      kind: 'NEGATIVE_FEEDBACK',
      incidentKey: input.incidentKey,
      subjectType: 'FeedbackRequest',
      subjectId: input.subjectId,
      jobCardId: input.jobCardId,
      customerId: input.customerId,
      detail: input.detail,
      traceId: input.traceId,
    });
    return { alertId: result.alertId };
  }

  /* --------------------------------------------------------------- private */

  /**
   * Whether this kind must wait until morning.
   *
   * Returns the reason to hold, or null to send now. Note what it does *not*
   * do: it never drops. A held alert is stored with its reason and its task is
   * already on somebody's list, so the information survives the delay.
   */
  private quietHoursHold(config: ShopConfig, kind: AlertKind, at: Date): string | null {
    const quiet = evaluateQuietHours(config, at);
    if (!quiet.withinQuietHours) return null;
    if (config.alerts.quietHoursOverride.includes(kind)) return null;
    return `Held until ${quiet.deferUntil?.toISOString() ?? 'morning'}: quiet hours, and ${kind} is not on this shop's override list`;
  }

  private async settle(
    shopId: string,
    alertId: string,
    messageId: string | null,
    taskId: string | null,
    heldReason: string | null,
  ): Promise<void> {
    await this.deps.uow.transaction((tx) =>
      this.deps.alerts.settle(tx, { shopId, alertId, messageId, taskId, heldReason }),
    );
  }

  private async emit(
    input: RaiseAlertInput,
    alertId: string,
    messageId: string | null,
    at: Date,
    actor: Actor,
  ): Promise<void> {
    await this.deps.uow.transaction(async (tx) => {
      const envelope: EventEnvelope = {
        id: uuidv7(),
        type: 'alert.raised',
        occurredAt: at.toISOString(),
        shopId: input.shopId,
        traceId: input.traceId,
        payload: {
          alertId,
          kind: input.kind,
          incidentKey: input.incidentKey,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          urgency: input.urgency ?? 'HIGH',
          detail: input.detail,
          messageId,
          actor: { type: actor.type, id: actor.id },
        },
      };
      await this.deps.outbox.enqueue(tx, envelope);
    });
  }
}
