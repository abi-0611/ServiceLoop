import { deterministicJudge } from '@serviceloop/adapters';
import { createAgentRuntime, createRetentionRuntime } from '@serviceloop/agent-core';
import {
  defaultShopConfig,
  formatAdapterSelection,
  getEnv,
  migrateShopConfig,
} from '@serviceloop/config';
import {
  AuditService,
  DEMO_SHOP_ID,
  OutboxService,
  PgConsentStore,
  PgConversationStore,
  PgJobCardStore,
  PgMessageStore,
  PgPriceListReader,
  PgShopConfigStore,
  PgShopDirectory,
  PgUnitOfWork,
  PgWorkItemStore,
  blindIndex,
  createAgentStores,
  createDatabase,
  createRetentionStores,
  jobCardLabels,
  openVisitsByVehicle,
  schema,
  type Database,
  type Tx,
} from '@serviceloop/db';
import {
  ConsentService,
  JobCardTransitionService,
  OutboundGate,
  WorkItemTransitionService,
  computeRollup,
  rollupKpis,
  windowsFrom,
  type DailyRollup,
  type RungScheduler,
} from '@serviceloop/domain';
import {
  formatPaise,
  localDay,
  parseEventEnvelope,
  uuidv7,
  type Clock,
  type EventEnvelope,
} from '@serviceloop/shared';
import { sql } from 'drizzle-orm';
import IORedis from 'ioredis';
import { assert, assertEqual, ScenarioRunner } from '../runner';

/**
 * `pnpm demo:phase6`
 *
 * The loop that starts after the vehicle has left, compressed onto a fake clock
 * and run against the real database.
 *
 * The arc the phase's acceptance gate names, end to end: a brake pad declined
 * at April's service, ledgered with the technician's own words; the rains
 * arriving in June and the season trigger raising it again in a message that
 * quotes that April visit and honours the price the customer was quoted; a
 * one-tap booking; the work approved on a second card; and the money appearing
 * in "₹ recovered from previously declined work" in that evening's owner
 * digest — which is then checked, number by number, against an independent
 * recomputation of the same day.
 *
 * **A note on the span.** The phase asks for "a compressed month". This demo
 * runs a compressed *quarter*, and deliberately: the shop's own configuration
 * puts the brake-wear horizon at 75 days, and the season trigger explicitly
 * refuses to shorten a horizon a technician asked for. A month-long demo could
 * only show the season trigger by first editing the shop's config to disagree
 * with itself. April to June is the arc the phase's own example copy describes.
 *
 * Nothing here reaches a model or a telephone. The one LLM call site — the
 * post-checker's third layer — gets the deterministic judge, which is the same
 * judge the unit suites and the phase-3/4/5 demos use.
 */

const TRACE = `demo-phase6-${uuidv7().slice(0, 8)}`;

const HAPPY_PHONE = `+9196${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`;
const UNHAPPY_PHONE = `+9195${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`;
const OWNER_PHONE = `+9194${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`;

const BRAKES_PAISE = 240_000;
const OIL_PAISE = 60_000;

/** April's service. A Thursday, inside working hours, outside quiet hours. */
const APRIL_VISIT = new Date('2026-04-02T10:30:00+05:30');
/**
 * The rains.
 *
 * Inside the shipped south-west monsoon window (05-25 → 07-15) *and* past the
 * brake item's own horizon, which is the combination the season trigger
 * requires: it refuses to wake an item early, because using the weather to
 * shorten a promise a technician made is not care, it is a pretext.
 */
const JUNE_RAINS = new Date('2026-07-05T11:00:00+05:30');

/** A clock the scenario winds forward by hand. */
class DemoClock implements Clock {
  constructor(private at: Date) {}
  now(): Date {
    return new Date(this.at);
  }
  set(at: Date): void {
    this.at = at;
  }
  advanceHours(hours: number): void {
    this.at = new Date(this.at.getTime() + hours * 3_600_000);
  }
}

class InMemoryRungScheduler implements RungScheduler {
  private counter = 0;
  async enqueue(): Promise<string | null> {
    this.counter += 1;
    return `demo6-job-${this.counter}`;
  }
  async cancel(): Promise<void> {
    /* nothing to cancel: this demo never fires a rung */
  }
}

