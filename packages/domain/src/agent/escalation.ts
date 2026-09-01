import type { EscalationLadder, EscalationRung, ShopConfig } from '@serviceloop/config';
import { migrateShopConfig } from '@serviceloop/config';
import {
  formatPaise,
  systemClock,
  t,
  uuidv7,
  type Clock,
  type EscalationRungType,
  type EventEnvelope,
  type Objective,
} from '@serviceloop/shared';
import type { Actor } from '../job-card/context';
import { SYSTEM_ACTOR } from '../job-card/context';
import type { AuditAppender, OutboxWriter, ShopConfigStore, UnitOfWork } from '../ports';
import type { OutboundGate } from '../messaging/outbound-gate';
import type { ConversationStore } from '../messaging/ports';
import { evaluateQuietHours } from '../guardrails/policies';
import type {
  AdvisorTaskStore,
  ApprovalStore,
  EscalationStore,
  EvidenceBundleStore,
  JobCardContextReader,
  RungScheduler,
} from './ports';
import type { RungOutcome, ScheduledRung } from './types';
import type { VoiceCallPlacer } from '../voice/ports';

/**
 * The escalation ladder engine (phase 3.7).
 *
 * L3: ladders close, they do not notify. A ladder is a cadence with a
 * termination condition, measured in time-to-decision, and this is the machine
 * that runs it: rungs scheduled as BullMQ delayed jobs keyed by the subject id,
 * every rung audited, and **every remaining rung cancelled atomically the
 * moment the customer decides or a human takes over**.
 *
 * Three details are the ones that bite in production:
 *
 *   - **The database row is the authority, not the queue job.** Cancellation
 *     updates the row and then best-effort removes the job. A job that fires
 *     anyway finds its rung already `CANCELLED` and does nothing — which is why
 *     a failed `queue.remove` cannot message a customer who already said yes.
 *   - **Quiet hours defer; they never skip.** A rung due at 22:40 is
 *     rescheduled to the morning, because the alternative is a customer whose
 *     ladder silently lost a rung and whose car sits on the lift another day.
 *   - **Rungs are idempotent by unique index.** `(subjectType, subjectId, rung)`
 *     is unique, so a redelivered `approval.requested` re-schedules nothing.
 */

export const APPROVAL_SUBJECT_TYPE = 'ApprovalRequest';

/**
 * Rungs that put a message on a channel, and therefore consume the shop's
 * frequency budget. A phone call and an owner-digest line do not — they are
 * work for a person, not another notification for the customer.
 */
const MESSAGE_RUNGS: ReadonlySet<EscalationRungType> = new Set<EscalationRungType>([
  'WHATSAPP',
  'SMS',
]);

export interface EscalationDeps<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly escalations: EscalationStore<Tx>;
  readonly approvals: ApprovalStore<Tx>;
  readonly bundles: EvidenceBundleStore<Tx>;
  readonly cards: JobCardContextReader<Tx>;
  readonly tasks: AdvisorTaskStore<Tx>;
  readonly conversations: ConversationStore<Tx>;
  readonly config: ShopConfigStore<Tx>;
  readonly gate: OutboundGate<Tx>;
  readonly scheduler: RungScheduler;
  readonly audit: AuditAppender<Tx>;
  readonly outbox: OutboxWriter<Tx>;
  /**
   * The telephone, when the deployment has one (phase 5.4a).
   *
   * Optional, and its absence is not a degraded mode: a shop that has not
   * switched voice on keeps the phase-3 rung, which raises an advisor task with
   * everything a person needs to make the call themselves. The gate refuses on
   * the shop's own settings too, so wiring this does not switch anybody's voice
   * on — it only makes it possible.
   */
  readonly voice?: VoiceCallPlacer;
  readonly clock?: Clock;
}

export interface ScheduleLadderInput {
  readonly shopId: string;
  readonly objective: Objective;
  readonly subjectType: string;
  readonly subjectId: string;
  /** T0 for the ladder — every rung's `afterMinutes` is measured from here. */
  readonly openedAt: Date;
  readonly actor: Actor;
  readonly traceId: string;
  /** Rung 0 is normally already done by the caller that sent the bundle. */
  readonly skipRungs?: readonly number[];
}

