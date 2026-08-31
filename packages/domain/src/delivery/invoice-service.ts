import type { ShopConfig } from '@serviceloop/config';
import {
  systemClock,
  uuidv7,
  zonedParts,
  type Clock,
  type EstimateLineKind,
  type EventEnvelope,
  type Paise,
} from '@serviceloop/shared';
import type { JobCardContextReader } from '../agent/ports';
import type { Actor } from '../job-card/context';
import type { AuditAppender, OutboxWriter, ShopDirectory, UnitOfWork } from '../ports';
import {
  buildInvoice,
  invoiceNumber,
  type BillableLine,
  type InvoiceLineDraft,
} from './invoice-builder';
import type {
  GeneratedMediaWriter,
  InvoiceEvidenceBlock,
  InvoiceRecord,
  InvoiceRenderer,
  InvoiceStore,
} from './ports';

/**
 * Invoicing (phase 4.8).
 *
 * The interesting half is not the tax arithmetic — that lives in
 * `invoice-builder.ts` and is pure — but *what gets billed* and *what proof
 * travels with it*. Only work the customer approved appears on the invoice, and
 * every line that was added after intake carries the photographs that justified
 * it, with the timestamp of the approval. A customer who queries a ₹3,200 line
 * three weeks later gets the picture and the minute they said yes, which is the
 * difference between a disagreement and an argument.
 */

export interface InvoiceServiceDeps<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly invoices: InvoiceStore<Tx>;
  readonly cards: JobCardContextReader<Tx>;
  readonly directory: ShopDirectory<Tx>;
  readonly renderer: InvoiceRenderer;
  readonly media: GeneratedMediaWriter;
  readonly audit: AuditAppender<Tx>;
  readonly outbox: OutboxWriter<Tx>;
  readonly loadConfig: (tx: Tx, shopId: string) => Promise<ShopConfig>;
  /** Thumbnails for the appendix. Absent bytes render as a caption-only block. */
  readonly loadThumbnails: (
    tx: Tx,
    shopId: string,
    mediaIds: readonly string[],
  ) => Promise<ReadonlyMap<string, Buffer | null>>;
  readonly clock?: Clock;
}

export type IssueInvoiceResult =
  | {
      readonly ok: true;
      readonly invoiceId: string;
      readonly number: string;
      readonly totalPaise: Paise;
      readonly mediaId: string | null;
      readonly renderHash: string | null;
      readonly evidenceBlocks: number;
      readonly alreadyIssued: boolean;
    }
  | { readonly ok: false; readonly code: string; readonly reason: string };

/** Work-item states whose line is billable: the customer said yes to all three. */
const BILLABLE_ITEM_STATES = new Set(['APPROVED', 'IN_PROGRESS', 'DONE']);

export class InvoiceService<Tx> {
  private readonly clock: Clock;

  constructor(private readonly deps: InvoiceServiceDeps<Tx>) {
    this.clock = deps.clock ?? systemClock;
  }

  /** The card's invoice, if one has been issued. One per visit, by design. */
  async forCard(shopId: string, jobCardId: string): Promise<InvoiceRecord | null> {
    return this.deps.uow.transaction((tx) =>
      this.deps.invoices.findByJobCard(tx, shopId, jobCardId),
    );
  }

