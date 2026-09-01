import type { RetentionRuntimeInput } from '@serviceloop/agent-core';
import {
  createRetentionStores,
  jobCardLabels,
  openVisitsByVehicle,
  PgConsentStore,
  PgConversationStore,
  PgPriceListReader,
  PgShopConfigStore,
  PgShopDirectory,
  type AuditService,
  type OutboxService,
  type PgUnitOfWork,
  type Tx,
} from '@serviceloop/db';
import {
  ConsentService,
  type AdvisorTaskCreator,
  type OutboundGate,
} from '@serviceloop/domain';

/**
 * The phase-6 wiring, assembled once per process.
 *
 * Same shape as `createLoopStores`, for the same reason: `createRetentionRuntime`
 * guarantees the *services* are identical wherever they are built, and each
 * process supplies the Postgres handles and the two SQL reads it owns.
 *
 * Both reads are here rather than behind a store port because neither belongs
 * to any one aggregate: "which vehicles are in the shop right now" spans job
 * cards and vehicles, and a digest line's vehicle label is a rendering concern
 * the metrics fold has deliberately never been given.
 */

export interface RetentionWiringInput {
  readonly uow: PgUnitOfWork;
  readonly audit: AuditService;
  readonly outbox: OutboxService;
  readonly gate: OutboundGate<Tx>;
  readonly tasks: AdvisorTaskCreator;
}

export function createRetentionWiring(input: RetentionWiringInput): RetentionRuntimeInput<Tx> {
  const stores = createRetentionStores();

  return {
    stores: {
      uow: input.uow,
      ledger: stores.ledger,
      touches: stores.touches,
      holds: stores.holds,
      odometer: stores.odometer,
      feedback: stores.feedback,
      forecasts: stores.forecasts,
      documents: stores.documents,
      digests: stores.digests,
      alerts: stores.alerts,
      events: stores.events,
      rollups: stores.rollups,
      directory: stores.directory,
      conversations: new PgConversationStore(),
      shops: new PgShopDirectory(),
      config: new PgShopConfigStore(),
      audit: input.audit,
      outbox: input.outbox,
    },
    gate: input.gate,
    consents: new ConsentService<Tx>({
      uow: input.uow,
      consents: new PgConsentStore(),
      audit: input.audit,
      outbox: input.outbox,
    }),
    openVisits: openVisitsByVehicle,
    cardLabels: jobCardLabels,
    tasks: input.tasks,
    // A re-pitch quotes the price the customer was given unless the shop's own
    // list has moved, in which case 6.3 says so plainly rather than re-quoting
    // quietly. Without this reader it can only do the former.
    prices: new PgPriceListReader(),
  };
}
