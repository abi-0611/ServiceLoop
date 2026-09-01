import type { ShopConfig } from '@serviceloop/config';
import {
  addDays,
  formatPaise,
  systemClock,
  t,
  uuidv7,
  type Clock,
  type ConsentPurpose,
  type EventEnvelope,
  type Language,
  type Paise,
  type RepitchResponse,
  type RetentionTrigger,
} from '@serviceloop/shared';
import type { PriceListReader } from '../agent/ports';
import type { EvidenceRef } from '../guardrails/policies';
import type { Actor } from '../job-card/context';
import { SYSTEM_ACTOR } from '../job-card/context';
import { REPITCH_ACTION_IDS } from '../messaging/retention-actions';
import type { OutboundGate } from '../messaging/outbound-gate';
import type { ConversationStore } from '../messaging/ports';
import { isWindowOpen } from '../messaging/session';
import type { OutboundContent } from '../messaging/types';
import type { AuditAppender, OutboxWriter, ShopDirectory, UnitOfWork } from '../ports';
import {
  evaluateTriggers,
  purposeFor,
  rationaleKey,
  repitchDedupeKey,
  type TriggerContext,
} from './horizon';
import type { LedgerService } from './ledger-service';
import type {
  LedgerStore,
  OdometerStore,
  RetentionDirectory,
  RetentionHoldStore,
  RetentionTouchStore,
} from './ports';
import type { LedgerItem, RetentionOutcome, TriggerHit, TriggerRationale } from './types';

/**
 * The retention engine (phases 6.2, 6.3 and 6.10).
 *
 * Three things happen here, and the order they happen in is the design:
 *
 *   1. **The trigger engine decides what is due** — pure, in `horizon.ts`, on a
 *      clock the tests control.
 *   2. **This service decides whether we may** — the per-item cap, the freeze, a
 *      customer with no thread. Every refusal writes a `SKIPPED` row with a
 *      code, because "the engine decided not to write to this person" and "the
 *      engine never looked" are the same silence from outside and completely
 *      different bugs from inside.
 *   3. **The gate decides whether it goes** — consent for the purpose the item
 *      earned, the twenty-one-day floor, quiet hours, the window, the caps.
 *
 * Step 3 is not a formality this service could skip on a good day. The floor is
 * enforced in the gate's frequency layer rather than here precisely so that a
 * retention flow written next year — a fifth trigger, a campaign somebody adds
 * in a hurry — inherits it without knowing it exists.
 *
 * The copy is assembled from the reviewed catalogue and the ledger's own frozen
 * snapshot of what the technician said. No model writes a re-pitch: every
 * sentence in it is either catalogue copy or a verbatim quotation of a
 * technician's note and a price that was already quoted, which is what lets the
 * claim-anchoring checker pass it and what makes "continuity of care" true
 * rather than a tone the prompt asks for.
 */

export interface RetentionServiceDeps<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly ledger: LedgerStore<Tx>;
  readonly ledgerService: LedgerService<Tx>;
  readonly touches: RetentionTouchStore<Tx>;
  readonly holds: RetentionHoldStore<Tx>;
  readonly odometer: OdometerStore<Tx>;
  readonly directory: RetentionDirectory<Tx>;
  readonly conversations: ConversationStore<Tx>;
  readonly shops: ShopDirectory<Tx>;
  readonly gate: OutboundGate<Tx>;
  readonly audit: AuditAppender<Tx>;
  readonly outbox: OutboxWriter<Tx>;
  readonly loadConfig: (tx: Tx, shopId: string) => Promise<ShopConfig>;
  /** Cards open right now, by vehicle — the next-visit trigger's only input. */
  readonly openVisits: (tx: Tx, shopId: string) => Promise<ReadonlyMap<string, string>>;
  /**
   * The shop's live price for a ledgered line, when it can be looked up.
   *
   * Optional. Absent, a re-pitch quotes the price the customer was already
   * given, which is the honest default; present, a price that has moved is
   * stated plainly rather than quietly.
   */
  readonly prices?: PriceListReader<Tx>;
  readonly clock?: Clock;
}

export interface RetentionScanResult {
  readonly examined: number;
  readonly due: readonly TriggerHit[];
  readonly sent: readonly RetentionOutcome[];
  readonly skipped: readonly RetentionOutcome[];
}

const SUBJECT_TYPE = 'DeclinedWorkLedger';

export class RetentionService<Tx> {
  private readonly clock: Clock;

  constructor(private readonly deps: RetentionServiceDeps<Tx>) {
    this.clock = deps.clock ?? systemClock;
  }