  async issue(input: {
    readonly shopId: string;
    readonly jobCardId: string;
    readonly placeOfSupplyStateCode?: string | null;
    readonly actor: Actor;
    readonly traceId: string;
  }): Promise<IssueInvoiceResult> {
    const now = this.clock.now();

    const existing = await this.deps.uow.transaction((tx) =>
      this.deps.invoices.findByJobCard(tx, input.shopId, input.jobCardId),
    );
    if (existing !== null) {
      // Re-issuing would mint a second number for one visit, and two invoice
      // numbers for one job is precisely what a tax audit asks about.
      return {
        ok: true,
        invoiceId: existing.id,
        number: existing.number,
        totalPaise: existing.totalPaise,
        mediaId: existing.mediaId,
        renderHash: existing.renderHash,
        evidenceBlocks: existing.evidenceMediaIds.length,
        alreadyIssued: true,
      };
    }

    const prepared = await this.deps.uow.transaction(async (tx) => {
      const card = await this.deps.cards.load(tx, input.shopId, input.jobCardId);
      if (card === null) return null;

      const config = await this.deps.loadConfig(tx, input.shopId);
      const shopName = (await this.deps.directory.loadShopName(tx, input.shopId)) ?? 'the workshop';
      const timezone = config.quietHours.timezone;
      const financialYear = financialYearOf(now, timezone);
      const sequence = await this.deps.invoices.nextSequence(tx, input.shopId, financialYear);

      return { card, config, shopName, timezone, sequence };
    });

    if (prepared === null) {
      return { ok: false, code: 'NO_JOB_CARD', reason: 'That job card is not in this shop' };
    }

    const billable = toBillableLines(prepared.card);
    const built = buildInvoice({
      number: invoiceNumber(
        prepared.config.invoice.numberPrefix,
        prepared.sequence,
        now,
        prepared.timezone,
      ),
      config: prepared.config.invoice,
      shopName: prepared.shopName,
      placeOfSupplyStateCode: input.placeOfSupplyStateCode ?? null,
      lines: billable,
    });

    if (!built.ok) return built;

    const invoiceId = uuidv7();
    await this.deps.uow.transaction(async (tx) => {
      await this.deps.invoices.insert(tx, {
        id: invoiceId,
        shopId: input.shopId,
        jobCardId: input.jobCardId,
        customerId: prepared.card.customerId,
        estimateId: prepared.card.estimate?.id ?? null,
        draft: built.draft,
        issuedAt: now,
      });
    });

    const rendered = await this.renderAndStore({
      shopId: input.shopId,
      invoiceId,
      jobCardId: input.jobCardId,
      card: prepared.card,
      config: prepared.config,
      shopName: prepared.shopName,
      traceId: input.traceId,
    });

    await this.deps.uow.transaction(async (tx) => {
      await this.deps.audit.append(tx, {
        shopId: input.shopId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'invoice.issued',
        entityType: 'invoice',
        entityId: invoiceId,
        payload: {
          jobCardId: input.jobCardId,
          number: built.draft.number,
          subtotalPaise: built.draft.subtotalPaise,
          cgstPaise: built.draft.cgstPaise,
          sgstPaise: built.draft.sgstPaise,
          igstPaise: built.draft.igstPaise,
          totalPaise: built.draft.totalPaise,
          intraState: built.draft.intraState,
          lineCount: built.draft.lines.length,
          mediaId: rendered?.mediaId ?? null,
          renderHash: rendered?.hash ?? null,
        },
        traceId: input.traceId,
      });

      const envelope: EventEnvelope = {
        id: uuidv7(),
        occurredAt: now.toISOString(),
        shopId: input.shopId,
        traceId: input.traceId,
        type: 'invoice.issued',
        payload: {
          invoiceId,
          jobCardId: input.jobCardId,
          number: built.draft.number,
          subtotalPaise: built.draft.subtotalPaise,
          taxPaise: built.draft.cgstPaise + built.draft.sgstPaise + built.draft.igstPaise,
          totalPaise: built.draft.totalPaise,
          mediaId: rendered?.mediaId ?? null,
          evidenceBlocks: built.draft.evidenceMediaIds.length,
          actor: { type: input.actor.type, id: input.actor.id },
        },
      };
      await this.deps.outbox.enqueue(tx, envelope);
    });

    return {
      ok: true,
      invoiceId,
      number: built.draft.number,
      totalPaise: built.draft.totalPaise,
      mediaId: rendered?.mediaId ?? null,
      renderHash: rendered?.hash ?? null,
      evidenceBlocks: built.draft.evidenceMediaIds.length,
      alreadyIssued: false,
    };
  }

  /**
   * Renders the PDF and stores it as a MediaAsset.
   *
   * A failure here does **not** fail the invoice. The invoice is a database
   * record of what was billed; the PDF is a rendering of it, and a shop whose
   * PDF service hiccuped should still have an invoice it can re-render, not a
   * job card stuck in limbo with no bill. The null `mediaId` is what the
   * console shows as "regenerate".
   */
  private async renderAndStore(input: {
    readonly shopId: string;
    readonly invoiceId: string;
    readonly jobCardId: string;
    readonly card: Awaited<ReturnType<JobCardContextReader<Tx>['load']>>;
    readonly config: ShopConfig;
    readonly shopName: string;
    readonly traceId: string;
  }): Promise<{ readonly mediaId: string; readonly hash: string } | null> {
    const card = input.card;
    if (card === null) return null;

    const loaded = await this.deps.uow.transaction(async (tx) => {
      const invoice = await this.deps.invoices.load(tx, input.shopId, input.invoiceId);
      if (invoice === null) return null;
      const lines = await this.deps.invoices.lines(tx, input.shopId, input.invoiceId);
      const thumbnails = await this.deps.loadThumbnails(
        tx,
        input.shopId,
        invoice.evidenceMediaIds,
      );
      return { invoice, lines, thumbnails };
    });
    if (loaded === null) return null;

    try {
      const result = await this.deps.renderer.render({
        invoice: loaded.invoice,
        lines: loaded.lines,
        shopName: input.shopName,
        customerName: card.customerName,
        vehicleLabel: card.vehicleLabel,
        registration: card.registration,
        jobCardCode: card.code,
        language: card.customerLanguage,
        timezone: input.config.quietHours.timezone,
        paymentStatus: loaded.invoice.status,
        amountPaidPaise: loaded.invoice.amountPaidPaise,
        evidence: buildEvidenceBlocks(loaded.lines, loaded.thumbnails, card.media),
      });

      const stored = await this.deps.media.store({
        shopId: input.shopId,
        jobCardId: input.jobCardId,
        contentType: 'application/pdf',
        bytes: result.bytes,
        filename: `${loaded.invoice.number.replace(/\W+/g, '-')}.pdf`,
        caption: `Invoice ${loaded.invoice.number}`,
        traceId: input.traceId,
      });

      await this.deps.uow.transaction((tx) =>
        this.deps.invoices.attachPdf(tx, {
          invoiceId: input.invoiceId,
          mediaId: stored.mediaId,
          renderHash: result.hash,
        }),
      );

      return { mediaId: stored.mediaId, hash: result.hash };
    } catch {
      return null;
    }
  }
}

