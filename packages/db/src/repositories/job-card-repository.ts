import {
  allowedJobCardEvents,
  evaluateJobCardGuard,
  type JobCardGuardContext,
} from '@serviceloop/domain';
import { migrateShopConfig } from '@serviceloop/config';
import {
  type AuditEntryDto,
  type BoardResponse,
  type EstimateDto,
  formatRegistrationForDisplay,
  JOB_CARD_STATES,
  type JobCardDetail,
  type JobCardSummary,
  maskPhone,
  type WorkItemDto,
} from '@serviceloop/shared';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database, Executor } from '../client';
import {
  auditEvents,
  customers,
  estimateLines,
  estimates,
  jobCards,
  shopConfig,
  shops,
  staff,
  vehicles,
  workItems,
} from '../schema';

/**
 * Read model for the console.
 *
 * Every method takes `shopId` first and filters on it — the multi-tenancy
 * convention (phase 1.8). A card belonging to another shop is simply absent
 * from the result, so the API returns 404 rather than leaking its existence.
 */
export class JobCardRepository {
  constructor(private readonly db: Database) {}

  async listSummaries(shopId: string, executor: Executor = this.db): Promise<JobCardSummary[]> {
    const rows = await executor
      .select({
        card: jobCards,
        customerId: customers.id,
        customerName: customers.fullNameEncrypted,
        customerPhone: customers.phoneEncrypted,
        customerLanguage: customers.preferredLanguage,
        vehicleId: vehicles.id,
        registration: vehicles.registrationNormalised,
        make: vehicles.make,
        model: vehicles.model,
        advisorId: staff.id,
        advisorName: staff.fullName,
      })
      .from(jobCards)
      .innerJoin(customers, eq(customers.id, jobCards.customerId))
      .innerJoin(vehicles, eq(vehicles.id, jobCards.vehicleId))
      .leftJoin(staff, eq(staff.id, jobCards.assignedAdvisorId))
      .where(and(eq(jobCards.shopId, shopId), isNull(jobCards.deletedAt)))
      .orderBy(desc(jobCards.stateChangedAt));

    if (rows.length === 0) return [];

    const cardIds = rows.map((row) => row.card.id);
    const [counts, totals] = await Promise.all([
      this.workItemCounts(shopId, cardIds, executor),
      this.acceptedOrLatestEstimateTotals(shopId, cardIds, executor),
    ]);

    return rows.map((row) => {
      const count = counts.get(row.card.id) ?? { total: 0, pendingApproval: 0, done: 0 };
      return {
        id: row.card.id,
        code: row.card.code,
        state: row.card.state,
        stateChangedAt: row.card.stateChangedAt.toISOString(),
        openedAt: row.card.openedAt?.toISOString() ?? null,
        promisedAt: row.card.promisedAt?.toISOString() ?? null,
        source: row.card.source,
        complaintText: row.card.complaintText,
        customer: {
          id: row.customerId,
          fullName: row.customerName,
          phoneMasked: maskPhone(row.customerPhone),
          preferredLanguage: row.customerLanguage,
        },
        vehicle: {
          id: row.vehicleId,
          registration: row.registration,
          registrationDisplay: formatRegistrationForDisplay(row.registration),
          make: row.make,
          model: row.model,
        },
        advisor:
          row.advisorId === null || row.advisorName === null
            ? null
            : { id: row.advisorId, fullName: row.advisorName },
        workItemCounts: count,
        estimateTotalPaise: totals.get(row.card.id) ?? null,
      };
    });
  }

  /** Board grouped by state, with every column present even when empty. */
  async board(shopId: string, executor: Executor = this.db): Promise<BoardResponse> {
    const summaries = await this.listSummaries(shopId, executor);
    const columns = JOB_CARD_STATES.map((state) => ({
      state,
      cards: summaries.filter((summary) => summary.state === state),
    }));
    return { columns, totalCards: summaries.length };
  }

  async findDetail(
    shopId: string,
    jobCardId: string,
    executor: Executor = this.db,
  ): Promise<JobCardDetail | null> {
    const summaries = await this.listSummaries(shopId, executor);
    const summary = summaries.find((entry) => entry.id === jobCardId);
    if (summary === undefined) return null;

    const [items, estimateDtos, trail, guardContext] = await Promise.all([
      this.workItems(shopId, jobCardId, executor),
      this.estimates(shopId, jobCardId, executor),
      this.auditTrail(shopId, jobCardId, executor),
      this.guardContext(shopId, jobCardId, summary.state, executor),
    ]);

    const allowedEvents = allowedJobCardEvents(summary.state).filter(
      (event) => evaluateJobCardGuard(summary.state, event, guardContext).allowed,
    );

    return {
      ...summary,
      workItems: items,
      estimates: estimateDtos,
      auditTrail: trail,
      allowedEvents,
    };
  }