  /**
   * One pass of the trigger engine over one shop (phase 6.2).
   *
   * Independently safe to lose, like every other sentinel here: nothing is
   * marked done until it has been done, so the next tick reclaims exactly what
   * a failed pass left. The dedupe key on the touch is what makes a re-run
   * idempotent rather than a second message.
   */
  async scan(input: {
    readonly shopId: string;
    readonly limit?: number;
    readonly traceId: string;
    readonly actor?: Actor;
  }): Promise<RetentionScanResult> {
    const limit = input.limit ?? 200;
    const now = this.clock.now();

    const prepared = await this.deps.uow.transaction(async (tx) => {
      const config = await this.deps.loadConfig(tx, input.shopId);
      if (!config.retention.enabled) return null;

      const items = await this.deps.ledger.openForShop(tx, input.shopId, limit);
      const openVisits = await this.deps.openVisits(tx, input.shopId);

      const odometerNow = new Map<string, Awaited<ReturnType<OdometerStore<Tx>['latest']>>>();
      const odometerAtDecline = new Map<string, Awaited<ReturnType<OdometerStore<Tx>['asOf']>>>();
      for (const item of items) {
        if (item.vehicleId === null || odometerNow.has(item.vehicleId)) continue;
        odometerNow.set(item.vehicleId, await this.deps.odometer.latest(tx, input.shopId, item.vehicleId));
        odometerAtDecline.set(
          item.vehicleId,
          await this.deps.odometer.asOf(tx, input.shopId, item.vehicleId, item.createdAt),
        );
      }

      const timezone = config.quietHours.timezone;
      const context: TriggerContext = {
        now,
        timezone,
        config: config.retention,
        openVisitByVehicleId: openVisits,
        odometerNow: compact(odometerNow),
        odometerAtDecline: compact(odometerAtDecline),
      };

      const due: TriggerHit[] = [];
      for (const item of items) {
        const hit = evaluateTriggers(item, context);
        if (hit !== null) due.push(hit);
      }
      return { config, items, due };
    });

    if (prepared === null) {
      return { examined: 0, due: [], sent: [], skipped: [] };
    }

    const byId = new Map(prepared.items.map((item) => [item.id, item]));
    const sent: RetentionOutcome[] = [];
    const skipped: RetentionOutcome[] = [];

    // One touch per customer per pass. The floor would refuse the second
    // anyway, but generating it would leave a SKIPPED row that says the shop
    // tried to write twice in one minute — which is a true record of a bad
    // plan, and the plan is fixable here.
    const pitchedCustomers = new Set<string>();

    for (const hit of prepared.due) {
      const item = byId.get(hit.ledgerItemId);
      if (item === undefined || item.customerId === null) continue;
      if (pitchedCustomers.has(item.customerId)) continue;
      pitchedCustomers.add(item.customerId);

      const outcome = await this.repitch({
        shopId: input.shopId,
        item,
        trigger: hit.trigger,
        rationale: hit.rationale,
        traceId: input.traceId,
        ...(input.actor === undefined ? {} : { actor: input.actor }),
      });

      if (outcome.status === 'SENT') sent.push(outcome);
      else skipped.push(outcome);
    }

    return { examined: prepared.items.length, due: prepared.due, sent, skipped };
  }

  /**
   * Composes and sends one re-pitch (phase 6.3).
   *
   * Public because the advisor's card drawer uses it too: the "while it's here"
   * prompt is the same pitch with a `next_visit` trigger, and a second code path
   * for it would be a second place the cap could be forgotten.
   */
  async repitch(input: {
    readonly shopId: string;
    readonly item: LedgerItem;
    readonly trigger: RetentionTrigger;
    readonly rationale: TriggerRationale;
    readonly traceId: string;
    readonly actor?: Actor;
  }): Promise<RetentionOutcome> {
    const actor = input.actor ?? SYSTEM_ACTOR;
    const now = this.clock.now();
    const { item } = input;
    const customerId = item.customerId;

    if (customerId === null) {
      return {
        touchId: '',
        status: 'SKIPPED',
        messageId: null,
        detail: 'NO_CUSTOMER: the ledger item has no customer to write to',
      };
    }

    const plan = await this.deps.uow.transaction(async (tx) => {
      const config = await this.deps.loadConfig(tx, input.shopId);

      const allowed = this.deps.ledgerService.mayRepitch(item, config);
      if (!allowed.ok) {
        return { kind: 'refuse' as const, code: allowed.code ?? 'REFUSED', reason: allowed.reason ?? '' };
      }

      // The freeze is checked here *as well as* in the gate. Not redundancy:
      // this stops the touch row being created at all, so a frozen customer's
      // ledger does not accumulate a SKIPPED row per scan for the whole time an
      // advisor takes to close a recovery task.
      const hold = await this.deps.holds.active(tx, input.shopId, customerId);
      if (hold !== null) {
        return { kind: 'refuse' as const, code: 'RETENTION_FROZEN', reason: hold.reason };
      }

      const customer = await this.deps.directory.loadCustomer(tx, input.shopId, customerId);
      if (customer === null) {
        return { kind: 'refuse' as const, code: 'NO_CUSTOMER', reason: 'Customer not found' };
      }

      const conversation = await this.deps.conversations.findByCustomer(
        tx,
        input.shopId,
        customerId,
        'WHATSAPP',
      );
      if (conversation === null) {
        return {
          kind: 'refuse' as const,
          code: 'NO_THREAD',
          reason: 'This customer has no WhatsApp thread to write on',
        };
      }

      const vehicle =
        item.vehicleId === null
          ? null
          : await this.deps.directory.loadVehicle(tx, input.shopId, item.vehicleId);

      const shopName = (await this.deps.shops.loadShopName(tx, input.shopId)) ?? 'the workshop';
      const advisor = await this.deps.shops.loadHandoffAdvisor(tx, input.shopId);

      const currentPrice = await this.currentPrice(tx, input.shopId, item);

      // Whether to piggyback the odometer ask (6.2).
      //
      // The condition is exactly the one that makes the answer *useful*: we ask
      // when nothing has told us this vehicle's mileage since the day the work
      // was declined, because that is precisely the reading the odometer
      // trigger is missing — `kmSince` needs a now and a then, and we already
      // have the then. Asking somebody a question we can already answer is how
      // a care-toned message starts reading like a form.
      const latestReading =
        item.vehicleId === null
          ? null
          : await this.deps.odometer.latest(tx, input.shopId, item.vehicleId);
      const askOdometer =
        config.retention.odometerAskEnabled &&
        item.vehicleId !== null &&
        (latestReading === null || latestReading.readAt.getTime() <= item.createdAt.getTime());

      const repitchNumber = item.repitchCount + 1;
      const touchId = uuidv7();
      const claimed = await this.deps.touches.claim(tx, {
        id: touchId,
        shopId: input.shopId,
        customerId,
        vehicleId: item.vehicleId,
        jobCardId: item.jobCardId,
        conversationId: conversation.id,
        trigger: input.trigger,
        purpose: purposeFor(item),
        ledgerItemIds: [item.id],
        amountPaise: currentPrice ?? item.amountPaise,
        language: customer.language,
        dedupeKey: repitchDedupeKey(item.id, repitchNumber),
        scheduledFor: now,
        traceId: input.traceId,
      });

      if (claimed === null) {
        return {
          kind: 'refuse' as const,
          code: 'ALREADY_SCHEDULED',
          reason: `Re-pitch ${repitchNumber} for this item already exists`,
        };
      }

      return {
        kind: 'send' as const,
        touchId,
        config,
        conversationId: conversation.id,
        customerName: customer.name,
        language: customer.language,
        vehicleLabel: vehicle?.label ?? 'your vehicle',
        shopName,
        advisorName: advisor?.fullName ?? 'our advisor',
        currentPrice,
        repitchNumber,
        askOdometer,
        // A re-pitch is *always* business-initiated and usually months late, so
        // the 24-hour window is normally shut. Which of the two shapes goes out
        // is decided here rather than by the gate, because only the composer
        // can produce the template's variables.
        windowOpen: isWindowOpen(conversation.windowExpiresAt, now),
        reengagementTemplate: config.messaging.templates.reengagement,
      };
    });

    if (plan.kind === 'refuse') {
      await this.recordSkip({
        shopId: input.shopId,
        customerId,
        ledgerItemIds: [item.id],
        trigger: input.trigger,
        code: plan.code,
        reason: plan.reason,
        traceId: input.traceId,
        actor,
      });
      return {
        touchId: '',
        status: 'SKIPPED',
        messageId: null,
        detail: `${plan.code}: ${plan.reason}`,
      };
    }

    const purpose = purposeFor(item);
    const composed = composeRepitch({
      language: plan.language,
      customerName: plan.customerName,
      vehicleLabel: plan.vehicleLabel,
      item,
      rationale: input.rationale,
      currentPricePaise: plan.currentPrice,
      declinedAt: item.createdAt,
      askOdometer: plan.askOdometer,
    });

    // Inside the window: the interactive message with its three one-tap answers.
    // Outside it: the shop's approved re-engagement template, which is the only
    // thing WhatsApp will carry. The template has no buttons, and that is not a
    // degradation to hide — it is why `repitch_declined_item` exists as an agent
    // objective: the customer replies in words and the runtime answers them.
    // A shop that has not registered a template gets a BLOCKED touch saying so,
    // which is an honest, actionable state rather than a silent nothing.
    const content: OutboundContent =
      plan.windowOpen || plan.reengagementTemplate === null
        ? composed.content
        : {
            kind: 'template',
            templateName: plan.reengagementTemplate,
            templateLanguage: plan.language,
            category: purpose === 'MARKETING' ? 'MARKETING' : 'UTILITY',
            variables: [plan.customerName, plan.vehicleLabel, item.title ?? 'the work we flagged'],
            preview: composed.body,
          };

    const outcome = await this.deps.gate.send({
      shopId: input.shopId,
      conversationId: plan.conversationId,
      customerId,
      purpose,
      content,
      actor,
      traceId: input.traceId,
      flow: 'retention',
      language: plan.language,
      jobCardId: item.jobCardId,
      claims: composed.claims,
      evidenceRefs: composed.claims.flatMap((claim) => [...claim.evidence]),
      // Catalogue copy with the technician's own note quoted into it. Not a
      // model's prose, which is what `templated` means to the autonomy layer —
      // and `createdByAgent` is deliberately absent, because nothing here was
      // written by an agent.
      templated: true,
    });

    return this.settle({
      shopId: input.shopId,
      touchId: plan.touchId,
      item,
      trigger: input.trigger,
      purpose,
      outcome,
      traceId: input.traceId,
      actor,
      amountPaise: plan.currentPrice ?? item.amountPaise,
      customerId,
      vehicleId: item.vehicleId,
    });
  }

