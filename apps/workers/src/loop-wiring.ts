import {
  createPaymentsPort,
  HeuristicStatusSignalParser,
  LlmStatusSignalParser,
  QrPngRenderer,
  ReactPdfInvoiceRenderer,
  type LlmPort,
  type SpeechPort,
  type StoragePort,
} from '@serviceloop/adapters';
import type { LoopRuntimeInput } from '@serviceloop/agent-core';
import type { Env } from '@serviceloop/config';
import {
  PgCardResolver,
  PgConversationStore,
  PgDeliveryBookingStore,
  PgEtaStore,
  PgGatePassStore,
  PgGeneratedMediaWriter,
  PgInvoiceStore,
  PgJobCardContextReader,
  PgPaymentStore,
  PgShopConfigStore,
  PgShopDirectory,
  PgSilentBayStore,
  PgStatusCommsStore,
  PgStatusSignalStore,
  decryptPii,
  type PgUnitOfWork,
  type AuditService,
  type Database,
  type OutboxService,
  type Tx,
} from '@serviceloop/db';
import type {
  AdvisorTaskCreator,
  JobCardTransitionService,
  OutboundGate,
  WorkItemTransitionService,
} from '@serviceloop/domain';
import { sql } from 'drizzle-orm';

/**
 * The worker's half of the phase-4 wiring.
 *
 * `createLoopRuntime` is shared with the API, but the *inputs* it needs — the
 * Postgres stores and the three SQL reads — are assembled twice, once per
 * process. That is the same shape phase 3 has: the factory guarantees the
 * services are identical, and each process supplies the handles it owns.
 */

export interface LoopWiringInput {
  readonly uow: PgUnitOfWork;
  readonly audit: AuditService;
  readonly outbox: OutboxService;
  readonly gate: OutboundGate<Tx>;
  readonly jobCards: JobCardTransitionService<Tx>;
  readonly workItems: WorkItemTransitionService<Tx>;
  readonly storage: StoragePort;
  readonly llm: LlmPort;
  readonly speech: SpeechPort;
  readonly tasks: AdvisorTaskCreator;
  readonly env: Env;
}

export function createLoopStores(input: LoopWiringInput): LoopRuntimeInput<Tx> {
  const { uow, storage } = input;

  return {
    stores: {
      uow,
      eta: new PgEtaStore(),
      signals: new PgStatusSignalStore(),
      resolver: new PgCardResolver(),
      bays: new PgSilentBayStore(),
      comms: new PgStatusCommsStore(),
      bookings: new PgDeliveryBookingStore(),
      invoices: new PgInvoiceStore(),
      payments: new PgPaymentStore(),
      passes: new PgGatePassStore(),
      cards: new PgJobCardContextReader(),
      conversations: new PgConversationStore(),
      directory: new PgShopDirectory(),
      config: new PgShopConfigStore(),
      audit: input.audit,
      outbox: input.outbox,
    },
    gate: input.gate,
    jobCards: input.jobCards,
    workItems: input.workItems,
    payments: createPaymentsPort(input.env),
    renderer: new ReactPdfInvoiceRenderer(),
    qr: new QrPngRenderer(),
    media: new PgGeneratedMediaWriter(storage, (work) => uow.transaction(work)),
    // A sandboxed LLM cannot read a technician's Tamil, so a sandboxed
    // deployment gets the deterministic parser rather than an echo dressed up
    // as an extraction.
    parser:
      input.llm.driver === 'anthropic'
        ? new LlmStatusSignalParser(input.llm, { fallbackToHeuristic: true })
        : new HeuristicStatusSignalParser(),
    speech: input.speech,
    gatePassSecret: () => input.env.GATE_PASS_SECRET,
    amountDue,
    customerPhone,
    loadThumbnails: (tx, shopId, mediaIds) => loadThumbnails(storage, tx, shopId, mediaIds),
    tasks: input.tasks,
  };
}

/**
 * Shops the sentinels scan.
 *
 * Read per pass rather than cached at boot: a shop deactivated at lunchtime
 * must stop being nudged that afternoon, not after the next deploy.
 */
export async function listActiveShopIds(db: Database): Promise<readonly string[]> {
  const result = await db.execute<{ id: string }>(sql`
    select id from shops where is_active = true and deleted_at is null order by created_at asc
  `);
  return result.rows.map((row) => row.id);
}

/**
 * What the customer owes: the invoice total once one exists, else the accepted
 * estimate, minus whatever has already been paid.
 */
async function amountDue(tx: Tx, shopId: string, jobCardId: string): Promise<number> {
  const invoice = await tx.execute<{
    total_paise: string | number;
    amount_paid_paise: string | number;
  }>(sql`
    select total_paise, amount_paid_paise
    from invoices
    where shop_id = ${shopId} and job_card_id = ${jobCardId}
    limit 1
  `);

  const row = invoice.rows[0];
  if (row !== undefined) {
    return Math.max(0, Number(row.total_paise) - Number(row.amount_paid_paise));
  }

  const estimate = await tx.execute<{ total_paise: string | number }>(sql`
    select total_paise
    from estimates
    where shop_id = ${shopId} and job_card_id = ${jobCardId} and status in ('ACCEPTED', 'SENT')
    order by version desc
    limit 1
  `);

  return Number(estimate.rows[0]?.total_paise ?? 0);
}

/** Decrypted here, so the key never goes near the database. */
async function customerPhone(tx: Tx, shopId: string, customerId: string): Promise<string | null> {
  const result = await tx.execute<{ phone_encrypted: string }>(sql`
    select phone_encrypted from customers where shop_id = ${shopId} and id = ${customerId}
  `);
  const encrypted = result.rows[0]?.phone_encrypted;
  return encrypted === undefined ? null : decryptPii(encrypted);
}

/**
 * Thumbnails for the invoice appendix.
 *
 * An erased object resolves to `null` rather than failing the render: the
 * appendix prints a labelled placeholder, so the document cannot disagree with
 * itself about how many things were photographed.
 */
async function loadThumbnails(
  storage: StoragePort,
  tx: Tx,
  shopId: string,
  mediaIds: readonly string[],
): Promise<ReadonlyMap<string, Buffer | null>> {
  const thumbnails = new Map<string, Buffer | null>();
  if (mediaIds.length === 0) return thumbnails;

  const result = await tx.execute<{
    id: string;
    thumbnail_key: string | null;
    storage_key: string;
  }>(sql`
    select id, thumbnail_key, storage_key
    from media_assets
    where shop_id = ${shopId}
      and deleted_at is null
      and id = any(${sql.raw(`ARRAY['${mediaIds.join("','")}']::uuid[]`)})
  `);

  for (const row of result.rows) {
    try {
      const object = await storage.get(row.thumbnail_key ?? row.storage_key);
      thumbnails.set(row.id, object.body);
    } catch {
      thumbnails.set(row.id, null);
    }
  }

  return thumbnails;
}