export interface FireRungInput {
  readonly shopId: string;
  readonly escalationId: string;
  readonly traceId: string;
}

export interface FireRungResult {
  readonly outcome: RungOutcome;
  readonly detail: string;
}

export class EscalationLadderEngine<Tx> {
  private readonly clock: Clock;

  /**
   * The telephone, which may be attached after construction (phase 5.4a).
   *
   * A constructor argument alone would not be enough: the voice runtime is
   * built *from* this runtime — it reuses the same tools, the same checker and
   * the same approval service — so the runner cannot exist before the ladder
   * does. The composition root builds both and then calls `attachVoice`, which
   * is the one place that ordering is visible rather than a rule somebody has
   * to remember.
   */
  private voicePlacer: VoiceCallPlacer | undefined;

  constructor(private readonly deps: EscalationDeps<Tx>) {
    this.clock = deps.clock ?? systemClock;
    this.voicePlacer = deps.voice;
  }

  /** Gives the ladder a telephone. Idempotent; the last one wins. */
  attachVoice(placer: VoiceCallPlacer): void {
    this.voicePlacer = placer;
  }

  /** True when this deployment is able to ring somebody. */
  get canPlaceCalls(): boolean {
    return this.voicePlacer !== undefined;
  }

  /**
   * Writes every rung of the configured ladder and enqueues its delayed job.
   *
   * Rungs whose time has already passed at scheduling time are enqueued with
   * zero delay rather than dropped: a shop whose config was changed while a
   * request was open should still get its chase, late rather than never.
   */
  async scheduleLadder(input: ScheduleLadderInput): Promise<readonly ScheduledRung[]> {
    const config = await this.loadConfig(input.shopId);
    const ladder = config.ladders[input.objective];
    if (!ladder.enabled) return [];

    const skip = new Set(input.skipRungs ?? []);
    const scheduled: ScheduledRung[] = [];

    for (const [index, rung] of ladder.rungs.entries()) {
      if (skip.has(index)) continue;

      const scheduledAt = new Date(input.openedAt.getTime() + rung.afterMinutes * 60_000);
      const escalationId = uuidv7();

      const created = await this.deps.uow.transaction(async (tx) =>
        this.deps.escalations.schedule(tx, {
          id: escalationId,
          shopId: input.shopId,
          objective: input.objective,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          ladderKey: input.objective,
          rung: index,
          rungType: rung.type,
          channel: channelForRung(rung.type, { canPlaceCalls: this.canPlaceCalls }),
          label: rung.label,
          scheduledAt,
          queueJobId: null,
        }),
      );

      // Null means the unique index already had this rung: a redelivered event.
      if (created === null) continue;

      const queueJobId = await this.deps.scheduler.enqueue({
        escalationId,
        shopId: input.shopId,
        subjectId: input.subjectId,
        runAt: scheduledAt,
      });

      if (queueJobId !== null) {
        await this.deps.uow.transaction(async (tx) =>
          this.deps.escalations.attachQueueJob(tx, escalationId, queueJobId),
        );
      }

      scheduled.push({
        id: escalationId,
        shopId: input.shopId,
        objective: input.objective,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        ladderKey: input.objective,
        rung: index,
        rungType: rung.type,
        label: rung.label,
        scheduledAt,
        queueJobId,
      });
    }

    if (scheduled.length > 0) {
      await this.deps.uow.transaction(async (tx) => {
        await this.deps.audit.append(tx, {
          shopId: input.shopId,
          actorType: input.actor.type,
          actorId: input.actor.id,
          action: 'escalation.scheduled',
          entityType: input.subjectType,
          entityId: input.subjectId,
          payload: {
            objective: input.objective,
            rungs: scheduled.map((rung) => ({
              rung: rung.rung,
              type: rung.rungType,
              at: rung.scheduledAt.toISOString(),
              label: rung.label,
            })),
            giveUpAfterMinutes: ladder.giveUpAfterMinutes,
          },
          traceId: input.traceId,
        });
      });
    }

    return scheduled;
  }

