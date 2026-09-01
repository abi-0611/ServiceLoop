import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { ShopConfig } from '@serviceloop/config';
import { migrateShopConfig } from '@serviceloop/config';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  systemClock,
  uuidv7,
  type CascadeAction,
  type Clock,
  type DataRequestVerification,
  type EventEnvelope,
} from '@serviceloop/shared';
import type { Actor } from '../job-card/context';
import type { AuditAppender, OutboxWriter, ShopConfigStore, UnitOfWork } from '../ports';
import { activeSteps, stepFor } from './cascade-plan';
import type {
  ArchiveWriter,
  DataRequestStore,
  ErasureExecutor,
  ExportSource,
  MediaPurger,
} from './ports';
import type {
  ArchiveEntry,
  CompletionReport,
  DataRequestRecord,
  ExportBundle,
} from './types';

/**
 * The DPDP data-principal workflows (phase 7.2).
 *
 * Two rights, one workflow engine, and the phase file's own instruction as the
 * design constraint: *"deletion is a workflow with an approval step and a
 * completion report, not a button."*
 *
 * Why it is not a button, concretely. A deletion is the only operation in this
 * system with no undo — not "hard to undo", none: the encrypted columns are
 * overwritten and the key does not help. The failure it guards against is not a
 * malicious operator; it is an advisor with two customers named Ramesh on
 * screen at 6pm on a Saturday. So there are four gates in front of the
 * irreversible act, and each is a different question answered by a different
 * person or a different clock:
 *
 *   verify   — is the requester actually the data principal?
 *   approve  — does the shop authorise destroying its records about them?
 *   schedule — a grace window in which a mistake can still be caught
 *   execute  — the cascade, per the declared plan, reporting what it did
 *
 * In a two-person workshop the first two are often the same person a minute
 * apart. They are still two acts, two columns and two audit rows, because when
 * something goes wrong the questions "who let them in" and "who authorised
 * this" have different answers and both need one.
 */

export interface DataPrincipalDeps<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly requests: DataRequestStore<Tx>;
  readonly config: ShopConfigStore<Tx>;
  readonly audit: AuditAppender<Tx>;
  readonly outbox: OutboxWriter<Tx>;
  readonly exports: ExportSource<Tx>;
  readonly archives: ArchiveWriter;
  readonly erasure: ErasureExecutor<Tx>;
  readonly media?: MediaPurger;
  /**
   * The key the subject pseudonym is derived under.
   *
   * The blind-index key, reused deliberately. A pseudonym has exactly the same
   * security requirement as a blind index — reproducible with the key, useless
   * without it — and minting a second key would double the number of secrets an
   * operator has to rotate for no gain.
   */
  readonly pseudonymKey: Buffer;
  readonly clock?: Clock;
  /** `DPDP_EXPORT_TTL_HOURS`. */
  readonly exportTtlHours?: number;
}

export interface RaiseRequestInput {
  readonly shopId: string;
  readonly customerId: string;
  readonly kind: 'EXPORT' | 'DELETION';
  readonly detail?: string | null;
  readonly actor: Actor;
  readonly requestedByStaffId?: string | null;
  readonly traceId: string;
}

export class DataPrincipalService<Tx> {
  private readonly clock: Clock;

  constructor(private readonly deps: DataPrincipalDeps<Tx>) {
    this.clock = deps.clock ?? systemClock;
  }

  /* ------------------------------------------------------------- lifecycle */