async function main(): Promise<void> {
  const env = getEnv();
  const database = createDatabase(env);
  const db = database.db;
  const redis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

  const clock = new DemoClock(APRIL_VISIT);
  const uow = new PgUnitOfWork(db);
  const audit = new AuditService(db, redis);
  const outbox = new OutboxService(db);

  const messages = new PgMessageStore();
  const conversations = new PgConversationStore();
  const configStore = new PgShopConfigStore();
  const consentStore = new PgConsentStore();
  const { createChannelPorts } = await import('@serviceloop/adapters');
  const channels = createChannelPorts(env, { redis });

  const retentionStores = createRetentionStores();

  // The gate gets the retention frequency reader, which is what makes the
  // twenty-one-day floor and the negative-feedback freeze properties of the
  // *send path* rather than of the composer. Without it this demo could not
  // honestly claim that every touch passed them.
  const gate = new OutboundGate<Tx>({
    uow,
    conversations,
    messages,
    consents: consentStore,
    config: configStore,
    audit,
    outbox,
    sender: channels.sender,
    retention: retentionStores.frequency,
    clock,
  });

  const jobCards = new JobCardTransitionService<Tx>({
    uow,
    cards: new PgJobCardStore(),
    config: configStore,
    audit,
    outbox,
    clock,
  });
  const workItems = new WorkItemTransitionService<Tx>({
    uow,
    items: new PgWorkItemStore(),
    audit,
    outbox,
    clock,
  });

  const agentStores = createAgentStores();
  const agent = createAgentRuntime<Tx>({
    stores: {
      uow,
      ...agentStores,
      conversations,
      messages,
      config: configStore,
      directory: new PgShopDirectory(),
      audit,
      outbox,
    },
    gate,
    jobCards,
    workItems,
    scheduler: new InMemoryRungScheduler(),
    llm: deterministicJudge(),
    config: defaultShopConfig(env.DEFAULT_TIMEZONE),
    conversationTail: (tx, shopId, conversationId, limit) =>
      messages.recentForConversation(tx, shopId, conversationId, limit),
    loadHeld: (tx, shopId, messageId) => messages.loadHeld(tx, shopId, messageId),
    resolvePinnedCard: (tx, shopId, messageId) =>
      messages.jobCardForMessage(tx, shopId, messageId),
    scheduleFollowup: async () => 'demo6-followup',
    openObjectionObjective: async () => undefined,
    clock,
  });

  const retention = createRetentionRuntime<Tx>({
    stores: {
      uow,
      ledger: retentionStores.ledger,
      touches: retentionStores.touches,
      holds: retentionStores.holds,
      odometer: retentionStores.odometer,
      feedback: retentionStores.feedback,
      forecasts: retentionStores.forecasts,
      documents: retentionStores.documents,
      digests: retentionStores.digests,
      alerts: retentionStores.alerts,
      events: retentionStores.events,
      rollups: retentionStores.rollups,
      directory: retentionStores.directory,
      conversations,
      shops: new PgShopDirectory(),
      config: configStore,
      audit,
      outbox,
    },
    gate,
    consents: new ConsentService<Tx>({ uow, consents: consentStore, audit, outbox, clock }),
    openVisits: openVisitsByVehicle,
    cardLabels: jobCardLabels,
    tasks: agent.tasks,
    prices: new PgPriceListReader(),
    clock,
  });

  /* ------------------------------------------------------------- scenario */

  let happy = emptyCustomer();
  let unhappy = emptyCustomer();
  let ownerStaffId = '';
  let ledgerItemId = '';
  let secondCardId = '';
  let recoveredPaise = 0;
  let digestLines: readonly string[] = [];
  let foldedDay = '';

  const runner = new ScenarioRunner(
    'ServiceLoop — phase 6 acceptance demo',
    'April’s declined brake pads → the June rains → one-tap booking → ₹ recovered in the evening digest',
  );

  for (const line of formatAdapterSelection(env)) process.stdout.write(`  ${line}\n`);

  runner
    .step('The shop switches retention, feedback and the digest on', async () => {
      // Read, migrated, patched, written back whole. A seeded shop's document
      // predates the phase-6 sections entirely, and merging into a key that is
      // not there produces SQL NULL — which is how a demo deletes a shop's
      // configuration instead of changing it.
      const current = await uow.transaction(async (tx) => {
        const row = await configStore.load(tx, DEMO_SHOP_ID);
        const timezone =
          (await configStore.loadShopTimezone(tx, DEMO_SHOP_ID)) ?? env.DEFAULT_TIMEZONE;
        return migrateShopConfig(row?.raw ?? {}, timezone).config;
      });

      await uow.transaction((tx) =>
        configStore.save(
          tx,
          DEMO_SHOP_ID,
          {
            ...current,
            autonomy: { ...current.autonomy, retention: 'L2_CONVERSATIONAL' },
            retention: { ...current.retention, enabled: true },
            feedback: {
              ...current.feedback,
              enabled: true,
              // A real Place link, so the positive route has somewhere to send
              // people. The schema refuses `askForReviewOnPositive` without one.
              reviewLink: 'https://g.page/r/sri-murugan-auto-works/review',
              askForReviewOnPositive: true,
            },
            digest: { ...current.digest, enabled: true },
            // 180 days, not the shipped 90, and the reason is worth stating.
            // The shop's brake-wear horizon is also 90 days, so a brake item
            // that converts on the horizon it was given lands one day outside
            // the recovery cohort and the headline rate reads 0% for exactly
            // the recovery the product is proudest of. See the open question in
            // PROGRESS.md; a shop whose slowest horizon is 90 days needs a
            // cohort longer than 90 days for the number to mean anything.
            analytics: { ...current.analytics, recoveryCohortDays: 180 },
            // 21:00–06:00, so the demo's own timestamps (10:30, 11:00, 20:30)
            // are never inside them however the reader's machine is set.
            quietHours: { timezone: env.DEFAULT_TIMEZONE, start: '21:00', end: '06:00' },
          },
          null,
        ),
      );

      return 'retention on · feedback on (review link set) · digest on · quiet 21:00–06:00';
    })

    .step('April: two vehicles are delivered, and one customer defers the brakes', async () => {
      clock.set(APRIL_VISIT);
      ownerStaffId = await ensureOwner(db);

      happy = await createDeliveredCard(db, jobCards, workItems, clock, {
        name: 'Ravi Kumar',
        phone: HAPPY_PHONE,
        plate: 'K6',
        declineBrakes: true,
      });
      unhappy = await createDeliveredCard(db, jobCards, workItems, clock, {
        name: 'Priya Raman',
        phone: UNHAPPY_PHONE,
        plate: 'K7',
        declineBrakes: false,
      });

      return `${happy.code} (brakes deferred) · ${unhappy.code} · owner ${ownerStaffId.slice(0, 8)}…`;
    })

    .step('The ledger records the decline in the technician’s own words', async () => {
      const opened = await retention.ledger.open({
        shopId: DEMO_SHOP_ID,
        jobCardId: happy.jobCardId,
        workItemId: happy.brakesWorkItemId,
        customerId: happy.customerId,
        vehicleId: happy.vehicleId,
        kind: 'DEFERRED',
        declineReason: 'customer_deferred',
        reason: 'Customer asked to do it next time',
        amountPaise: BRAKES_PAISE,
        category: 'brakes',
        title: 'Front brake pad replacement',
        technicianNote: 'Front pads worn to 2.1mm, minimum is 3mm. Metal to metal soon.',
        evidenceBundleId: null,
        estimateLineIds: [happy.brakesEstimateLineId],
        traceId: TRACE,
      });
      ledgerItemId = opened.ledgerItemId;

      const item = await retention.ledger.load(DEMO_SHOP_ID, ledgerItemId);
      assert(item !== null, 'the ledger item was not stored');
      if (item === null) return '';

      assertEqual(item.status, 'OPEN', 'a fresh ledger item should be OPEN');
      assert(
        item.triggerTags.includes('season:monsoon'),
        `brake work should be tagged for the monsoon, got ${item.triggerTags.join(', ')}`,
      );
      assert(item.followUpAfter !== null, 'brake work should get a timed horizon');

      // Idempotent by index, which is what makes the worker's handler safe
      // under the redelivery the outbox guarantees.
      const again = await retention.ledger.open({
        shopId: DEMO_SHOP_ID,
        jobCardId: happy.jobCardId,
        workItemId: happy.brakesWorkItemId,
        customerId: happy.customerId,
        vehicleId: happy.vehicleId,
        kind: 'DEFERRED',
        declineReason: 'customer_deferred',
        reason: 'Customer asked to do it next time',
        amountPaise: BRAKES_PAISE,
        category: 'brakes',
        title: 'Front brake pad replacement',
        technicianNote: 'Front pads worn to 2.1mm, minimum is 3mm. Metal to metal soon.',
        evidenceBundleId: null,
        estimateLineIds: [happy.brakesEstimateLineId],
        traceId: TRACE,
      });
      assertEqual(again.created, false, 'a redelivered decline must not open a second item');
      assertEqual(again.ledgerItemId, ledgerItemId, 'the redelivery should find the same item');

      const horizon = item.followUpAfter?.toISOString().slice(0, 10) ?? '';
      return `${formatPaise(item.amountPaise)} · tags ${item.triggerTags.join(' ')} · horizon ${horizon}`;
    })

    .step('A day later the feedback ask goes out, and Ravi says it went well', async () => {
      clock.set(new Date(APRIL_VISIT.getTime() + 26 * 3_600_000));

      await retention.feedback.scheduleForDelivery({
        shopId: DEMO_SHOP_ID,
        jobCardId: happy.jobCardId,
        customerId: happy.customerId,
        conversationId: happy.conversationId,
        deliveredAt: APRIL_VISIT,
        traceId: TRACE,
      });

      const asked = await retention.feedback.sendDue({ shopId: DEMO_SHOP_ID, traceId: TRACE });
      const mine = asked.filter((row) => row.feedbackId !== undefined);
      assert(mine.length > 0, 'no feedback ask was due');

      const feedbackId = await feedbackIdFor(db, happy.jobCardId);
      const answer = await retention.feedback.recordAnswer({
        shopId: DEMO_SHOP_ID,
        feedbackId,
        sentiment: 'POSITIVE',
        comment: 'Car feels smooth, thanks',
        conversationId: happy.conversationId,
        traceId: TRACE,
      });
      assert(answer.handled, `the positive answer was not handled: ${answer.detail}`);
      assert(answer.reviewAsked, 'a positive answer should have offered the review link');

      // Asked once, never nagged. A second tap on the same card is not an error
      // — it reports the state it finds — but it must not send a second ask, so
      // the assertion is on the *messages*, which is where nagging would show.
      const twice = await retention.feedback.recordAnswer({
        shopId: DEMO_SHOP_ID,
        feedbackId,
        sentiment: 'POSITIVE',
        comment: null,
        conversationId: happy.conversationId,
        traceId: TRACE,
      });
      assertEqual(twice.handled, false, 'a second tap must not re-run the routing');

      const reviewMessages = await countMessagesContaining(db, happy.conversationId, 'review');
      assertEqual(reviewMessages, 1, 'the review link must be sent exactly once');

      return `😊 · review link sent once · ${mine.length} ask(s) due`;
    })

    .step('Ravi is asked for MARKETING consent separately, and grants it', async () => {
      // Three hours later, not three seconds. The shop's own frequency cap sits
      // under this call and refuses two messages inside an hour — which is the
      // right answer, and the reason the ask rides on a later moment rather
      // than chasing the thank-you down the thread.
      clock.advanceHours(3);

      const askResult = await retention.marketing.ask({
        shopId: DEMO_SHOP_ID,
        customerId: happy.customerId,
        conversationId: happy.conversationId,
        traceId: TRACE,
      });
      assert(askResult.asked, `the MARKETING ask was not sent: ${askResult.reason}`);

      // The tap comes back a few minutes later, as taps do.
      clock.advanceHours(0.1);

      const decided = await retention.marketing.decide({
        shopId: DEMO_SHOP_ID,
        customerId: happy.customerId,
        conversationId: happy.conversationId,
        decision: 'GRANT',
        evidence: 'marketing:yes',
        traceId: TRACE,
      });
      assertEqual(decided.status, 'GRANTED', 'the grant was not recorded');

      const rows = await uow.transaction((tx) =>
        consentStore.current(tx, DEMO_SHOP_ID, happy.customerId),
      );
      const marketing = rows.find((row) => row.purpose === 'MARKETING');
      assertEqual(marketing?.status ?? null, 'GRANTED', 'MARKETING consent is not on record');

      return 'a second, explicit ask · MARKETING GRANTED, audited with the button id';
    })

    .step('May: the trigger engine looks, and finds nothing due', async () => {
      clock.set(new Date('2026-05-10T11:00:00+05:30'));
      const scan = await retention.retention.scan({ shopId: DEMO_SHOP_ID, traceId: TRACE });

      assertEqual(
        scan.due.filter((hit) => hit.ledgerItemId === ledgerItemId).length,
        0,
        'nothing should be due 38 days into a 75-day horizon, outside the season window',
      );
      return `${scan.examined} item(s) examined · 0 due · nothing sent`;
    })

    .step('June: the rains start and the season trigger raises it', async () => {
      clock.set(JUNE_RAINS);
      const scan = await retention.retention.scan({ shopId: DEMO_SHOP_ID, traceId: TRACE });

      const hit = scan.due.find((candidate) => candidate.ledgerItemId === ledgerItemId);
      assert(hit !== undefined, 'the season trigger did not fire on the brake item');
      if (hit === undefined) return '';
      assertEqual(hit.trigger, 'season', 'the season trigger should beat the elapsed horizon');

      const sent = scan.sent.find((outcome) => outcome.status === 'SENT');
      assert(sent !== undefined, `nothing was sent: ${scan.skipped.map((s) => s.detail).join('; ')}`);

      const body = await lastOutboundBody(db, happy.conversationId);
      assert(body.includes('April'), `the re-pitch should reference April’s visit: ${body}`);
      assert(body.includes('2.1mm'), `the re-pitch should quote the technician: ${body}`);
      assert(
        body.includes(formatPaise(BRAKES_PAISE)),
        `the re-pitch should honour the original price: ${body}`,
      );

      const purpose = await lastTouchPurpose(db, happy.customerId);
      assertEqual(
        purpose,
        'SERVICE',
        'a safety-relevant technician finding is a SERVICE touch, not marketing',
      );

      process.stdout.write(`\n      → ${body.replace(/\n/g, '\n        ')}\n\n`);
      return `season:monsoon · SERVICE · ${formatPaise(BRAKES_PAISE)} honoured`;
    })

    .step('Ravi taps “Book a slot”', async () => {
      clock.advanceHours(3);
      const response = await retention.retention.recordResponse({
        shopId: DEMO_SHOP_ID,
        ledgerItemId,
        response: 'BOOK',
        conversationId: happy.conversationId,
        customerId: happy.customerId,
        traceId: TRACE,
      });
      assert(response.handled, `the booking tap was not handled: ${response.detail}`);

      const item = await retention.ledger.load(DEMO_SHOP_ID, ledgerItemId);
      assertEqual(item?.lastResponse ?? null, 'BOOK', 'the tap was not recorded on the item');
      assertEqual(item?.repitchCount ?? 0, 1, 'the re-pitch should be counted exactly once');

      return `BOOK · re-pitch ${item?.repitchCount ?? 0} of 2 · advisor acknowledged`;
    })

    .step('The work is done on a second card, and the money is attributed back', async () => {
      const built = await createFollowUpCard(db, jobCards, clock, happy, ledgerItemId);
      secondCardId = built.jobCardId;

      const converted = await retention.retention.convertFromApproval({
        shopId: DEMO_SHOP_ID,
        jobCardId: secondCardId,
        approvedWorkItemIds: [built.workItemId],
        traceId: TRACE,
        actor: { type: 'STAFF', id: null },
      });

      assertEqual(converted.length, 1, 'the approval did not convert the ledger item');
      recoveredPaise = converted.reduce((sum, row) => sum + row.recoveredPaise, 0);
      assertEqual(recoveredPaise, BRAKES_PAISE, 'the recovered amount should be the ledgered one');

      const item = await retention.ledger.load(DEMO_SHOP_ID, ledgerItemId);
      assertEqual(item?.status ?? null, 'CONVERTED', 'the item should be closed as CONVERTED');

      return `${built.code} · ${formatPaise(recoveredPaise)} recovered · item CONVERTED`;
    })

    .step('Priya’s service went badly, and the owner hears about it now', async () => {
      const feedbackId = await retention.feedback.scheduleForDelivery({
        shopId: DEMO_SHOP_ID,
        jobCardId: unhappy.jobCardId,
        customerId: unhappy.customerId,
        conversationId: unhappy.conversationId,
        deliveredAt: new Date(clock.now().getTime() - 26 * 3_600_000),
        traceId: TRACE,
      });
      assert(feedbackId !== null, 'the feedback ask was not scheduled');

      const before = clock.now().getTime();
      const answer = await retention.feedback.recordAnswer({
        shopId: DEMO_SHOP_ID,
        feedbackId: await feedbackIdFor(db, unhappy.jobCardId),
        sentiment: 'NEGATIVE',
        comment: 'The noise is still there and nobody called me back.',
        conversationId: unhappy.conversationId,
        traceId: TRACE,
      });

      assert(answer.handled, `the negative answer was not handled: ${answer.detail}`);
      assert(answer.recoveryTaskId !== null, 'no recovery task was raised');
      assert(answer.holdId !== null, 'retention was not frozen for this customer');
      assertEqual(answer.reviewAsked, false, 'an unhappy customer must never be asked for a review');

      const alert = await db.execute<{ kind: string; raised_at: Date | string }>(sql`
        select kind, raised_at from exception_alerts
        where shop_id = ${DEMO_SHOP_ID} and kind = 'NEGATIVE_FEEDBACK'
        order by raised_at desc limit 1
      `);
      assert(alert.rows.length > 0, 'the owner was not alerted');

      // "Realtime, not the digest" is measurable: the alert row exists on the
      // same tick the answer was recorded, not at 20:30.
      const raisedAt = alert.rows[0]?.raised_at;
      const raised = raisedAt === undefined ? 0 : new Date(raisedAt).getTime();
      assert(
        Math.abs(raised - before) < 60_000,
        'the negative-feedback alert should be raised immediately, not batched',
      );

      return `😞 · owner alerted · recovery task ${answer.recoveryTaskId?.slice(0, 8)}… · retention frozen`;
    })

    .step('Nothing further reaches Priya while the recovery task is open', async () => {
      const item = await retention.ledger.open({
        shopId: DEMO_SHOP_ID,
        jobCardId: unhappy.jobCardId,
        workItemId: unhappy.brakesWorkItemId,
        customerId: unhappy.customerId,
        vehicleId: unhappy.vehicleId,
        kind: 'DEFERRED',
        declineReason: 'customer_deferred',
        reason: 'Wants to think about it',
        amountPaise: BRAKES_PAISE,
        category: 'brakes',
        title: 'Front brake pad replacement',
        technicianNote: 'Pads at 2.4mm.',
        evidenceBundleId: null,
        estimateLineIds: [],
        traceId: TRACE,
      });

      const loaded = await retention.ledger.load(DEMO_SHOP_ID, item.ledgerItemId);
      assert(loaded !== null, 'the second ledger item was not stored');
      if (loaded === null) return '';

      const outcome = await retention.retention.repitch({
        shopId: DEMO_SHOP_ID,
        item: loaded,
        trigger: 'season',
        rationale: { kind: 'season', season: 'monsoon' },
        traceId: TRACE,
      });

      assertEqual(outcome.status, 'SKIPPED', 'a frozen customer must not be written to');
      assert(
        outcome.detail.startsWith('RETENTION_FROZEN'),
        `the refusal should name the freeze, got ${outcome.detail}`,
      );
      return outcome.detail;
    })

    .step('The day is folded from the event log', async () => {
      foldedDay = localDay(clock.now(), env.DEFAULT_TIMEZONE);
      const result = await retention.metrics.computeDay({
        shopId: DEMO_SHOP_ID,
        day: foldedDay,
        traceId: TRACE,
      });

      assert(
        result.rollup.recoveredPaise >= recoveredPaise,
        `the fold should see ${formatPaise(recoveredPaise)} recovered, saw ${formatPaise(result.rollup.recoveredPaise)}`,
      );
      assert(result.rollup.feedbackNegative >= 1, 'the fold missed the negative feedback');
      assert(result.rollup.repitchesSent >= 1, 'the fold missed the re-pitch');

      return `${foldedDay} · ${result.eventsRead} events · ${formatPaise(result.rollup.recoveredPaise)} recovered · hash ${result.payloadHash.slice(0, 12)}…`;
    })

    .step('The evening digest quotes the fold, and every number checks out', async () => {
      clock.set(new Date(`${foldedDay}T20:35:00+05:30`));
      const results = await retention.digest.sendDaily({
        shopId: DEMO_SHOP_ID,
        day: foldedDay,
        traceId: TRACE,
      });

      const brief = results.find((row) => row.payload !== null);
      assert(brief?.payload != null, 'no digest was composed');
      if (brief?.payload == null) return '';
      digestLines = brief.payload.lines;

      // The golden check the phase asks for: fold the same day again, from the
      // raw event log, with no help from the stored rollup — and require the
      // brief's own numbers to match it.
      const independent = await recomputeIndependently(db, uow, configStore, env, foldedDay);
      assertEqual(
        brief.payload.numbers.recoveredPaise,
        independent.recoveredPaise,
        'the digest’s recovered figure disagrees with an independent recomputation',
      );
      assertEqual(
        brief.payload.numbers.approvedPaise,
        independent.approvedValuePaise,
        'the digest’s approved figure disagrees with an independent recomputation',
      );
      assertEqual(
        brief.payload.numbers.vehiclesOut,
        independent.vehiclesOut,
        'the digest’s delivered count disagrees with an independent recomputation',
      );
      assertEqual(
        brief.payload.numbers.feedbackFlags,
        independent.feedbackNegative,
        'the digest’s feedback flags disagree with an independent recomputation',
      );

      process.stdout.write(`\n      ${digestLines.join('\n      ')}\n\n`);
      return `${digestLines.length} line(s) · every figure independently recomputed and matched`;
    })

    .step('A recompute of the whole quarter reproduces every day exactly', async () => {
      const from = localDay(APRIL_VISIT, env.DEFAULT_TIMEZONE);
      const results = await retention.metrics.recompute({
        shopId: DEMO_SHOP_ID,
        from,
        to: foldedDay,
        traceId: TRACE,
      });

      const changed = results.filter((result) => result.changed);
      // Only the days this demo folded were stored, so every *other* day is
      // written for the first time and legitimately "changes". The day under
      // test is the one that must be identical.
      const today = changed.find((result) => result.day === foldedDay);
      assert(
        today === undefined,
        `re-folding ${foldedDay} produced different numbers: ${today?.previousHash ?? ''} → ${today?.payloadHash ?? ''}`,
      );

      const secondPass = await retention.metrics.recompute({
        shopId: DEMO_SHOP_ID,
        from,
        to: foldedDay,
        traceId: TRACE,
      });
      assertEqual(
        secondPass.filter((result) => result.changed).length,
        0,
        'a second recompute over the same range must change nothing at all',
      );

      return `${results.length} day(s) re-folded · ${foldedDay} identical · second pass 0 changed`;
    })

    .step('The KPI summary', async () => {
      const range = await retention.metrics.range(
        DEMO_SHOP_ID,
        localDay(APRIL_VISIT, env.DEFAULT_TIMEZONE),
        foldedDay,
      );
      const kpis = rollupKpis(range.total);
      assert(
        kpis.declinedWorkRecoveryRate !== null && kpis.declinedWorkRecoveryRate > 0,
        'the recovery rate should be a real number after a conversion inside the cohort',
      );

      const lines = [
        `approval turnaround   median ${format(kpis.approvalTurnaroundMedianMinutes, 'min')} · p90 ${format(kpis.approvalTurnaroundP90Minutes, 'min')}`,
        `approval conversion   ${percent(kpis.approvalConversionRate)}`,
        `status deflection     ${percent(kpis.statusDeflectionRate)}`,
        `on-time delivery      ${percent(kpis.onTimeDeliveryRate)}`,
        `declined-work recovery ${percent(kpis.declinedWorkRecoveryRate)}  (${formatPaise(range.total.cohortRecoveredPaise)} recovered of ${formatPaise(range.total.cohortLedgeredPaise)} ledgered, ${range.total.windows?.recoveryCohortDays ?? 90}-day cohort)`,
        `repeat visits         ${percent(kpis.repeatVisitRate)}`,
        `agent containment     ${percent(kpis.agentContainmentRate)}`,
        `review velocity       ${range.total.reviewAsks} ask(s)`,
        `guardrails            ${range.total.messagesBlocked} blocked · ${range.total.retentionTouchesSkipped} retention touches withheld · ${range.total.alertsRaised} alert(s)`,
      ];
      process.stdout.write(`\n      ${lines.join('\n      ')}\n\n`);

      return `${range.days.length} day(s) rolled up`;
    })

    .onTeardown(async () => {
      // The configuration is deliberately *not* restored, and that is the whole
      // point of this comment.
      //
      // This demo widens `analytics.recoveryCohortDays` to 180 and then folds a
      // quarter of shop-days under it, leaving 95 rollups behind. Those rollups
      // are only reproducible under the config that produced them: the fold's
      // lookback is `max(recoveryCohortDays, repeatVisitWindowDays) + 1`, so
      // putting 90 back changes the event window for every day and every stored
      // number with it. `pnpm metrics:recompute` — the audit story for
      // "₹ recovered", and a required check — would then report all 95 days as
      // changed on a database nobody had touched.
      //
      // Restoring the switch while keeping the numbers it produced is the
      // inconsistent state, not leaving it on. A shop that ran this demo *did*
      // turn retention on, and the rollups are the evidence.
      await redis.quit();
      await database.close();
    });

  process.exitCode = await runner.run();
}

