import { forwardRef, Module } from '@nestjs/common';
import {
  createLoopRuntime,
  type AgentRuntime,
  type LoopRuntime,
} from '@serviceloop/agent-core';
import {
  createPaymentsPort,
  HeuristicStatusSignalParser,
  LlmStatusSignalParser,
  QrPngRenderer,
  ReactPdfInvoiceRenderer,
  type ChannelPorts,
  type StoragePort,
} from '@serviceloop/adapters';
import { getEnv } from '@serviceloop/config';
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
  type AuditService,
  type Database,
  type OutboxService,
  type PgUnitOfWork,
  type Tx,
} from '@serviceloop/db';
import type {
  JobCardTransitionService,
  OutboundGate,
  WorkItemTransitionService,
} from '@serviceloop/domain';
import { sql } from 'drizzle-orm';
import {
  AGENT_RUNTIME,
  AUDIT_SERVICE,
  CHANNEL_PORTS,
  DATABASE,
  JOB_CARD_TRANSITION_SERVICE,
  LOOP_RUNTIME,
  OUTBOUND_GATE,
  OUTBOX_SERVICE,
  STORAGE,
  UNIT_OF_WORK,
  WORK_ITEM_TRANSITION_SERVICE,
} from '../infra/tokens';
import { MessagingModule } from '../messaging/messaging.module';
import { DeliveryController } from './delivery.controller';
import { GatePassController } from './gate-pass.controller';
import { PaymentsWebhookController } from './payments.controller';
import { StatusController } from './status.controller';

/**
 * The middle and the end of the loop (phase 4).
 *
 * Named for master L1: the unit of value is a closed loop — approval obtained,
 * status delivered, payment collected — and this module owns the second half of
 * it. Phase 3's `MessagingModule` owns the first.
 *
 * It imports `MessagingModule` for one thing above all: `OutboundGate`. There
 * is exactly one gate in the process, and two would be two opinions about
 * whether a message may leave.
 */
@Module({
  imports: [forwardRef(() => MessagingModule)],
  controllers: [
    StatusController,
    DeliveryController,
    PaymentsWebhookController,
    GatePassController,
  ],
  providers: [
    {
      provide: LOOP_RUNTIME,
      useFactory: (
        db: Database,
        uow: PgUnitOfWork,
        audit: AuditService,
        outbox: OutboxService,
        gate: OutboundGate<Tx>,
        jobCards: JobCardTransitionService<Tx>,
        workItems: WorkItemTransitionService<Tx>,
        ports: ChannelPorts,
        storage: StoragePort,
        agent: AgentRuntime<Tx>,
      ): LoopRuntime<Tx> => {
        const env = getEnv();

        return createLoopRuntime<Tx>({
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
            audit,
            outbox,
          },
          gate,
          jobCards,
          workItems,
          payments: createPaymentsPort(env),
          renderer: new ReactPdfInvoiceRenderer(),
          qr: new QrPngRenderer(),
          media: new PgGeneratedMediaWriter(storage, (work) => uow.transaction(work)),
          // The sandbox LLM cannot parse a technician's Tamil, so a sandboxed
          // deployment gets the deterministic parser rather than an echo
          // dressed up as an extraction — the same choice the explanation
          // writer makes in `createAgentRuntime`.
          parser:
            ports.llm.driver === 'anthropic'
              ? new LlmStatusSignalParser(ports.llm, { fallbackToHeuristic: true })
              : new HeuristicStatusSignalParser(),
          speech: ports.speech,
          gatePassSecret: () => env.GATE_PASS_SECRET,
          amountDue: (tx, shopId, jobCardId) => amountDue(tx, shopId, jobCardId),
          customerPhone: (tx, shopId, customerId) => customerPhone(tx, shopId, customerId),
          loadThumbnails: (tx, shopId, mediaIds) => loadThumbnails(storage, tx, shopId, mediaIds),
          // The balance ladder ends in a person (L6).
          tasks: agent.tasks,
        });
      },
      inject: [
        DATABASE,
        UNIT_OF_WORK,
        AUDIT_SERVICE,
        OUTBOX_SERVICE,
        OUTBOUND_GATE,
        JOB_CARD_TRANSITION_SERVICE,
        WORK_ITEM_TRANSITION_SERVICE,
        CHANNEL_PORTS,
        STORAGE,
        AGENT_RUNTIME,
      ],
    },
  ],
  exports: [LOOP_RUNTIME],
})
export class LoopModule {}

/* ---------------------------------------------------------------- reads -- */

/**
 * What the customer owes.
 *
 * The invoice total once one exists, because that is the document they were
 * given; the accepted estimate before then. Minus whatever has already been
 * paid, so a part payment at the counter is reflected in the ready message
 * rather than the customer being asked for the whole amount again.
 */
async function amountDue(tx: Tx, shopId: string, jobCardId: string): Promise<number> {
  const invoice = await tx.execute<{ total_paise: string | number; amount_paid_paise: string | number }>(sql`
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

/**
 * The customer's phone, for the provider's own record.
 *
 * Decrypted here rather than in the query: the column is AES-GCM at rest and
 * the key never goes near the database. Razorpay is told the number so its
 * dashboard is reconcilable by a human, not so it can message anybody — the
 * adapter switches provider notifications off.
 */
async function customerPhone(tx: Tx, shopId: string, customerId: string): Promise<string | null> {
  const { decryptPii } = await import('@serviceloop/db');
  const result = await tx.execute<{ phone_encrypted: string }>(sql`
    select phone_encrypted from customers where shop_id = ${shopId} and id = ${customerId}
  `);

  const encrypted = result.rows[0]?.phone_encrypted;
  return encrypted === undefined ? null : decryptPii(encrypted);
}

/**
 * Thumbnails for the invoice's evidence appendix.
 *
 * A media asset whose object has been erased under DPDP resolves to `null`
 * rather than failing the render: the appendix prints a labelled placeholder,
 * so the document cannot disagree with itself about how many things were
 * photographed.
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
    const key = row.thumbnail_key ?? row.storage_key;
    try {
      const object = await storage.get(key);
      thumbnails.set(row.id, object.body);
    } catch {
      thumbnails.set(row.id, null);
    }
  }

  return thumbnails;
}
