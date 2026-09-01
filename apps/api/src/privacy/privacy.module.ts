import { Module } from '@nestjs/common';
import { StorageArchiveWriter, type StoragePort } from '@serviceloop/adapters';
import { getEnv } from '@serviceloop/config';
import {
  PgDataRequestStore,
  PgErasureExecutor,
  PgExportSource,
  PgShopConfigStore,
  type PgUnitOfWork,
  type AuditService,
  type OutboxService,
  type Tx,
} from '@serviceloop/db';
import { DataPrincipalService } from '@serviceloop/domain';
import {
  AUDIT_SERVICE,
  OUTBOX_SERVICE,
  STORAGE,
  UNIT_OF_WORK,
} from '../infra/tokens';
import { DATA_PRINCIPAL_SERVICE } from './privacy.tokens';
import { PrivacyController } from './privacy.controller';
import { PublicPrivacyController } from './public-privacy.controller';

/**
 * The DPDP data-principal workflows (phase 7.2).
 *
 * A module of its own rather than a corner of `MessagingModule`, and the reason
 * is the one the whole phase turns on: nothing else in the application depends
 * on this, and this depends on nothing else in the application. An erasure is
 * not a feature of messaging that happens to delete some rows; it is a
 * cross-cutting operation over the entire schema, and giving it its own module
 * keeps that visible in the module graph rather than buried.
 */
@Module({
  controllers: [PrivacyController, PublicPrivacyController],
  providers: [
    {
      provide: DATA_PRINCIPAL_SERVICE,
      useFactory: (
        uow: PgUnitOfWork,
        audit: AuditService,
        outbox: OutboxService,
        storage: StoragePort,
      ) => {
        const env = getEnv();
        return new DataPrincipalService<Tx>({
          uow,
          requests: new PgDataRequestStore(),
          config: new PgShopConfigStore(),
          audit,
          outbox,
          exports: new PgExportSource(storage, env.DPDP_EXPORT_TTL_HOURS * 3600),
          archives: new StorageArchiveWriter(storage),
          erasure: new PgErasureExecutor(),
          // The blind-index key, reused. A pseudonym has exactly the blind
          // index's security requirement — reproducible with the key, useless
          // without it — and a second secret would double what an operator has
          // to rotate for no gain.
          pseudonymKey: Buffer.from(env.BLIND_INDEX_KEY, 'base64'),
          exportTtlHours: env.DPDP_EXPORT_TTL_HOURS,
        });
      },
      inject: [UNIT_OF_WORK, AUDIT_SERVICE, OUTBOX_SERVICE, STORAGE],
    },
  ],
  exports: [DATA_PRINCIPAL_SERVICE],
})
export class PrivacyModule {}