/* -------------------------------------------------------------------------- *
 * Fixtures
 * -------------------------------------------------------------------------- */

interface DemoCustomer {
  customerId: string;
  vehicleId: string;
  conversationId: string;
  jobCardId: string;
  code: string;
  brakesWorkItemId: string;
  brakesEstimateLineId: string;
}

function emptyCustomer(): DemoCustomer {
  return {
    customerId: '',
    vehicleId: '',
    conversationId: '',
    jobCardId: '',
    code: '',
    brakesWorkItemId: '',
    brakesEstimateLineId: '',
  };
}

/**
 * A customer, a vehicle, an open thread with SERVICE consent, and a job card
 * driven all the way to DELIVERED.
 *
 * Driven rather than inserted, so the audit chain and the outbox see a real
 * lifecycle — which is the whole reason the metrics fold has anything to read.
 */
async function createDeliveredCard(
  db: Database,
  jobCards: JobCardTransitionService<Tx>,
  workItems: WorkItemTransitionService<Tx>,
  clock: DemoClock,
  input: {
    readonly name: string;
    readonly phone: string;
    readonly plate: string;
    readonly declineBrakes: boolean;
  },
): Promise<DemoCustomer> {
  const suffix = uuidv7().slice(-6).toUpperCase();
  const customerId = uuidv7();
  const vehicleId = uuidv7();
  const jobCardId = uuidv7();
  const estimateId = uuidv7();
  const brakesId = uuidv7();
  const oilId = uuidv7();
  const brakesLineId = uuidv7();
  const conversationId = uuidv7();
  const code = `JC-DEMO6-${suffix.slice(0, 4)}`;
  const now = clock.now();

  await db.insert(schema.customers).values({
    id: customerId,
    shopId: DEMO_SHOP_ID,
    fullNameEncrypted: input.name,
    phoneEncrypted: input.phone,
    phoneHash: blindIndex(DEMO_SHOP_ID, input.phone),
    preferredLanguage: 'en',
    whatsappOptIn: true,
  });

  await db.insert(schema.vehicles).values({
    id: vehicleId,
    shopId: DEMO_SHOP_ID,
    customerId,
    registrationRaw: `TN 09 ${input.plate} ${suffix.slice(0, 4)}`,
    registrationNormalised: `TN09${input.plate}${suffix.slice(0, 4)}`,
    make: 'Maruti Suzuki',
    model: 'Swift',
    odometerKm: 58_000,
  });

  await db.insert(schema.conversations).values({
    id: conversationId,
    shopId: DEMO_SHOP_ID,
    customerId,
    kind: 'CUSTOMER',
    channel: 'WHATSAPP',
    externalThreadId: `wa:${conversationId}`,
    externalAddressEncrypted: input.phone,
    displayName: input.name,
    state: 'OPEN',
    language: 'en',
    lastInboundAt: new Date(now.getTime() - 60_000),
    // Wide open for the whole demo. The re-pitch's window/template branch is
    // covered by the unit suite; what this demo is about is the trigger, the
    // gate and the fold.
    windowExpiresAt: new Date(now.getTime() + 200 * 24 * 3_600_000),
  });

  await db.insert(schema.consents).values({
    id: uuidv7(),
    shopId: DEMO_SHOP_ID,
    customerId,
    purpose: 'SERVICE',
    status: 'GRANTED',
    channel: 'WHATSAPP',
    source: 'SEED',
    grantedAt: new Date(now.getTime() - 86_400_000),
  });

  await db.insert(schema.jobCards).values({
    id: jobCardId,
    shopId: DEMO_SHOP_ID,
    customerId,
    vehicleId,
    code,
    state: 'DRAFT',
    source: 'WALK_IN',
    complaintText: 'Routine service, slight noise from the front',
    odometerKm: 58_000,
  });

  await db.insert(schema.workItems).values([
    {
      id: brakesId,
      shopId: DEMO_SHOP_ID,
      jobCardId,
      title: 'Front brake pad replacement',
      state: 'PENDING_APPROVAL',
      requiresApproval: true,
      technicianNote: 'Front pads worn to 2.1mm, minimum is 3mm. Metal to metal soon.',
      sequence: 0,
    },
    {
      id: oilId,
      shopId: DEMO_SHOP_ID,
      jobCardId,
      title: 'Engine oil and filter',
      state: 'PENDING_APPROVAL',
      requiresApproval: true,
      technicianNote: 'Oil is dark and the filter is due at this odometer.',
      sequence: 1,
    },
  ]);

  // DRAFT first, then ACCEPTED after the lines exist. Phase 1's trigger makes
  // an accepted estimate's lines immutable, which is exactly the protection it
  // should be — a fixture that could write through it would not be a fixture of
  // this system.
  await db.insert(schema.estimates).values({
    id: estimateId,
    shopId: DEMO_SHOP_ID,
    jobCardId,
    version: 1,
    status: 'DRAFT',
    subtotalPaise: BRAKES_PAISE + OIL_PAISE,
    totalPaise: BRAKES_PAISE + OIL_PAISE,
  });

  await db.insert(schema.estimateLines).values([
    {
      id: brakesLineId,
      shopId: DEMO_SHOP_ID,
      estimateId,
      workItemId: brakesId,
      kind: 'PART',
      description: 'Front brake pads (set)',
      quantityMilli: 1000,
      unitPricePaise: BRAKES_PAISE,
      lineTotalPaise: BRAKES_PAISE,
      sequence: 0,
    },
    {
      id: uuidv7(),
      shopId: DEMO_SHOP_ID,
      estimateId,
      workItemId: oilId,
      kind: 'CONSUMABLE',
      description: 'Engine oil and filter',
      quantityMilli: 1000,
      unitPricePaise: OIL_PAISE,
      lineTotalPaise: OIL_PAISE,
      sequence: 1,
    },
  ]);

  await db.execute(sql`
    update estimates set status = 'ACCEPTED' where id = ${estimateId}
  `);

  const actor = { type: 'STAFF' as const, id: null };

  // Driven in the order the shop actually works: the card asks for a decision
  // *before* the customer makes one. Deciding the work items first would leave
  // nothing pending and `REQUEST_APPROVAL` would be refused — correctly, which
  // is why the fixture follows the lifecycle rather than working around it.
  for (const event of ['OPEN_CARD', 'BEGIN_DIAGNOSIS', 'REQUEST_APPROVAL'] as const) {
    await jobCards.transition({ shopId: DEMO_SHOP_ID, jobCardId, event, actor, traceId: TRACE });
  }

  await workItems.transition({
    shopId: DEMO_SHOP_ID,
    workItemId: oilId,
    event: 'APPROVE',
    actor,
    traceId: TRACE,
  });
  await workItems.transition({
    shopId: DEMO_SHOP_ID,
    workItemId: brakesId,
    event: input.declineBrakes ? 'DEFER' : 'APPROVE',
    actor,
    traceId: TRACE,
    ...(input.declineBrakes ? { reason: 'Customer asked to do it next time' } : {}),
  });

  await jobCards.transition({
    shopId: DEMO_SHOP_ID,
    jobCardId,
    event: 'APPROVAL_GRANTED',
    actor,
    traceId: TRACE,
  });

  // The approved work is actually done. `WORK_COMPLETED` refuses a card with an
  // approved item still open, which is the guard that stops a shop delivering a
  // car it has not finished.
  const done = input.declineBrakes ? [oilId] : [oilId, brakesId];
  for (const workItemId of done) {
    for (const event of ['START', 'COMPLETE'] as const) {
      await workItems.transition({
        shopId: DEMO_SHOP_ID,
        workItemId,
        event,
        actor,
        traceId: TRACE,
      });
    }
  }

  // `PAYMENT_SETTLED` *is* the delivery for a card that was paid at the
  // counter: AWAITING_PAYMENT → DELIVERED. There is no separate handover event
  // on that branch, and adding one would be an illegal transition.
  for (const event of [
    'WORK_COMPLETED',
    'QUALITY_PASSED',
    'PAYMENT_REQUESTED',
    'PAYMENT_SETTLED',
  ] as const) {
    await jobCards.transition({ shopId: DEMO_SHOP_ID, jobCardId, event, actor, traceId: TRACE });
  }

  return {
    customerId,
    vehicleId,
    conversationId,
    jobCardId,
    code,
    brakesWorkItemId: brakesId,
    brakesEstimateLineId: brakesLineId,
  };
}

