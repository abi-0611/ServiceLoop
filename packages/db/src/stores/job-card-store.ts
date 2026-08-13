import type {
  JobCardSnapshot,
  JobCardStateWrite,
  JobCardStore,
  WorkItemSnapshot,
} from '@serviceloop/domain';
import type { Paise } from '@serviceloop/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { estimates, jobCards, workItems } from '../schema';

/**
 * Postgres implementation of the domain's JobCard port.
 *
 * `lockCard` takes a row lock, which is what makes two concurrent transitions
 * on one card serialise: the second transaction blocks on the lock, then reads
 * the state the first one wrote, and its own transition is judged against that.
 */
export class PgJobCardStore implements JobCardStore<Tx> {
  async lockCard(tx: Tx, shopId: string, jobCardId: string): Promise<JobCardSnapshot | null> {
    const result = await tx.execute<{
      id: string;
      shop_id: string;
      state: JobCardSnapshot['state'];
      version: number;
    }>(sql`
      select id, shop_id, state, version
      from job_cards
      where id = ${jobCardId} and shop_id = ${shopId} and deleted_at is null
      for update
    `);

    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      shopId: row.shop_id,
      state: row.state,
      version: Number(row.version),
    };
  }

  async loadWorkItems(tx: Tx, shopId: string, jobCardId: string): Promise<WorkItemSnapshot[]> {
    const rows = await tx
      .select({
        id: workItems.id,
        shopId: workItems.shopId,
        jobCardId: workItems.jobCardId,
        state: workItems.state,
        requiresApproval: workItems.requiresApproval,
      })
      .from(workItems)
      .where(and(eq(workItems.shopId, shopId), eq(workItems.jobCardId, jobCardId)))
      .orderBy(asc(workItems.sequence));

    return rows;
  }

  /**
   * Outstanding balance = accepted estimate total minus payments recorded.
   * Payments arrive in phase 4; until then an accepted estimate is fully
   * outstanding, which is the conservative reading for the delivery guard.
   */
  async loadOutstandingBalancePaise(tx: Tx, shopId: string, jobCardId: string): Promise<Paise> {
    const rows = await tx
      .select({ total: estimates.totalPaise })
      .from(estimates)
      .where(
        and(
          eq(estimates.shopId, shopId),
          eq(estimates.jobCardId, jobCardId),
          eq(estimates.status, 'ACCEPTED'),
        ),
      );

    return rows.reduce<Paise>((total, row) => total + Number(row.total), 0);
  }

  async writeState(tx: Tx, write: JobCardStateWrite): Promise<void> {
    const timestampPatch: Record<string, Date | null> = {};
    if (write.to === 'OPEN') timestampPatch['openedAt'] = write.at;
    if (write.to === 'DELIVERED') timestampPatch['deliveredAt'] = write.at;
    if (write.to === 'CLOSED') timestampPatch['closedAt'] = write.at;

    const result = await tx
      .update(jobCards)
      .set({
        state: write.to,
        stateChangedAt: write.at,
        version: write.expectedVersion + 1,
        updatedAt: write.at,
        ...timestampPatch,
      })
      .where(
        and(
          eq(jobCards.id, write.jobCardId),
          eq(jobCards.shopId, write.shopId),
          eq(jobCards.version, write.expectedVersion),
        ),
      );

    if ((result.rowCount ?? 0) === 0) {
      throw new Error(
        `Concurrent modification of job card ${write.jobCardId}: expected version ${write.expectedVersion}`,
      );
    }
  }
}
