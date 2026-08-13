import { Global, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createNotifierPort, createStoragePort } from '@serviceloop/adapters';
import { getEnv } from '@serviceloop/config';
import {
  AuditService,
  createDatabase,
  JobCardRepository,
  OutboxService,
  PgJobCardStore,
  PgShopConfigStore,
  PgUnitOfWork,
  PgWorkItemStore,
  StaffRepository,
  type Database,
  type DatabaseHandle,
} from '@serviceloop/db';
import {
  GuardrailService,
  JobCardTransitionService,
  WorkItemTransitionService,
} from '@serviceloop/domain';
import IORedis, { type Redis } from 'ioredis';
import {
  AUDIT_SERVICE,
  DATABASE,
  GUARDRAIL_SERVICE,
  JOB_CARD_REPOSITORY,
  JOB_CARD_TRANSITION_SERVICE,
  NOTIFIER,
  OUTBOX_SERVICE,
  REDIS,
  STAFF_REPOSITORY,
  STORAGE,
  UNIT_OF_WORK,
  WORK_ITEM_TRANSITION_SERVICE,
} from './tokens';

/**
 * Composition root.
 *
 * Domain services are constructed here with their Postgres port
 * implementations. Adapters come from the factory that also produces the boot
 * log, so what the log claims is live is exactly what is wired.
 */

let databaseHandle: DatabaseHandle | null = null;
let redisClient: Redis | null = null;

@Global()
@Module({
  providers: [
    {
      provide: DATABASE,
      useFactory: (): Database => {
        databaseHandle ??= createDatabase(getEnv());
        return databaseHandle.db;
      },
    },
    {
      provide: REDIS,
      useFactory: (): Redis => {
        redisClient ??= new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: 2 });
        return redisClient;
      },
    },
    { provide: STORAGE, useFactory: () => createStoragePort(getEnv()) },
    {
      // Deliberately not wired to `rootLogger`: the sandbox notifier's whole
      // purpose is printing the OTP, and the application logger redacts it.
      provide: NOTIFIER,
      useFactory: () => createNotifierPort(getEnv()),
    },
    {
      provide: UNIT_OF_WORK,
      useFactory: (db: Database) => new PgUnitOfWork(db),
      inject: [DATABASE],
    },
    {
      provide: AUDIT_SERVICE,
      useFactory: (db: Database, redis: Redis) => new AuditService(db, redis),
      inject: [DATABASE, REDIS],
    },
    {
      provide: OUTBOX_SERVICE,
      useFactory: (db: Database) => new OutboxService(db),
      inject: [DATABASE],
    },
    {
      provide: JOB_CARD_REPOSITORY,
      useFactory: (db: Database) => new JobCardRepository(db),
      inject: [DATABASE],
    },
    {
      provide: STAFF_REPOSITORY,
      useFactory: (db: Database) => new StaffRepository(db),
      inject: [DATABASE],
    },
    {
      provide: JOB_CARD_TRANSITION_SERVICE,
      useFactory: (uow: PgUnitOfWork, audit: AuditService, outbox: OutboxService) =>
        new JobCardTransitionService({
          uow,
          cards: new PgJobCardStore(),
          config: new PgShopConfigStore(),
          audit,
          outbox,
        }),
      inject: [UNIT_OF_WORK, AUDIT_SERVICE, OUTBOX_SERVICE],
    },
    {
      provide: WORK_ITEM_TRANSITION_SERVICE,
      useFactory: (uow: PgUnitOfWork, audit: AuditService, outbox: OutboxService) =>
        new WorkItemTransitionService({
          uow,
          items: new PgWorkItemStore(),
          audit,
          outbox,
        }),
      inject: [UNIT_OF_WORK, AUDIT_SERVICE, OUTBOX_SERVICE],
    },
    {
      provide: GUARDRAIL_SERVICE,
      useFactory: (uow: PgUnitOfWork, audit: AuditService, outbox: OutboxService) =>
        new GuardrailService({ uow, store: new PgShopConfigStore(), audit, outbox }),
      inject: [UNIT_OF_WORK, AUDIT_SERVICE, OUTBOX_SERVICE],
    },
  ],
  exports: [
    DATABASE,
    REDIS,
    STORAGE,
    NOTIFIER,
    UNIT_OF_WORK,
    AUDIT_SERVICE,
    OUTBOX_SERVICE,
    JOB_CARD_REPOSITORY,
    STAFF_REPOSITORY,
    JOB_CARD_TRANSITION_SERVICE,
    WORK_ITEM_TRANSITION_SERVICE,
    GUARDRAIL_SERVICE,
  ],
})
export class InfraModule implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    if (redisClient !== null) {
      await redisClient.quit().catch(() => undefined);
      redisClient = null;
    }
    if (databaseHandle !== null) {
      await databaseHandle.close().catch(() => undefined);
      databaseHandle = null;
    }
  }
}