  /**
   * Lodges a request. Idempotent per (customer, kind) while one is open: a
   * customer who asks twice gets their existing request back rather than a
   * second cascade racing the first.
   */
  async raise(input: RaiseRequestInput): Promise<DataRequestRecord> {
    return this.deps.uow.transaction(async (tx) => {
      const existing = await this.deps.requests.findOpenFor(
        tx,
        input.shopId,
        input.customerId,
        input.kind,
      );
      if (existing !== null) return existing;

      const now = this.clock.now();
      const record = await this.deps.requests.create(tx, {
        shopId: input.shopId,
        customerId: input.customerId,
        subjectPseudonym: this.pseudonymFor(input.shopId, input.customerId),
        kind: input.kind,
        requestDetail: input.detail ?? null,
        requestedByStaffId: input.requestedByStaffId ?? null,
        createdAt: now,
      });

      await this.audit(tx, input.shopId, input.actor, 'privacy.request_raised', record, {
        kind: input.kind,
        // Never the customer id in the payload: this audit row is one of the
        // rows that survives the erasure it describes.
        subjectPseudonym: record.subjectPseudonym,
      }, input.traceId);

      await this.emit(tx, input.shopId, input.traceId, {
        type: 'privacy.request_raised',
        payload: {
          requestId: record.id,
          subjectPseudonym: record.subjectPseudonym,
          customerId: record.customerId,
          kind: input.kind,
        },
      });

      return record;
    });
  }

  /**
   * Records that we are satisfied the requester is the data principal.
   *
   * The *method* is stored, not a boolean, because the three methods are not
   * equally strong and a regulator asking "how did you know" is asking which
   * one. An OTP to the number on file is strong; an advisor attesting to an ID
   * check at the counter is only as strong as the advisor.
   */
  async verify(input: {
    readonly shopId: string;
    readonly requestId: string;
    readonly verification: DataRequestVerification;
    readonly actor: Actor;
    readonly traceId: string;
  }): Promise<DataRequestRecord> {
    return this.deps.uow.transaction(async (tx) => {
      const record = await this.load(tx, input.shopId, input.requestId);
      if (record.status !== 'RECEIVED') {
        throw new ConflictError(
          `This request is ${record.status}; only a RECEIVED request can be verified`,
        );
      }

      const now = this.clock.now();
      await this.deps.requests.markVerified(tx, record.id, {
        verification: input.verification,
        at: now,
      });
      await this.deps.requests.markStatus(tx, record.id, { status: 'VERIFIED', at: now });

      await this.audit(tx, input.shopId, input.actor, 'privacy.request_verified', record, {
        verification: input.verification,
      }, input.traceId);

      return { ...record, status: 'VERIFIED', verification: input.verification, verifiedAt: now };
    });
  }

  /**
   * Authorises the cascade, and schedules it for the end of the shop's grace
   * window.
   *
   * `skipGrace` exists and is deliberately awkward to reach: it requires the
   * OWNER role and a written reason, and both go into the audit row. There is a
   * legitimate case for it — a customer standing at the counter who wants it
   * done before they leave — and pretending otherwise would just get the grace
   * window configured to zero for every request instead of for the one that
   * needed it.
   */
  async approve(input: {
    readonly shopId: string;
    readonly requestId: string;
    readonly approvedByStaffId: string;
    readonly actor: Actor;
    readonly traceId: string;
    readonly skipGrace?: { readonly reason: string };
  }): Promise<DataRequestRecord> {
    return this.deps.uow.transaction(async (tx) => {
      const record = await this.load(tx, input.shopId, input.requestId);
      if (record.status !== 'VERIFIED') {
        throw new ConflictError(
          `This request is ${record.status}; a request must be VERIFIED before it can be approved`,
        );
      }
      if (input.skipGrace !== undefined && input.actor.type !== 'STAFF') {
        throw new ForbiddenError('Only a member of staff may waive the deletion grace window');
      }

      const config = await this.shopConfig(tx, input.shopId);
      const now = this.clock.now();

      // An export has nothing to undo, so it runs immediately. The grace window
      // exists for the irreversible half only.
      const graceDays = record.kind === 'DELETION' ? config.privacy.deletionGraceDays : 0;
      const scheduledFor =
        input.skipGrace !== undefined || graceDays === 0
          ? now
          : new Date(now.getTime() + graceDays * 86_400_000);

      await this.deps.requests.markApproved(tx, record.id, {
        approvedByStaffId: input.approvedByStaffId,
        at: now,
        scheduledFor,
      });
      // SCHEDULED when the grace window is still ahead, APPROVED when it is
      // not — an export, or a deletion whose window an owner waived in writing.
      const status = scheduledFor.getTime() > now.getTime() ? 'SCHEDULED' : 'APPROVED';
      await this.deps.requests.markStatus(tx, record.id, { status, at: now });

      await this.audit(tx, input.shopId, input.actor, 'privacy.request_approved', record, {
        scheduledFor: scheduledFor.toISOString(),
        graceDays,
        ...(input.skipGrace === undefined ? {} : { graceWaivedReason: input.skipGrace.reason }),
      }, input.traceId);

      // The status that was *written*, not a hard-coded 'APPROVED'.
      //
      // Returning APPROVED for a row stored as SCHEDULED made the caller
      // disagree with the database: the console renders its buttons from this
      // value, so it would offer "Run now" on a deletion still inside its grace
      // window — a button the API then refuses, which teaches an operator that
      // this screen's buttons are unreliable.
      return { ...record, status, approvedAt: now, scheduledFor };
    });
  }