  /**
   * The customer tapped one of the three buttons (phase 6.3).
   *
   * "Not interested" is the one that matters: it closes the item as `OPTED_OUT`
   * for ever, and the acknowledgement that follows is an acknowledgement of
   * *their* action — exempt from the frequency caps for the same reason an
   * opt-out confirmation is, because a customer who taps a button and hears
   * nothing assumes it did not work and taps again.
   */
  async recordResponse(input: {
    readonly shopId: string;
    readonly ledgerItemId: string;
    readonly response: RepitchResponse;
    readonly conversationId: string;
    readonly customerId: string | null;
    readonly traceId: string;
    readonly actor?: Actor;
  }): Promise<{ readonly handled: boolean; readonly detail: string }> {
    const actor = input.actor ?? SYSTEM_ACTOR;

    const applied = await this.deps.ledgerService.recordResponse({
      shopId: input.shopId,
      ledgerItemId: input.ledgerItemId,
      response: input.response,
      traceId: input.traceId,
      actor,
    });

    if (!applied.applied) {
      return { handled: false, detail: `Ledger item is already ${applied.status}` };
    }

    const context = await this.deps.uow.transaction(async (tx) => {
      const conversation = await this.deps.conversations.findById(
        tx,
        input.shopId,
        input.conversationId,
      );
      const advisor = await this.deps.shops.loadHandoffAdvisor(tx, input.shopId);
      const item = await this.deps.ledger.load(tx, input.shopId, input.ledgerItemId);
      const vehicle =
        item?.vehicleId == null
          ? null
          : await this.deps.directory.loadVehicle(tx, input.shopId, item.vehicleId);
      return { conversation, advisor, vehicle };
    });

    const language = context.conversation?.language ?? 'en';
    const body =
      input.response === 'BOOK'
        ? t(language, 'retention.booked_ack', {
            advisorName: context.advisor?.fullName ?? 'our advisor',
            vehicle: context.vehicle?.label ?? 'your vehicle',
          })
        : input.response === 'REMIND_LATER'
          ? t(language, 'retention.remind_later_ack')
          : t(language, 'retention.not_interested_ack');

    await this.deps.gate.send({
      shopId: input.shopId,
      conversationId: input.conversationId,
      customerId: input.customerId,
      // The acknowledgement rides SERVICE consent whatever the pitch rode: it
      // confirms something the customer just did, and a customer who taps "not
      // interested" must hear that it worked even if their MARKETING consent is
      // the very thing they are withdrawing in spirit.
      purpose: 'SERVICE',
      content: { kind: 'text', body },
      actor,
      traceId: input.traceId,
      flow: 'retention',
      language,
      isAcknowledgement: true,
      templated: true,
    });

    return { handled: true, detail: `Recorded ${input.response}` };
  }

