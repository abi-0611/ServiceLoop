import type { Provider } from '@nestjs/common';
import { createRetentionRuntime, type AgentRuntime, type RetentionRuntime } from '@serviceloop/agent-core';
import {
  createRetentionStores,
  jobCardLabels,
  openVisitsByVehicle,
  PgConversationStore,
  PgPriceListReader,
  PgShopConfigStore,
  PgShopDirectory,
  type AuditService,
  type OutboxService,
  type PgUnitOfWork,
  type Tx,
} from '@serviceloop/db';
import type { ConsentService, OutboundGate } from '@serviceloop/domain';
import {
  AGENT_RUNTIME,
  AUDIT_SERVICE,
  CONSENT_SERVICE,
  OUTBOUND_GATE,
  OUTBOX_SERVICE,
  RETENTION_RUNTIME,
  UNIT_OF_WORK,
} from '../infra/tokens';

/**
 * The phase-6 runtime, as the API sees it.
 *
 * The API does not *run* retention — the worker owns every timer that decides
 * when a re-pitch, a reminder or a digest goes out. What it does is answer the
 * taps those messages come back with, and read the rollups the worker folded.
 * Both need the identical services, so both build them from the same factory.
 *
 * `agent.tasks` is shared rather than rebuilt: a recovery task from a bad
 * review and an approval task from a stuck ladder are the same queue in front
 * of the same advisor.
 */
export const retentionProviders: Provider[] = [
  {
    provide: RETENTION_RUNTIME,
    useFactory: (
      uow: PgUnitOfWork,
      audit: AuditService,
      outbox: OutboxService,
      gate: OutboundGate<Tx>,
      consents: ConsentService<Tx>,
      agent: AgentRuntime<Tx>,
    ): RetentionRuntime<Tx> => {
      const stores = createRetentionStores();

      return createRetentionRuntime<Tx>({
        stores: {
          uow,
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
          audit,
          outbox,
        },
        gate,
        consents,
        openVisits: openVisitsByVehicle,
        cardLabels: jobCardLabels,
        tasks: agent.tasks,
        prices: new PgPriceListReader(),
      });
    },
    inject: [
      UNIT_OF_WORK,
      AUDIT_SERVICE,
      OUTBOX_SERVICE,
      OUTBOUND_GATE,
      CONSENT_SERVICE,
      AGENT_RUNTIME,
    ],
  },
];
