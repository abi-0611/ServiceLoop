import type { StoragePort } from '@serviceloop/adapters';
import { ObjectNotFoundError } from '@serviceloop/adapters';
import { PgMediaStore, PgUnitOfWork, type Database, type Tx } from '@serviceloop/db';
import type { DeferredSendService, MediaBytesLoader } from '@serviceloop/domain';
import type { Logger } from 'pino';

/**
 * The quiet-hours drain loop (phase 2.9).
 *
 * The gate promises that a message held for quiet hours is deferred, not
 * dropped. This loop is what keeps that promise: every tick it claims the holds
 * whose time has come and pushes them back through the gate, which re-runs
 * every customer protection before letting any of them out.
 *
 * Polling rather than a BullMQ delayed job, deliberately. A delayed job fixes
 * the send time at the moment of deferral; a shop that changes its quiet hours,
 * or a customer who opts out at midnight, would still be served by a job
 * scheduled hours earlier. Reading the due set from the database each tick
 * means the current rules always apply.
 */
export interface DeferredSenderOptions {
  readonly service: DeferredSendService<Tx>;
  readonly logger: Logger;
  readonly intervalMs: number;
  readonly batchSize: number;
}

export class DeferredSender {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private draining = false;

  constructor(private readonly options: DeferredSenderOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Let an in-flight drain finish rather than abandoning messages mid-batch.
    while (this.draining) await new Promise((resolve) => setTimeout(resolve, 25));
  }

  /** One pass. Exposed so a test and the demo can drive it without a timer. */
  async drainOnce(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const result = await this.options.service.drain({ limit: this.options.batchSize });
      if (result.claimed > 0) {
        this.options.logger.info(
          {
            claimed: result.claimed,
            sent: result.sent,
            blocked: result.blocked,
            deferredAgain: result.deferredAgain,
            failed: result.failed,
          },
          'released quiet-hours holds',
        );
      }
    } catch (error) {
      // A failed pass must not stop the loop: the next tick reclaims the same
      // rows, because nothing was marked sent.
      this.options.logger.error({ err: error }, 'deferred-send drain failed');
    } finally {
      this.draining = false;
    }
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.drainOnce().finally(() => this.schedule());
    }, this.options.intervalMs);
    this.timer.unref();
  }
}

/**
 * Reads back the bytes of a held media message.
 *
 * A message deferred with a photo attached has to be re-sent with that photo,
 * and the bytes live in object storage rather than on the row. A missing object
 * returns null rather than throwing: an erasure is a legitimate reason for a
 * held message to become unsendable, and the gate records it as such.
 */
export class StorageMediaBytesLoader implements MediaBytesLoader {
  private readonly media = new PgMediaStore();

  constructor(
    private readonly db: Database,
    private readonly storage: StoragePort,
  ) {}

  async load(
    shopId: string,
    mediaId: string,
  ): Promise<{ bytes: Buffer; contentType: string } | null> {
    const uow = new PgUnitOfWork(this.db);
    const asset = await uow.transaction(async (tx: Tx) =>
      this.media.findById(tx, shopId, mediaId),
    );
    if (asset === null) return null;

    try {
      const object = await this.storage.get(asset.storageKey);
      return { bytes: object.body, contentType: asset.contentType };
    } catch (error) {
      if (error instanceof ObjectNotFoundError) return null;
      throw error;
    }
  }
}