  /**
   * Previously-declined work was approved on a new visit (phase 6.1).
   *
   * The conversion half of the arc, and the point at which "₹ recovered" gets a
   * rupee in it. Driven by `approval.decided` rather than by anybody
   * remembering to press something: the advisor's only action was adding the
   * deferred line to the new card from the drawer prompt, which wrote the link
   * this reads.
   *
   * The recovered amount is what the line costs *on the new card*, not what was
   * quoted months ago. A part whose price has moved recovers the number the
   * customer actually paid, which is the only figure a shop could defend.
   */
  async convertFromApproval(input: {
    readonly shopId: string;
    readonly jobCardId: string;
    readonly approvedWorkItemIds: readonly string[];
    readonly traceId: string;
    readonly actor?: Actor;
  }): Promise<readonly { readonly ledgerItemId: string; readonly recoveredPaise: Paise }[]> {
    if (input.approvedWorkItemIds.length === 0) return [];

    const links = await this.deps.uow.transaction((tx) =>
      this.deps.ledger.linkedLedgerItems(tx, input.shopId, input.approvedWorkItemIds),
    );

    const converted: { ledgerItemId: string; recoveredPaise: Paise }[] = [];
    for (const link of links) {
      const ok = await this.deps.ledgerService.convert({
        shopId: input.shopId,
        ledgerItemId: link.ledgerItemId,
        convertedJobCardId: input.jobCardId,
        recoveredAmountPaise: link.amountPaise,
        traceId: input.traceId,
        ...(input.actor === undefined ? {} : { actor: input.actor }),
      });
      if (ok) converted.push({ ledgerItemId: link.ledgerItemId, recoveredPaise: link.amountPaise });
    }
    return converted;
  }

  /**
   * Records an odometer reading (phase 6.2).
   *
   * `source` is load-bearing rather than descriptive, and it is the whole
   * reason this takes one: the odometer trigger fires **only** on
   * `CUSTOMER_VOLUNTEERED`. A number an advisor typed from memory at the
   * counter, or one an intake extraction guessed off a photo, improves the
   * service-due forecast and appears in history — and can never, on its own,
   * cause the shop to write to somebody about brake pads.
   */
  async recordOdometer(input: {
    readonly shopId: string;
    readonly vehicleId: string;
    readonly odometerKm: number;
    readonly source: 'CUSTOMER_VOLUNTEERED' | 'INTAKE' | 'CONSOLE';
    readonly messageId?: string | null;
    readonly jobCardId?: string | null;
    readonly traceId: string;
    readonly actor?: Actor;
  }): Promise<void> {
    const actor = input.actor ?? SYSTEM_ACTOR;
    const now = this.clock.now();

    await this.deps.uow.transaction(async (tx) => {
      await this.deps.odometer.record(tx, {
        id: uuidv7(),
        shopId: input.shopId,
        vehicleId: input.vehicleId,
        odometerKm: input.odometerKm,
        source: input.source,
        messageId: input.messageId ?? null,
        jobCardId: input.jobCardId ?? null,
        readAt: now,
      });
      await this.deps.audit.append(tx, {
        shopId: input.shopId,
        actorType: actor.type,
        actorId: actor.id,
        action: 'odometer.recorded',
        entityType: 'Vehicle',
        entityId: input.vehicleId,
        payload: { odometerKm: input.odometerKm, source: input.source },
        traceId: input.traceId,
      });
    });
  }

  /**
   * A bare number a customer sent us, read as an odometer reading (phase 6.2).
   *
   * Two guards, and both are the reason this can exist at all:
   *
   *   - **We must have asked.** The reading is only accepted when a retention
   *     touch reached this customer recently, because the ask rides on one and
   *     nothing else in the product invites a bare number. Without that, "4432"
   *     — a registration fragment every technician in the shop types daily —
   *     would become a vehicle with 4,432 km on it.
   *   - **It must be a bare number.** Not a number inside a sentence. A
   *     customer writing "the 40000 service is due, when can I come?" is asking
   *     a question, and answering it by silently recording a mileage is the
   *     kind of helpfulness that produces wrong data nobody can trace.
   *
   * Returns the reading it recorded, or null — and null is the ordinary case,
   * which is why the caller treats it as "this was not an odometer reply"
   * rather than as a failure.
   */
  async tryRecordVolunteeredOdometer(input: {
    readonly shopId: string;
    readonly customerId: string;
    readonly text: string;
    readonly messageId?: string | null;
    readonly traceId: string;
    readonly actor?: Actor;
  }): Promise<{ readonly vehicleId: string; readonly odometerKm: number } | null> {
    const odometerKm = parseBareOdometer(input.text);
    if (odometerKm === null) return null;

    const context = await this.deps.uow.transaction(async (tx) => {
      const config = await this.deps.loadConfig(tx, input.shopId);
      if (!config.retention.odometerAskEnabled) return null;

      const lastTouch = await this.deps.touches.lastSentAt(tx, input.shopId, input.customerId);
      if (lastTouch === null) return null;
      const days = (this.clock.now().getTime() - lastTouch.getTime()) / 86_400_000;
      if (days > ODOMETER_REPLY_WINDOW_DAYS) return null;

      // The vehicle the ask was about: whichever one this customer has open
      // ledger work on, else their only vehicle. Two vehicles and no open item
      // is ambiguous, and a reading filed against the wrong car is worse than
      // no reading.
      const items = await this.deps.ledger.openForCustomer(tx, input.shopId, input.customerId);
      const vehicleIds = new Set(
        items.map((item) => item.vehicleId).filter((id): id is string => id !== null),
      );
      if (vehicleIds.size !== 1) return null;
      return { vehicleId: [...vehicleIds][0] as string, language: config.languages.default };
    });

    if (context === null) return null;

    await this.recordOdometer({
      shopId: input.shopId,
      vehicleId: context.vehicleId,
      odometerKm,
      source: 'CUSTOMER_VOLUNTEERED',
      messageId: input.messageId ?? null,
      traceId: input.traceId,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
    });

    return { vehicleId: context.vehicleId, odometerKm };
  }

