import type { Env } from '@serviceloop/config';
import { formatBytes, type MediaKind, type MediaOrigin, uuidv7 } from '@serviceloop/shared';
import {
  CompositeAudioNormaliser,
  FfmpegAudioNormaliser,
  type AudioNormalisationFailure,
  type AudioNormaliserPort,
} from './audio';
import { createAntivirusPort } from '../factory';
import type { AntivirusPort } from '../antivirus/port';
import { SharpImageProcessor, type ImageProcessorPort } from './image-processor';
import { sniffContentType, type SniffResult } from './sniff';
import { mediaKey, type StoragePort } from '../storage/port';

/**
 * The inbound media pipeline (phase 2.4).
 *
 * Sniff → size-check → normalise → derive a thumbnail → store original and
 * derivatives → hand back a descriptor. It deliberately does *not* write to the
 * database: `packages/db` owns the `media_assets` row, so this stays a pure
 * bytes-and-object-storage concern that a test can drive with an in-memory
 * StoragePort.
 *
 * Rejections carry a customer-facing reason, because "your file was too large"
 * is something the workshop's customer needs told, in their language, rather
 * than something that shows up only in a log.
 */

export interface MediaLimits {
  readonly maxImageBytes: number;
  readonly maxAudioBytes: number;
  readonly maxVideoBytes: number;
  readonly maxDocumentBytes: number;
  readonly maxDimensionPx: number;
  readonly thumbnailPx: number;
}

export function limitsFromEnv(env: Env): MediaLimits {
  return {
    maxImageBytes: env.MEDIA_MAX_IMAGE_BYTES,
    maxAudioBytes: env.MEDIA_MAX_AUDIO_BYTES,
    maxVideoBytes: env.MEDIA_MAX_VIDEO_BYTES,
    maxDocumentBytes: env.MEDIA_MAX_DOCUMENT_BYTES,
    maxDimensionPx: env.MEDIA_MAX_DIMENSION_PX,
    thumbnailPx: env.MEDIA_THUMBNAIL_PX,
  };
}

export interface IngestRequest {
  readonly shopId: string;
  /** Groups the object under a card once one exists; `inbox` until then. */
  readonly jobCardId?: string | null;
  readonly bytes: Buffer;
  /** What the sender claimed. A hint only — the bytes decide. */
  readonly declaredContentType?: string;
  readonly filename?: string | null;
  readonly origin: MediaOrigin;
  readonly providerMediaId?: string | null;
  readonly caption?: string | null;
  /**
   * Stores the audio and leaves the 16 kHz transcode to the worker.
   *
   * The webhook path sets this. Transcoding is the only step here that shells
   * out to ffmpeg, and a customer's phone should not hold a webhook open for
   * it — the `media.ingested` event the ingest emits is what the worker picks
   * up, so the derivative arrives moments later on a process that is actually
   * sized for it.
   */
  readonly deferAudio?: boolean;
}

export interface StoredMedia {
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
  /** Normalised derivative: rotated/resized image, or 16 kHz mono WAV. */
  readonly derivedKey: string | null;
  readonly derivedContentType: string | null;
  readonly providerMediaId: string | null;
  /** Non-fatal notes: a mismatched declared type, an unconvertible codec. */
  readonly warnings: readonly string[];
}

export type IngestRejection =
  | {
      readonly code: 'TOO_LARGE';
      readonly reason: string;
      readonly sizeBytes: number;
      readonly limitBytes: number;
    }
  | { readonly code: 'EMPTY'; readonly reason: string }
  | { readonly code: 'UNSUPPORTED_TYPE'; readonly reason: string; readonly contentType: string }
  | { readonly code: 'UNREADABLE'; readonly reason: string }
  /**
   * The scanner found something, or (fail-closed only) could not look.
   *
   * A rejection rather than a quarantine-and-store, and the reason is that
   * there is nothing useful to do with a stored infected file: no advisor
   * should open it, no customer should get it back, and keeping it means
   * keeping malware in a bucket the console has read access to.
   */
  | {
      readonly code: 'INFECTED';
      readonly reason: string;
      readonly signature: string;
    }
  | { readonly code: 'SCAN_UNAVAILABLE'; readonly reason: string };

