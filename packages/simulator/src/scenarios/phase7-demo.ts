import {
  ChannelFailoverSender,
  SandboxSmsAdapter,
  SmsChannelSender,
  StorageArchiveWriter,
  createChannelPorts,
  createStoragePort,
} from '@serviceloop/adapters';
import { formatAdapterSelection, getEnv, migrateShopConfig } from '@serviceloop/config';
import {
  AuditService,
  DEMO_SHOP_ID,
  OutboxService,
  PgConsentStore,
  PgConversationStore,
  PgCostStore,
  PgDataRequestStore,
  PgErasureExecutor,
  PgExportSource,
  PgMessageStore,
  PgShopConfigStore,
  PgTemplateRegistrationStore,
  PgUnitOfWork,
  blindIndex,
  createDatabase,
  schema,
  type Database,
  type Tx,
} from '@serviceloop/db';
import {
  DataPrincipalService,
  OutboundGate,
  type ChannelSendRequest,
} from '@serviceloop/domain';
import {
  buildTemplateOpsView,
  formatLintFindings,
  lintTemplates,
  smsCoverage,
  uuidv7,
  type Clock,
} from '@serviceloop/shared';
import { sql } from 'drizzle-orm';
import IORedis from 'ioredis';
import { assert, assertEqual, ScenarioRunner } from '../runner';

/**
 * `pnpm demo:phase7`
 *
 * The phase that has no customer-visible feature of its own. Everything here is
 * a promise about what happens when something goes wrong — a customer asks for
 * their data back, a customer asks to be forgotten, WhatsApp stops answering,
 * somebody uploads a virus, a bill arrives that nobody can reconcile.
 *
 * Those promises are the ones that cannot be checked by looking. "The deletion
 * worked" is not observable from the console — the console is *supposed* to
 * show nothing afterwards. So every assertion in this file that matters is made
 * with **raw SQL against the database**, deliberately going around every store,
 * service and encryption helper the application would use, because a check that
 * went through the same code path as the thing it is checking would prove only
 * that the code is self-consistent.
 *
 * The arc, in order:
 *
 *  1. The template catalog and its lint — can this shop reach its customers at all?
 *  2. SMS coverage — and what happens on the rung when it cannot.
 *  3. A WhatsApp outage, injected: the circuit opens, SMS carries the message,
 *     WhatsApp comes back and the circuit closes.
 *  4. Cost metering: what that outage cost, split by channel.
 *  5. A data-principal **export**: lodged, verified, approved, run, and the
 *     archive delivered against a single-use expiring token.
 *  6. A data-principal **erasure**: the grace window, the cascade, and then the
 *     four probes that are the whole point — PII unrecoverable in raw SQL,
 *     invoices retained under the tax carve-out with the identity gone, the
 *     audit chain still verifying, and the metric totals unmoved.
 *
 * Nothing here reaches a model, a telephone or a real WhatsApp.
 */

const TRACE = `demo-phase7-${uuidv7().slice(0, 8)}`;

const SUBJECT_PHONE = `+9193${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`;
const SUBJECT_NAME = 'Anand Selvaraj';
const OWNER_PHONE = `+9194${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`;

/** A Tuesday, mid-morning: inside working hours, outside quiet hours. */
const VISIT = new Date('2026-05-12T10:30:00+05:30');

const INVOICE_PAISE = 412_500;

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

/**
 * A WhatsApp that can be switched off.
 *
 * Wrapping the sandbox sender rather than replacing it: the failover logic must
 * see the same shape of success it sees in production, or the drill proves
 * something about a stub instead of about the circuit breaker. `fail` throws
 * the kind of error a transport failure produces — not a business rejection,
 * which the failover is specified never to fall back on.
 */
class OutageInjector {
  down = false;
  sent = 0;

  constructor(private readonly inner: { send: (request: ChannelSendRequest) => Promise<unknown> }) {}

  get channel(): 'WHATSAPP' {
    return 'WHATSAPP';
  }

  async send(request: ChannelSendRequest): Promise<unknown> {
    if (this.down) {
      const error = new Error('socket hang up');
      (error as { code?: string }).code = 'ECONNRESET';
      throw error;
    }
    this.sent += 1;
    return this.inner.send(request);
  }
}