/**
 * The second visit: the deferred work, now on a card of its own.
 *
 * `ledgerItemId` on the work item is the whole mechanism behind "₹ recovered".
 * An advisor sets it by adding the item from the drawer's next-visit prompt;
 * without it, the approval is just another approval and the shop can never
 * prove the money came back.
 */
async function createFollowUpCard(
  db: Database,
  jobCards: JobCardTransitionService<Tx>,
  clock: DemoClock,
  customer: DemoCustomer,
  ledgerItemId: string,
): Promise<{ jobCardId: string; code: string; workItemId: string }> {
  const suffix = uuidv7().slice(-6).toUpperCase();
  const jobCardId = uuidv7();
  const workItemId = uuidv7();
  const estimateId = uuidv7();
  const code = `JC-DEMO6-${suffix.slice(0, 4)}`;

  await db.insert(schema.jobCards).values({
    id: jobCardId,
    shopId: DEMO_SHOP_ID,
    customerId: customer.customerId,
    vehicleId: customer.vehicleId,
    code,
    state: 'DRAFT',
    source: 'WHATSAPP',
    complaintText: 'Booked the brake pads we flagged in April',
    odometerKm: 61_500,
  });

  await db.insert(schema.workItems).values({
    id: workItemId,
    shopId: DEMO_SHOP_ID,
    jobCardId,
    title: 'Front brake pad replacement',
    state: 'PENDING_APPROVAL',
    requiresApproval: true,
    technicianNote: 'The pads we flagged in April.',
    sequence: 0,
    ledgerItemId,
  });

  await db.insert(schema.estimates).values({
    id: estimateId,
    shopId: DEMO_SHOP_ID,
    jobCardId,
    version: 1,
    status: 'DRAFT',
    subtotalPaise: BRAKES_PAISE,
    totalPaise: BRAKES_PAISE,
  });

  await db.insert(schema.estimateLines).values({
    id: uuidv7(),
    shopId: DEMO_SHOP_ID,
    estimateId,
    workItemId,
    kind: 'PART',
    description: 'Front brake pads (set)',
    quantityMilli: 1000,
    unitPricePaise: BRAKES_PAISE,
    lineTotalPaise: BRAKES_PAISE,
    sequence: 0,
  });

  await db.execute(sql`
    update estimates set status = 'ACCEPTED' where id = ${estimateId}
  `);

  clock.advanceHours(2);
  for (const event of ['OPEN_CARD', 'BEGIN_DIAGNOSIS', 'REQUEST_APPROVAL'] as const) {
    await jobCards.transition({
      shopId: DEMO_SHOP_ID,
      jobCardId,
      event,
      actor: { type: 'STAFF', id: null },
      traceId: TRACE,
    });
  }

  return { jobCardId, code, workItemId };
}