export type IngestResult =
  | { readonly ok: true; readonly media: StoredMedia }
  | { readonly ok: false; readonly rejection: IngestRejection };

export interface MediaPipelineDeps {
  readonly storage: StoragePort;
  readonly limits: MediaLimits;
  readonly images?: ImageProcessorPort;
  readonly audio?: AudioNormaliserPort;
  readonly newId?: () => string;
  /**
   * Upload scanning (phase 7.1). Optional so a unit test need not stand one up;
   * every composition root supplies one, because `createChannelPorts` always
   * returns one.
   */
  readonly antivirus?: AntivirusPort;
  /**
   * Refuse the upload when the scanner cannot answer.
   *
   * The trade is real in both directions and the default is fail-*open*: this
   * is a workshop customer photographing a dashboard light, and a clamd restart
   * that eats their photo costs a job card. See `ANTIVIRUS_FAIL_CLOSED`.
   */
  readonly antivirusFailClosed?: boolean;
}

/** Re-exported: the rejection reason and the i18n copy must agree word for word. */
export { formatBytes };

export class MediaPipeline {
  private readonly images: ImageProcessorPort;
  private readonly audio: AudioNormaliserPort;
  private readonly newId: () => string;

  constructor(private readonly deps: MediaPipelineDeps) {
    this.images = deps.images ?? new SharpImageProcessor();
    this.audio = deps.audio ?? new CompositeAudioNormaliser(null);
    this.newId = deps.newId ?? uuidv7;
  }

  limitFor(kind: MediaKind): number {
    switch (kind) {
      case 'PHOTO':
        return this.deps.limits.maxImageBytes;
      case 'AUDIO':
        return this.deps.limits.maxAudioBytes;
      case 'VIDEO':
        return this.deps.limits.maxVideoBytes;
      case 'DOCUMENT':
        return this.deps.limits.maxDocumentBytes;
    }
  }

  async ingest(request: IngestRequest): Promise<IngestResult> {
    if (request.bytes.length === 0) {
      return {
        ok: false,
        rejection: { code: 'EMPTY', reason: 'The file arrived with no content' },
      };
    }

    const sniffed = sniffContentType(request.bytes, request.declaredContentType);
    const warnings: string[] = [];
    if (sniffed.declaredTypeMismatch) {
      // Recorded rather than fatal: phones mislabel constantly. What matters is
      // that the *stored* Content-Type comes from the bytes.
      warnings.push(
        `Sender declared "${request.declaredContentType ?? 'nothing'}" but the bytes are ${sniffed.contentType}`,
      );
    }

    const limit = this.limitFor(sniffed.kind);
    if (request.bytes.length > limit) {
      return {
        ok: false,
        rejection: {
          code: 'TOO_LARGE',
          reason: `That file is ${formatBytes(request.bytes.length)} — larger than the ${formatBytes(limit)} we can accept`,
          sizeBytes: request.bytes.length,
          limitBytes: limit,
        },
      };
    }

    /**
     * Scanned *before* the bytes reach object storage, which is the whole
     * point of where this line sits. Scanning after the put would mean an
     * infected file exists in a bucket the console can read, and the cleanup
     * would be a delete that has to succeed — one more thing that can fail
     * while malware is at rest in somebody's GCS bucket.
     */
    const scanner = this.deps.antivirus;
    if (scanner !== undefined) {
      const verdict = await scanner.scan(request.bytes, request.filename ?? null);
      if (verdict.status === 'INFECTED') {
        return {
          ok: false,
          rejection: {
            code: 'INFECTED',
            reason: 'That file did not pass our virus scan, so we have not stored it',
            signature: verdict.signature,
          },
        };
      }
      if (verdict.status === 'UNAVAILABLE') {
        if (this.deps.antivirusFailClosed === true) {
          return {
            ok: false,
            rejection: {
              code: 'SCAN_UNAVAILABLE',
              reason: `The virus scanner could not check that file (${verdict.reason})`,
            },
          };
        }
        // Fail-open, but never silently: the warning rides on the stored media
        // descriptor, so "which files went in unscanned during the outage" is
        // answerable afterwards instead of being a shrug.
        warnings.push(`Virus scan unavailable: ${verdict.reason}`);
      }
    }

    const mediaId = this.newId();
    const jobCardId = request.jobCardId ?? 'inbox';

    const originalKey = mediaKey({
      shopId: request.shopId,
      jobCardId,
      mediaId,
      kind: sniffed.kind,
      extension: sniffed.extension,
    });

    // The original always lands first and is never mutated: a derivative can be
    // regenerated, but the bytes the customer actually sent cannot.
    const stored = await this.deps.storage.put({
      key: originalKey,
      body: request.bytes,
      contentType: sniffed.contentType,
      metadata: {
        shopId: request.shopId,
        origin: request.origin,
        ...(request.filename === null || request.filename === undefined
          ? {}
          : { filename: request.filename }),
      },
    });

    const derived = await this.derive(request, mediaId, jobCardId, sniffed, warnings);

    return {
      ok: true,
      media: {
        mediaId,
        kind: sniffed.kind,
        bucket: stored.bucket,
        storageKey: stored.key,
        contentType: sniffed.contentType,
        sizeBytes: stored.sizeBytes,
        checksumSha256: stored.checksumSha256,
        providerMediaId: request.providerMediaId ?? null,
        warnings,
        ...derived,
      },
    };
  }

