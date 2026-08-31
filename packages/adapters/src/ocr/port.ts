import type { JobCardDraft, Language } from '@serviceloop/shared';

/**
 * `OcrPort` — reading a photographed paper job card (master L2, phase 2.5).
 *
 * The paper path is not a fallback, it is the flagship on-ramp, so it gets a
 * port of its own rather than being an inline call to a model. Two adapters
 * ship with it: `VisionLlmOcrAdapter`, which runs a vision model through
 * `LlmPort`, and `FixtureOcrAdapter`, which resolves images by content hash
 * against a registered golden set. The second is what makes `pnpm eval:ocr`
 * and the demo deterministic.
 *
 * What comes back is a *draft*, never a record. Nothing here writes to the
 * database; `IntakeService.confirm` does that, after a human has looked.
 */

export interface OcrExtractInput {
  readonly shopId: string;
  readonly bytes: Buffer;
  /** Sniffed content type of the image. Not the sender's claim. */
  readonly contentType: string;
  /** The shop's default language, used only to break ties. */
  readonly languageHint?: Language;
  /** Free-text caption sent with the photo; often carries the customer name. */
  readonly caption?: string | null;
  readonly traceId?: string;
}

export interface OcrExtraction {
  readonly draft: JobCardDraft;
  /** Which model read the card. Recorded on the draft for provenance. */
  readonly model: string;
  readonly promptHash: string;
  readonly latencyMs: number;
  /** The raw JSON the extractor produced, kept for the eval harness. */
  readonly raw: string;
}

export interface OcrPort {
  readonly driver: 'vision-llm' | 'fixture';
  extractJobCard(input: OcrExtractInput): Promise<OcrExtraction>;
}

export class OcrUnsupportedImageError extends Error {
  constructor(readonly contentType: string) {
    super(`A job card cannot be read from ${contentType}; send a photo (JPEG, PNG or WebP)`);
    this.name = 'OcrUnsupportedImageError';
  }
}

const SUPPORTED: Readonly<Record<string, 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'>> =
  {
    'image/jpeg': 'image/jpeg',
    'image/jpg': 'image/jpeg',
    'image/png': 'image/png',
    'image/webp': 'image/webp',
    'image/gif': 'image/gif',
  };

/** Narrows a sniffed content type to what a vision model will accept. */
export function toVisionMediaType(
  contentType: string,
): 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' {
  const media = SUPPORTED[contentType.toLowerCase()];
  if (media === undefined) throw new OcrUnsupportedImageError(contentType);
  return media;
}