  /** Withdraws a request during the grace window. */
  async cancel(input: {
    readonly shopId: string;
    readonly requestId: string;
    readonly reason: string;
    readonly actor: Actor;
    readonly traceId: string;
  }): Promise<void> {
    await this.deps.uow.transaction(async (tx) => {
      const record = await this.load(tx, input.shopId, input.requestId);
      if (!['RECEIVED', 'VERIFIED', 'APPROVED', 'SCHEDULED'].includes(record.status)) {
        throw new ConflictError(`A ${record.status} request cannot be cancelled`);
      }
      const now = this.clock.now();
      await this.deps.requests.markStatus(tx, record.id, {
        status: 'CANCELLED',
        at: now,
        outcomeReason: input.reason,
      });
      await this.audit(tx, input.shopId, input.actor, 'privacy.request_cancelled', record, {
        reason: input.reason,
      }, input.traceId);
    });
  }

  async reject(input: {
    readonly shopId: string;
    readonly requestId: string;
    readonly reason: string;
    readonly actor: Actor;
    readonly traceId: string;
  }): Promise<void> {
    await this.deps.uow.transaction(async (tx) => {
      const record = await this.load(tx, input.shopId, input.requestId);
      const now = this.clock.now();
      await this.deps.requests.markStatus(tx, record.id, {
        status: 'REJECTED',
        at: now,
        outcomeReason: input.reason,
      });
      await this.audit(tx, input.shopId, input.actor, 'privacy.request_rejected', record, {
        reason: input.reason,
      }, input.traceId);
    });
  }

  /* --------------------------------------------------------------- execute */

  /**
   * Runs an approved request whose grace window has elapsed.
   *
   * Dispatches on kind rather than being two methods, because the sentinel that
   * polls `dueForExecution` should not have to know which is which — a request
   * is due or it is not.
   */
  async execute(input: {
    readonly shopId: string;
    readonly requestId: string;
    readonly actor: Actor;
    readonly traceId: string;
  }): Promise<CompletionReport> {
    const record = await this.deps.uow.transaction(async (tx) =>
      this.load(tx, input.shopId, input.requestId),
    );

    if (!['APPROVED', 'SCHEDULED', 'RUNNING'].includes(record.status)) {
      throw new ConflictError(`A ${record.status} request cannot be executed`);
    }
    if (record.scheduledFor !== null && record.scheduledFor.getTime() > this.clock.now().getTime()) {
      throw new ConflictError(
        `This request is scheduled for ${record.scheduledFor.toISOString()} and is still inside its grace window`,
      );
    }
    if (record.customerId === null) {
      throw new ConflictError('This request has no customer attached; it has already run');
    }

    return record.kind === 'EXPORT'
      ? this.runExport(record, record.customerId, input)
      : this.runDeletion(record, record.customerId, input);
  }