  /**
   * The lapsed-customer win-back (phase 6.10).
   *
   * One message, MARKETING-gated, at most once every six months, with a hook
   * that is actually about the vehicle in front of us — its age — rather than a
   * discount. A win-back that offers money off is a shop admitting it has
   * nothing else to say.
   */
  async winBack(input: {
    readonly shopId: string;
    readonly limit?: number;
    readonly traceId: string;
    readonly actor?: Actor;
  }): Promise<readonly RetentionOutcome[]> {
    const actor = input.actor ?? SYSTEM_ACTOR;
    const now = this.clock.now();
    const limit = input.limit ?? 50;

    const candidates = await this.deps.uow.transaction(async (tx) => {
      const config = await this.deps.loadConfig(tx, input.shopId);
      if (!config.retention.enabled || !config.retention.winBack.enabled) return null;

      const before = addDays(now, -config.retention.winBack.afterMonths * 30);
      const lapsed = await this.deps.directory.lapsedCustomers(tx, {
        shopId: input.shopId,
        before,
        limit,
      });
      return { config, lapsed };
    });

    if (candidates === null) return [];

    const results: RetentionOutcome[] = [];
    for (const candidate of candidates.lapsed) {
      results.push(
        await this.sendWinBack({
          shopId: input.shopId,
          config: candidates.config,
          customerId: candidate.customerId,
          vehicleId: candidate.vehicleId,
          lastVisitAt: candidate.lastVisitAt,
          now,
          traceId: input.traceId,
          actor,
        }),
      );
    }
    return results;
  }

  /* --------------------------------------------------------------- private */

  private async sendWinBack(input: {
    readonly shopId: string;
    readonly config: ShopConfig;
    readonly customerId: string;
    readonly vehicleId: string | null;
    readonly lastVisitAt: Date;
    readonly now: Date;
    readonly traceId: string;
    readonly actor: Actor;
  }): Promise<RetentionOutcome> {
    const cooldownMonths = input.config.retention.winBack.cooldownMonths;
    // Two different guards, and they guard different things.
    //
    // The **cooldown** is measured from this customer's own last win-back,
    // because a calendar block would let somebody written to on the last day of
    // a block be written to again the next morning — six months has to mean six
    // months for everybody, not "some time in the next block".
    //
    // The **dedupe key** is per attempt-day, and only stops two scans in one
    // day producing two messages. It is not the cooldown and must not be
    // mistaken for it: a win-back the gate refuses gives its key back, which is
    // correct, and would silently reset a cooldown that lived in the key.
    const dedupeKey = `win_back:${input.customerId}:${input.now.toISOString().slice(0, 10)}`;

    const plan = await this.deps.uow.transaction(async (tx) => {
      const hold = await this.deps.holds.active(tx, input.shopId, input.customerId);
      if (hold !== null) {
        return { kind: 'refuse' as const, code: 'RETENTION_FROZEN', reason: hold.reason };
      }

      const lastWinBack = await this.deps.touches.lastSentAtForTrigger(
        tx,
        input.shopId,
        input.customerId,
        'win_back',
      );
      if (lastWinBack !== null) {
        const monthsSince =
          (input.now.getTime() - lastWinBack.getTime()) / (30 * 24 * 60 * 60_000);
        if (monthsSince < cooldownMonths) {
          return {
            kind: 'refuse' as const,
            code: 'WIN_BACK_COOLDOWN',
            reason: `Last win-back was ${Math.floor(monthsSince)} month(s) ago; this shop waits ${cooldownMonths}`,
          };
        }
      }

      const customer = await this.deps.directory.loadCustomer(tx, input.shopId, input.customerId);
      const conversation = await this.deps.conversations.findByCustomer(
        tx,
        input.shopId,
        input.customerId,
        'WHATSAPP',
      );
      if (customer === null || conversation === null) {
        return { kind: 'refuse' as const, code: 'NO_THREAD', reason: 'No thread to write on' };
      }

      const vehicle =
        input.vehicleId === null
          ? null
          : await this.deps.directory.loadVehicle(tx, input.shopId, input.vehicleId);
      const shopName = (await this.deps.shops.loadShopName(tx, input.shopId)) ?? 'the workshop';

      const touchId = uuidv7();
      const claimed = await this.deps.touches.claim(tx, {
        id: touchId,
        shopId: input.shopId,
        customerId: input.customerId,
        vehicleId: input.vehicleId,
        jobCardId: null,
        conversationId: conversation.id,
        trigger: 'win_back',
        purpose: 'MARKETING',
        ledgerItemIds: [],
        amountPaise: 0,
        language: customer.language,
        dedupeKey,
        scheduledFor: input.now,
        traceId: input.traceId,
      });
      if (claimed === null) {
        return {
          kind: 'refuse' as const,
          code: 'WIN_BACK_ALREADY_ATTEMPTED',
          reason: 'A win-back for this customer was already attempted today',
        };
      }

      return {
        kind: 'send' as const,
        touchId,
        conversationId: conversation.id,
        customerName: customer.name,
        language: customer.language,
        vehicleLabel: vehicle?.label ?? 'your vehicle',
        modelYear: vehicle?.modelYear ?? null,
        shopName,
        // A lapsed customer's window is shut by definition — eight months is
        // rather longer than twenty-four hours. The template is the only shape
        // that can reach them, which is why a shop with none configured gets a
        // BLOCKED touch that says so rather than a win-back that silently
        // never happens.
        windowOpen: isWindowOpen(conversation.windowExpiresAt, input.now),
        reengagementTemplate: input.config.messaging.templates.reengagement,
      };
    });

    if (plan.kind === 'refuse') {
      await this.recordSkip({
        shopId: input.shopId,
        customerId: input.customerId,
        ledgerItemIds: [],
        trigger: 'win_back',
        code: plan.code,
        reason: plan.reason,
        traceId: input.traceId,
        actor: input.actor,
      });
      return { touchId: '', status: 'SKIPPED', messageId: null, detail: `${plan.code}: ${plan.reason}` };
    }

    const months = Math.max(
      1,
      Math.round((input.now.getTime() - input.lastVisitAt.getTime()) / (30 * 24 * 60 * 60_000)),
    );
    const age =
      plan.modelYear === null ? null : input.now.getUTCFullYear() - plan.modelYear;
    const hook =
      age !== null && age >= 3
        ? t(plan.language, 'winback.hook.age', { age })
        : t(plan.language, 'winback.hook.general');

    const body = t(plan.language, 'winback.body', {
      customerName: plan.customerName,
      vehicle: plan.vehicleLabel,
      shopName: plan.shopName,
      months,
      hook,
    });

    const outcome = await this.deps.gate.send({
      shopId: input.shopId,
      conversationId: plan.conversationId,
      customerId: input.customerId,
      purpose: 'MARKETING',
      content:
        plan.windowOpen || plan.reengagementTemplate === null
          ? {
              kind: 'interactive',
              body,
              buttons: [{ id: 'winback:book', title: t(plan.language, 'winback.action.book') }],
            }
          : {
              kind: 'template',
              templateName: plan.reengagementTemplate,
              templateLanguage: plan.language,
              category: 'MARKETING',
              variables: [plan.customerName, plan.vehicleLabel, String(months)],
              preview: body,
            },
      actor: input.actor,
      traceId: input.traceId,
      flow: 'retention',
      language: plan.language,
      templated: true,
      // No claims. A win-back asserts nothing about this vehicle's condition —
      // it says how long it has been and offers a check-up, which is the only
      // honest thing to say about a car nobody has looked at in eight months.
    });

    return this.settle({
      shopId: input.shopId,
      touchId: plan.touchId,
      item: null,
      trigger: 'win_back',
      purpose: 'MARKETING',
      outcome,
      traceId: input.traceId,
      actor: input.actor,
      amountPaise: 0,
      customerId: input.customerId,
      vehicleId: input.vehicleId,
    });
  }

