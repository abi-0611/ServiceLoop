import type { MediaPipeline, StoragePort } from '@serviceloop/adapters';
import { ObjectNotFoundError } from '@serviceloop/adapters';
import { PgMediaStore } from '@serviceloop/db';
import type { EventHandler, HandlerContext } from './registry';

/**
 * Audio → 16 kHz mono WAV, off the webhook path (phase 2.4).
 *
 * The webhook stores the original and emits `media.ingested`; this handler
 * produces the derivative phase 4's speech-to-text consumes. Two reasons it
 * lives here rather than inline:
 *
 * - **ffmpeg is the only thing in the pipeline that shells out.** A customer's
 *   phone should not hold a webhook open for a subprocess, and Meta redelivers
 *   anything that takes too long.
 * - **The worker is where the binary actually is.** An API container sized for
 *   HTTP need not carry a media toolchain.
 *
 * It runs inside the consumer's transaction next to the idempotency claim, so a
 * redelivered event cannot transcode the same file twice — and a file that
 * already has a derivative is skipped, which makes a manual replay safe.
 */
export function createAudioTranscodeHandler(
  pipeline: MediaPipeline,
  storage: StoragePort,
): EventHandler {
  const media = new PgMediaStore();

  return {
    name: 'audio-transcode',
    handles: ['media.ingested'],

    async handle(context: HandlerContext): Promise<Record<string, unknown>> {
      const envelope = context.envelope;
      if (envelope.type !== 'media.ingested') return { skipped: 'wrong event type' };
      if (envelope.payload.kind !== 'AUDIO') return { skipped: 'not audio' };

      const asset = await media.findById(context.tx, envelope.shopId, envelope.payload.mediaId);
      if (asset === null) return { skipped: 'asset not found' };
      if (asset.derivedKey !== null) return { skipped: 'already transcoded' };

      let original;
      try {
        original = await storage.get(asset.storageKey);
      } catch (error) {
        if (error instanceof ObjectNotFoundError) {
          // A DPDP erasure between ingest and this job is a legitimate outcome,
          // not a failure to retry: the bytes are gone on purpose.
          context.logger.warn(
            { mediaId: asset.id, key: asset.storageKey },
            'audio object is gone; nothing to transcode',
          );
          return { skipped: 'object erased' };
        }
        throw error;
      }

      const result = await pipeline.normaliseStoredAudio({
        shopId: asset.shopId,
        jobCardId: asset.jobCardId,
        mediaId: asset.id,
        bytes: original.body,
        contentType: asset.contentType,
      });

      if (!result.ok) {
        // Not an error: an environment with no ffmpeg is a supported
        // configuration, and the original is still stored and still playable.
        context.logger.info(
          { mediaId: asset.id, reason: result.reason },
          'audio kept as sent; no transcode available',
        );
        return { transcoded: false, reason: result.reason };
      }

      await media.attachDerivative(context.tx, {
        shopId: asset.shopId,
        mediaId: asset.id,
        derivedKey: result.derivedKey,
        derivedContentType: result.contentType,
        durationMs: result.durationMs,
      });

      return {
        transcoded: true,
        derivedKey: result.derivedKey,
        durationMs: result.durationMs,
      };
    },
  };
}
