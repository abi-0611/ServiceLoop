import {
  BestEffortUsageSink,
  createChannelPorts,
  MeteredLlmPort,
  MockLlmAdapter,
  type LlmPort,
} from '@serviceloop/adapters';
import { createAgentRuntime, DeterministicExplanationWriter } from '@serviceloop/agent-core';
import { defaultShopConfig, formatAdapterSelection, getEnv } from '@serviceloop/config';
import {
  AuditService,
  createAgentStores,
  createDatabase,
  DEMO_SHOP_ID,
  OutboxService,
  PgConversationStore,
  PgJobCardStore,
  PgMessageStore,
  PgShopConfigStore,
  PgShopDirectory,
  PgUnitOfWork,
  PgWorkItemStore,
  blindIndex,
  schema,
  type Database,
  type Tx,
} from '@serviceloop/db';
import {
  APPROVAL_ACTION_IDS,
  APPROVAL_SUBJECT_TYPE,
  JobCardTransitionService,
  OutboundGate,
  WorkItemTransitionService,
  type EvidenceBundle,
  type RungScheduler,
} from '@serviceloop/domain';
import { formatPaise, uuidv7 } from '@serviceloop/shared';
import { sql } from 'drizzle-orm';
import IORedis from 'ioredis';
import { deterministicJudge } from '@serviceloop/adapters';
import { assert, assertEqual, ScenarioRunner } from '../runner';

/**
 * `pnpm demo:phase3`
 *
 * One full approval saga, narrated: technician evidence → evidence bundle →
 * approval request → price objection → refused concession → permitted
 * concession → approval → work items moved and the ladder cancelled.
 *
 * Against the **real database**, deliberately. The domain rules have their own
 * in-memory suites and the personas run without a database at all; what this
 * demo uniquely exercises is the phase-3 Postgres stores — the ones every other
 * test replaces with a double. A step that passes here is a step that works
 * against SQL.
 *
 * The delayed-job queue is the one thing kept in memory: a demo that needed a
 * BullMQ worker running to prove a ladder was scheduled would be testing the
 * developer's terminal, not the code.
 */

const TRACE = `demo-phase3-${uuidv7().slice(0, 8)}`;

/** A fresh number every run, so repeated demos never collide on a thread. */
const CUSTOMER_PHONE = `+9196${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`;

/**
 * A port whose script can be swapped between runs.
 *
 * The agent's turns reference the estimate line it is repricing, and that id is
 * only known once the seeded card has been picked — so the runtime is built
 * first and the script is installed per objection round.
 */
class SwappableLlm implements LlmPort {
  readonly driver = 'mock' as const;
  private current: LlmPort;

  constructor(initial: LlmPort) {
    this.current = initial;
  }

  use(port: LlmPort): void {
    this.current = port;
  }

  modelFor(taskClass: Parameters<LlmPort['modelFor']>[0]): string {
    return this.current.modelFor(taskClass);
  }

  complete(request: Parameters<LlmPort['complete']>[0]): ReturnType<LlmPort['complete']> {
    return this.current.complete(request);
  }

  extract: LlmPort['extract'] = (request) => this.current.extract(request);
}

/** Records what was scheduled without needing Redis. */
class InMemoryRungScheduler implements RungScheduler {
  readonly jobs = new Map<string, { escalationId: string; runAt: Date }>();
  private counter = 0;

  async enqueue(input: {
    readonly escalationId: string;
    readonly shopId: string;
    readonly subjectId: string;
    readonly runAt: Date;
  }): Promise<string | null> {
    this.counter += 1;
    const jobId = `demo-job-${this.counter}`;
    this.jobs.set(jobId, { escalationId: input.escalationId, runAt: input.runAt });
    return jobId;
  }

  async cancel(jobId: string): Promise<void> {
    this.jobs.delete(jobId);
  }
}