  /* ---------------------------------------------------------------- export */

  private async runExport(
    record: DataRequestRecord,
    customerId: string,
    input: { readonly shopId: string; readonly actor: Actor; readonly traceId: string },
  ): Promise<CompletionReport> {
    const now = this.clock.now();

    await this.deps.uow.transaction(async (tx) => {
      await this.deps.requests.markStatus(tx, record.id, { status: 'RUNNING', at: now });
    });

    // Collected inside a transaction so the archive is a consistent snapshot,
    // then written to object storage *outside* it: holding a database
    // transaction open across a multi-megabyte upload pins a connection for the
    // length of a network round trip, which is the same reason `OutboundGate`
    // splits its send.
    const bundle = await this.deps.uow.transaction(async (tx) =>
      this.deps.exports.collect(tx, input.shopId, customerId, now),
    );

    const archive = await this.deps.archives.write({
      shopId: input.shopId,
      requestId: record.id,
      entries: archiveEntries(bundle),
    });

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + (this.deps.exportTtlHours ?? 72) * 3_600_000);

    const report: CompletionReport = {
      requestId: record.id,
      kind: 'EXPORT',
      subjectPseudonym: record.subjectPseudonym,
      completedAt: now.toISOString(),
      totals: {
        purgedRows: 0,
        pseudonymisedRows: 0,
        retainedRows: 0,
        tablesTouched: 0,
      },
      steps: [],
      summary: [
        `Export prepared: ${archive.sizeBytes} bytes across ${archiveEntries(bundle).length} files.`,
        `${bundle.jobCards.length} job card(s), ${bundle.invoices.length} invoice(s), ${bundle.messages.length} message(s), ${bundle.mediaIndex.length} media file(s) indexed.`,
        `The download link expires at ${expiresAt.toISOString()}.`,
      ].join(' '),
    };

    await this.deps.uow.transaction(async (tx) => {
      await this.deps.requests.attachArchive(tx, record.id, {
        archive,
        downloadTokenHash: sha256(token),
        expiresAt,
      });
      await this.deps.requests.markCompleted(tx, record.id, { at: now, report });
      await this.audit(tx, input.shopId, input.actor, 'privacy.export_completed', record, {
        bytes: archive.sizeBytes,
        sha256: archive.sha256,
        expiresAt: expiresAt.toISOString(),
      }, input.traceId);
      await this.emit(tx, input.shopId, input.traceId, {
        type: 'privacy.export_ready',
        payload: {
          requestId: record.id,
          subjectPseudonym: record.subjectPseudonym,
          customerId: record.customerId,
          // The token travels on the event so the composer can put the link in
          // a message; it is never written to a row in the clear.
          downloadToken: token,
          expiresAt: expiresAt.toISOString(),
        },
      });
    });