  /** Runs one rung. Called by the worker when its delayed job fires. */
  async fireRung(input: FireRungInput): Promise<FireRungResult> {
    const claimed = await this.deps.uow.transaction(async (tx) =>
      this.deps.escalations.claim(tx, input.shopId, input.escalationId),
    );

    // Already cancelled, already executed, or never existed. All three are the
    // same non-event: the row is the authority and it says this rung is done.
    if (claimed === null) {
      return { outcome: 'SKIPPED', detail: 'Rung is no longer scheduled' };
    }

    const result = await this.execute(claimed, input.traceId);
    const now = this.clock.now();

    await this.deps.uow.transaction(async (tx) => {
      if (result.outcome === 'SKIPPED') {
        await this.deps.escalations.markSkipped(tx, claimed.id, result.detail, now);
      } else {
        await this.deps.escalations.markExecuted(tx, {
          escalationId: claimed.id,
          outcome: result.outcome,
          detail: result.detail,
          at: now,
        });
      }

      await this.deps.audit.append(tx, {
        shopId: claimed.shopId,
        actorType: 'AGENT',
        actorId: null,
        action: 'escalation.rung_fired',
        entityType: claimed.subjectType,
        entityId: claimed.subjectId,
        payload: {
          escalationId: claimed.id,
          objective: claimed.objective,
          rung: claimed.rung,
          rungType: claimed.rungType,
          label: claimed.label,
          outcome: result.outcome,
          detail: result.detail,
        },
        traceId: input.traceId,
      });

      const envelope: EventEnvelope = {
        id: uuidv7(),
        type: 'escalation.rung_fired',
        occurredAt: now.toISOString(),
        shopId: claimed.shopId,
        traceId: input.traceId,
        payload: {
          escalationId: claimed.id,
          objective: claimed.objective as Objective,
          subjectType: claimed.subjectType,
          subjectId: claimed.subjectId,
          rung: claimed.rung,
          rungType: claimed.rungType,
          outcome: result.outcome,
          detail: result.detail,
          actor: { type: 'AGENT', id: null },
        },
      };
      await this.deps.outbox.enqueue(tx, envelope);
    });

    return result;
  }

  /**
   * Cancels every remaining rung for a subject.
   *
   * Called on a customer decision and on a human takeover. The two are the same
   * event as far as the ladder is concerned: the objective is no longer the
   * agent's to chase.
   */
  async cancelForSubject(input: {
    readonly shopId: string;
    readonly subjectType: string;
    readonly subjectId: string;
    readonly reason: string;
    readonly actor: Actor;
    readonly traceId: string;
  }): Promise<readonly number[]> {
    const now = this.clock.now();

    const cancelled = await this.deps.uow.transaction(async (tx) => {
      const rungs = await this.deps.escalations.cancelForSubject(tx, {
        shopId: input.shopId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        at: now,
      });

      if (rungs.length > 0) {
        await this.deps.audit.append(tx, {
          shopId: input.shopId,
          actorType: input.actor.type,
          actorId: input.actor.id,
          action: 'escalation.cancelled',
          entityType: input.subjectType,
          entityId: input.subjectId,
          payload: {
            reason: input.reason,
            rungs: rungs.map((rung) => rung.rung),
          },
          traceId: input.traceId,
        });

        const envelope: EventEnvelope = {
          id: uuidv7(),
          type: 'escalation.cancelled',
          occurredAt: now.toISOString(),
          shopId: input.shopId,
          traceId: input.traceId,
          payload: {
            objective: (rungs[0]?.objective ?? 'APPROVAL') as Objective,
            subjectType: input.subjectType,
            subjectId: input.subjectId,
            cancelledRungs: rungs.map((rung) => rung.rung),
            reason: input.reason,
            actor: { type: input.actor.type, id: input.actor.id },
          },
        };
        await this.deps.outbox.enqueue(tx, envelope);
      }

      return rungs;
    });

    // The queue removal is best effort *by design*: the row above is already
    // CANCELLED, so a job that survives finds nothing to do.
    for (const rung of cancelled) {
      if (rung.queueJobId !== null) {
        await this.deps.scheduler.cancel(rung.queueJobId).catch(() => undefined);
      }
    }

    return cancelled.map((rung) => rung.rung);
  }

  /* ------------------------------------------------------------ execution */

