import {
  type Clock,
  type EventEnvelope,
  type MediaKind,
  type MediaOrigin,
  systemClock,
  uuidv7,
} from '@serviceloop/shared';
import type { Actor } from '../job-card/context';
import type { AuditAppender, OutboxWriter, UnitOfWork } from '../ports';

/**
 * Media as a *domain* concern (phase 2.4).
 *
 * `packages/adapters` owns the bytes — sniffing, EXIF rotation, thumbnails,
 * the 16 kHz transcode — and knows nothing about shops or job cards. This file
 * owns everything that makes those bytes a record: which shop they belong to,
 * what the customer was told when they were refused, the audit entry, and the
 * `media.ingested` event other phases hang work off.
 *
 * The split is why the pipeline can be tested with an in-memory bucket and no
 * database, and why this service can be tested with no image library at all.
 */

/* -------------------------------------------------------------------------- *
 * The byte pipeline, as a port
 * -------------------------------------------------------------------------- */

/** What the pipeline produced. Mirrors `StoredMedia` in `packages/adapters`. */
export interface StoredMediaDescriptor {
  readonly mediaId: string;
  readonly kind: MediaKind;
  readonly bucket: string;
  readonly storageKey: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
  readonly thumbnailKey: string | null;
  readonly widthPx: number | null;
  readonly heightPx: number | null;
  readonly durationMs: number | null;
  readonly derivedKey: string | null;
  readonly derivedContentType: string | null;
  readonly providerMediaId: string | null;
  readonly warnings: readonly string[];
}

export interface MediaRejection {
  readonly code:
    | 'TOO_LARGE'
    | 'EMPTY'
    | 'UNSUPPORTED_TYPE'
    | 'UNREADABLE'
    /** The scanner matched a signature (phase 7.1). Nothing was stored. */
    | 'INFECTED'
    /** Fail-closed only: the scanner could not answer, so nothing was stored. */
    | 'SCAN_UNAVAILABLE';
  /** Already phrased for a customer to read; the handler sends it as-is. */
  readonly reason: string;
  readonly sizeBytes?: number;
  readonly limitBytes?: number;
  readonly contentType?: string;
}

export type MediaIngestOutcome =
  | { readonly ok: true; readonly media: StoredMediaDescriptor }
  | { readonly ok: false; readonly rejection: MediaRejection };

export interface MediaIngestRequest {
  readonly shopId: string;
  readonly jobCardId?: string | null;
  readonly bytes: Buffer;
  readonly declaredContentType?: string;
  readonly filename?: string | null;
  readonly origin: MediaOrigin;
  readonly providerMediaId?: string | null;
  readonly caption?: string | null;
  /**
   * Leaves the audio transcode to the worker. The webhook path sets this: a
   * customer's phone should not wait on ffmpeg, and the worker is where the
   * binary is actually installed.
   */
  readonly deferAudio?: boolean;
}

/** Implemented by `MediaPipeline` in `packages/adapters`. */
export interface MediaIngestPort {
  ingest(request: MediaIngestRequest): Promise<MediaIngestOutcome>;
}

/* -------------------------------------------------------------------------- *
 * Persistence
 * -------------------------------------------------------------------------- */

export interface MediaAssetRecord {
  readonly id: string;
  readonly shopId: string;
  readonly jobCardId: string | null;
  readonly kind: MediaKind;
  readonly origin: MediaOrigin;
  readonly bucket: string;
  readonly storageKey: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
  readonly caption: string | null;
  readonly thumbnailKey: string | null;
  readonly widthPx: number | null;
  readonly heightPx: number | null;
  readonly durationMs: number | null;
  readonly derivedKey: string | null;
  readonly derivedContentType: string | null;
  readonly providerMediaId: string | null;
  readonly createdAt: Date;
}

