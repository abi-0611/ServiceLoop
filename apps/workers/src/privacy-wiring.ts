import { StorageArchiveWriter, type StoragePort } from '@serviceloop/adapters';
import { getEnv } from '@serviceloop/config';
import {
  PgDataRequestStore,
  PgErasureExecutor,
  PgExportSource,
  PgShopConfigStore,
  type AuditService,
  type OutboxService,
  type PgUnitOfWork,
  type Tx,
} from '@serviceloop/db';
import { DataPrincipalService } from '@serviceloop/domain';

/**
 * The DPDP service, assembled for the worker process (phase 7.2).
 *
 * Duplicated from `PrivacyModule`'s factory for the same reason
 * `createRetentionWiring` is duplicated between the API and the workers: the
 * service lives in `@serviceloop/domain` and the Postgres stores live in
 * `@serviceloop/db`, and neither package depends on the other, so each process
 * supplies its own handles.
 *
 * What must **not** diverge is the `pseudonymKey`. A worker that minted
 * pseudonyms from a different secret than the API would produce a second,
 * unrelated identity for the same person — the retained invoice and the audit
 * event would stop joining to the request row, which is the one property the
 * whole erasure design exists to preserve. Both read `BLIND_INDEX_KEY`, and an
 * environment where those two processes disagree is an environment where far
 * more than this is already broken.
 */
export function createDataPrincipalService(input: {
  readonly uow: PgUnitOfWork;
  readonly audit: AuditService;
  readonly outbox: OutboxService;
  readonly storage: StoragePort;
}): DataPrincipalService<Tx> {
  const env = getEnv();

  return new DataPrincipalService<Tx>({
    uow: input.uow,
    requests: new PgDataRequestStore(),
    config: new PgShopConfigStore(),
    audit: input.audit,
    outbox: input.outbox,
    exports: new PgExportSource(input.storage, env.DPDP_EXPORT_TTL_HOURS * 3600),
    archives: new StorageArchiveWriter(input.storage),
    erasure: new PgErasureExecutor(),
    pseudonymKey: Buffer.from(env.BLIND_INDEX_KEY, 'base64'),
    exportTtlHours: env.DPDP_EXPORT_TTL_HOURS,
  });
}