  /**
   * Produces the 16 kHz mono WAV for audio that was stored with `deferAudio`.
   *
   * The worker calls this with the bytes it read back from object storage, so
   * the derivative lands under the same key layout as an inline transcode would
   * have used — a DPDP erasure that enumerates the media id still sweeps it up.
   */
  async normaliseStoredAudio(input: {
    readonly shopId: string;
    readonly jobCardId: string | null;
    readonly mediaId: string;
    readonly bytes: Buffer;
    readonly contentType: string;
  }): Promise<
    | {
        readonly ok: true;
        readonly derivedKey: string;
        readonly contentType: string;
        readonly durationMs: number;
      }
    | { readonly ok: false; readonly reason: string }
  > {
    const result = await this.audio.toPcm16kMono(input.bytes, input.contentType);
    if (!result.ok) return { ok: false, reason: describeAudioFailure(result.failure) };

    const derivedKey = derivativeKey(
      input.shopId,
      input.jobCardId ?? 'inbox',
      input.mediaId,
      'pcm16k',
      'wav',
    );
    await this.deps.storage.put({
      key: derivedKey,
      body: result.audio.bytes,
      contentType: result.audio.contentType,
      metadata: { shopId: input.shopId, derivedFrom: input.mediaId, sampleRate: '16000' },
    });

    return {
      ok: true,
      derivedKey,
      contentType: result.audio.contentType,
      durationMs: result.audio.durationMs,
    };
  }