  private async execute(rung: ScheduledRung, traceId: string): Promise<FireRungResult> {
    const config = await this.loadConfig(rung.shopId);

    const subject = await this.deps.uow.transaction(async (tx) => {
      const approval = await this.deps.approvals.lockById(tx, rung.shopId, rung.subjectId);
      if (approval === null) return null;
      const conversation =
        approval.conversationId === null
          ? null
          : await this.deps.conversations.findById(tx, rung.shopId, approval.conversationId);
      const bundle =
        approval.evidenceBundleId === null
          ? null
          : await this.deps.bundles.load(tx, rung.shopId, approval.evidenceBundleId);
      const card = await this.deps.cards.load(tx, rung.shopId, approval.jobCardId);
      return { approval, conversation, bundle, card };
    });

    if (subject === null) {
      return { outcome: 'SKIPPED', detail: 'The approval request no longer exists' };
    }
    if (subject.approval.decidedAt !== null) {
      return { outcome: 'SKIPPED', detail: 'The customer has already decided' };
    }
    if (subject.conversation?.humanOverrideAt != null) {
      return {
        outcome: 'SKIPPED',
        detail: 'A human advisor has taken over this thread',
      };
    }

    // Quiet hours defer rather than skip. The rung is re-enqueued for the
    // morning and the row goes back to SCHEDULED, so nothing is lost.
    const quietHours = evaluateQuietHours(config, this.clock.now());
    if (quietHours.withinQuietHours && quietHours.deferUntil !== null) {
      await this.deferRung(rung, quietHours.deferUntil);
      return {
        outcome: 'DEFERRED',
        detail: `Quiet hours; rung deferred to ${quietHours.deferUntil.toISOString()}`,
      };
    }

    // The minimum interval between messages, honoured by *waiting* rather than
    // by losing the rung.
    //
    // The shipped approval ladder nudges at T+45m and the shipped cap is 60
    // minutes, so a shop on the defaults hits this on its very first reminder.
    // Neither number is wrong: the cadence is what closes an approval, and the
    // cap is what stops a shop pestering someone. Weakening either to make them
    // agree would be weakening a guardrail (master §10); deferring satisfies
    // both, and the customer gets their reminder fifteen minutes later.
    const tooSoon = this.tooSoonUntil(subject.conversation?.lastOutboundAt ?? null, config);
    if (tooSoon !== null && MESSAGE_RUNGS.has(rung.rungType)) {
      await this.deferRung(rung, tooSoon);
      return {
        outcome: 'DEFERRED',
        detail: `Only minutes since the last message; rung deferred to ${tooSoon.toISOString()} to respect the shop's minimum interval`,
      };
    }

    switch (rung.rungType) {
      case 'WHATSAPP':
      case 'SMS':
        return this.sendReminder(rung, subject, traceId);
      case 'VOICE_OR_ADVISOR':
        return this.raiseCallTask(rung, subject, traceId);
      case 'OWNER_DIGEST':
        return this.raiseOwnerException(rung, subject, traceId);
      case 'HUMAN':
        return this.raiseHandoff(rung, subject, traceId);
    }
  }

  private async sendReminder(
    rung: ScheduledRung,
    subject: LadderSubject,
    traceId: string,
  ): Promise<FireRungResult> {
    const { approval, card } = subject;
    if (approval.conversationId === null || approval.customerId === null || card === null) {
      return { outcome: 'SKIPPED', detail: 'The request has no customer thread to remind on' };
    }

    const language = subject.bundle?.language ?? card.customerLanguage;
    const body = t(language, 'approval.reminder', {
      vehicle: card.vehicleLabel,
      amount: formatPaise(approval.amountPaise),
    });

    const outcome = await this.deps.gate.send({
      shopId: rung.shopId,
      conversationId: approval.conversationId,
      customerId: approval.customerId,
      purpose: 'SERVICE',
      content: { kind: 'text', body },
      actor: SYSTEM_ACTOR,
      traceId,
      flow: 'approval',
      language,
      jobCardId: approval.jobCardId,
      createdByAgent: true,
      agentRunId: approval.agentRunId,
      // A reminder restates an estimate the customer already has, so it cites
      // the bundle's own sources rather than making a fresh claim.
      evidenceRefs: subject.bundle?.claims.flatMap((claim) => [...claim.sources]) ?? [],
    });

    switch (outcome.status) {
      case 'SENT':
        return { outcome: 'SENT', detail: `message ${outcome.messageId}` };
      case 'DEFERRED':
        return { outcome: 'DEFERRED', detail: outcome.reason };
      case 'PENDING_APPROVAL':
        return { outcome: 'TASK_CREATED', detail: `held for advisor approval: ${outcome.reason}` };
      case 'BLOCKED':
      case 'FAILED':
        return { outcome: 'BLOCKED', detail: `${outcome.code}: ${outcome.reason}` };
    }
  }