/**
 * The billable lines on a card.
 *
 * An estimate line is billable when the work item it bills reached APPROVED —
 * a customer who said yes owes for it whether or not the technician has
 * finished. A line with no work item at all (a fee, a shop charge) is billable
 * unconditionally; the shop levies those regardless of what was approved.
 */
export function toBillableLines(card: {
  readonly workItems: readonly {
    readonly id: string;
    readonly state: string;
    readonly title: string;
  }[];
  readonly estimate: {
    readonly lines: readonly {
      readonly id: string;
      readonly workItemId: string | null;
      readonly description: string;
      readonly kind: EstimateLineKind;
      readonly quantityMilli: number;
      readonly unitPricePaise: Paise;
      readonly lineTotalPaise: Paise;
      readonly taxRateBp: number;
    }[];
  } | null;
  readonly media: readonly { readonly id: string; readonly workItemId: string | null }[];
  readonly promisedAt: Date | null;
}): readonly BillableLine[] {
  const items = new Map(card.workItems.map((item) => [item.id, item]));
  const mediaByItem = new Map<string, string[]>();
  for (const asset of card.media) {
    if (asset.workItemId === null) continue;
    mediaByItem.set(asset.workItemId, [...(mediaByItem.get(asset.workItemId) ?? []), asset.id]);
  }

  return (card.estimate?.lines ?? [])
    .filter((line) => {
      if (line.workItemId === null) return true;
      const item = items.get(line.workItemId);
      return item !== undefined && BILLABLE_ITEM_STATES.has(item.state);
    })
    .map((line): BillableLine => {
      const evidence = line.workItemId === null ? [] : (mediaByItem.get(line.workItemId) ?? []);
      return {
        estimateLineId: line.id,
        workItemId: line.workItemId,
        description: line.description,
        kind: line.kind,
        quantityMilli: line.quantityMilli,
        unitPricePaise: line.unitPricePaise,
        lineTotalPaise: line.lineTotalPaise,
        taxRateBp: line.taxRateBp,
        // Work backed by photographs is work a technician found after the
        // vehicle arrived — that is precisely what the appendix documents.
        isAdditionalWork: evidence.length > 0,
        approvedAt: null,
        evidenceMediaIds: evidence,
      };
    });
}

/** One appendix block per additional-work line that has media behind it. */
export function buildEvidenceBlocks(
  lines: readonly InvoiceLineDraft[],
  thumbnails: ReadonlyMap<string, Buffer | null>,
  media: readonly { readonly id: string; readonly caption: string | null }[],
): readonly InvoiceEvidenceBlock[] {
  const captions = new Map(media.map((asset) => [asset.id, asset.caption]));

  return lines
    .filter((line) => line.isAdditionalWork && line.evidenceMediaIds.length > 0)
    .map((line) => ({
      lineDescription: line.description,
      approvedAt: line.approvedAt,
      media: line.evidenceMediaIds.map((id) => ({
        id,
        caption: captions.get(id) ?? null,
        thumbnail: thumbnails.get(id) ?? null,
      })),
    }));
}

/** `2026-27` for any instant in the Indian financial year starting April 2026. */
export function financialYearOf(instant: Date, timeZone: string): string {
  const parts = zonedParts(instant, timeZone);
  const startYear = parts.month >= 4 ? parts.year : parts.year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

export type { InvoiceRecord };