    return report;
  }

  /** Exchanges a download token for the archive bytes, once, before expiry. */
  async download(token: string): Promise<{ readonly bytes: Buffer; readonly filename: string }> {
    const record = await this.deps.uow.transaction(async (tx) =>
      this.deps.requests.findByDownloadTokenHash(tx, sha256(token)),
    );
    if (record === null) throw new NotFoundError('That download link is not valid');
    if (record.artifactKey === null) throw new NotFoundError('That export has no archive');
    if (record.downloadExpiresAt !== null && record.downloadExpiresAt < this.clock.now()) {
      throw new ForbiddenError('That download link has expired. Ask the workshop for a new one.');
    }

    const bytes = await this.deps.archives.read(record.artifactKey);
    await this.deps.uow.transaction(async (tx) => {
      await this.deps.requests.markDownloaded(tx, record.id, this.clock.now());
    });

    return { bytes, filename: `serviceloop-export-${record.subjectPseudonym.slice(0, 12)}.zip` };
  }

  /* -------------------------------------------------------------- deletion */

  private async runDeletion(
    record: DataRequestRecord,
    customerId: string,
    input: { readonly shopId: string; readonly actor: Actor; readonly traceId: string },
  ): Promise<CompletionReport> {
    const now = this.clock.now();
    const config = await this.deps.uow.transaction(async (tx) => {
      await this.deps.requests.markStatus(tx, record.id, { status: 'RUNNING', at: now });
      return this.shopConfig(tx, input.shopId);
    });

    const retentionUntil = new Date(now);
    retentionUntil.setFullYear(retentionUntil.getFullYear() + config.privacy.invoiceRetentionYears);

    /**
     * The whole cascade in one transaction.
     *
     * Not step-by-step-committed, and the reason is the state a partial
     * deletion leaves: a customer whose messages are gone and whose phone
     * number is not is *both* unable to be served and still identifiable —
     * strictly worse than either outcome. One transaction means the shop either
     * has the record or does not.
     *
     * The steps table is still written per step inside that transaction, so the
     * completion report says what each table gave up, and a crash rolls back
     * the report with the deletion rather than leaving a report for something
     * that did not happen.
     */
    const executed = await this.deps.uow.transaction(async (tx) => {
      const results: {
        table: string;
        action: CascadeAction;
        rows: number;
        detail: string;
        retentionUntil: Date | null;
      }[] = [];

      let index = 0;
      for (const step of activeSteps()) {
        const until = step.action === 'RETAINED' ? retentionUntil : null;
        const outcome = await this.deps.erasure.execute(tx, {
          shopId: input.shopId,
          customerId,
          subjectPseudonym: record.subjectPseudonym,
          table: step.table,
          action: step.action,
          retentionUntil: until,
          now,
        });

        await this.deps.requests.recordStep(tx, record.id, {
          stepIndex: index,
          tableName: step.table,
          action: step.action,
          rowsAffected: outcome.rowsAffected,
          detail: outcome.detail,
          retentionUntil: until,
        });

        results.push({
          table: step.table,
          action: step.action,
          rows: outcome.rowsAffected,
          detail: outcome.detail,
          retentionUntil: until,
        });
        index += 1;
      }

      return results;
    });

    const report = buildReport(record, executed, now);

    await this.deps.uow.transaction(async (tx) => {
      await this.deps.requests.markCompleted(tx, record.id, { at: now, report });
      // Only now: the request row must stop pointing at a customer whose row is
      // about to be unrecognisable, and it must do so *after* the report is
      // attached, so a crash between the two leaves a request that still knows
      // whose it was.
      await this.deps.requests.detachCustomer(tx, record.id);
      await this.audit(tx, input.shopId, input.actor, 'privacy.deletion_completed', record, {
        purgedRows: report.totals.purgedRows,
        pseudonymisedRows: report.totals.pseudonymisedRows,
        retainedRows: report.totals.retainedRows,
        tablesTouched: report.totals.tablesTouched,
      }, input.traceId);
      await this.emit(tx, input.shopId, input.traceId, {
        type: 'privacy.deletion_completed',
        payload: {
          requestId: record.id,
          subjectPseudonym: record.subjectPseudonym,
          // Null, deliberately: by the time this is emitted the id no longer
          // resolves to a person, and carrying it would be an identifier
          // outliving its own erasure.
          customerId: null,
          totals: report.totals,
        },
      });
    });

    return report;
  }

  /* --------------------------------------------------------------- reading */

  async get(shopId: string, requestId: string): Promise<DataRequestRecord> {
    return this.deps.uow.transaction(async (tx) => this.load(tx, shopId, requestId));
  }

  async list(
    shopId: string,
    filter: { readonly status?: DataRequestRecord['status']; readonly limit?: number } = {},
  ): Promise<readonly DataRequestRecord[]> {
    return this.deps.uow.transaction(async (tx) =>
      this.deps.requests.list(tx, shopId, {
        ...(filter.status === undefined ? {} : { status: filter.status }),
        limit: filter.limit ?? 50,
      }),
    );
  }

  async reportFor(shopId: string, requestId: string): Promise<CompletionReport | null> {
    return this.deps.uow.transaction(async (tx) => {
      const record = await this.load(tx, shopId, requestId);
      return record.report;
    });
  }

  /** Approved requests whose grace window has elapsed. Polled by the worker. */
  async due(now: Date, limit = 20): Promise<readonly DataRequestRecord[]> {
    return this.deps.uow.transaction(async (tx) =>
      this.deps.requests.dueForExecution(tx, now, limit),
    );
  }

  /**
   * The stable one-way pseudonym for a data principal.
   *
   * `HMAC(key, shopId || customerId)`, hex, prefixed so it is recognisable in a
   * log or a JSON payload as a pseudonym rather than mistaken for an id. Scoped
   * by shop for the same reason the blind index is: one shop's pseudonym must
   * not identify the same person in another's records.
   */
  pseudonymFor(shopId: string, customerId: string): string {
    const digest = createHmac('sha256', this.deps.pseudonymKey)
      .update(shopId)
      .update(' ')
      .update(customerId)
      .digest('hex');
    return `sub_${digest.slice(0, 32)}`;
  }

  /* --------------------------------------------------------------- private */

  private async load(tx: Tx, shopId: string, requestId: string): Promise<DataRequestRecord> {
    const record = await this.deps.requests.lockById(tx, shopId, requestId);
    if (record === null) throw new NotFoundError(`No data request ${requestId}`);
    return record;
  }

  private async shopConfig(tx: Tx, shopId: string): Promise<ShopConfig> {
    const stored = await this.deps.config.load(tx, shopId);
    const timezone = (await this.deps.config.loadShopTimezone(tx, shopId)) ?? 'Asia/Kolkata';
    return migrateShopConfig(stored?.raw ?? {}, timezone).config;
  }

  private async audit(
    tx: Tx,
    shopId: string,
    actor: Actor,
    action: string,
    record: DataRequestRecord,
    payload: Record<string, unknown>,
    traceId: string,
  ): Promise<void> {
    await this.deps.audit.append(tx, {
      shopId,
      actorType: actor.type,
      actorId: actor.id,
      action,
      entityType: 'DataRequest',
      entityId: record.id,
      // The pseudonym rather than the customer id, always. These rows outlive
      // the customer they are about — that is the point of them — so a customer
      // id here would be an identifier surviving its own erasure.
      payload: { ...payload, subjectPseudonym: record.subjectPseudonym, kind: record.kind },
      traceId,
    });
  }

  /**
   * Takes a fully-formed envelope rather than a type string and a bag.
   *
   * The looser shape typechecks and is worse: `EventEnvelope` is a discriminated
   * union whose whole value is that a payload cannot drift from its type, and a
   * helper taking `Record<string, unknown>` hands that guarantee back.
   */
  private async emit(
    tx: Tx,
    shopId: string,
    traceId: string,
    event: Pick<EventEnvelope, 'type' | 'payload'>,
  ): Promise<void> {
    await this.deps.outbox.enqueue(tx, {
      id: uuidv7(),
      occurredAt: this.clock.now().toISOString(),
      shopId,
      traceId,
      ...event,
    } as EventEnvelope);
  }
}

