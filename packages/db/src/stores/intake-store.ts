import type {
  CreateEstimateLineInput,
  CreateJobCardInput,
  CreateWorkItemInput,
  CustomerMatch,
  DraftRecord,
  DraftStore,
  EntityLookup,
  InsertDraftInput,
  JobCardWriter,
  VehicleMatch,
} from '@serviceloop/domain';
import {
  JobCardDraftSchema,
  lineTotal,
  type DraftCorrection,
  type IntakeDraftStatus,
} from '@serviceloop/shared';
import { and, asc, eq, like, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { blindIndex } from '../crypto/pii';
import { customers, estimateLines, estimates, jobCards, vehicles, workItems } from '../schema';
import { jobCardDrafts, mergeSuggestions } from '../schema/intake';

/**
 * Postgres implementations of the zero-migration intake ports (phase 2.5–2.8).
 *
 * Three separate concerns live here because the domain keeps them separate:
 * storing an inert draft, writing the rows a confirmed draft becomes, and
 * looking entities up so those rows attach to the right customer and vehicle.
 */

/* -------------------------------------------------------------------------- *
 * Drafts
 * -------------------------------------------------------------------------- */

/** `tx.execute` types its rows as a record, so the shape is declared as one. */
interface DraftRow extends Record<string, unknown> {
  readonly id: string;
  readonly shop_id: string;
  readonly source: DraftRecord['source'];
  readonly status: IntakeDraftStatus;
  readonly conversation_id: string | null;
  readonly message_id: string | null;
  readonly media_id: string | null;
  readonly submitted_by_staff_id: string | null;
  readonly raw_input: string | null;
  readonly draft: unknown;
  readonly corrections: unknown;
  readonly confidence_milli: number;
  readonly low_confidence_fields: unknown;
  readonly extractor_model: string | null;
  readonly job_card_id: string | null;
  readonly created_at: Date;
}

function toDraftRecord(row: DraftRow): DraftRecord {
  return {
    id: row.id,
    shopId: row.shop_id,
    source: row.source,
    status: row.status,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    mediaId: row.media_id,
    submittedByStaffId: row.submitted_by_staff_id,
    rawInput: row.raw_input,
    // Re-validated on the way out. A draft document that has drifted from the
    // schema — an older row, a bad manual edit — must fail here rather than in
    // the middle of confirming it into a job card.
    draft: JobCardDraftSchema.parse(row.draft),
    corrections: (row.corrections ?? []) as readonly DraftCorrection[],
    confidenceMilli: Number(row.confidence_milli),
    lowConfidenceFields: (row.low_confidence_fields ?? []) as readonly string[],
    extractorModel: row.extractor_model,
    jobCardId: row.job_card_id,
    createdAt: row.created_at,
  };
}

const DRAFT_COLUMNS = sql`
  id, shop_id, source, status, conversation_id, message_id, media_id,
  submitted_by_staff_id, raw_input, draft, corrections, confidence_milli,
  low_confidence_fields, extractor_model, job_card_id, created_at
`;

export class PgDraftStore implements DraftStore<Tx> {
  async insert(tx: Tx, input: InsertDraftInput): Promise<void> {
    await tx.insert(jobCardDrafts).values({
      id: input.id,
      shopId: input.shopId,
      source: input.source,
      status: 'AWAITING_CONFIRMATION',
      conversationId: input.conversationId,
      messageId: input.messageId,
      mediaId: input.mediaId,
      submittedByStaffId: input.submittedByStaffId,
      rawInput: input.rawInput,
      draft: input.draft,
      corrections: [],
      confidenceMilli: input.confidenceMilli,
      lowConfidenceFields: [...input.lowConfidenceFields],
      extractorModel: input.extractorModel,
      extractorPromptHash: input.extractorPromptHash,
      extractionMs: input.extractionMs,
      createdAt: input.createdAt,
    });
  }

  async load(tx: Tx, shopId: string, draftId: string): Promise<DraftRecord | null> {
    const result = await tx.execute<DraftRow>(sql`
      select ${DRAFT_COLUMNS} from job_card_drafts
      where id = ${draftId} and shop_id = ${shopId}
    `);
    const row = result.rows[0];
    return row === undefined ? null : toDraftRecord(row);
  }

  /**
   * Locks the draft. Two advisors tapping Confirm on the same photo at the
   * same moment is not hypothetical — the card is on a shared WhatsApp group —
   * and without this both taps would create a job card.
   */
  async lock(tx: Tx, shopId: string, draftId: string): Promise<DraftRecord | null> {
    const result = await tx.execute<DraftRow>(sql`
      select ${DRAFT_COLUMNS} from job_card_drafts
      where id = ${draftId} and shop_id = ${shopId}
      for update
    `);
    const row = result.rows[0];
    return row === undefined ? null : toDraftRecord(row);
  }

  async findOpenForConversation(
    tx: Tx,
    shopId: string,
    conversationId: string,
  ): Promise<DraftRecord | null> {
    // Newest first: a correction always refers to the draft the thread is
    // currently looking at.
    const result = await tx.execute<DraftRow>(sql`
      select ${DRAFT_COLUMNS} from job_card_drafts
      where shop_id = ${shopId}
        and conversation_id = ${conversationId}
        and status = 'AWAITING_CONFIRMATION'
      order by created_at desc
      limit 1
    `);
    const row = result.rows[0];
    return row === undefined ? null : toDraftRecord(row);
  }

  async update(
    tx: Tx,
    input: {
      readonly shopId: string;
      readonly draftId: string;
      readonly draft: DraftRecord['draft'];
      readonly corrections: readonly DraftCorrection[];
      readonly confidenceMilli: number;
      readonly lowConfidenceFields: readonly string[];
    },
  ): Promise<void> {
    await tx
      .update(jobCardDrafts)
      .set({
        draft: input.draft,
        corrections: [...input.corrections],
        confidenceMilli: input.confidenceMilli,
        lowConfidenceFields: [...input.lowConfidenceFields],
      })
      .where(
        and(eq(jobCardDrafts.id, input.draftId), eq(jobCardDrafts.shopId, input.shopId)),
      );
  }

  async settle(
    tx: Tx,
    input: {
      readonly shopId: string;
      readonly draftId: string;
      readonly status: IntakeDraftStatus;
      readonly jobCardId: string | null;
      readonly resolvedCustomerId: string | null;
      readonly resolvedVehicleId: string | null;
      readonly failureReason: string | null;
      readonly at: Date;
    },
  ): Promise<void> {
    await tx
      .update(jobCardDrafts)
      .set({
        status: input.status,
        jobCardId: input.jobCardId,
        resolvedCustomerId: input.resolvedCustomerId,
        resolvedVehicleId: input.resolvedVehicleId,
        failureReason: input.failureReason,
        confirmedAt: input.status === 'CONFIRMED' ? input.at : null,
        discardedAt: input.status === 'DISCARDED' ? input.at : null,
      })
      .where(and(eq(jobCardDrafts.id, input.draftId), eq(jobCardDrafts.shopId, input.shopId)));
  }
}

/* -------------------------------------------------------------------------- *
 * Job-card writing
 * -------------------------------------------------------------------------- */

export class PgJobCardWriter implements JobCardWriter<Tx> {
  /**
   * `JC-YYYY-NNNN`, allocated inside the caller's transaction.
   *
   * The counter is derived from the highest existing code for the year rather
   * than from a sequence, so a shop's numbering stays contiguous and readable
   * even after a rollback — the number goes on paperwork a customer keeps.
   * The advisory lock serialises allocation without blocking anything else.
   */
  async nextJobCardCode(tx: Tx, shopId: string, at: Date): Promise<string> {
    const year = at.getUTCFullYear();
    const prefix = `JC-${year}-`;

    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`jobcard-code:${shopId}:${year}`}))`);

    const result = await tx.execute<{ code: string }>(sql`
      select code from job_cards
      where shop_id = ${shopId} and code like ${`${prefix}%`}
      order by code desc
      limit 1
    `);

    const previous = result.rows[0]?.code;
    const sequence =
      previous === undefined ? 1 : Number.parseInt(previous.slice(prefix.length), 10) + 1;

    return `${prefix}${String(Number.isFinite(sequence) ? sequence : 1).padStart(4, '0')}`;
  }

  async createJobCard(tx: Tx, input: CreateJobCardInput): Promise<void> {
    await tx.insert(jobCards).values({
      id: input.id,
      shopId: input.shopId,
      customerId: input.customerId,
      vehicleId: input.vehicleId,
      code: input.code,
      // Created in DRAFT. `JobCardTransitionService` opens it, so the audit
      // chain records an OPEN_CARD transition instead of a row that simply
      // appeared already open.
      state: 'DRAFT',
      source: input.source,
      complaintText: input.complaintText,
      odometerKm: input.odometerKm,
      promisedAt: input.promisedAt,
      assignedAdvisorId: input.assignedAdvisorId,
    });
  }

  async createWorkItems(tx: Tx, items: readonly CreateWorkItemInput[]): Promise<void> {
    if (items.length === 0) return;
    await tx.insert(workItems).values(
      items.map((item) => ({
        id: item.id,
        shopId: item.shopId,
        jobCardId: item.jobCardId,
        title: item.title,
        description: item.description,
        state: 'PROPOSED' as const,
        sequence: item.sequence,
      })),
    );
  }

  async createEstimate(
    tx: Tx,
    input: {
      readonly id: string;
      readonly shopId: string;
      readonly jobCardId: string;
      readonly version: number;
      readonly lines: readonly CreateEstimateLineInput[];
      readonly createdById: string | null;
    },
  ): Promise<void> {
    const totals = input.lines.map((line) => lineTotal(line.quantityMilli, line.unitPricePaise));
    const subtotal = totals.reduce((sum, value) => sum + value, 0);

    await tx.insert(estimates).values({
      id: input.id,
      shopId: input.shopId,
      jobCardId: input.jobCardId,
      version: input.version,
      status: 'DRAFT',
      subtotalPaise: subtotal,
      // Tax is computed when the estimate is priced for the customer (phase 3);
      // an intake draft carries the shop's own line amounts, nothing more.
      taxPaise: 0,
      totalPaise: subtotal,
      createdById: input.createdById,
    });

    if (input.lines.length === 0) return;

    await tx.insert(estimateLines).values(
      input.lines.map((line, index) => ({
        shopId: input.shopId,
        estimateId: input.id,
        workItemId: line.workItemId,
        kind: line.kind,
        description: line.description,
        quantityMilli: line.quantityMilli,
        unitPricePaise: line.unitPricePaise,
        lineTotalPaise: totals[index] ?? 0,
        sequence: index,
      })),
    );
  }
}

/* -------------------------------------------------------------------------- *
 * Entity lookup
 * -------------------------------------------------------------------------- */

export class PgEntityLookup implements EntityLookup<Tx> {
  async findVehicleByRegistration(
    tx: Tx,
    shopId: string,
    registrationNormalised: string,
  ): Promise<VehicleMatch | null> {
    const rows = await tx
      .select({
        id: vehicles.id,
        customerId: vehicles.customerId,
        registrationNormalised: vehicles.registrationNormalised,
        make: vehicles.make,
        model: vehicles.model,
      })
      .from(vehicles)
      .where(
        and(
          eq(vehicles.shopId, shopId),
          eq(vehicles.registrationNormalised, registrationNormalised),
          sql`${vehicles.deletedAt} is null`,
        ),
      )
      .limit(1);

    return rows[0] ?? null;
  }

  async findVehiclesByRegistrationPrefix(
    tx: Tx,
    shopId: string,
    prefix: string,
    limit: number,
  ): Promise<readonly VehicleMatch[]> {
    if (prefix.length === 0) return [];

    return tx
      .select({
        id: vehicles.id,
        customerId: vehicles.customerId,
        registrationNormalised: vehicles.registrationNormalised,
        make: vehicles.make,
        model: vehicles.model,
      })
      .from(vehicles)
      .where(
        and(
          eq(vehicles.shopId, shopId),
          like(vehicles.registrationNormalised, `${prefix}%`),
          sql`${vehicles.deletedAt} is null`,
        ),
      )
      .orderBy(asc(vehicles.registrationNormalised))
      .limit(limit);
  }

  /**
   * Phone lookup goes through the blind index, never the encrypted column:
   * the ciphertext is non-deterministic by design, so the HMAC is the only
   * searchable form. It is shop-scoped, which is also why one person known to
   * two shops cannot be correlated across them from the database alone.
   */
  async findCustomerByPhone(
    tx: Tx,
    shopId: string,
    phoneE164: string,
  ): Promise<CustomerMatch | null> {
    const rows = await tx
      .select({
        id: customers.id,
        fullName: customers.fullNameEncrypted,
        preferredLanguage: customers.preferredLanguage,
      })
      .from(customers)
      .where(
        and(
          eq(customers.shopId, shopId),
          eq(customers.phoneHash, blindIndex(shopId, phoneE164)),
          sql`${customers.deletedAt} is null`,
        ),
      )
      .limit(1);

    return rows[0] ?? null;
  }

  async findCustomerById(
    tx: Tx,
    shopId: string,
    customerId: string,
  ): Promise<CustomerMatch | null> {
    const rows = await tx
      .select({
        id: customers.id,
        fullName: customers.fullNameEncrypted,
        preferredLanguage: customers.preferredLanguage,
      })
      .from(customers)
      .where(
        and(
          eq(customers.id, customerId),
          eq(customers.shopId, shopId),
          sql`${customers.deletedAt} is null`,
        ),
      )
      .limit(1);

    return rows[0] ?? null;
  }

  async createCustomer(
    tx: Tx,
    input: {
      readonly id: string;
      readonly shopId: string;
      readonly fullName: string;
      readonly phoneE164: string;
      readonly preferredLanguage: CustomerMatch['preferredLanguage'];
    },
  ): Promise<void> {
    await tx.insert(customers).values({
      id: input.id,
      shopId: input.shopId,
      fullNameEncrypted: input.fullName,
      phoneEncrypted: input.phoneE164,
      phoneHash: blindIndex(input.shopId, input.phoneE164),
      preferredLanguage: input.preferredLanguage,
    });
  }

  async createVehicle(
    tx: Tx,
    input: {
      readonly id: string;
      readonly shopId: string;
      readonly customerId: string;
      readonly registrationRaw: string;
      readonly registrationNormalised: string;
      readonly make: string | null;
      readonly model: string | null;
      readonly odometerKm: number | null;
    },
  ): Promise<void> {
    await tx.insert(vehicles).values({
      id: input.id,
      shopId: input.shopId,
      customerId: input.customerId,
      registrationRaw: input.registrationRaw,
      registrationNormalised: input.registrationNormalised,
      make: input.make,
      model: input.model,
      odometerKm: input.odometerKm,
    });
  }

  /**
   * Records a suggestion, and reports whether it was new.
   *
   * The unique index on (shop, kind, primary, candidate) makes a re-suggestion
   * a no-op rather than a growing pile of identical rows in the advisor's
   * queue — the same near-miss will be detected on every intake for that
   * vehicle until someone resolves it.
   */
  async recordMergeSuggestion(
    tx: Tx,
    input: {
      readonly id: string;
      readonly shopId: string;
      readonly kind: 'CUSTOMER' | 'VEHICLE';
      readonly primaryEntityId: string;
      readonly candidateEntityId: string;
      readonly reason: string;
      readonly scoreMilli: number;
      readonly context: Readonly<Record<string, unknown>>;
      readonly draftId: string | null;
    },
  ): Promise<boolean> {
    const inserted = await tx
      .insert(mergeSuggestions)
      .values({
        id: input.id,
        shopId: input.shopId,
        kind: input.kind,
        status: 'OPEN',
        primaryEntityId: input.primaryEntityId,
        candidateEntityId: input.candidateEntityId,
        reason: input.reason,
        scoreMilli: input.scoreMilli,
        context: input.context,
        draftId: input.draftId,
      })
      .onConflictDoNothing()
      .returning({ id: mergeSuggestions.id });

    return inserted.length > 0;
  }
}