  private async derive(
    request: IngestRequest,
    mediaId: string,
    jobCardId: string,
    sniffed: SniffResult,
    warnings: string[],
  ): Promise<
    Pick<
      StoredMedia,
      'thumbnailKey' | 'widthPx' | 'heightPx' | 'durationMs' | 'derivedKey' | 'derivedContentType'
    >
  > {
    const empty = {
      thumbnailKey: null,
      widthPx: null,
      heightPx: null,
      durationMs: null,
      derivedKey: null,
      derivedContentType: null,
    };

    if (sniffed.kind === 'PHOTO') {
      try {
        const normalised = await this.images.normalise(
          request.bytes,
          this.deps.limits.maxDimensionPx,
        );
        const thumbnail = await this.images.thumbnail(request.bytes, this.deps.limits.thumbnailPx);

        const derivedKey = derivativeKey(request.shopId, jobCardId, mediaId, 'normalised', 'jpg');
        const thumbnailKey = derivativeKey(request.shopId, jobCardId, mediaId, 'thumb', 'jpg');

        await this.deps.storage.put({
          key: derivedKey,
          body: normalised.bytes,
          contentType: normalised.contentType,
          metadata: { shopId: request.shopId, derivedFrom: mediaId },
        });
        await this.deps.storage.put({
          key: thumbnailKey,
          body: thumbnail.bytes,
          contentType: thumbnail.contentType,
          metadata: { shopId: request.shopId, derivedFrom: mediaId },
        });

        return {
          thumbnailKey,
          widthPx: normalised.widthPx,
          heightPx: normalised.heightPx,
          durationMs: null,
          derivedKey,
          derivedContentType: normalised.contentType,
        };
      } catch (error) {
        // A corrupt image still gets stored — a human can look at it, and OCR
        // can still be attempted on the original.
        warnings.push(
          `Image could not be normalised: ${error instanceof Error ? error.message : String(error)}`,
        );
        return empty;
      }
    }

    if (sniffed.kind === 'AUDIO') {
      if (request.deferAudio === true) return empty;

      const result = await this.audio.toPcm16kMono(request.bytes, sniffed.contentType);
      if (!result.ok) {
        warnings.push(describeAudioFailure(result.failure));
        return empty;
      }

      const derivedKey = derivativeKey(request.shopId, jobCardId, mediaId, 'pcm16k', 'wav');
      await this.deps.storage.put({
        key: derivedKey,
        body: result.audio.bytes,
        contentType: result.audio.contentType,
        metadata: { shopId: request.shopId, derivedFrom: mediaId, sampleRate: '16000' },
      });

      return {
        thumbnailKey: null,
        widthPx: null,
        heightPx: null,
        durationMs: result.audio.durationMs,
        derivedKey,
        derivedContentType: result.audio.contentType,
      };
    }

    return empty;
  }
}

/**
 * Derivatives live under the original's id, so a DPDP erasure that enumerates
 * `shops/<shop>/…/<mediaId>` sweeps up the thumbnail and the transcode too.
 */
function derivativeKey(
  shopId: string,
  jobCardId: string,
  mediaId: string,
  variant: string,
  extension: string,
): string {
  return `shops/${shopId}/job-cards/${jobCardId}/derived/${mediaId}.${variant}.${extension}`;
}

function describeAudioFailure(failure: AudioNormalisationFailure): string {
  switch (failure.kind) {
    case 'UNSUPPORTED_SOURCE_FORMAT':
      return `Audio kept as sent: no transcoder available for ${failure.contentType} (set FFMPEG_PATH to enable one)`;
    case 'TOOL_UNAVAILABLE':
      return `Audio kept as sent: ${failure.detail}`;
    case 'CORRUPT_SOURCE':
      return `Audio kept as sent: the file could not be decoded (${failure.detail})`;
    case 'CONVERSION_FAILED':
      return `Audio kept as sent: conversion failed (${failure.detail})`;
  }
}

export function createAudioNormaliser(env: Env): AudioNormaliserPort {
  return new CompositeAudioNormaliser(
    env.FFMPEG_PATH === undefined ? null : new FfmpegAudioNormaliser(env.FFMPEG_PATH),
  );
}

export function createMediaPipeline(
  env: Env,
  storage: StoragePort,
  antivirus?: AntivirusPort,
): MediaPipeline {
  return new MediaPipeline({
    storage,
    limits: limitsFromEnv(env),
    images: new SharpImageProcessor(),
    audio: createAudioNormaliser(env),
    antivirus: antivirus ?? createAntivirusPort(env),
    antivirusFailClosed: env.ANTIVIRUS_FAIL_CLOSED,
  });
}