  async workItems(
    shopId: string,
    jobCardId: string,
    executor: Executor = this.db,
  ): Promise<WorkItemDto[]> {
    const rows = await executor
      .select()
      .from(workItems)
      .where(and(eq(workItems.shopId, shopId), eq(workItems.jobCardId, jobCardId)))
      .orderBy(asc(workItems.sequence));

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      state: row.state,
      requiresApproval: row.requiresApproval,
      technicianNote: row.technicianNote,
      sequence: row.sequence,
      estimatedMinutes: row.estimatedMinutes,
    }));
  }

  async estimates(
    shopId: string,
    jobCardId: string,
    executor: Executor = this.db,
  ): Promise<EstimateDto[]> {
    const estimateRows = await executor
      .select()
      .from(estimates)
      .where(and(eq(estimates.shopId, shopId), eq(estimates.jobCardId, jobCardId)))
      .orderBy(desc(estimates.version));

    if (estimateRows.length === 0) return [];

    const lineRows = await executor
      .select()
      .from(estimateLines)
      .where(
        and(
          eq(estimateLines.shopId, shopId),
          inArray(
            estimateLines.estimateId,
            estimateRows.map((row) => row.id),
          ),
        ),
      )
      .orderBy(asc(estimateLines.sequence));

    return estimateRows.map((estimate) => ({
      id: estimate.id,
      version: estimate.version,
      status: estimate.status,
      subtotalPaise: Number(estimate.subtotalPaise),
      taxPaise: Number(estimate.taxPaise),
      totalPaise: Number(estimate.totalPaise),
      acceptedAt: estimate.acceptedAt?.toISOString() ?? null,
      lines: lineRows
        .filter((line) => line.estimateId === estimate.id)
        .map((line) => ({
          id: line.id,
          description: line.description,
          kind: line.kind,
          quantityMilli: line.quantityMilli,
          unitPricePaise: Number(line.unitPricePaise),
          lineTotalPaise: Number(line.lineTotalPaise),
          workItemId: line.workItemId,
        })),
    }));
  }

  async auditTrail(
    shopId: string,
    jobCardId: string,
    executor: Executor = this.db,
  ): Promise<AuditEntryDto[]> {
    const rows = await executor
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.shopId, shopId), eq(auditEvents.entityId, jobCardId)))
      .orderBy(asc(auditEvents.seq));

    return rows.map((row) => ({
      id: row.id,
      seq: Number(row.seq),
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      actorType: row.actorType,
      actorId: row.actorId,
      payload: (row.payload ?? {}) as Record<string, unknown>,
      hash: row.hash,
      prevHash: row.prevHash,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  private async guardContext(
    shopId: string,
    jobCardId: string,
    state: JobCardSummary['state'],
    executor: Executor,
  ): Promise<JobCardGuardContext> {
    const [items, balance, configRow, shopRow] = await Promise.all([
      executor
        .select({
          id: workItems.id,
          shopId: workItems.shopId,
          jobCardId: workItems.jobCardId,
          state: workItems.state,
          requiresApproval: workItems.requiresApproval,
        })
        .from(workItems)
        .where(and(eq(workItems.shopId, shopId), eq(workItems.jobCardId, jobCardId))),
      executor
        .select({ total: estimates.totalPaise })
        .from(estimates)
        .where(
          and(
            eq(estimates.shopId, shopId),
            eq(estimates.jobCardId, jobCardId),
            eq(estimates.status, 'ACCEPTED'),
          ),
        ),
      executor
        .select({ config: shopConfig.config })
        .from(shopConfig)
        .where(eq(shopConfig.shopId, shopId))
        .limit(1),
      executor
        .select({ timezone: shops.timezone })
        .from(shops)
        .where(eq(shops.id, shopId))
        .limit(1),
    ]);

    const { config } = migrateShopConfig(
      configRow[0]?.config ?? {},
      shopRow[0]?.timezone ?? 'Asia/Kolkata',
    );

    return {
      card: { id: jobCardId, shopId, state, version: 1 },
      workItems: items,
      config,
      outstandingBalancePaise: balance.reduce((total, row) => total + Number(row.total), 0),
      now: new Date(),
    };
  }

  private async workItemCounts(
    shopId: string,
    cardIds: readonly string[],
    executor: Executor,
  ): Promise<Map<string, { total: number; pendingApproval: number; done: number }>> {
    const rows = await executor
      .select({
        jobCardId: workItems.jobCardId,
        total: sql<number>`count(*)::int`,
        pendingApproval: sql<number>`count(*) filter (where ${workItems.state} = 'PENDING_APPROVAL')::int`,
        done: sql<number>`count(*) filter (where ${workItems.state} = 'DONE')::int`,
      })
      .from(workItems)
      .where(and(eq(workItems.shopId, shopId), inArray(workItems.jobCardId, [...cardIds])))
      .groupBy(workItems.jobCardId);

    return new Map(
      rows.map((row) => [
        row.jobCardId,
        {
          total: Number(row.total),
          pendingApproval: Number(row.pendingApproval),
          done: Number(row.done),
        },
      ]),
    );
  }

  /** Highest-version estimate per card — what an advisor expects to see. */
  private async acceptedOrLatestEstimateTotals(
    shopId: string,
    cardIds: readonly string[],
    executor: Executor,
  ): Promise<Map<string, number>> {
    const rows = await executor
      .select({
        jobCardId: estimates.jobCardId,
        version: estimates.version,
        totalPaise: estimates.totalPaise,
      })
      .from(estimates)
      .where(and(eq(estimates.shopId, shopId), inArray(estimates.jobCardId, [...cardIds])))
      .orderBy(asc(estimates.jobCardId), desc(estimates.version));

    const totals = new Map<string, number>();
    for (const row of rows) {
      if (!totals.has(row.jobCardId)) totals.set(row.jobCardId, Number(row.totalPaise));
    }
    return totals;
  }
}
