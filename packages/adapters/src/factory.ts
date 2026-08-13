import { type Env, selectAdapters } from '@serviceloop/config';
import { ConfigurationError } from '@serviceloop/shared';
import { InMemoryNotifier, LoggingNotifier, type LogSink } from './notifier/sandbox-notifiers';
import type { NotifierPort } from './notifier/port';
import { InMemoryStorage } from './storage/in-memory-storage';
import type { StoragePort } from './storage/port';
import { S3Storage } from './storage/s3-storage';

/**
 * Adapter construction from the validated environment. This is the only place
 * that decides which implementation of a port is live, so the boot log
 * (`formatAdapterSelection`) and the wiring can never disagree.
 */

export function createStoragePort(env: Env): StoragePort {
  const selection = selectAdapters(env).find((entry) => entry.port === 'storage');
  if (selection !== undefined && !selection.implemented) {
    throw new ConfigurationError(
      `No storage adapter is implemented for STORAGE_DRIVER=${env.STORAGE_DRIVER}`,
      { driver: env.STORAGE_DRIVER },
    );
  }

  if (env.STORAGE_DRIVER === 'memory') return new InMemoryStorage(env.S3_BUCKET);

  return new S3Storage({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    bucket: env.S3_BUCKET,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  });
}

export function createNotifierPort(env: Env, sink?: LogSink): NotifierPort {
  if (env.DEMO_MODE || env.NOTIFIER_DRIVER !== 'sms') {
    return env.NOTIFIER_DRIVER === 'memory' ? new InMemoryNotifier() : new LoggingNotifier(sink);
  }

  throw new ConfigurationError(
    'The SMS notifier adapter is not wired yet; set NOTIFIER_DRIVER=log or enable DEMO_MODE',
    { driver: env.NOTIFIER_DRIVER },
  );
}