export interface InsertMediaAssetInput {
  readonly id: string;
  readonly shopId: string;
  readonly jobCardId: string | null;
  readonly kind: MediaKind;
  readonly origin: MediaOrigin;
  readonly bucket: string;
  readonly storageKey: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
  readonly caption: string | null;
  readonly thumbnailKey: string | null;
  readonly widthPx: number | null;
  readonly heightPx: number | null;
  readonly durationMs: number | null;
  readonly derivedKey: string | null;
  readonly derivedContentType: string | null;
  readonly providerMediaId: string | null;
  readonly capturedById: string | null;
  readonly capturedAt: Date;
}

export interface MediaStore<Tx> {
  insert(tx: Tx, input: InsertMediaAssetInput): Promise<void>;
  findById(tx: Tx, shopId: string, mediaId: string): Promise<MediaAssetRecord | null>;
  /**
   * A redelivered webhook carries the same provider media id. Re-using the
   * stored object means Meta's 30-day media window is only spent once.
   */
  findByProviderMediaId(
    tx: Tx,
    shopId: string,
    providerMediaId: string,
  ): Promise<MediaAssetRecord | null>;
  /** Fills in the transcode the worker produced after the fact. */
  attachDerivative(
    tx: Tx,
    input: {
      readonly shopId: string;
      readonly mediaId: string;
      readonly derivedKey: string;
      readonly derivedContentType: string;
      readonly durationMs: number | null;
    },
  ): Promise<void>;
}

/* -------------------------------------------------------------------------- *
 * Service
 * -------------------------------------------------------------------------- */

export interface MediaServiceDeps<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly store: MediaStore<Tx>;
  readonly pipeline: MediaIngestPort;
  readonly audit: AuditAppender<Tx>;
  readonly outbox: OutboxWriter<Tx>;
  readonly clock?: Clock;
}

export interface IngestInboundInput {
  readonly shopId: string;
  readonly bytes: Buffer;
  readonly declaredContentType: string;
  readonly filename?: string | null;
  readonly caption?: string | null;
  readonly origin: MediaOrigin;
  readonly providerMediaId?: string | null;
  readonly messageId?: string | null;
  readonly jobCardId?: string | null;
  readonly capturedByStaffId?: string | null;
  readonly deferAudio?: boolean;
  readonly actor: Actor;
  readonly traceId: string;
}

export type MediaIngestResult =
  | { readonly ok: true; readonly asset: MediaAssetRecord; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly rejection: MediaRejection };

export class MediaService<Tx> {
  private readonly clock: Clock;

  constructor(private readonly deps: MediaServiceDeps<Tx>) {
    this.clock = deps.clock ?? systemClock;
  }