async function main(): Promise<void> {
  const env = getEnv();
  const database = createDatabase(env);
  const db = database.db;
  const redis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

  const uow = new PgUnitOfWork(db);
  const audit = new AuditService(db, redis);
  const outbox = new OutboxService(db);
  const channels = createChannelPorts(env, { redis });
  const scheduler = new InMemoryRungScheduler();

  const messages = new PgMessageStore();
  const conversations = new PgConversationStore();
  const configStore = new PgShopConfigStore();

  const gate = new OutboundGate<Tx>({
    uow,
    conversations,
    messages,
    consents: new (await import('@serviceloop/db')).PgConsentStore(),
    config: configStore,
    audit,
    outbox,
    sender: channels.sender,
  });

  const agentScript = new SwappableLlm(deterministicJudge());

  // Metered, against the real `llm_usage` table — this demo is the only place
  // `PgLlmUsageSink` is exercised against SQL.
  const usageSink = new BestEffortUsageSink(
    new (await import('@serviceloop/db')).PgLlmUsageSink(db),
    (error) => process.stdout.write(`  [usage] ${String(error)}
`),
  );
  const meteredLlm = new MeteredLlmPort(agentScript, usageSink, {
    pricing: { 'demo-agent': { inputPerMTokUsd: 3, outputPerMTokUsd: 15 } },
  });

  const jobCardTransitions = new JobCardTransitionService<Tx>({
    uow,
    cards: new PgJobCardStore(),
    config: configStore,
    audit,
    outbox,
  });

  const stores = createAgentStores();
  const agent = createAgentRuntime<Tx>({
    stores: {
      uow,
      ...stores,
      conversations,
      messages,
      config: configStore,
      directory: new PgShopDirectory(),
      audit,
      outbox,
    },
    gate,
    jobCards: jobCardTransitions,
    workItems: new WorkItemTransitionService<Tx>({
      uow,
      items: new PgWorkItemStore(),
      audit,
      outbox,
    }),
    scheduler,
    llm: meteredLlm,
    config: defaultShopConfig(env.DEFAULT_TIMEZONE),
    conversationTail: (tx, shopId, conversationId, limit) =>
      messages.recentForConversation(tx, shopId, conversationId, limit),
    loadHeld: (tx, shopId, messageId) => messages.loadHeld(tx, shopId, messageId),
    resolvePinnedCard: (tx, shopId, messageId) =>
      messages.jobCardForMessage(tx, shopId, messageId),
    scheduleFollowup: async () => 'demo-followup',
    openObjectionObjective: async () => undefined,
    // No key required: the deterministic writer produces a real, correctly
    // anchored explanation, which is what the checker and the customer need.
    explanations: new DeterministicExplanationWriter(),
  });

  /* ------------------------------------------------------------- scenario */

  let jobCardId = '';
  let jobCardCode = '';
  let customerId = '';
  let conversationId = '';
  let workItemIds: string[] = [];
  let lineId = '';
  let bundle: EvidenceBundle | null = null;
  let approvalId = '';
  let linePaise = 0;
  let originalConfig: unknown = null;

  /** One `resolve_partial_approval` run, with whatever script is installed. */
  const runObjection = async () =>
    agent.runner.run({
      shopId: DEMO_SHOP_ID,
      objective: 'resolve_partial_approval',
      conversationId,
      customerId,
      jobCardId,
      triggerMessageId: null,
      traceId: TRACE,
      config: demoConfig(env.DEFAULT_TIMEZONE),
      shop: {
        name: 'Sri Murugan Auto Works',
        city: 'Chennai',
        advisorName: 'Meena',
        priceListSummary: '',
      },
      card: null,
      conversationTail: [],
      sources: [],
      language: 'en',
      customerName: 'the customer',
    });

  const runner = new ScenarioRunner(
    'ServiceLoop — phase 3 acceptance demo',
    'evidence → bundle → approval request → objection → concession → approval',
  );

  for (const line of formatAdapterSelection(env)) {
    process.stdout.write(`  ${line}\n`);
  }

  runner
    .step('A job card is driven to AWAITING_APPROVAL', async () => {
      const found = await createDemoCard(db, jobCardTransitions);
      jobCardId = found.jobCardId;
      jobCardCode = found.code;
      customerId = found.customerId;
      workItemIds = found.workItemIds;
      lineId = found.lineId;

      assert(workItemIds.length > 0, 'the card has no decidable work items');
      assert(lineId.length > 0, 'the card has no estimate line to reprice');
      linePaise = found.linePaise;
      return `${jobCardCode} · ${workItemIds.length} item(s) · line ${formatPaise(linePaise)}`;
    })

    .step('The shop lets the agent speak, and may discount 10%', async () => {
      // Captured so teardown can put it back. A demo that permanently loosens a
      // shop's autonomy is a demo that has changed the thing it was supposed to
      // demonstrate — and `demo:phase1` asserts the conservative default, so it
      // would fail next, three scenarios away from the cause.
      const stored = await db.execute<{ config: unknown }>(sql`
        select config from shop_config where shop_id = ${DEMO_SHOP_ID}
      `);
      originalConfig = stored.rows[0]?.config ?? null;

      // Quiet hours are moved away from *now*. Phase 2 proves the deferral
      // works; a phase-3 demo that could only be run in the afternoon would
      // prove nothing at all, and every other guardrail still applies.
      const quiet = quietHoursAwayFromNow(env.DEFAULT_TIMEZONE);

      // Written directly rather than through the guardrail service: the demo is
      // about the approval flow, and phase 1 already proves the config path.
      await db.execute(sql`
        update shop_config
        set config = jsonb_set(
              jsonb_set(
                jsonb_set(config, '{autonomy,approval}', '"L2_CONVERSATIONAL"'),
                '{pricing}', '{"priceFloorPercent":90,"discountCeilingPercent":10}'
              ),
              '{quietHours}',
              ${JSON.stringify({ timezone: env.DEFAULT_TIMEZONE, ...quiet })}::jsonb
            )
        where shop_id = ${DEMO_SHOP_ID}
      `);
      return `L2_CONVERSATIONAL · floor 90% · ceiling 10% · quiet ${quiet.start}–${quiet.end}`;
    })

    .step('The customer has an open WhatsApp thread', async () => {
      conversationId = await openThread(db, customerId);
      return `thread ${conversationId.slice(0, 8)}… on ${CUSTOMER_PHONE}`;
    })

    .step('A technician photographs the wear and tags it to the card', async () => {
      const result = await agent.bundles.build({
        shopId: DEMO_SHOP_ID,
        anchor: { kind: 'explicit', jobCardId },
        note: 'Front pads worn to 2.1mm, minimum is 3mm. Metal to metal soon.',
        noteLanguage: 'en',
        authorStaffId: null,
        mediaIds: [],
        workItemIds,
        traceId: TRACE,
        actor: { type: 'STAFF', id: null },
      });

      assert(result.ok, `bundle failed: ${result.ok ? '' : result.failure.reason}`);
      if (!result.ok) return '';
      bundle = result.bundle;

      // L7: every sentence the customer will read cites a real source.
      const sourceIds = new Set([
        ...bundle.sourceNotes.map((note) => `note:${note.id}`),
        ...bundle.lines.map((line) => `line:${line.id}`),
      ]);
      for (const claim of bundle.claims) {
        for (const source of claim.sources) {
          assert(sourceIds.has(source), `claim cites unknown source ${source}`);
        }
      }

      return `${bundle.claims.length} claim(s), all anchored · total ${formatPaise(bundle.totalPaise)}`;
    })

    .step('The bundle goes to the customer with three buttons', async () => {
      assert(bundle !== null, 'no bundle');
      if (bundle === null) return '';

      const created = await agent.approvals.createApprovalRequest({
        shopId: DEMO_SHOP_ID,
        jobCardId,
        customerId,
        conversationId,
        bundle,
        ladderRef: 'APPROVAL',
        actor: { type: 'AGENT', id: null },
        traceId: TRACE,
      });

      assert(created.ok, `approval request failed: ${created.ok ? '' : created.reason}`);
      if (!created.ok) return '';
      approvalId = created.approvalId;
      assertEqual(created.gateStatus, 'SENT', 'the approval request should have gone out');

      const sent = channels.whatsapp as unknown as { outbox?: unknown[] };
      void sent;
      return `approval ${approvalId.slice(0, 8)}… sent as an interactive message`;
    })

    .step('The escalation ladder is scheduled and every rung is timed', async () => {
      const rungs = await agent.ladder.scheduleLadder({
        shopId: DEMO_SHOP_ID,
        objective: 'APPROVAL',
        subjectType: APPROVAL_SUBJECT_TYPE,
        subjectId: approvalId,
        openedAt: new Date(),
        actor: { type: 'AGENT', id: null },
        traceId: TRACE,
        skipRungs: [0],
      });

      assertEqual(rungs.length, 3, 'expected the reminder, the call rung and the owner digest');
      assertEqual(rungs[1]?.rungType, 'VOICE_OR_ADVISOR', 'rung 2 should be the voice rung');
      assertEqual(rungs[2]?.rungType, 'OWNER_DIGEST', 'rung 3 should be the owner exception');
      assertEqual(scheduler.jobs.size, 3, 'every rung should have a timer');

      return rungs
        .map((rung) => `T+${Math.round((rung.scheduledAt.getTime() - Date.now()) / 60_000)}m ${rung.rungType}`)
        .join(' · ');
    })

    .step('The customer objects on price; the floor refuses a third off', async () => {
      // A third off the line — far below the shop's 10% ceiling.
      agentScript.use(objectionScript('refused', lineId, Math.round(linePaise * 0.67), null));

      const report = await runObjection();
      const steps = await agent.runner.replay(DEMO_SHOP_ID, report.runId);
      assert(
        steps.some((call) => call.name === 'adjust_offer'),
        'the agent never tried to adjust the offer',
      );

      const refusal = await lastToolResult(db, report.runId, 'adjust_offer');
      assertEqual(refusal?.['code'], 'PRICE_BELOW_FLOOR', 'the floor should have refused');
      assertEqual(report.outcome, 'objective_met', 'the agent should still have replied');

      return `refused ${formatPaise(Math.round(linePaise * 0.67))}: ${String(refusal?.['reason']).slice(0, 60)}…`;
    })

    .step('The agent relays the refusal honestly rather than implying a discount', async () => {
      const body = await lastOutboundBody(db, conversationId);
      assert(
        body.includes('below what I am able to offer'),
        `the refusal was not relayed: ${body.slice(0, 80)}`,
      );
      assert(
        !body.includes(formatPaise(Math.round(linePaise * 0.67))),
        'the message quoted a price the shop refused',
      );
      return `"${body.slice(0, 70)}…"`;
    })

    .step('A concession inside the ceiling is accepted and becomes quotable', async () => {
      const agreed = Math.round(linePaise * 0.9);
      agentScript.use(objectionScript('accepted', lineId, agreed, agreed));

      const report = await runObjection();
      assert(
        report.skipped === undefined,
        `the run did not start: ${report.skipped ?? ''} — ${report.reason ?? ''}`,
      );
      const accepted = await lastToolResult(db, report.runId, 'adjust_offer');
      assertEqual(
        accepted?.['accepted'],
        true,
        `a 10% concession should have been accepted (run ${report.outcome}: ${report.reason ?? ''}; result ${JSON.stringify(accepted)})`,
      );

      const body = await lastOutboundBody(db, conversationId);
      assert(
        body.includes(formatPaise(agreed)),
        `the agreed price was not quoted (run ${report.outcome}: ${report.reason ?? ''}); last sent: ${body.slice(0, 80)}`,
      );

      return `agreed ${formatPaise(agreed)} and quoted it, cited line:${lineId.slice(0, 8)}…@agreed`;
    })

    .step('Every agent step is persisted and replayable', async () => {
      const runs = await db.execute<{ id: string; step_count: number; outcome: string | null }>(sql`
        select id, step_count, outcome::text as outcome
        from agent_runs
        where shop_id = ${DEMO_SHOP_ID}
        order by started_at desc
        limit 1
      `);
      const run = runs.rows[0];
      assert(run !== undefined, 'no agent run was persisted');
      if (run === undefined) return '';

      const replayed = await agent.runner.replay(DEMO_SHOP_ID, run.id);
      assert(replayed.length > 0, 'the persisted run replays to no tool calls');
      assertEqual(
        replayed.length >= Number(run.step_count),
        true,
        'the replay should cover every recorded step',
      );

      return `run ${run.id.slice(0, 8)}… · ${run.step_count} step(s) · replays ${replayed.length} tool call(s)`;
    })

    .step('The customer taps Approve and the decision is recorded once', async () => {
      const first = await agent.replies.approve({
        shopId: DEMO_SHOP_ID,
        conversationId,
        customerId,
        triggerMessageId: null,
        replyTitle: 'Approve ✅',
        traceId: TRACE,
      });
      assert(first.handled, `approve was not handled: ${first.detail}`);

      // A second tap: customers do this when they are unsure it worked.
      const second = await agent.replies.approve({
        shopId: DEMO_SHOP_ID,
        conversationId,
        customerId,
        triggerMessageId: null,
        replyTitle: 'Approve ✅',
        traceId: TRACE,
      });
      assertEqual(second.handled, false, 'a second tap must not decide anything twice');

      return `approval ${approvalId.slice(0, 8)}… decided once, ${APPROVAL_ACTION_IDS.approve}`;
    })

    .step('The work items moved and the card is back in progress', async () => {
      const items = await db.execute<{ state: string; count: number }>(sql`
        select state::text as state, count(*)::int as count
        from work_items where job_card_id = ${jobCardId} group by state
      `);
      const approved = items.rows.find((row) => row.state === 'APPROVED');
      assert(approved !== undefined, 'no work item reached APPROVED');

      const card = await db.execute<{ state: string }>(sql`
        select state::text as state from job_cards where id = ${jobCardId}
      `);
      assertEqual(card.rows[0]?.state, 'IN_PROGRESS', 'the card should be back in progress');

      return `${approved?.count ?? 0} item(s) APPROVED · card IN_PROGRESS`;
    })

    .step('The ladder was cancelled the moment the customer decided', async () => {
      const pending = await uow.transaction(async (tx) =>
        stores.escalations.pendingForSubject(tx, DEMO_SHOP_ID, APPROVAL_SUBJECT_TYPE, approvalId),
      );
      assertEqual(pending.length, 0, 'rungs are still scheduled after a decision');
      assertEqual(scheduler.jobs.size, 0, 'timers are still armed after a decision');
      return 'every remaining rung cancelled, every timer dropped';
    })

    .step('The ETA hook phase 4 fills was emitted', async () => {
      const events = await db.execute<{ type: string }>(sql`
        select type from events_outbox
        where shop_id = ${DEMO_SHOP_ID} and type = 'eta.requested'
        order by created_at desc limit 1
      `);
      assert(events.rows.length === 1, 'no eta.requested event was emitted');
      return 'eta.requested is on the outbox for phase 4';
    })

    .step('Every model call was metered, with a cost estimate', async () => {
      const usage = await db.execute<{
        calls: number;
        tokens: number;
        priced: number;
        classes: string;
      }>(sql`
        select
          count(*)::int as calls,
          coalesce(sum(input_tokens + output_tokens), 0)::int as tokens,
          count(*) filter (where cost_usd_micros is not null)::int as priced,
          string_agg(distinct task_class::text, ',') as classes
        from llm_usage where shop_id = ${DEMO_SHOP_ID}
      `);

      const row = usage.rows[0];
      assert(row !== undefined, 'llm_usage is not queryable');
      assert(Number(row?.calls ?? 0) > 0, 'no model call was metered');
      assert(Number(row?.tokens ?? 0) > 0, 'a metered call recorded no tokens');
      assert(Number(row?.priced ?? 0) > 0, 'the priced model recorded no cost estimate');

      return `${row?.calls} call(s) · ${row?.tokens} token(s) · ${row?.priced} priced · classes ${row?.classes}`;
    })

    .onTeardown(async () => {
      if (originalConfig !== null) {
        await db.execute(sql`
          update shop_config
          set config = ${JSON.stringify(originalConfig)}::jsonb, updated_at = now()
          where shop_id = ${DEMO_SHOP_ID}
        `);
      }
      await redis.quit();
      await database.close();
    });

  const code = await runner.run();
  process.exit(code);
}

