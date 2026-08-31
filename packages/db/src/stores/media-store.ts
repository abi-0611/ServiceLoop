import type {
  HandoffAdvisor,
  InsertMediaAssetInput,
  MediaAssetRecord,
  MediaStore,
  ShopDirectory,
} from '@serviceloop/domain';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { mediaAssets } from '../schema/jobs';
import { shops, staff } from '../schema/core';

/**
 * Media assets and shop identity (phase 2.4).
 *
 * The bytes live in object storage and the pipeline in `packages/adapters` put
 * them there; this file records where they went, so a DPDP erasure has
 * something to enumerate and the inbox has something to render a thumbnail
 * from.
 */

const MEDIA_COLUMNS = {
  id: mediaAssets.id,
  shopId: mediaAssets.shopId,
  jobCardId: mediaAssets.jobCardId,
  kind: mediaAssets.kind,
  origin: mediaAssets.origin,
  bucket: mediaAssets.bucket,
  storageKey: mediaAssets.storageKey,
  contentType: mediaAssets.contentType,
  sizeBytes: mediaAssets.sizeBytes,
  checksumSha256: mediaAssets.checksumSha256,
  caption: mediaAssets.caption,
  thumbnailKey: mediaAssets.thumbnailKey,
  widthPx: mediaAssets.widthPx,
  heightPx: mediaAssets.heightPx,
  durationMs: mediaAssets.durationMs,
  derivedKey: mediaAssets.derivedKey,
  derivedContentType: mediaAssets.derivedContentType,
  providerMediaId: mediaAssets.providerMediaId,
  createdAt: mediaAssets.createdAt,
} as const;

export class PgMediaStore implements MediaStore<Tx> {
  async insert(tx: Tx, input: InsertMediaAssetInput): Promise<void> {
    await tx.insert(mediaAssets).values({
      id: input.id,
      shopId: input.shopId,
      jobCardId: input.jobCardId,
      kind: input.kind,
      origin: input.origin,
      bucket: input.bucket,
      storageKey: input.storageKey,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      checksumSha256: input.checksumSha256,
      caption: input.caption,
      thumbnailKey: input.thumbnailKey,
      widthPx: input.widthPx,
      heightPx: input.heightPx,
      durationMs: input.durationMs,
      derivedKey: input.derivedKey,
      derivedContentType: input.derivedContentType,
      providerMediaId: input.providerMediaId,
      capturedById: input.capturedById,
      capturedAt: input.capturedAt,
    });
  }

  async findById(tx: Tx, shopId: string, mediaId: string): Promise<MediaAssetRecord | null> {
    const rows = await tx
      .select(MEDIA_COLUMNS)
      .from(mediaAssets)
      .where(
        and(
          eq(mediaAssets.id, mediaId),
          eq(mediaAssets.shopId, shopId),
          sql`${mediaAssets.deletedAt} is null`,
        ),
      )
      .limit(1);

    return rows[0] ?? null;
  }

  /**
   * Meta redelivers a webhook on any non-2xx, and the same photograph arrives
   * with the same media id. Re-using the stored object means the provider's
   * 30-day media window is spent once rather than once per retry.
   */
  async findByProviderMediaId(
    tx: Tx,
    shopId: string,
    providerMediaId: string,
  ): Promise<MediaAssetRecord | null> {
    const rows = await tx
      .select(MEDIA_COLUMNS)
      .from(mediaAssets)
      .where(
        and(
          eq(mediaAssets.shopId, shopId),
          eq(mediaAssets.providerMediaId, providerMediaId),
          sql`${mediaAssets.deletedAt} is null`,
        ),
      )
      .limit(1);

    return rows[0] ?? null;
  }