  /**
   * The `VOICE_OR_ADVISOR` rung (phase 5.4a).
   *
   * The rung's name is the whole design: it rings the customer if it can, and
   * it puts the call in front of a person if it cannot. Which of the two
   * happens is decided by the call gate, not here — this method's job is to
   * turn whatever the gate decided into the one thing a ladder rung has to
   * produce, which is an outcome that either closes the loop or hands it to
   * somebody who will (L3).
   *
   * Four endings, and the ordering matters:
   *
   *   1. **A decision.** The customer answered and said yes, no, or later. The
   *      approval service has already recorded it and cancelled the rest of the
   *      ladder; there is nothing left to chase.
   *   2. **Nobody answered, once.** The phase asks for exactly one retry, and
   *      "exactly one" is counted from the call rows for this rung rather than
   *      from a flag, because a deferred rung keeps its id and its row.
   *   3. **A person already has it** — bridged live, or holding an advisor task
   *      the runtime raised on its way out. Raising a second task here would put
   *      the same customer on the queue twice.
   *   4. **Anything else** falls back to the phase-3 behaviour: a prioritised
   *      task carrying the brief. A refusal the gate marked as *not* falling
   *      back to an advisor — a customer who revoked consent — stops instead,
   *      because tasking a person to ring somebody who asked not to be rung is
   *      the same violation with an extra step.
   */
  private async raiseCallTask(
    rung: ScheduledRung,
    subject: LadderSubject,
    traceId: string,
  ): Promise<FireRungResult> {
    const { approval, card } = subject;
    const placer = this.voicePlacer;

    if (placer !== undefined && approval.customerId !== null) {
      const attempts = await placer.attemptsForEscalation(rung.shopId, rung.id);

      const outcome = await placer.placeApprovalCall({
        shopId: rung.shopId,
        jobCardId: approval.jobCardId,
        customerId: approval.customerId,
        conversationId: approval.conversationId,
        approvalRequestId: approval.id,
        escalationId: rung.id,
        amountPaise: approval.amountPaise,
        workSummary:
          card === null
            ? 'the work waiting on your approval'
            : `${card.vehicleLabel} (${card.code})`,
        traceId,
      });

      if (outcome.placed && outcome.answered) {
        if (outcome.decision !== null) {
          return { outcome: 'SENT', detail: `call ${outcome.callId}: ${outcome.decision}` };
        }
        if (outcome.handedOff) {
          return { outcome: 'TASK_CREATED', detail: `call ${outcome.callId} ended with a person` };
        }
        // Answered, no decision, nobody holding it: the customer hung up. The
        // rungs below this one are what chase that, and raising a task here
        // would pre-empt a ladder that has not finished.
        return { outcome: 'SENT', detail: `call ${outcome.callId} ended without a decision` };
      }

      if (outcome.placed && outcome.retryAfterMinutes !== null && attempts === 0) {
        // Nobody answered, and the shop allows one more attempt. `attempts` was
        // read *before* this call, so zero means this was the rung's first ring
        // and the second ring-out falls through to a person — which is the
        // phase's "retry once, then an advisor task", counted from the rows
        // rather than from a flag somebody has to remember to clear.
        const retryAt = new Date(this.clock.now().getTime() + outcome.retryAfterMinutes * 60_000);
        await this.deferRung(rung, retryAt);
        return {
          outcome: 'DEFERRED',
          detail: `Nobody answered; ringing again at ${retryAt.toISOString()}`,
        };
      }

      if (!outcome.fallBackToAdvisor) {
        return {
          outcome: 'BLOCKED',
          detail: `${outcome.refusalCode ?? 'REFUSED'}: ${outcome.refusalReason ?? 'the call gate refused'}`,
        };
      }
    }

    const brief =
      card === null
        ? `Call the customer about approval ${approval.id}`
        : `Call ${card.customerName} about ${card.vehicleLabel} (${card.code}): ${formatPaise(
            approval.amountPaise,
          )} of work is waiting on their decision, ${describeAge(approval.requestedAt, this.clock.now())}.`;

    return this.createTask(rung, subject, traceId, {
      kind: 'CALL_CUSTOMER',
      urgency: 'HIGH',
      brief,
    });
  }