/* ---------------------------------------------------------------- helpers -- */

/** The shop configuration the demo runs under, as the runtime sees it. */
function demoConfig(timezone: string) {
  const base = defaultShopConfig(timezone);
  return {
    ...base,
    autonomy: { ...base.autonomy, approval: 'L2_CONVERSATIONAL' as const },
    pricing: { priceFloorPercent: 90, discountCeilingPercent: 10 },
  };
}

/**
 * One objection round: try a price, then say something about the outcome.
 *
 * `agreedPaise` is non-null only when the concession is expected to be accepted
 * — that is the case where the agent may quote the new figure, and the source it
 * cites is the one `adjust_offer` minted when it approved the price.
 */
function objectionScript(
  name: string,
  lineId: string,
  askPaise: number,
  agreedPaise: number | null,
): MockLlmAdapter {
  const draft =
    agreedPaise === null
      ? 'That is below what I am able to offer. I can check with the owner and come back to you.'
      : `I can do that line for ${formatPaise(agreedPaise)}. Shall we go ahead?`;

  const claims =
    agreedPaise === null
      ? []
      : [
          {
            text: `I can do that line for ${formatPaise(agreedPaise)}.`,
            sources: [`line:${lineId}@agreed`],
          },
        ];

  return new MockLlmAdapter(
    {
      name: `demo-phase3-${name}`,
      description: 'price objection round',
      model: 'demo-agent',
      turns: [
        {
          text: '',
          toolCalls: [{ name: 'adjust_offer', args: { lineId, newPricePaise: askPaise } }],
          inputTokens: 900,
          outputTokens: 90,
        },
        {
          text: '',
          toolCalls: [
            { name: 'compose_customer_message', args: { draft, claims, language: 'en' } },
          ],
          inputTokens: 900,
          outputTokens: 90,
        },
        {
          text: '',
          toolCalls: [{ name: 'send_customer_message', args: { candidateId: '{{candidateId}}' } }],
          inputTokens: 900,
          outputTokens: 40,
        },
      ],
    },
    // The script is the agent's turns; the claim judge is delegated so it
    // cannot consume one.
    { handles: ['AGENT'], delegate: deterministicJudge() },
  );
}