  /**
   * Runs the byte pipeline, then records the asset.
   *
   * The pipeline call deliberately happens *outside* the transaction: it uploads
   * to object storage over the network, and holding a database connection open
   * for the length of that would starve the pool under any real inbound rate.
   * The consequence — an object with no row, if the process dies in between — is
   * an orphan in a bucket, which a sweep can reclaim. The reverse (a row
   * pointing at bytes that were never written) would be a broken record.
   */
  async ingestInbound(input: IngestInboundInput): Promise<MediaIngestResult> {
    const existing =
      input.providerMediaId === undefined || input.providerMediaId === null
        ? null
        : await this.deps.uow.transaction(async (tx) =>
            this.deps.store.findByProviderMediaId(
              tx,
              input.shopId,
              input.providerMediaId as string,
            ),
          );
    if (existing !== null) return { ok: true, asset: existing, warnings: [] };

    const outcome = await this.deps.pipeline.ingest({
      shopId: input.shopId,
      jobCardId: input.jobCardId ?? null,
      bytes: input.bytes,
      declaredContentType: input.declaredContentType,
      filename: input.filename ?? null,
      origin: input.origin,
      providerMediaId: input.providerMediaId ?? null,
      caption: input.caption ?? null,
      ...(input.deferAudio === undefined ? {} : { deferAudio: input.deferAudio }),
    });

    if (!outcome.ok) {
      // A refusal is still a fact about this shop's traffic, and the customer
      // is about to be told about it — so it is audited rather than logged.
      await this.deps.uow.transaction(async (tx) => {
        await this.deps.audit.append(tx, {
          shopId: input.shopId,
          actorType: input.actor.type,
          actorId: input.actor.id,
          action: 'media.rejected',
          entityType: 'MediaAsset',
          entityId: null,
          payload: {
            code: outcome.rejection.code,
            reason: outcome.rejection.reason,
            messageId: input.messageId ?? null,
            declaredContentType: input.declaredContentType,
          },
          traceId: input.traceId,
        });
      });
      return { ok: false, rejection: outcome.rejection };
    }

    const media = outcome.media;
    const at = this.clock.now();

    const asset = await this.deps.uow.transaction(async (tx) => {
      const record: InsertMediaAssetInput = {
        id: media.mediaId,
        shopId: input.shopId,
        jobCardId: input.jobCardId ?? null,
        kind: media.kind,
        origin: input.origin,
        bucket: media.bucket,
        storageKey: media.storageKey,
        contentType: media.contentType,
        sizeBytes: media.sizeBytes,
        checksumSha256: media.checksumSha256,
        caption: input.caption ?? null,
        thumbnailKey: media.thumbnailKey,
        widthPx: media.widthPx,
        heightPx: media.heightPx,
        durationMs: media.durationMs,
        derivedKey: media.derivedKey,
        derivedContentType: media.derivedContentType,
        providerMediaId: media.providerMediaId,
        capturedById: input.capturedByStaffId ?? null,
        capturedAt: at,
      };
      await this.deps.store.insert(tx, record);

      await this.deps.audit.append(tx, {
        shopId: input.shopId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'media.ingested',
        entityType: 'MediaAsset',
        entityId: media.mediaId,
        payload: {
          kind: media.kind,
          contentType: media.contentType,
          sizeBytes: media.sizeBytes,
          checksumSha256: media.checksumSha256,
          messageId: input.messageId ?? null,
          warnings: media.warnings,
        },
        traceId: input.traceId,
      });

      const envelope: EventEnvelope = {
        id: uuidv7(),
        type: 'media.ingested',
        occurredAt: at.toISOString(),
        shopId: input.shopId,
        traceId: input.traceId,
        payload: {
          mediaId: media.mediaId,
          kind: media.kind,
          contentType: media.contentType,
          sizeBytes: media.sizeBytes,
          messageId: input.messageId ?? null,
          jobCardId: input.jobCardId ?? null,
          actor: { type: input.actor.type, id: input.actor.id },
        },
      };
      await this.deps.outbox.enqueue(tx, envelope);

      const stored = await this.deps.store.findById(tx, input.shopId, media.mediaId);
      if (stored === null) throw new Error('The media asset row vanished after insert');
      return stored;
    });

    return { ok: true, asset, warnings: media.warnings };
  }

  async load(shopId: string, mediaId: string): Promise<MediaAssetRecord | null> {
    return this.deps.uow.transaction(async (tx) => this.deps.store.findById(tx, shopId, mediaId));
  }

  /** Records the derivative a worker produced for an asset stored earlier. */
  async attachDerivative(input: {
    readonly shopId: string;
    readonly mediaId: string;
    readonly derivedKey: string;
    readonly derivedContentType: string;
    readonly durationMs: number | null;
    readonly traceId: string;
  }): Promise<void> {
    await this.deps.uow.transaction(async (tx) => {
      await this.deps.store.attachDerivative(tx, {
        shopId: input.shopId,
        mediaId: input.mediaId,
        derivedKey: input.derivedKey,
        derivedContentType: input.derivedContentType,
        durationMs: input.durationMs,
      });
      await this.deps.audit.append(tx, {
        shopId: input.shopId,
        actorType: 'SYSTEM',
        actorId: null,
        action: 'media.derivative_attached',
        entityType: 'MediaAsset',
        entityId: input.mediaId,
        payload: {
          derivedKey: input.derivedKey,
          derivedContentType: input.derivedContentType,
          durationMs: input.durationMs,
        },
        traceId: input.traceId,
      });
    });
  }
}