async function ensureOwner(db: Database): Promise<string> {
  const existing = await db.execute<{ id: string }>(sql`
    select id from staff
    where shop_id = ${DEMO_SHOP_ID} and role = 'OWNER' and is_active = true and deleted_at is null
    limit 1
  `);
  const found = existing.rows[0];
  if (found !== undefined) return found.id;

  const staffId = uuidv7();
  await db.insert(schema.staff).values({
    id: staffId,
    shopId: DEMO_SHOP_ID,
    fullName: 'Kumar',
    phoneEncrypted: OWNER_PHONE,
    phoneHash: blindIndex(DEMO_SHOP_ID, OWNER_PHONE),
    role: 'OWNER',
    isActive: true,
  });
  return staffId;
}

/* -------------------------------------------------------------------------- *
 * Reads the assertions need
 * -------------------------------------------------------------------------- */

async function feedbackIdFor(db: Database, jobCardId: string): Promise<string> {
  const result = await db.execute<{ id: string }>(sql`
    select id from feedback_requests
    where shop_id = ${DEMO_SHOP_ID} and job_card_id = ${jobCardId}
  `);
  const id = result.rows[0]?.id;
  assert(id !== undefined, `no feedback request for ${jobCardId}`);
  return id ?? '';
}

async function lastOutboundBody(db: Database, conversationId: string): Promise<string> {
  const result = await db.execute<{ body: string | null }>(sql`
    select body from messages
    where shop_id = ${DEMO_SHOP_ID} and conversation_id = ${conversationId}
      and direction = 'OUTBOUND' and status = 'SENT'
    order by created_at desc limit 1
  `);
  return result.rows[0]?.body ?? '';
}