/* -------------------------------------------------------------------------- *
 * Pure helpers
 * -------------------------------------------------------------------------- */

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * The archive's contents.
 *
 * A README first, in plain words. A ZIP of raw JSON satisfies the letter of a
 * data-access right and, handed to a workshop customer, is functionally a
 * refusal — so the first file says what every other file is.
 */
export function archiveEntries(bundle: ExportBundle): readonly ArchiveEntry[] {
  const json = (value: unknown): Buffer => Buffer.from(JSON.stringify(value, null, 2), 'utf8');

  return [
    { name: 'README.txt', bytes: Buffer.from(readme(bundle), 'utf8') },
    { name: 'profile.json', bytes: json(bundle.profile) },
    { name: 'vehicles.json', bytes: json(bundle.vehicles) },
    { name: 'job-cards.json', bytes: json(bundle.jobCards) },
    { name: 'invoices.json', bytes: json(bundle.invoices) },
    { name: 'messages.json', bytes: json(bundle.messages) },
    { name: 'calls.json', bytes: json(bundle.calls) },
    { name: 'consents.json', bytes: json(bundle.consents) },
    { name: 'media-index.json', bytes: json(bundle.mediaIndex) },
  ];
}

function readme(bundle: ExportBundle): string {
  return [
    `Your data from ${bundle.profile.shopName}`,
    `Prepared on ${bundle.generatedAt}`,
    '',
    'This archive contains everything the workshop holds about you. Each file is',
    'in JSON format, which any text editor can open.',
    '',
    '  profile.json      Your name, phone number and language preference.',
    '  vehicles.json     The vehicles registered against your name.',
    '  job-cards.json    Every visit, what was found and what was done.',
    '  invoices.json     Every invoice, with its lines and payments.',
    '  messages.json     Every WhatsApp message, in both directions.',
    '  calls.json        Every telephone call, with its transcript.',
    '  consents.json     What you agreed to, when, and anything you withdrew.',
    '  media-index.json  A list of your photographs and voice notes.',
    '',
    'Photographs and voice notes are listed rather than included, because they',
    'can run to tens of megabytes and this file is meant to reach you on a',
    'phone. Each entry carries a link that works for as long as this archive',
    'does. If you would rather have them all, ask the workshop and they will',
    'arrange it.',
    '',
    'If anything here looks wrong, you can ask the workshop to correct it. If',
    'you would like it deleted, you can ask for that too — see the privacy',
    'notice for what can be deleted and what the law requires be kept.',
  ].join('\n');
}