/** The result a named tool returned on a run, from the persisted steps. */
async function lastToolResult(
  db: Database,
  runId: string,
  tool: string,
): Promise<Record<string, unknown> | null> {
  const rows = await db.execute<{ result: unknown }>(sql`
    select r->'result' as result
    from agent_steps s, jsonb_array_elements(s.tool_results) r
    where s.run_id = ${runId} and r->>'name' = ${tool}
    order by s.step_index desc
    limit 1
  `);
  const result = rows.rows[0]?.result;
  return typeof result === 'object' && result !== null
    ? (result as Record<string, unknown>)
    : null;
}

/** The body of the newest message that actually reached the customer. */
async function lastOutboundBody(db: Database, conversationId: string): Promise<string> {
  const rows = await db.execute<{ body: string }>(sql`
    select body from messages
    where conversation_id = ${conversationId}
      and direction = 'OUTBOUND'
      and status in ('SENT', 'DELIVERED', 'READ')
    order by created_at desc
    limit 1
  `);
  return rows.rows[0]?.body ?? '';
}

/**
 * A one-hour quiet window that does not contain the current local time.
 *
 * Two hours ahead, so a demo run at any hour of the day sends rather than
 * defers. The quiet-hours *rule* is proved by phase 2's demo and by the ladder's
 * own tests; this exists so phase 3 can be run at 22:00 without appearing to be
 * broken.
 */