async function countMessagesContaining(
  db: Database,
  conversationId: string,
  needle: string,
): Promise<number> {
  const result = await db.execute<{ count: number }>(sql`
    select count(*)::int as count from messages
    where shop_id = ${DEMO_SHOP_ID} and conversation_id = ${conversationId}
      and direction = 'OUTBOUND' and body ilike ${`%${needle}%`}
  `);
  return Number(result.rows[0]?.count ?? 0);
}

async function lastTouchPurpose(db: Database, customerId: string): Promise<string> {
  const result = await db.execute<{ purpose: string }>(sql`
    select purpose from retention_touches
    where shop_id = ${DEMO_SHOP_ID} and customer_id = ${customerId} and status = 'SENT'
    order by sent_at desc limit 1
  `);
  return result.rows[0]?.purpose ?? '';
}

/**
 * The golden check: fold the day again from the raw event log.
 *
 * Deliberately built from the pure function and the raw rows rather than from
 * the metrics service — a check that went through the same code path as the
 * thing it is checking would prove only that the code is deterministic.
 */
async function recomputeIndependently(
  db: Database,
  uow: PgUnitOfWork,
  configStore: PgShopConfigStore,
  env: ReturnType<typeof getEnv>,
  day: string,
): Promise<DailyRollup> {
  const config = await uow.transaction(async (tx) => {
    const row = await configStore.load(tx, DEMO_SHOP_ID);
    const timezone = (await configStore.loadShopTimezone(tx, DEMO_SHOP_ID)) ?? env.DEFAULT_TIMEZONE;
    return migrateShopConfig(row?.raw ?? {}, timezone).config;
  });

  const windows = windowsFrom(config);
  const events = await uow.transaction((tx) =>
    readAll(tx, day, windows.recoveryCohortDays, windows.repeatVisitWindowDays),
  );

  return computeRollup({
    shopId: DEMO_SHOP_ID,
    day,
    timezone: config.quietHours.timezone,
    windows,
    events,
  });
}