  async attachDerivative(
    tx: Tx,
    input: {
      readonly shopId: string;
      readonly mediaId: string;
      readonly derivedKey: string;
      readonly derivedContentType: string;
      readonly durationMs: number | null;
    },
  ): Promise<void> {
    await tx
      .update(mediaAssets)
      .set({
        derivedKey: input.derivedKey,
        derivedContentType: input.derivedContentType,
        // A duration the transcoder measured beats one the sender declared, but
        // a null result must not erase what we already knew.
        ...(input.durationMs === null ? {} : { durationMs: input.durationMs }),
      })
      .where(and(eq(mediaAssets.id, input.mediaId), eq(mediaAssets.shopId, input.shopId)));
  }

  /** Audio stored with `deferAudio` and still waiting for its 16 kHz WAV. */
  async pendingAudioDerivatives(
    tx: Tx,
    shopId: string,
    limit: number,
  ): Promise<readonly MediaAssetRecord[]> {
    return tx
      .select(MEDIA_COLUMNS)
      .from(mediaAssets)
      .where(
        and(
          eq(mediaAssets.shopId, shopId),
          eq(mediaAssets.kind, 'AUDIO'),
          sql`${mediaAssets.derivedKey} is null`,
          sql`${mediaAssets.deletedAt} is null`,
        ),
      )
      .orderBy(asc(mediaAssets.createdAt))
      .limit(limit);
  }
}

/* -------------------------------------------------------------------------- *
 * Shop identity
 * -------------------------------------------------------------------------- */

/**
 * Who the shop is, for the copy that says so.
 *
 * Kept apart from `PgShopConfigStore` because they answer different questions,
 * and because a message that names the wrong advisor is a different class of
 * bug from a misread quiet-hours window.
 */
export class PgShopDirectory implements ShopDirectory<Tx> {
  async loadShopName(tx: Tx, shopId: string): Promise<string | null> {
    const rows = await tx
      .select({ name: shops.name })
      .from(shops)
      .where(eq(shops.id, shopId))
      .limit(1);
    return rows[0]?.name ?? null;
  }

  /**
   * The person a handoff names.
   *
   * An ADVISOR is preferred over the OWNER because that is whose job it is; the
   * owner is the fallback for a one-person shop. Ordering by `createdAt` keeps
   * the answer stable, so the same customer is not promised a different name
   * every time they ask.
   */
  /**
   * Which shop a webhook belongs to.
   *
   * Meta posts every shop's traffic to one URL, and the only stable shop
   * identity in the payload is `metadata.phone_number_id`. Resolving it here
   * rather than trusting anything else in the body matters: the body is
   * attacker-controlled until the signature has been checked, and even after,
   * a spoofed shop id would be a cross-tenant write.
   */
  async findShopByPhoneNumberId(tx: Tx, phoneNumberId: string): Promise<string | null> {
    const rows = await tx.execute<{ shop_id: string }>(sql`
      select shop_id from shop_config
      where config -> 'messaging' ->> 'whatsappPhoneNumberId' = ${phoneNumberId}
      limit 1
    `);
    return rows.rows[0]?.shop_id ?? null;
  }

  /** The only shop, when there is exactly one. Sandbox and single-tenant dev. */
  async soleShopId(tx: Tx): Promise<string | null> {
    const rows = await tx
      .select({ id: shops.id })
      .from(shops)
      .where(sql`${shops.deletedAt} is null`)
      .limit(2);

    return rows.length === 1 ? (rows[0]?.id ?? null) : null;
  }

  async loadHandoffAdvisor(tx: Tx, shopId: string): Promise<HandoffAdvisor | null> {
    const rows = await tx
      .select({ id: staff.id, fullName: staff.fullName })
      .from(staff)
      .where(
        and(
          eq(staff.shopId, shopId),
          eq(staff.isActive, true),
          sql`${staff.deletedAt} is null`,
          sql`${staff.role} in ('ADVISOR', 'OWNER')`,
        ),
      )
      .orderBy(sql`case ${staff.role} when 'ADVISOR' then 0 else 1 end`, asc(staff.createdAt))
      .limit(1);

    return rows[0] ?? null;
  }
}
