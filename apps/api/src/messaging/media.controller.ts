import { Controller, Get, Inject, Res } from '@nestjs/common';
import { ObjectNotFoundError, type StoragePort } from '@serviceloop/adapters';
import type { MediaService } from '@serviceloop/domain';
import type { Tx } from '@serviceloop/db';
import { NotFoundError } from '@serviceloop/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentStaff, type AuthenticatedStaff } from '../auth/auth.types';
import { ZodParam } from '../common/zod';
import { MEDIA_SERVICE, STORAGE } from '../infra/tokens';

/**
 * Serving inbound media to the console (phase 2.4).
 *
 * The bytes are streamed through the API rather than handed out as a presigned
 * URL. A presigned URL is a bearer token for an object: it survives being
 * pasted into a chat, it outlives the session that minted it, and it carries no
 * shop scope. Proxying costs a hop and keeps every read behind the same
 * authentication and the same `shopId` check as everything else.
 */
const UUID = z.string().uuid();

@Controller('media')
export class MediaController {
  constructor(
    @Inject(MEDIA_SERVICE) private readonly media: MediaService<Tx>,
    @Inject(STORAGE) private readonly storage: StoragePort,
  ) {}

  @Get(':id')
  async original(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodParam('id', UUID) id: string,
    @Res() response: Response,
  ): Promise<void> {
    await this.stream(staff.shopId, id, 'original', response);
  }

  @Get(':id/thumbnail')
  async thumbnail(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodParam('id', UUID) id: string,
    @Res() response: Response,
  ): Promise<void> {
    await this.stream(staff.shopId, id, 'thumbnail', response);
  }

  private async stream(
    shopId: string,
    mediaId: string,
    variant: 'original' | 'thumbnail',
    response: Response,
  ): Promise<void> {
    const asset = await this.media.load(shopId, mediaId);
    if (asset === null) throw new NotFoundError('MediaAsset', mediaId);

    // A thumbnail is a derivative and may legitimately be absent (audio, a
    // document, an image sharp could not read); falling back to the original
    // beats a broken image in the inbox.
    const key =
      variant === 'thumbnail' && asset.thumbnailKey !== null
        ? asset.thumbnailKey
        : asset.storageKey;
    const contentType =
      variant === 'thumbnail' && asset.thumbnailKey !== null ? 'image/jpeg' : asset.contentType;

    try {
      const object = await this.storage.get(key);
      response.setHeader('content-type', contentType);
      response.setHeader('content-length', String(object.body.byteLength));
      // Media is immutable once stored, so it can be cached hard — but only
      // privately: this is a customer's photograph, not a public asset.
      response.setHeader('cache-control', 'private, max-age=3600');
      response.end(object.body);
    } catch (error) {
      if (error instanceof ObjectNotFoundError) throw new NotFoundError('MediaAsset', mediaId);
      throw error;
    }
  }
}