async function readAll(
  tx: Tx,
  day: string,
  cohortDays: number,
  repeatDays: number,
): Promise<readonly EventEnvelope[]> {
  const lookback = Math.max(cohortDays, repeatDays) + 1;
  const result = await tx.execute<{
    id: string;
    type: string;
    payload: unknown;
    occurred_at: Date;
    trace_id: string;
  }>(sql`
    select id, type, payload, occurred_at, trace_id
    from events_outbox
    where shop_id = ${DEMO_SHOP_ID}
      and occurred_at >= (${day}::date - ${lookback} * interval '1 day')
      and occurred_at < (${day}::date + interval '2 day')
    order by occurred_at asc, id asc
  `);

  const events: EventEnvelope[] = [];
  for (const row of result.rows) {
    try {
      events.push(
        parseEventEnvelope({
          id: row.id,
          type: row.type,
          occurredAt: new Date(row.occurred_at).toISOString(),
          shopId: DEMO_SHOP_ID,
          traceId: row.trace_id,
          payload: row.payload,
        }),
      );
    } catch {
      /* an envelope this build no longer understands is skipped, as the reader does */
    }
  }
  return events;
}

function percent(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

function format(value: number | null, unit: string): string {
  return value === null ? '—' : `${Math.round(value)}${unit}`;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