function quietHoursAwayFromNow(timezone: string): { start: string; end: string } {
  const local = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date());

  const hour = Number(local.slice(0, 2));
  const start = (hour + 2) % 24;
  const end = (hour + 3) % 24;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return { start: `${pad(start)}:00`, end: `${pad(end)}:00` };
}

/**
 * The demo's own customer, vehicle and job card.
 *
 * Created rather than borrowed. A demo that consumed a seeded card would work
 * once and then hit the shop's daily frequency cap on the customer it had
 * already messaged — and would look broken while the guardrail was working
 * exactly as intended. Creating its own subject makes it re-runnable without
 * weakening anything.
 *
 * The card is *driven* to AWAITING_APPROVAL through the transition service
 * rather than inserted in it, so the demo produces a genuine hash-chained audit
 * trail and real outbox events, exactly as the seed does.
 */
async function createDemoCard(
  db: Database,
  transitions: JobCardTransitionService<Tx>,
): Promise<{
  jobCardId: string;
  code: string;
  customerId: string;
  workItemIds: string[];
  lineId: string;
  linePaise: number;
}> {
  const suffix = uuidv7().slice(-8).toUpperCase();
  const customerId = uuidv7();
  const vehicleId = uuidv7();
  const jobCardId = uuidv7();
  const estimateId = uuidv7();
  const brakesId = uuidv7();
  const oilId = uuidv7();
  const brakeLineId = uuidv7();
  const oilLineId = uuidv7();
  const code = `JC-DEMO3-${suffix.slice(0, 4)}`;

  const BRAKES_PAISE = 320_000;
  const OIL_PAISE = 160_000;

  // Through drizzle: `full_name_encrypted` and `phone_encrypted` are PII
  // columns, and a raw insert would store them in the clear.
  await db.insert(schema.customers).values({
    id: customerId,
    shopId: DEMO_SHOP_ID,
    fullNameEncrypted: 'Ravi Kumar',
    phoneEncrypted: CUSTOMER_PHONE,
    phoneHash: blindIndex(DEMO_SHOP_ID, CUSTOMER_PHONE),
    preferredLanguage: 'en',
    whatsappOptIn: true,
  });

  await db.insert(schema.vehicles).values({
    id: vehicleId,
    shopId: DEMO_SHOP_ID,
    customerId,
    registrationRaw: `TN 09 D3 ${suffix.slice(0, 4)}`,
    registrationNormalised: `TN09D3${suffix.slice(0, 4)}`,
    make: 'Maruti Suzuki',
    model: 'Swift',
    odometerKm: 62_000,
  });

  await db.insert(schema.jobCards).values({
    id: jobCardId,
    shopId: DEMO_SHOP_ID,
    customerId,
    vehicleId,
    code,
    state: 'DRAFT',
    source: 'WALK_IN',
    complaintText: 'Grinding noise when braking',
    odometerKm: 62_000,
  });

  await db.insert(schema.workItems).values([
    {
      id: brakesId,
      shopId: DEMO_SHOP_ID,
      jobCardId,
      title: 'Front brake pad replacement',
      state: 'PENDING_APPROVAL',
      requiresApproval: true,
      technicianNote: 'Front pads worn to 2.1mm, minimum is 3mm.',
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
      id: brakeLineId,
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
      id: oilLineId,
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

  // Driven, not inserted: the audit chain and the outbox see a real lifecycle.
  for (const event of ['OPEN_CARD', 'BEGIN_DIAGNOSIS', 'REQUEST_APPROVAL'] as const) {
    await transitions.transition({
      shopId: DEMO_SHOP_ID,
      jobCardId,
      event,
      actor: { type: 'STAFF', id: null },
      traceId: TRACE,
    });
  }

  return {
    jobCardId,
    code,
    customerId,
    workItemIds: [brakesId, oilId],
    lineId: brakeLineId,
    linePaise: BRAKES_PAISE,
  };
}

/**
 * A thread with an open 24-hour window and SERVICE consent on record.
 *
 * Written directly because phase 2 already proves the inbound path that would
 * otherwise create it, and re-proving it here would make this demo about
 * something else.
 */
async function openThread(db: Database, customerId: string): Promise<string> {
  const conversationId = uuidv7();
  const now = new Date();

  // Through drizzle, not raw SQL: `external_address_encrypted` is an
  // `encryptedText` column, and a raw insert would write the customer's phone
  // number in the clear — which is both a DPDP violation and unreadable on the
  // way out.
  await db.insert(schema.conversations).values({
    id: conversationId,
    shopId: DEMO_SHOP_ID,
    customerId,
    kind: 'CUSTOMER',
    channel: 'WHATSAPP',
    // The whole id, not a prefix: uuidv7's leading characters are a timestamp,
    // so two runs inside the same minute would collide on the thread key.
    externalThreadId: `wa:demo3:${conversationId}`,
    externalAddressEncrypted: CUSTOMER_PHONE,
    displayName: 'Demo customer',
    state: 'OPEN',
    language: 'en',
    lastInboundAt: now,
    windowExpiresAt: new Date(now.getTime() + 20 * 60 * 60 * 1000),
  });

  await db.insert(schema.consents).values({
    id: uuidv7(),
    shopId: DEMO_SHOP_ID,
    customerId,
    purpose: 'SERVICE',
    status: 'GRANTED',
    channel: 'WHATSAPP',
    source: 'SEED',
    grantedAt: now,
  });

  return conversationId;
}

main().catch((error: unknown) => {
  console.error('[demo:phase3] failed');
  console.error(error);
  process.exit(1);
});