function buildReport(
  record: DataRequestRecord,
  executed: readonly {
    table: string;
    action: CascadeAction;
    rows: number;
    detail: string;
    retentionUntil: Date | null;
  }[],
  now: Date,
): CompletionReport {
  const totals = executed.reduce(
    (accumulator, step) => ({
      purgedRows: accumulator.purgedRows + (step.action === 'PURGED' ? step.rows : 0),
      pseudonymisedRows:
        accumulator.pseudonymisedRows + (step.action === 'PSEUDONYMISED' ? step.rows : 0),
      retainedRows: accumulator.retainedRows + (step.action === 'RETAINED' ? step.rows : 0),
      tablesTouched: accumulator.tablesTouched + (step.rows > 0 ? 1 : 0),
    }),
    { purgedRows: 0, pseudonymisedRows: 0, retainedRows: 0, tablesTouched: 0 },
  );

  const retained = executed.filter((step) => step.action === 'RETAINED' && step.rows > 0);
  const retainedUntil = retained[0]?.retentionUntil ?? null;

  return {
    requestId: record.id,
    kind: 'DELETION',
    subjectPseudonym: record.subjectPseudonym,
    completedAt: now.toISOString(),
    totals,
    steps: executed.map((step) => ({
      table: step.table,
      action: step.action,
      rows: step.rows,
      detail: step.detail,
      retentionUntil: step.retentionUntil?.toISOString() ?? null,
    })),
    summary: [
      `${totals.purgedRows} record(s) permanently deleted across ${totals.tablesTouched} table(s).`,
      totals.pseudonymisedRows > 0
        ? `${totals.pseudonymisedRows} record(s) kept with every identifier replaced, so the workshop's audit trail and totals remain verifiable without naming you.`
        : '',
      retained.length > 0 && retainedUntil !== null
        ? `${totals.retainedRows} tax record(s) retained until ${retainedUntil.toISOString().slice(0, 10)} under ${stepFor('invoices')?.retention?.basis ?? 'the GST record-keeping obligation'}; your name and address have been removed from them.`
        : '',
    ]
      .filter((line) => line !== '')
      .join(' '),
  };
}
