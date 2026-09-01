import type {
  JobCardSnapshot,
  JobCardStateWrite,
  JobCardStore,
  WorkItemSnapshot,
} from '@serviceloop/domain';
import type { Paise } from '@serviceloop/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { jobCards, workItems } from '../schema';

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
  /**
   * What this card still owes.
   *
   * **The invoice wins when one exists**, and that is the whole of it: an
   * invoice records both what was charged and what has been paid, and the
   * accepted estimate records neither. Summing estimate totals — which is what
   * this did — made the balance a constant that no payment could move, and the
   * two guards that read it (`deliveryBeforePaymentAllowed` and
   * `balanceSettled`) then had a branch that could never be taken. Concretely:
   * a shop collecting payment before delivery could not hand back a car the
   * customer had paid for in full, and **no card could ever be CLOSED**.
   *
   * Before an invoice is issued, the fallback sums the accepted estimate's
   * *lines*, excluding work the customer declined or deferred. The old version
   * summed the header total, which charges for the brake job somebody said no
   * to — the exact mistake the declined-work ledger exists because of.
   */
  async loadOutstandingBalancePaise(tx: Tx, shopId: string, jobCardId: string): Promise<Paise> {
    const invoice = await tx.execute<{ total: string | number; paid: string | number }>(sql`
      select total_paise as total, amount_paid_paise as paid
        from invoices
       where shop_id = ${shopId} and job_card_id = ${jobCardId}
       order by created_at desc
       limit 1
    `);

    const billed = invoice.rows[0];
    if (billed !== undefined) {
      return Math.max(0, Number(billed.total) - Number(billed.paid));
    }

    const quoted = await tx.execute<{ due: string | number }>(sql`
      select coalesce(sum(el.line_total_paise), 0) as due
        from estimate_lines el
        join estimates e on e.id = el.estimate_id
        left join work_items wi on wi.id = el.work_item_id
       where e.shop_id = ${shopId}
         and e.job_card_id = ${jobCardId}
         and e.status = 'ACCEPTED'
         -- A line with no work item is a charge in its own right and counts.
         and (wi.state is null or wi.state not in ('DECLINED', 'DEFERRED'))
    `);

    return Number(quoted.rows[0]?.due ?? 0);
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