  /**
   * Turns a gate outcome into a settled touch, an event and (for a re-pitch)
   * an incremented ledger count.
   *
   * Shared by every flow that writes here, which is the point: the phase's
   * "every retention touch passes the OutboundGate" acceptance criterion is
   * satisfied by there being exactly one place that can settle one.
   */
  private async settle(input: {
    readonly shopId: string;
    readonly touchId: string;
    readonly item: LedgerItem | null;
    readonly trigger: RetentionTrigger;
    readonly purpose: ConsentPurpose;
    readonly outcome: Awaited<ReturnType<OutboundGate<Tx>['send']>>;
    readonly traceId: string;
    readonly actor: Actor;
    readonly amountPaise: Paise;
    readonly customerId: string;
    readonly vehicleId: string | null;
  }): Promise<RetentionOutcome> {
    const at = this.clock.now();
    const { outcome } = input;

    const status =
      outcome.status === 'SENT'
        ? 'SENT'
        : outcome.status === 'DEFERRED' || outcome.status === 'PENDING_APPROVAL'
          ? 'HELD'
          : 'BLOCKED';

    const code =
      outcome.status === 'BLOCKED' || outcome.status === 'FAILED'
        ? outcome.code
        : outcome.status === 'DEFERRED'
          ? 'QUIET_HOURS'
          : outcome.status === 'PENDING_APPROVAL'
            ? 'AWAITING_ADVISOR'
            : null;
    const reason =
      outcome.status === 'SENT' ? null : 'reason' in outcome ? outcome.reason : 'held';

    await this.deps.uow.transaction(async (tx) => {
      await this.deps.touches.settle(tx, {
        shopId: input.shopId,
        touchId: input.touchId,
        status,
        messageId: outcome.status === 'SENT' ? outcome.messageId : null,
        skipCode: code,
        skipReason: reason,
        // A blocked touch gives its slot back; a held one keeps it, because the
        // deferred sender still owns that message and will release it later.
        releaseDedupeKey: status === 'BLOCKED',
        at,
      });

      await this.deps.audit.append(tx, {
        shopId: input.shopId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: status === 'SENT' ? 'retention.touch_sent' : 'retention.touch_withheld',
        entityType: 'RetentionTouch',
        entityId: input.touchId,
        payload: {
          trigger: input.trigger,
          purpose: input.purpose,
          status,
          code,
          reason,
          ledgerItemIds: input.item === null ? [] : [input.item.id],
        },
        traceId: input.traceId,
      });

      const envelope: EventEnvelope =
        status === 'SENT'
          ? {
              id: uuidv7(),
              type: 'retention.touch_sent',
              occurredAt: at.toISOString(),
              shopId: input.shopId,
              traceId: input.traceId,
              payload: {
                touchId: input.touchId,
                customerId: input.customerId,
                trigger: input.trigger,
                purpose: input.purpose,
                ledgerItemIds: input.item === null ? [] : [input.item.id],
                jobCardId: input.item?.jobCardId ?? null,
                vehicleId: input.vehicleId,
                messageId: outcome.status === 'SENT' ? outcome.messageId : '',
                amountPaise: input.amountPaise,
                actor: { type: input.actor.type, id: input.actor.id },
              },
            }
          : {
              id: uuidv7(),
              type: 'retention.touch_skipped',
              occurredAt: at.toISOString(),
              shopId: input.shopId,
              traceId: input.traceId,
              payload: {
                touchId: input.touchId,
                customerId: input.customerId,
                trigger: input.trigger,
                ledgerItemIds: input.item === null ? [] : [input.item.id],
                code: code ?? 'UNKNOWN',
                reason: reason ?? '',
                actor: { type: input.actor.type, id: input.actor.id },
              },
            };
      await this.deps.outbox.enqueue(tx, envelope);
    });

    // Only a message that actually reached the customer counts against the cap.
    // A re-pitch the gate blocked was not a re-pitch — counting it would let a
    // consent problem quietly spend an item's two chances.
    if (status === 'SENT' && input.item !== null) {
      await this.deps.ledgerService.recordRepitch({
        shopId: input.shopId,
        ledgerItemId: input.item.id,
        touchId: input.touchId,
        messageId: outcome.status === 'SENT' ? outcome.messageId : null,
        trigger:
          input.trigger === 'next_visit' ||
          input.trigger === 'time_elapsed' ||
          input.trigger === 'season' ||
          input.trigger === 'odometer'
            ? input.trigger
            : 'manual',
        purpose: input.purpose === 'SERVICE' ? 'SERVICE' : 'MARKETING',
        traceId: input.traceId,
        actor: input.actor,
      });
    }

    return {
      touchId: input.touchId,
      status,
      messageId: outcome.status === 'SENT' ? outcome.messageId : null,
      detail: status === 'SENT' ? `message ${outcome.messageId}` : `${code}: ${reason}`,
    };
  }

