import type { WorkItemSnapshot, WorkItemStateWrite, WorkItemStore } from '@serviceloop/domain';
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { declinedWorkLedger, estimateLines, jobCards, workItems } from '../schema';

/** Postgres implementation of the domain's WorkItem port. */
export class PgWorkItemStore implements WorkItemStore<Tx> {
  async lockWorkItem(tx: Tx, shopId: string, workItemId: string): Promise<WorkItemSnapshot | null> {
    const result = await tx.execute<{
      id: string;
      shop_id: string;
      job_card_id: string;
      state: WorkItemSnapshot['state'];
      requires_approval: boolean;
    }>(sql`
      select id, shop_id, job_card_id, state, requires_approval
      from work_items
      where id = ${workItemId} and shop_id = ${shopId}
      for update
    `);

    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      shopId: row.shop_id,
      jobCardId: row.job_card_id,
      state: row.state,
      requiresApproval: row.requires_approval,
    };
  }

  async writeState(tx: Tx, write: WorkItemStateWrite): Promise<void> {
    const patch: Record<string, Date> = {};
    if (write.to === 'APPROVED') patch['approvedAt'] = write.at;
    if (write.to === 'IN_PROGRESS') patch['startedAt'] = write.at;
    if (write.to === 'DONE') patch['completedAt'] = write.at;

    await tx
      .update(workItems)
      .set({ state: write.to, updatedAt: write.at, ...patch })
      .where(and(eq(workItems.id, write.workItemId), eq(workItems.shopId, write.shopId)));
  }

  /**
   * Declined and deferred work lands in the ledger in the same transaction as
   * the state change — this row is what phase 6 re-pitches from, so losing it
   * would silently destroy recoverable revenue.
   */
  async recordDeclineOrDefer(
    tx: Tx,
    input: {
      shopId: string;
      workItemId: string;
      jobCardId: string;
      kind: 'DECLINED' | 'DEFERRED';
      reason: string;
      followUpAfter: Date | null;
      at: Date;
    },
  ): Promise<void> {
    const [card] = await tx
      .select({ customerId: jobCards.customerId, vehicleId: jobCards.vehicleId })
      .from(jobCards)
      .where(and(eq(jobCards.id, input.jobCardId), eq(jobCards.shopId, input.shopId)))
      .limit(1);

    const [amount] = await tx
      .select({ total: sql<number>`coalesce(sum(${estimateLines.lineTotalPaise}), 0)::bigint` })
      .from(estimateLines)
      .where(
        and(eq(estimateLines.shopId, input.shopId), eq(estimateLines.workItemId, input.workItemId)),
      );

    await tx
      .insert(declinedWorkLedger)
      .values({
        shopId: input.shopId,
        jobCardId: input.jobCardId,
        workItemId: input.workItemId,
        customerId: card?.customerId ?? null,
        vehicleId: card?.vehicleId ?? null,
        kind: input.kind,
        reason: input.reason,
        amountPaise: Number(amount?.total ?? 0),
        followUpAfter: input.followUpAfter,
        status: 'OPEN',
        // The transition's own instant, not the database's. `created_at` on this
        // row is the "declined at" a re-pitch quotes months later.
        createdAt: input.at,
        updatedAt: input.at,
      })
      .onConflictDoNothing({ target: declinedWorkLedger.workItemId });
  }
}
