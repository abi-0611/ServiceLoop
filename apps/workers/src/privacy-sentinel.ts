import type { DataPrincipalService } from '@serviceloop/domain';
import type { Tx } from '@serviceloop/db';
import { uuidv7 } from '@serviceloop/shared';
import { PollingSentinel, type SentinelBase } from './sentinels';

/**
 * The DPDP execution sentinel (phase 7.2).
 *
 * An approval does not run the cascade. It *schedules* it, `now` plus the
 * shop's grace window, and this pass is what eventually runs it — which is the
 * whole reason the grace window is worth having. A deletion that executed
 * inside the approve request would give an owner who mis-tapped a customer row
 * no interval in which to cancel, and there is no undo on the other side of it.
 *
 * Three properties, each of which is a way this could go wrong:
 *
 * **One request at a time, and the whole pass gives up on a lock.** The service
 * takes a row lock in `execute`; two workers polling the same second would
 * otherwise both load an `APPROVED` request and both start a cascade. The
 * second would fail on the status check rather than duplicate the work, but it
 * would fail *after* writing a `RUNNING` transition, so the request's history
 * would record an attempt nobody made.
 *
 * **A failure does not stop the loop, and does not retry immediately.** An
 * erasure that throws leaves the request `FAILED` with the reason on it, and
 * `dueForExecution` does not return `FAILED` rows — so a request that cannot
 * complete stops asking rather than looping on the same exception every thirty
 * seconds until somebody reads the logs. Restarting it is a person's decision,
 * because the failure usually means something about the cascade plan is wrong.
 *
 * **It is not scoped by shop.** Every other sentinel iterates `shopIds()`,
 * because every other sentinel reads shop configuration to decide whether to
 * act. This one asks the database a single question — which requests are past
 * their scheduled time — and the answer is already shop-tagged. Iterating shops
 * here would turn one indexed query into one per shop for no gain, and would
 * quietly skip a request belonging to a shop deactivated after it was approved,
 * which is precisely the request a person is most likely to be waiting on.
 */
export class DataRequestSentinel extends PollingSentinel {
  constructor(
    private readonly deps: SentinelBase,
    private readonly service: DataPrincipalService<Tx>,
    intervalMs: number,
    private readonly batchSize: number,
  ) {
    super(deps, intervalMs, 'dpdp');
  }

  protected async pass(): Promise<void> {
    const due = await this.service.due(new Date(), this.batchSize);

    for (const record of due) {
      const traceId = `dpdp:${uuidv7()}`;
      try {
        const report = await this.service.execute({
          shopId: record.shopId,
          requestId: record.id,
          // The system acting on an authorisation a person already gave. The
          // approving staff id is on the request row and in the audit chain;
          // attributing the *execution* to that person would claim they were
          // present when the cascade ran, which they were not.
          //
          // `id` is null rather than a label: `audit_events.actor_id` is a
          // `uuid` column, and a string there fails the insert — which would
          // turn every unattended erasure into an exception, in the one code
          // path nobody watches. The label goes in the log line below instead.
          actor: { type: 'SYSTEM', id: null },
          traceId,
        });

        this.deps.logger.info(
          {
            requestId: record.id,
            shopId: record.shopId,
            kind: record.kind,
            // The pseudonym, never the customer id: this line survives in a log
            // aggregator long after the row it refers to has been erased, and a
            // customer id there would make the log the thing that remembers.
            subject: record.subjectPseudonym,
            steps: report.steps.length,
            traceId,
          },
          'data-principal request executed',
        );
      } catch (error) {
        // Logged per request rather than thrown, so one wedged request does not
        // block the ones behind it in the same pass.
        this.deps.logger.error(
          { err: error, requestId: record.id, shopId: record.shopId, kind: record.kind, traceId },
          'data-principal request failed',
        );
      }
    }
  }
}