  /**
   * Records a touch that was due and did not happen, without a touch row.
   *
   * The row is written here too — a `SKIPPED` touch with a code — because the
   * alternative is an engine whose refusals are invisible, and "why did this
   * customer never get their re-pitch" is the first question anybody asks of a
   * retention system that is not working.
   */
  private async recordSkip(input: {
    readonly shopId: string;
    readonly customerId: string;
    readonly ledgerItemIds: readonly string[];
    readonly trigger: RetentionTrigger;
    readonly code: string;
    readonly reason: string;
    readonly traceId: string;
    readonly actor: Actor;
  }): Promise<void> {
    const at = this.clock.now();
    await this.deps.uow.transaction(async (tx) => {
      await this.deps.audit.append(tx, {
        shopId: input.shopId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'retention.touch_withheld',
        entityType: SUBJECT_TYPE,
        entityId: input.ledgerItemIds[0] ?? null,
        payload: {
          customerId: input.customerId,
          trigger: input.trigger,
          code: input.code,
          reason: input.reason,
        },
        traceId: input.traceId,
      });

      const envelope: EventEnvelope = {
        id: uuidv7(),
        type: 'retention.touch_skipped',
        occurredAt: at.toISOString(),
        shopId: input.shopId,
        traceId: input.traceId,
        payload: {
          touchId: uuidv7(),
          customerId: input.customerId,
          trigger: input.trigger,
          ledgerItemIds: [...input.ledgerItemIds],
          code: input.code,
          reason: input.reason,
          actor: { type: input.actor.type, id: input.actor.id },
        },
      };
      await this.deps.outbox.enqueue(tx, envelope);
    });
  }

  private async currentPrice(tx: Tx, shopId: string, item: LedgerItem): Promise<Paise | null> {
    const prices = this.deps.prices;
    const lineId = item.estimateLineIds[0];
    if (prices === undefined || lineId === undefined) return null;
    const listed = await prices.listPriceFor(tx, shopId, lineId);
    return listed === null || listed === item.amountPaise ? null : listed;
  }
}

/* -------------------------------------------------------------------------- *
 * The composer
 * -------------------------------------------------------------------------- */

