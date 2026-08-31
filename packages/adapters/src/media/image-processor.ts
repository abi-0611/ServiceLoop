import sharp from 'sharp';

/**
 * Image normalisation for the media pipeline.
 *
 * Three jobs, all of which matter downstream:
 *
 *  - **EXIF rotation.** A photo of a paper job card taken in portrait on an
 *    Android phone is very often stored landscape with an orientation tag. A
 *    vision model reading raw pixels sees it sideways, and OCR accuracy falls
 *    off a cliff. Baking the rotation in is the single highest-value step here.
 *  - **Bounding the longest edge.** A 12-megapixel photo costs vision tokens
 *    and storage without adding legible detail; 2200px keeps handwriting
 *    readable while cutting the payload by an order of magnitude.
 *  - **A thumbnail**, so the Conversations inbox can render a thread without
 *    pulling full-resolution originals over a workshop's phone connection.
 *
 * The original bytes are always kept: the normalised copy is a derivative, and
 * evidence must stay auditable back to what was actually received.
 */

export interface ImageMetadata {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly format: string;
}

export interface NormalisedImage {
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly widthPx: number;
  readonly heightPx: number;
  /** True when the output is byte-identical in purpose to the input. */
  readonly unchanged: boolean;
}

export interface ImageProcessorPort {
  metadata(bytes: Buffer): Promise<ImageMetadata>;
  /** EXIF-rotates and bounds the longest edge to `maxDimensionPx`. */
  normalise(bytes: Buffer, maxDimensionPx: number): Promise<NormalisedImage>;
  /** A square, centre-cropped thumbnail for the inbox. */
  thumbnail(bytes: Buffer, sizePx: number): Promise<NormalisedImage>;
}

export class SharpImageProcessor implements ImageProcessorPort {
  async metadata(bytes: Buffer): Promise<ImageMetadata> {
    const meta = await sharp(bytes).metadata();
    // `autoOrient` swaps the axes for orientations 5–8; report post-rotation
    // dimensions so callers never see the pre-rotation ones.
    const rotated = (meta.orientation ?? 1) >= 5;
    return {
      widthPx: (rotated ? meta.height : meta.width) ?? 0,
      heightPx: (rotated ? meta.width : meta.height) ?? 0,
      format: meta.format ?? 'unknown',
    };
  }

  async normalise(bytes: Buffer, maxDimensionPx: number): Promise<NormalisedImage> {
    const meta = await this.metadata(bytes);
    const longestEdge = Math.max(meta.widthPx, meta.heightPx);
    const needsResize = longestEdge > maxDimensionPx;

    // `autoOrient` bakes the EXIF orientation into the pixels and drops the
    // tag, so no later consumer can apply it a second time.
    const pipeline = sharp(bytes).autoOrient();

    if (needsResize) {
      pipeline.resize({
        width: maxDimensionPx,
        height: maxDimensionPx,
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    // JPEG at 88 is where handwriting stops losing strokes; mozjpeg buys
    // roughly 10% more for free.
    const output = await pipeline.jpeg({ quality: 88, mozjpeg: true }).toBuffer({
      resolveWithObject: true,
    });

    return {
      bytes: output.data,
      contentType: 'image/jpeg',
      widthPx: output.info.width,
      heightPx: output.info.height,
      unchanged: false,
    };
  }

  async thumbnail(bytes: Buffer, sizePx: number): Promise<NormalisedImage> {
    const output = await sharp(bytes)
      .autoOrient()
      .resize({ width: sizePx, height: sizePx, fit: 'cover', position: 'centre' })
      .jpeg({ quality: 72, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });

    return {
      bytes: output.data,
      contentType: 'image/jpeg',
      widthPx: output.info.width,
      heightPx: output.info.height,
      unchanged: false,
    };
  }
}