async function main(): Promise<void> {
  const env = getEnv();
  const database = createDatabase(env);
  const db = database.db;
  const redis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

  const clock = new DemoClock(VISIT);
  const uow = new PgUnitOfWork(db);
  const audit = new AuditService(db, redis);
  const outbox = new OutboxService(db);
  const storage = createStoragePort(env);

  const messages = new PgMessageStore();
  const conversations = new PgConversationStore();
  const configStore = new PgShopConfigStore();
  const consentStore = new PgConsentStore();
  const templates = new PgTemplateRegistrationStore();
  const costs = new PgCostStore();
  const channels = createChannelPorts(env, { redis });

  const whatsapp = new OutageInjector(channels.sender as never);
  // The settings reader is a function rather than a value because a shop's DLT
  // registration is configuration an owner can change without a restart, and
  // the sender is built once at boot long before any shop is in scope.
  const sms = new SmsChannelSender(new SandboxSmsAdapter(), async (shopId) => {
    const config = await uow.transaction(async (tx) => {
      const row = await configStore.load(tx, shopId);
      return migrateShopConfig(row?.raw ?? {}, env.DEFAULT_TIMEZONE).config;
    });
    return {
      enabled: config.smsFallback.enabled,
      senderId: config.smsFallback.senderId,
      dltTemplateIds: config.smsFallback.dltTemplateIds,
    };
  });
  const failoverEvents: string[] = [];
  const sender = new ChannelFailoverSender(whatsapp as never, sms, {
    threshold: 2,
    probeAfterMs: 60_000,
    onStateChange: (event) => failoverEvents.push(`${event.state}:${event.detail}`),
    now: () => clock.now(),
  });

  const gate = new OutboundGate<Tx>({
    uow,
    conversations,
    messages,
    consents: consentStore,
    config: configStore,
    audit,
    outbox,
    sender,
    clock,
  });

  const privacy = new DataPrincipalService<Tx>({
    uow,
    requests: new PgDataRequestStore(),
    config: configStore,
    audit,
    outbox,
    exports: new PgExportSource(storage, env.DPDP_EXPORT_TTL_HOURS * 3600),
    archives: new StorageArchiveWriter(storage),
    erasure: new PgErasureExecutor(),
    pseudonymKey: Buffer.from(env.BLIND_INDEX_KEY, 'base64'),
    exportTtlHours: env.DPDP_EXPORT_TTL_HOURS,
    clock,
  });

  /* ------------------------------------------------------------- scenario */

  let originalConfig: unknown = null;
  let ownerStaffId = '';
  let subject = { customerId: '', vehicleId: '', conversationId: '', jobCardId: '', invoiceId: '' };
  let pseudonym = '';
  let exportRequestId = '';
  let deletionRequestId = '';
  let downloadToken = '';
  let archiveBytes = 0;
  let beforeInvoiceTotals = { count: 0, paise: 0 };
  let beforeChainLength = 0;
  let beforeRollups = new Map<string, string>();

  const runner = new ScenarioRunner(
    'ServiceLoop — phase 7 acceptance demo',
    'Template ops → a WhatsApp outage carried by SMS → cost metering → DPDP export → erasure, proven in raw SQL',
  );

  for (const line of formatAdapterSelection(env)) process.stdout.write(`  ${line}\n`);

  runner
    .step('The shop is configured for the drill', async () => {
      const stored = await db.execute<{ config: unknown }>(sql`
        select config from shop_config where shop_id = ${DEMO_SHOP_ID}
      `);
      originalConfig = stored.rows[0]?.config ?? null;

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
            // L2 for the status flow. The drill is about the *channel* failing
            // over, and a shop at L0 holds every draft for review — which is
            // the guardrail working correctly and would make this demo assert
            // nothing about SMS. Every other flow is left where it was.
            autonomy: { ...current.autonomy, status: 'L2_CONVERSATIONAL' },
            smsFallback: {
              ...current.smsFallback,
              enabled: true,
              senderId: 'SRIMGN',
              dltEntityId: '1101234567890123456',
              // Two of the manifest's customer-facing templates registered, the
              // rest not — because a shop three days into onboarding has
              // exactly this, and a demo where everything is registered would
              // never exercise the coverage report that exists to find the gap.
              dltTemplateIds: {
                ready_for_delivery: '1707161234567890123',
                approval_request: '1707161234567890124',
              },
            },
            // A one-day grace window, so the demo can show it exists and then
            // pass through it on a wound clock rather than by waiving it. A
            // waiver is a different code path and it is not the one shops use.
            privacy: { ...current.privacy, deletionGraceDays: 1, invoiceRetentionYears: 8 },
            quietHours: { timezone: env.DEFAULT_TIMEZONE, start: '21:00', end: '06:00' },
          },
          null,
        ),
      );

      return 'SMS fallback on (2 DLT ids registered) · deletion grace 1 day · invoices retained 8 years';
    })

    .step('7.3 — the template catalog and its lint', () => {
      const findings = lintTemplates();
      assert(
        findings.length === 0,
        `the shipped catalogue is inconsistent:\n${formatLintFindings(findings)}`,
      );

      const view = buildTemplateOpsView([]);
      // Nothing registered yet, so every template must be reported — driven by
      // the manifest. A fold driven by the rows would show an empty screen
      // here, and an empty screen reads as "nothing to do".
      assertEqual(
        view.summary.notSubmitted,
        view.summary.total,
        'an unregistered shop must report every template as not submitted',
      );
      assertEqual(view.summary.ready, 0, 'nothing can be ready before anything is submitted');

      return `${view.summary.total} templates · ${view.summary.customerFacing} customer-facing · lint clean`;
    })

    .step('7.3 — a template is not ready until every language is approved', async () => {
      const first = buildTemplateOpsView([]).rows.find((row) => row.customerFacing);
      assert(first !== undefined, 'the manifest has no customer-facing template');

      // English through, Tamil pending: the ordinary state two days into
      // onboarding, and the one a screen most easily lies about.
      await uow.transaction(async (tx) => {
        await templates.upsert(tx, {
          shopId: DEMO_SHOP_ID,
          templateKey: first.key,
          language: 'en',
          status: 'APPROVED',
          providerTemplateId: '1707161000000000001',
          reviewedAt: clock.now(),
        });
        await templates.upsert(tx, {
          shopId: DEMO_SHOP_ID,
          templateKey: first.key,
          language: 'ta',
          status: 'PENDING',
          submittedAt: clock.now(),
        });
      });

      const rows = await uow.transaction((tx) => templates.listForShop(tx, DEMO_SHOP_ID));
      const view = buildTemplateOpsView(
        rows.map((row) => ({
          templateKey: row.templateKey,
          language: row.language,
          status: row.status,
          providerTemplateId: row.providerTemplateId,
          rejectionReason: row.rejectionReason,
          submittedAt: row.submittedAt,
          reviewedAt: row.reviewedAt,
          submittedBody: row.submittedBody,
        })),
      );

      const row = view.rows.find((entry) => entry.key === first.key);
      assert(row !== undefined, 'the registered template vanished from the fold');
      assertEqual(row.ready, false, 'a template with Tamil pending must not be reported ready');
      assertEqual(
        row.blockedOn.join(','),
        'ta,hi',
        'the blocked list must name the variants standing in the way',
      );

      return `${first.key}: en APPROVED, ta PENDING, hi NOT_SUBMITTED → blocked on ta, hi`;
    })

    .step('7.3 — SMS coverage names the templates that cannot fall back', async () => {
      const config = await uow.transaction(async (tx) => {
        const row = await configStore.load(tx, DEMO_SHOP_ID);
        return migrateShopConfig(row?.raw ?? {}, env.DEFAULT_TIMEZONE).config;
      });

      const coverage = smsCoverage(config.smsFallback.dltTemplateIds);
      assert(
        coverage.missing.length > 0,
        'this demo deliberately leaves templates unregistered; the report found none',
      );
      assertEqual(coverage.covered.length, 2, 'exactly the two registered ids should be covered');

      return `${coverage.covered.length} covered · ${coverage.missing.length} with no DLT id (they raise an advisor task instead of sending)`;
    })

    .step('A customer, a delivered card and a paid invoice', async () => {
      ownerStaffId = await ensureOwner(db);
      subject = await seedSubject(db, clock);
      pseudonym = privacy.pseudonymFor(DEMO_SHOP_ID, subject.customerId);

      // An audit event *about this customer*, carrying their name and number in
      // its payload — which is what a real intake writes, and what probe 3
      // exists to prove gets rewritten. Without it the cascade's audit step
      // matches nothing and the probe would pass by finding no problem in an
      // empty set, which is the shape of a test that has quietly stopped
      // testing anything.
      await uow.transaction((tx) =>
        audit.append(tx, {
          shopId: DEMO_SHOP_ID,
          actorType: 'STAFF',
          actorId: ownerStaffId,
          action: 'customer.created',
          entityType: 'customer',
          entityId: subject.customerId,
          payload: {
            customerId: subject.customerId,
            customerName: SUBJECT_NAME,
            customerPhone: SUBJECT_PHONE,
          },
          traceId: TRACE,
        }),
      );

      beforeInvoiceTotals = await invoiceTotals(db);
      beforeChainLength = await chainLength(db);
      beforeRollups = await rollupFingerprints(db);

      return `${SUBJECT_NAME} · invoice ${(INVOICE_PAISE / 100).toFixed(2)} · pseudonym ${pseudonym.slice(0, 12)}…`;
    })

    .step('7.3 — WhatsApp goes down; the circuit opens and SMS carries the message', async () => {
      whatsapp.down = true;

      const results = [];
      // Three sends an hour apart, the first carrying the AI disclosure.
      //
      // Both of those are the gate's rules, and the drill obeys them rather
      // than switching them off: the first outbound in a session must disclose,
      // and the shop requires sixty minutes between messages. A drill that
      // relaxed either would be proving that SMS works for a message the
      // product would never have sent.
      for (const body of [
        'This is the ServiceLoop assistant for Sri Murugan Auto Works. Your Swift is ready for collection.',
        'The gate pass is ready at the counter.',
        'Balance due at collection: ₹4,125.',
      ]) {
        results.push(
          await gate.send({
            shopId: DEMO_SHOP_ID,
            conversationId: subject.conversationId,
            customerId: subject.customerId,
            purpose: 'SERVICE',
            content: { kind: 'text', body },
            // Without this the SMS leg refuses the send outright: there is no
            // registered DLT template a free-form sentence could travel under,
            // and inventing one is exactly what DLT exists to prevent. Naming
            // the manifest key is how a message declares it *can* fall back.
            smsFallback: { templateKey: 'ready_for_delivery', body, language: 'en' },
            actor: { type: 'SYSTEM', id: null },
            traceId: TRACE,
            flow: 'status',
          }),
        );
        clock.advanceHours(1);
      }

      const sent = results.filter((result) => result.status === 'SENT');
      assert(
        sent.length === 3,
        `expected 3 sends to survive the outage, got ${sent.length} (${results
          .map((result) =>
            result.status === 'BLOCKED' ? `BLOCKED:${result.code}` : result.status,
          )
          .join(', ')})`,
      );

      // The property that matters: the customer was reached anyway. Which
      // channel each one took is read from the database rather than from the
      // sender's own report, because the sender is the thing under test.
      const bySms = await db.execute<{ id: string; count: number }>(sql`
        select id, count(*) over () :: int as count from messages
        where shop_id = ${DEMO_SHOP_ID}
          and conversation_id = ${subject.conversationId}
          and direction = 'OUTBOUND' and channel = 'SMS'
        order by created_at desc limit 1
      `);
      const smsRow = bySms.rows[0];
      assert(smsRow !== undefined, 'the outage produced no SMS at all');

      assert(
        failoverEvents.some((event) => event.startsWith('DOWN:')),
        'the circuit never opened, so every message paid a full HTTP timeout',
      );

      return `3 sends · ${smsRow.count} carried by SMS · circuit ${failoverEvents[0] ?? 'unchanged'}`;
    })

    .step('7.3 — WhatsApp comes back and the circuit closes', async () => {
      whatsapp.down = false;
      // The next morning. Past `probeAfterMs`, so the send probes the primary
      // rather than going straight to the understudy — and past the shop's
      // daily cap of three, which the outage above has just used up. Both of
      // those are the system behaving correctly: a fourth message on the same
      // day would be refused however healthy the channel was, and a drill that
      // raised the cap to get its recovery send through would be proving the
      // circuit closed for a message the shop would never have sent.
      clock.advanceHours(24);

      const before = whatsapp.sent;
      // A **template**, not a free-form sentence, and that is the point rather
      // than a detail. Twenty-four hours have passed, so the WhatsApp session
      // window has closed and free-form text is refused — which is exactly what
      // templates exist for, and exactly why the ops screen in steps 02–04
      // matters. A shop with no approved template cannot reach this customer at
      // all now, however healthy the channel is.
      const body = 'Your Swift is ready for collection at Sri Murugan Auto Works.';
      const result = await gate.send({
        shopId: DEMO_SHOP_ID,
        conversationId: subject.conversationId,
        customerId: subject.customerId,
        purpose: 'SERVICE',
        content: {
          kind: 'template',
          templateName: 'sl_ready_for_delivery_v1',
          templateLanguage: 'en',
          category: 'SERVICE',
          variables: ['Swift', 'Sri Murugan Auto Works'],
          preview: body,
        },
        smsFallback: { templateKey: 'ready_for_delivery', body, language: 'en' },
        actor: { type: 'SYSTEM', id: null },
        traceId: TRACE,
        flow: 'status',
      });

      assert(
        result.status === 'SENT',
        `the recovery send was ${result.status}${result.status === 'BLOCKED' ? `:${result.code}` : ''}`,
      );
      assert(
        whatsapp.sent > before,
        'the primary was never probed again — the circuit is stuck open',
      );
      assert(
        failoverEvents.some((event) => event.startsWith('RECOVERED:')),
        'recovery was never reported, so an operator would still be looking for an outage',
      );

      return `primary probed and healthy · ${failoverEvents.length} state change(s) reported`;
    })

    .step('7.3 — cost metering splits the outage by channel', async () => {
      const day = clock.now().toISOString().slice(0, 10);

      // A baseline, because the cost store is an accumulator and this demo is
      // re-runnable. Asserting absolute totals would pass exactly once and then
      // report a phantom regression on every subsequent run — which is worse
      // than not asserting, because somebody would eventually "fix" the meter.
      const before = (
        await uow.transaction((tx) => costs.dailyCosts(tx, DEMO_SHOP_ID, day, day))
      ).find((row) => row.day === day) ?? {
        day,
        whatsapp: {
          conversations: 0,
          messages: 0,
          costPaise: 0,
          byCategory: {} as Readonly<Record<string, number>>,
        },
        sms: { messages: 0, segments: 0, costPaise: 0 },
        totalPaise: 0,
      };

      await uow.transaction(async (tx) => {
        // What the cost-meter handler writes when it consumes `message.sent`.
        // Driven here rather than through the worker because this demo has no
        // queue running; the arithmetic and the category split are what is
        // under test.
        //
        // Two categories deliberately. On the current India card a SERVICE
        // conversation is **free** and a UTILITY one is not, and a meter that
        // could not tell them apart would produce a margin figure that moved
        // with traffic rather than with cost. The assertions below are that the
        // free one really is recorded at zero and the billable one is not.
        await costs.recordConversation(tx, {
          shopId: DEMO_SHOP_ID,
          day,
          category: 'SERVICE',
          conversations: 1,
          messages: 3,
          ratePaise: env.WA_PRICING_JSON.SERVICE,
        });
        await costs.recordConversation(tx, {
          shopId: DEMO_SHOP_ID,
          day,
          category: 'UTILITY',
          conversations: 1,
          messages: 1,
          ratePaise: env.WA_PRICING_JSON.UTILITY,
        });
        await costs.recordSms(tx, {
          shopId: DEMO_SHOP_ID,
          day,
          messages: 3,
          segments: 3,
          costPaise: 0,
        });
      });

      const rows = await uow.transaction((tx) => costs.dailyCosts(tx, DEMO_SHOP_ID, day, day));
      const today = rows.find((row) => row.day === day);
      assert(today !== undefined, 'no cost row for the day the drill ran');

      assertEqual(
        today.whatsapp.conversations - before.whatsapp.conversations,
        2,
        'two billable conversations were opened',
      );
      assertEqual(today.sms.messages - before.sms.messages, 3, 'three messages went over SMS');
      assertEqual(
        (today.whatsapp.byCategory['SERVICE'] ?? 0) - (before.whatsapp.byCategory['SERVICE'] ?? 0),
        0,
        'a SERVICE conversation was priced above zero; it is free on the current India card',
      );
      assertEqual(
        (today.whatsapp.byCategory['UTILITY'] ?? 0) - (before.whatsapp.byCategory['UTILITY'] ?? 0),
        env.WA_PRICING_JSON.UTILITY,
        'the UTILITY rate was not read from the pricing table',
      );
      assertEqual(
        today.totalPaise - before.totalPaise,
        env.WA_PRICING_JSON.UTILITY,
        'the day’s cost moved by something other than the one billable conversation',
      );

      return `WhatsApp 2 conv — SERVICE free, UTILITY ₹${(env.WA_PRICING_JSON.UTILITY / 100).toFixed(2)} · SMS 3 segments (cost pending the provider receipt)`;
    })

    .step('7.2 — a customer asks for a copy of their data', async () => {
      const record = await privacy.raise({
        shopId: DEMO_SHOP_ID,
        customerId: subject.customerId,
        kind: 'EXPORT',
        detail: 'Send me everything you hold about me and my car.',
        actor: { type: 'STAFF', id: ownerStaffId },
        requestedByStaffId: ownerStaffId,
        traceId: TRACE,
      });
      exportRequestId = record.id;

      assertEqual(record.status, 'RECEIVED', 'a new request must start unverified');
      assertEqual(
        record.subjectPseudonym,
        pseudonym,
        'the pseudonym must be reproducible from the shop and customer alone',
      );

      return `request ${record.id.slice(0, 8)}… RECEIVED, nothing verified yet`;
    })

    .step('7.2 — verified, approved, and the archive is built', async () => {
      await privacy.verify({
        shopId: DEMO_SHOP_ID,
        requestId: exportRequestId,
        verification: 'OTP_TO_NUMBER_ON_FILE',
        actor: { type: 'STAFF', id: ownerStaffId },
        traceId: TRACE,
      });
      await privacy.approve({
        shopId: DEMO_SHOP_ID,
        requestId: exportRequestId,
        approvedByStaffId: ownerStaffId,
        actor: { type: 'STAFF', id: ownerStaffId },
        traceId: TRACE,
      });

      // An export has no grace window — nothing is destroyed by it — so it runs
      // as soon as it is approved.
      const report = await privacy.execute({
        shopId: DEMO_SHOP_ID,
        requestId: exportRequestId,
        actor: { type: 'STAFF', id: ownerStaffId },
        traceId: TRACE,
      });

      // An export has no cascade *steps* — it destroys nothing — so the report
      // is a summary rather than a per-table ledger. Asserting on steps here
      // would be asserting that an export behaves like a deletion.
      assertEqual(report.kind, 'EXPORT', 'the report is for the wrong kind of request');
      assert(
        report.summary.includes('Export prepared'),
        `the export summary says nothing about an archive: ${report.summary}`,
      );
      assertEqual(
        report.totals.purgedRows,
        0,
        'an export purged rows; a request for a copy must destroy nothing',
      );

      const row = await db.execute<{ token_hash: string; artifact_bytes: number }>(sql`
        select download_token_hash as token_hash, artifact_bytes
        from data_requests where id = ${exportRequestId}
      `);
      archiveBytes = Number(row.rows[0]?.artifact_bytes ?? 0);
      assert(archiveBytes > 0, 'the archive is empty');
      assert(
        (row.rows[0]?.token_hash ?? '').length > 0,
        'no download token was minted, so the customer has no way to fetch it',
      );

      // The plaintext token exists for exactly one instant and travels on the
      // outbox event, so the composer can put a link in the customer's thread.
      // The database keeps only its SHA-256. Reading it from the event here is
      // not a shortcut — it is the delivery path, and a demo that read it from
      // a column would be asserting against a column that must not exist.
      downloadToken = await tokenFromOutbox(db, exportRequestId);
      assert(
        downloadToken !== '',
        'no `privacy.export.ready` event carried a token, so the customer would never receive a link',
      );

      return `${archiveBytes} bytes · nothing purged · single-use link expires in ${env.DPDP_EXPORT_TTL_HOURS}h`;
    })

    .step('7.2 — the token fetches the archive exactly once', async () => {
      const archive = await privacy.download(downloadToken);
      assertEqual(archive.bytes.length, archiveBytes, 'the delivered archive is a different size');
      assert(
        !archive.filename.toLowerCase().includes('anand'),
        `the filename names the customer (${archive.filename}) — a small leak to everyone who borrows the phone`,
      );

      const marked = await db.execute<{ downloaded_at: Date | null }>(sql`
        select downloaded_at from data_requests where id = ${exportRequestId}
      `);
      assert(
        marked.rows[0]?.downloaded_at != null,
        'the download was not recorded, so nobody can say whether the customer received it',
      );

      return `${archive.filename} · ${archive.bytes.length} bytes · download recorded`;
    })

    .step('7.2 — the customer asks to be forgotten; a grace window opens', async () => {
      const raised = await privacy.raise({
        shopId: DEMO_SHOP_ID,
        customerId: subject.customerId,
        kind: 'DELETION',
        detail: 'Please delete everything you have about me.',
        actor: { type: 'STAFF', id: ownerStaffId },
        requestedByStaffId: ownerStaffId,
        traceId: TRACE,
      });
      deletionRequestId = raised.id;

      await privacy.verify({
        shopId: DEMO_SHOP_ID,
        requestId: deletionRequestId,
        verification: 'STAFF_ATTESTED_IN_PERSON',
        actor: { type: 'STAFF', id: ownerStaffId },
        traceId: TRACE,
      });
      const approved = await privacy.approve({
        shopId: DEMO_SHOP_ID,
        requestId: deletionRequestId,
        approvedByStaffId: ownerStaffId,
        actor: { type: 'STAFF', id: ownerStaffId },
        traceId: TRACE,
      });

      assertEqual(approved.status, 'SCHEDULED', 'an approved deletion must be scheduled, not run');
      assert(
        approved.scheduledFor !== null && approved.scheduledFor > clock.now(),
        'the grace window did not open — a mistap would be irreversible immediately',
      );

      // And it genuinely refuses to run early. This is the assertion that makes
      // the window real rather than decorative.
      let refused = false;
      try {
        await privacy.execute({
          shopId: DEMO_SHOP_ID,
          requestId: deletionRequestId,
          actor: { type: 'STAFF', id: ownerStaffId },
          traceId: TRACE,
        });
      } catch {
        refused = true;
      }
      assert(refused, 'the cascade ran inside its own grace window');

      return `SCHEDULED for ${approved.scheduledFor?.toISOString() ?? '?'} · running early was refused`;
    })

    .step('7.2 — the window elapses and the cascade runs', async () => {
      clock.advanceHours(25);

      // A generous limit, and the reason is worth knowing outside this demo:
      // `dueForExecution` returns APPROVED, SCHEDULED *and* RUNNING rows in one
      // batch — RUNNING deliberately, so a worker that died mid-cascade resumes
      // — and they share the batch size. A backlog of requests wedged in
      // RUNNING therefore starves newly-due ones, which is exactly what a run
      // of this demo interrupted halfway leaves behind. The sentinel's real
      // batch is `DPDP_BATCH_SIZE`; see the runbook.
      const due = await privacy.due(clock.now(), 200);
      assert(
        due.some((record) => record.id === deletionRequestId),
        'the sentinel would not have found this request — it would sit SCHEDULED for ever',
      );

      const report = await privacy.execute({
        shopId: DEMO_SHOP_ID,
        requestId: deletionRequestId,
        // The sentinel's actor: the system acting on an authorisation a person
        // already gave. Attributing it to the owner would claim they were
        // present when it ran.
        actor: { type: 'SYSTEM', id: null },
        traceId: TRACE,
      });

      assert(report.totals.purgedRows > 0, 'nothing was purged');
      assert(
        report.totals.retainedRows > 0,
        'nothing was retained — the tax carve-out did not apply, which cannot be right with an invoice on file',
      );
      assert(
        report.totals.pseudonymisedRows > 0,
        'nothing was pseudonymised, so either the audit chain or the rollups have been damaged',
      );

      return `${report.totals.tablesTouched} tables · ${report.totals.purgedRows} purged · ${report.totals.pseudonymisedRows} pseudonymised · ${report.totals.retainedRows} retained`;
    })

    /* ---------------------------------------------------------------------- *
     * The four probes. Raw SQL, no stores, no decryption helpers — the point
     * is to look at what is actually on disk.
     * ---------------------------------------------------------------------- */

    .step('PROBE 1 — the PII is unrecoverable in raw SQL', async () => {
      // The customer *row* survives as a tombstone, and deliberately: retained
      // invoices carry a NOT NULL RESTRICT link to it, so deleting it would
      // either destroy the tax record or leave a dangling foreign key. What
      // must not survive is anything in it that identifies a person.
      const customer = await db.execute<{
        name: string;
        phone: string;
        erased_at: string | null;
        subject_pseudonym: string | null;
      }>(sql`
        select full_name_encrypted as name, phone_encrypted as phone,
               erased_at, subject_pseudonym
          from customers where id = ${subject.customerId}
      `);
      const row = customer.rows[0];
      assert(row !== undefined, 'the customer tombstone is gone; retained invoices now dangle');
      assert(row.erased_at !== null, 'the row was never marked erased');
      assertEqual(row.subject_pseudonym, pseudonym, 'the tombstone carries no pseudonym');
      // Read straight out of the column, so this sees ciphertext exactly as a
      // database dump would. The application would decrypt it; a thief would
      // not, and the assertion is about the thief.
      assert(
        !row.name.includes(SUBJECT_NAME),
        'the encrypted name column still contains the customer’s name',
      );

      // The blind index is the thing that would let somebody find this person
      // again by phone number. If it survives, the erasure is theatre.
      const hash = blindIndex(DEMO_SHOP_ID, SUBJECT_PHONE);
      const findable = await db.execute<{ hits: number }>(sql`
        select count(*)::int as hits from customers
         where shop_id = ${DEMO_SHOP_ID} and phone_hash = ${hash}
      `);
      assertEqual(
        Number(findable.rows[0]?.hits ?? -1),
        0,
        'the customer is still findable by phone number',
      );

      // And the name or number as a literal, anywhere a text column kept one.
      const leaks = await db.execute<{ leaks: number }>(sql`
        select (
          (select count(*) from messages
             where shop_id = ${DEMO_SHOP_ID} and body like ${'%' + SUBJECT_NAME + '%'})
        + (select count(*) from audit_events
             where shop_id = ${DEMO_SHOP_ID} and payload::text like ${'%' + SUBJECT_PHONE + '%'})
        + (select count(*) from conversations
             where shop_id = ${DEMO_SHOP_ID} and customer_id = ${subject.customerId})
        )::int as leaks
      `);
      assertEqual(
        Number(leaks.rows[0]?.leaks ?? -1),
        0,
        'the customer is still findable by name or number, or the thread survived',
      );

      return 'tombstoned · phone index destroyed · no name or number in messages, threads or audit payloads';
    })

    .step('PROBE 2 — the invoice is retained, pseudonymised, with its clock', async () => {
      const invoice = await db.execute<{
        customer_id: string | null;
        subject_pseudonym: string | null;
        // A string. `db.execute` returns the driver's raw rows, and a
        // `timestamptz` arrives as text rather than as the Date the typed query
        // builder would produce — the same trap that made the export throw.
        retained_until: string | null;
        total_paise: number;
      }>(sql`
        select customer_id, subject_pseudonym, retained_until, total_paise
        from invoices where id = ${subject.invoiceId}
      `);

      const row = invoice.rows[0];
      assert(row !== undefined, 'the invoice was destroyed — GST records must survive an erasure');
      // `customer_id` deliberately *stays*: it is NOT NULL and RESTRICT, and
      // the row it points at is the tombstone probe 1 just inspected. An
      // assessor following the link finds `[erased]`, which is the design —
      // nulling it would break the constraint, and deleting the customer would
      // break the invoice.
      assert(row.customer_id !== null, 'the invoice’s NOT NULL customer link was nulled');
      assertEqual(
        row.subject_pseudonym,
        pseudonym,
        'the retained invoice carries no pseudonym, so it can never be joined to the request again',
      );
      assert(
        row.retained_until !== null,
        'the invoice was retained with no retention clock, which is indefinite retention by accident',
      );
      assertEqual(
        Number(row.total_paise),
        INVOICE_PAISE,
        'the amount changed — a retained tax record must be intact',
      );

      const after = await invoiceTotals(db);
      assertEqual(
        after.paise,
        beforeInvoiceTotals.paise,
        'the shop’s invoiced total moved, so the books no longer reconcile',
      );

      return `invoice intact at ₹${(INVOICE_PAISE / 100).toFixed(2)} · identity replaced by ${pseudonym.slice(0, 12)}… · retained until ${row.retained_until?.slice(0, 10) ?? '?'}`;
    })

    .step('PROBE 3 — the audit chain still verifies', async () => {
      const after = await chainLength(db);
      assert(
        after >= beforeChainLength,
        `the chain lost rows (${beforeChainLength} → ${after}) — every hash after them is now unverifiable`,
      );

      const broken = await db.execute<{ broken: number }>(sql`
        with ordered as (
          select id, hash, prev_hash, payload_redacted,
                 lag(hash) over (partition by shop_id order by created_at, id) as expected_prev
            from audit_events
           where shop_id = ${DEMO_SHOP_ID}
        )
        select count(*)::int as broken from ordered
         where expected_prev is not null and prev_hash is distinct from expected_prev
      `);
      assertEqual(
        Number(broken.rows[0]?.broken ?? -1),
        0,
        'the hash chain is broken — the erasure damaged the shop’s ability to prove anything',
      );

      const redacted = await db.execute<{ redacted: number }>(sql`
        select count(*)::int as redacted from audit_events
         where shop_id = ${DEMO_SHOP_ID} and subject_pseudonym = ${pseudonym}
      `);
      assert(
        Number(redacted.rows[0]?.redacted ?? 0) > 0,
        'no audit event was pseudonymised, so this person left no trace that they were erased',
      );

      return `${after} events, chain intact · ${redacted.rows[0]?.redacted ?? 0} event(s) rewritten to the pseudonym and marked redacted`;
    })

    .step('PROBE 4 — the metric rollups are unmoved', async () => {
      // Compared by **stored payload hash**, day by day, before and after.
      //
      // Stronger than reading any one figure back: the hash covers every number
      // in the rollup, so a deletion that moved last quarter's revenue — or any
      // other total the shop is judged on — changes it. A probe that checked a
      // single column would pass while a different one had shifted.
      const after = await rollupFingerprints(db);

      const changed = [...beforeRollups.entries()]
        .filter(([day, hash]) => after.get(day) !== hash)
        .map(([day]) => day);

      assertEqual(
        changed.join(', '),
        '',
        'the erasure changed a stored rollup; every figure the shop is judged on is now unauditable',
      );

      const vanished = [...beforeRollups.keys()].filter((day) => !after.has(day));
      assertEqual(vanished.join(', '), '', 'the erasure destroyed a rollup');

      // And nothing left in a rollup names the person who is gone.
      const orphaned = await db.execute<{ orphaned: number }>(sql`
        select count(*)::int as orphaned from metric_rollups
         where shop_id = ${DEMO_SHOP_ID} and payload::text like ${'%' + subject.customerId + '%'}
      `);
      assertEqual(
        Number(orphaned.rows[0]?.orphaned ?? -1),
        0,
        'a rollup still names the erased customer',
      );

      return `${after.size} stored rollup(s), every payload hash identical, none naming the erased customer`;
    })

    .onTeardown(async () => {
      if (originalConfig !== null) {
        await db.execute(sql`
          update shop_config set config = ${JSON.stringify(originalConfig)}::jsonb
           where shop_id = ${DEMO_SHOP_ID}
        `);
      }
      await db.execute(sql`
        delete from template_registrations where shop_id = ${DEMO_SHOP_ID}
      `);
      // Requests this run left in flight, so an interrupted run does not starve
      // the next one's batch. Completed requests are left alone: they are the
      // evidence that an erasure happened, and the customer they name has
      // already been reduced to a pseudonym.
      await db.execute(sql`
        delete from data_request_steps where request_id in (
          select id from data_requests
           where shop_id = ${DEMO_SHOP_ID} and status in ('RECEIVED','VERIFIED','APPROVED','SCHEDULED','RUNNING')
        )
      `);
      await db.execute(sql`
        delete from data_requests
         where shop_id = ${DEMO_SHOP_ID}
           and status in ('RECEIVED','VERIFIED','APPROVED','SCHEDULED','RUNNING')
      `);
      await redis.quit();
      await database.close();
    });

  process.exit(await runner.run());
}