  private async raiseOwnerException(
    rung: ScheduledRung,
    subject: LadderSubject,
    traceId: string,
  ): Promise<FireRungResult> {
    const { approval, card } = subject;
    const brief =
      card === null
        ? `Approval ${approval.id} has had no decision for a day`
        : `No decision for a day on ${card.vehicleLabel} (${card.code}) — ${formatPaise(
            approval.amountPaise,
          )} of work and a bay held since ${approval.requestedAt.toISOString()}.`;

    return this.createTask(rung, subject, traceId, {
      kind: 'OWNER_EXCEPTION',
      urgency: 'HIGH',
      brief,
    });
  }

  private async raiseHandoff(
    rung: ScheduledRung,
    subject: LadderSubject,
    traceId: string,
  ): Promise<FireRungResult> {
    const { approval, card } = subject;
    return this.createTask(rung, subject, traceId, {
      kind: 'HANDOFF',
      urgency: 'NORMAL',
      brief:
        card === null
          ? `Take over approval ${approval.id}`
          : `Take over the approval chase for ${card.vehicleLabel} (${card.code}); the ladder has run out.`,
    });
  }

  private async createTask(
    rung: ScheduledRung,
    subject: LadderSubject,
    traceId: string,
    task: {
      readonly kind: 'CALL_CUSTOMER' | 'OWNER_EXCEPTION' | 'HANDOFF';
      readonly urgency: 'LOW' | 'NORMAL' | 'HIGH';
      readonly brief: string;
    },
  ): Promise<FireRungResult> {
    const now = this.clock.now();
    const { approval, card } = subject;

    const taskId = await this.deps.uow.transaction(async (tx) => {
      const id = await this.deps.tasks.create(
        tx,
        uuidv7(),
        {
          shopId: rung.shopId,
          kind: task.kind,
          urgency: task.urgency,
          brief: task.brief,
          context: {
            approvalId: approval.id,
            jobCardId: approval.jobCardId,
            jobCardCode: card?.code ?? null,
            amountPaise: approval.amountPaise,
            workItemIds: [...approval.workItemIds],
            evidenceBundleId: approval.evidenceBundleId,
            rung: rung.rung,
            rungType: rung.rungType,
            requestedAt: approval.requestedAt.toISOString(),
          },
          jobCardId: approval.jobCardId,
          conversationId: approval.conversationId,
          customerId: approval.customerId,
          approvalRequestId: approval.id,
          agentRunId: approval.agentRunId,
          // One task per rung per subject: a redelivered job re-uses it rather
          // than filling an advisor's list with the same phone call.
          dedupeKey: `escalation:${rung.subjectId}:${rung.rung}`,
        },
        now,
      );

      const envelope: EventEnvelope = {
        id: uuidv7(),
        type: 'advisor_task.created',
        occurredAt: now.toISOString(),
        shopId: rung.shopId,
        traceId,
        payload: {
          taskId: id,
          kind: task.kind,
          urgency: task.urgency,
          jobCardId: approval.jobCardId,
          conversationId: approval.conversationId,
          brief: task.brief,
          actor: { type: 'AGENT', id: null },
        },
      };
      await this.deps.outbox.enqueue(tx, envelope);

      return id;
    });

    return { outcome: 'TASK_CREATED', detail: `advisor task ${taskId}` };
  }

  /**
   * The instant this shop's minimum interval elapses, or null if it already has.
   *
   * Read from the conversation's own `lastOutboundAt` rather than from a fresh
   * query, and computed with the same config value `checkFrequencyCaps` uses —
   * so the ladder waits for exactly as long as the gate would have refused for.
   */
  private tooSoonUntil(lastOutboundAt: Date | null, config: ShopConfig): Date | null {
    if (lastOutboundAt === null) return null;
    const minimumMs = config.frequencyCaps.minMinutesBetweenMessages * 60_000;
    const earliest = new Date(lastOutboundAt.getTime() + minimumMs);
    return earliest.getTime() > this.clock.now().getTime() ? earliest : null;
  }