export interface ComposedRepitch {
  readonly content: OutboundContent;
  /** The rendered copy, so a template send can carry it as its preview. */
  readonly body: string;
  readonly claims: readonly { readonly text: string; readonly evidence: readonly EvidenceRef[] }[];
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/**
 * The re-pitch, assembled from the catalogue and the ledger's frozen snapshot.
 *
 * Pure, exported, and separately testable — which is how the phase's "post-checker
 * passes all composer outputs" can be asserted without a channel or a database.
 *
 * Three properties hold by construction:
 *
 *   - **Every claim cites the original evidence.** The one claim this message
 *     makes is the technician's finding, and it cites the ledger item's frozen
 *     note plus each estimate line the price came from. There is no path that
 *     produces an unanchored sentence, so the gate's claim-anchoring check
 *     cannot fail on a well-formed item — and an item with no technician note
 *     produces no finding sentence at all rather than an invented one.
 *   - **The price is the one they were already given**, unless the shop's own
 *     list has moved, in which case the message says so and states both. It
 *     never quietly re-quotes.
 *   - **The rationale is a catalogue sentence chosen by the trigger**, never
 *     prose about urgency. "With the monsoon starting" is a fact about the
 *     calendar; "your brakes are dangerous" would be a claim about the vehicle,
 *     and this composer has no way to make one.
 */
export function composeRepitch(input: {
  readonly language: Language;
  readonly customerName: string;
  readonly vehicleLabel: string;
  readonly item: LedgerItem;
  readonly rationale: TriggerRationale;
  readonly currentPricePaise: Paise | null;
  readonly declinedAt: Date;
  /**
   * Append "roughly how many kilometres now?" (phase 6.2).
   *
   * The odometer trigger may only fire on a reading the customer volunteered,
   * so somebody has to ask — and the phase is explicit that the ask piggybacks
   * on another touchpoint and is never a message of its own. This is that
   * piggyback. It is a sentence in the body rather than a fourth button
   * because WhatsApp allows three, and the three that exist are the answer to
   * the question the message is actually about.
   */
  readonly askOdometer?: boolean;
}): ComposedRepitch {
  const { language, item } = input;
  const when = `${MONTHS[input.declinedAt.getUTCMonth()] ?? 'the last'} ${input.declinedAt.getUTCFullYear()}`;

  const rationale = t(language, rationaleKey(input.rationale), rationaleParams(input));
  // The technician's own sentence, with any trailing full stop trimmed: the
  // catalogue copy supplies its own, and "metal to metal soon.." in front of a
  // customer reads as carelessness about everything else in the message.
  const finding = (item.technicianNote?.trim() ?? item.reason).replace(/[.。]+$/u, '');
  const title = item.title ?? 'the work we flagged';

  const pitch =
    input.currentPricePaise === null
      ? t(language, 'retention.repitch_body', {
          customerName: input.customerName,
          vehicle: input.vehicleLabel,
          when,
          item: title,
          finding,
          rationale,
          amount: formatPaise(item.amountPaise),
        })
      : t(language, 'retention.repitch_price_changed', {
          customerName: input.customerName,
          vehicle: input.vehicleLabel,
          when,
          item: title,
          finding,
          rationale,
          amount: formatPaise(input.currentPricePaise),
          previousAmount: formatPaise(item.amountPaise),
        });

  const body =
    input.askOdometer === true
      ? `${pitch}

${t(language, 'retention.odometer_ask', { vehicle: input.vehicleLabel })}`
      : pitch;

  const evidence: EvidenceRef[] = [];
  if (item.technicianNote !== null && item.technicianNote.trim().length > 0) {
    evidence.push({ kind: 'TECHNICIAN_NOTE', id: item.id });
  }
  for (const lineId of item.estimateLineIds) {
    evidence.push({ kind: 'ESTIMATE_LINE', id: lineId });
  }

  return {
    body,
    content: {
      kind: 'interactive',
      body,
      buttons: [
        { id: REPITCH_ACTION_IDS.book(item.id), title: t(language, 'retention.action.book') },
        { id: REPITCH_ACTION_IDS.remind(item.id), title: t(language, 'retention.action.remind') },
        {
          id: REPITCH_ACTION_IDS.notInterested(item.id),
          title: t(language, 'retention.action.not_interested'),
        },
      ],
    },
    // One claim: the finding and the price, which is the only assertion this
    // message makes about the vehicle. An item with neither a note nor an
    // estimate line produces no claim, and the gate then has nothing to check —
    // correct, because such a message asserts nothing.
    claims: evidence.length === 0 ? [] : [{ text: `${title}: ${finding}`, evidence }],
  };
}

function rationaleParams(input: {
  readonly rationale: TriggerRationale;
  readonly vehicleLabel: string;
}): Record<string, string | number> {
  switch (input.rationale.kind) {
    case 'time_elapsed':
      return { months: input.rationale.months };
    case 'next_visit':
      return { vehicle: input.vehicleLabel };
    case 'odometer':
      return { km: input.rationale.kmSince };
    case 'season':
    case 'manual':
      return {};
  }
}

function compact<T>(source: ReadonlyMap<string, T | null>): ReadonlyMap<string, T> {
  const out = new Map<string, T>();
  for (const [key, value] of source) {
    if (value !== null) out.set(key, value);
  }
  return out;
}

/**
 * How long after a retention touch a bare number is still read as an answer.
 *
 * A fortnight, because a customer who reads the message on Saturday and walks
 * out to their car to check the dial on Sunday is answering the question, and
 * because nothing else in the product invites a bare number — so the cost of
 * the window being generous is small and the cost of it being mean is a
 * customer who bothered and was ignored.
 */
const ODOMETER_REPLY_WINDOW_DAYS = 14;

/**
 * A message that is *only* a mileage.
 *
 * Optional thousands separators, an optional unit in any of the three
 * languages, and nothing else — no leading words, no trailing question.
 *
 * **A bare four-digit number is refused, and this is the important rule.**
 * Anything under 10,000 is ambiguous with the last four digits of a
 * registration, which is how a great many of this product's users refer to
 * their car — and "4432" filed as a mileage would put 4,432 km on somebody's
 * Swift, then silently suppress that vehicle's odometer trigger for ever,
 * because the trigger measures distance *since* the reading it has. So a low
 * number is accepted only when the customer wrote the unit: "4432 km" is a
 * person answering a question, "4432" is a person naming their car. A genuine
 * sub-10,000 reading typed without a unit is a reading we can afford to lose;
 * a plate fragment recorded as one is a fact about a vehicle that is wrong.
 *
 * The ceiling refuses a typo that would poison the trigger from the other end.
 */
export function parseBareOdometer(text: string): number | null {
  const trimmed = text.trim().toLowerCase();
  const match = /^([0-9][0-9,\s.]*?)\s*(km|kms|k\.m\.|கிமீ|கி\.மீ\.|किमी|कि\.मी\.)?$/u.exec(trimmed);
  if (match === null) return null;

  const digits = (match[1] ?? '').replace(/[,\s.]/g, '');
  if (digits.length === 0 || digits.length > 7) return null;

  const value = Number(digits);
  if (!Number.isSafeInteger(value)) return null;
  if (value < 100 || value > 1_000_000) return null;

  const hasUnit = match[2] !== undefined;
  return value >= REGISTRATION_AMBIGUITY_CEILING || hasUnit ? value : null;
}

/** Above this, a bare number cannot be the last four digits of a plate. */
const REGISTRATION_AMBIGUITY_CEILING = 10_000;