/* -------------------------------------------------------------------------- *
 * Seeding
 * -------------------------------------------------------------------------- */

/**
 * The data principal: a customer, a vehicle, an open consented thread, a
 * delivered card and a paid invoice.
 *
 * Inserted rather than driven through the transition services, and this is the
 * one demo where that is right: what is under test is what the *erasure* does
 * to rows, not how the rows came to exist — the lifecycle is phase 1 to 6's
 * business and six demos already prove it. What matters here is that every
 * table the cascade plan names actually has a row in it, so a plan step that
 * silently matches nothing cannot pass.
 */
async function seedSubject(
  db: Database,
  clock: DemoClock,
): Promise<{
  customerId: string;
  vehicleId: string;
  conversationId: string;
  jobCardId: string;
  invoiceId: string;
}> {
  const now = clock.now();
  const customerId = uuidv7();
  const vehicleId = uuidv7();
  const conversationId = uuidv7();
  const jobCardId = uuidv7();
  const invoiceId = uuidv7();
  const suffix = uuidv7().slice(-6).toUpperCase();

  await db.insert(schema.customers).values({
    id: customerId,
    shopId: DEMO_SHOP_ID,
    fullNameEncrypted: SUBJECT_NAME,
    phoneEncrypted: SUBJECT_PHONE,
    phoneHash: blindIndex(DEMO_SHOP_ID, SUBJECT_PHONE),
    preferredLanguage: 'en',
    createdAt: now,
  });

  const plate = `TN01AA${suffix.slice(0, 4)}`;
  await db.insert(schema.vehicles).values({
    id: vehicleId,
    shopId: DEMO_SHOP_ID,
    customerId,
    registrationRaw: plate,
    registrationNormalised: plate.toUpperCase().replace(/[^A-Z0-9]/g, ''),
    make: 'Maruti',
    model: 'Swift',
    createdAt: now,
  });

  await db.insert(schema.conversations).values({
    id: conversationId,
    shopId: DEMO_SHOP_ID,
    customerId,
    externalThreadId: SUBJECT_PHONE,
    externalAddressEncrypted: SUBJECT_PHONE,
    channel: 'WHATSAPP',
    kind: 'CUSTOMER',
    state: 'OPEN',
    lastInboundAt: now,
    windowExpiresAt: new Date(now.getTime() + 24 * 3_600_000),
    createdAt: now,
  });

  await db.insert(schema.consents).values({
    id: uuidv7(),
    shopId: DEMO_SHOP_ID,
    customerId,
    purpose: 'SERVICE',
    status: 'GRANTED',
    channel: 'WHATSAPP',
    source: 'INTERACTIVE_REPLY',
    createdAt: now,
  });

  await db.insert(schema.jobCards).values({
    id: jobCardId,
    shopId: DEMO_SHOP_ID,
    customerId,
    vehicleId,
    code: `JC-P7-${suffix}`,
    state: 'DELIVERED',
    source: 'WHATSAPP',
    createdAt: now,
  });

  await db.insert(schema.invoices).values({
    id: invoiceId,
    shopId: DEMO_SHOP_ID,
    jobCardId,
    customerId,
    number: `INV-P7-${suffix}`,
    status: 'PAID',
    // The seller block is what makes this a tax record rather than a receipt,
    // and it is what must survive the erasure intact — the assessor's copy
    // names the shop, not the customer.
    sellerName: 'Sri Murugan Auto Works',
    subtotalPaise: 350_000,
    cgstPaise: 31_250,
    sgstPaise: 31_250,
    totalPaise: INVOICE_PAISE,
    issuedAt: now,
    createdAt: now,
  });

  return { customerId, vehicleId, conversationId, jobCardId, invoiceId };
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
 * Probes
 * -------------------------------------------------------------------------- */

async function invoiceTotals(db: Database): Promise<{ count: number; paise: number }> {
  const result = await db.execute<{ count: number; paise: string | number | null }>(sql`
    select count(*)::int as count, coalesce(sum(total_paise), 0) as paise
      from invoices where shop_id = ${DEMO_SHOP_ID}
  `);
  const row = result.rows[0];
  return { count: Number(row?.count ?? 0), paise: Number(row?.paise ?? 0) };
}

/**
 * The export link, read from the event that carries it to the customer.
 *
 * Scanned across every event mentioning the request rather than filtered by
 * event type, deliberately: an event *renamed* should surface here as a found
 * token, not as "no token was minted" — the second would send somebody looking
 * at the archive writer for a fault that is in the composer's subscription.
 */
async function tokenFromOutbox(db: Database, requestId: string): Promise<string> {
  const rows = await db.execute<{ payload: unknown; type: string }>(sql`
    select type, payload from events_outbox
     where shop_id = ${DEMO_SHOP_ID} and payload::text like ${'%' + requestId + '%'}
     order by created_at desc
  `);

  for (const row of rows.rows) {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const token = payload['downloadToken'];
    if (typeof token === 'string' && token.length > 0) return token;
  }
  return '';
}

/**
 * Every stored rollup for the shop, by day, fingerprinted by its payload hash.
 *
 * The hash is what the metrics service already stores to decide whether a
 * re-fold changed anything, so this probe and `pnpm metrics:recompute` are
 * asking the same question of the same value — which is the point. A second,
 * independent notion of "did this number move" would eventually disagree with
 * the one the product uses.
 */
async function rollupFingerprints(db: Database): Promise<Map<string, string>> {
  const result = await db.execute<{ day: string; payload_hash: string }>(sql`
    select day::text as day, payload_hash from metric_rollups
     where shop_id = ${DEMO_SHOP_ID} order by day
  `);
  return new Map(result.rows.map((row) => [row.day, row.payload_hash]));
}

async function chainLength(db: Database): Promise<number> {
  const result = await db.execute<{ count: number }>(sql`
    select count(*)::int as count from audit_events where shop_id = ${DEMO_SHOP_ID}
  `);
  return Number(result.rows[0]?.count ?? 0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