  private async deferRung(rung: ScheduledRung, until: Date): Promise<void> {
    // The old job is dropped first: leaving it in place would fire the rung
    // again at the original quiet-hours time and defer it a second time, which
    // is a loop rather than a hold.
    if (rung.queueJobId !== null) {
      await this.deps.scheduler.cancel(rung.queueJobId).catch(() => undefined);
    }

    const queueJobId = await this.deps.scheduler.enqueue({
      escalationId: rung.id,
      shopId: rung.shopId,
      subjectId: rung.subjectId,
      runAt: until,
    });

    await this.deps.uow.transaction(async (tx) => {
      await this.deps.escalations.schedule(tx, {
        id: rung.id,
        shopId: rung.shopId,
        objective: rung.objective,
        subjectType: rung.subjectType,
        subjectId: rung.subjectId,
        ladderKey: rung.ladderKey,
        rung: rung.rung,
        rungType: rung.rungType,
        channel: channelForRung(rung.rungType, { canPlaceCalls: this.canPlaceCalls }),
        label: rung.label,
        scheduledAt: until,
        queueJobId,
      });
    });
  }

  private async loadConfig(shopId: string): Promise<ShopConfig> {
    return this.deps.uow.transaction(async (tx) => {
      const stored = await this.deps.config.load(tx, shopId);
      const timezone = (await this.deps.config.loadShopTimezone(tx, shopId)) ?? 'Asia/Kolkata';
      return migrateShopConfig(stored?.raw ?? {}, timezone).config;
    });
  }
}

interface LadderSubject {
  readonly approval: {
    readonly id: string;
    readonly jobCardId: string;
    readonly conversationId: string | null;
    readonly customerId: string | null;
    readonly evidenceBundleId: string | null;
    readonly workItemIds: readonly string[];
    readonly amountPaise: number;
    readonly agentRunId: string | null;
    readonly requestedAt: Date;
    readonly decidedAt: Date | null;
  };
  readonly conversation: {
    readonly humanOverrideAt: Date | null;
    readonly lastOutboundAt: Date | null;
  } | null;
  readonly bundle: { readonly language: 'en' | 'ta' | 'hi'; readonly claims: readonly { readonly sources: readonly string[] }[] } | null;
  readonly card: {
    readonly code: string;
    readonly customerName: string;
    readonly customerLanguage: 'en' | 'ta' | 'hi';
    readonly vehicleLabel: string;
  } | null;
}

/**
 * What the rung will actually use, as opposed to what it *is*.
 *
 * `VOICE_OR_ADVISOR` reports `HUMAN` unless the deployment can place calls, at
 * which point it reports `VOICE`. The parameter exists because the channel is
 * written when the rung is *scheduled* — hours before it fires — so the honest
 * answer is "what this deployment is able to do", not "what happened". What
 * happened is on the call row and in the rung's own result detail.
 */
export function channelForRung(
  type: EscalationRungType,
  options: { readonly canPlaceCalls?: boolean } = {},
): 'WHATSAPP' | 'SMS' | 'VOICE' | 'HUMAN' {
  switch (type) {
    case 'WHATSAPP':
      return 'WHATSAPP';
    case 'SMS':
      return 'SMS';
    case 'VOICE_OR_ADVISOR':
      return options.canPlaceCalls === true ? 'VOICE' : 'HUMAN';
    case 'OWNER_DIGEST':
    case 'HUMAN':
      return 'HUMAN';
  }
}

/** Rung timings for a ladder, for tests and for the console's ladder preview. */
export function rungSchedule(ladder: EscalationLadder, openedAt: Date): readonly Date[] {
  return ladder.rungs.map(
    (rung: EscalationRung) => new Date(openedAt.getTime() + rung.afterMinutes * 60_000),
  );
}

function describeAge(from: Date, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - from.getTime()) / 60_000));
  if (minutes < 60) return `sent ${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `sent ${hours} hours ago`;
  return `sent ${Math.round(hours / 24)} days ago`;
}
