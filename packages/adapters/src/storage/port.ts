import type { MediaKind } from '@serviceloop/shared';

/**
 * StoragePort — the only way ServiceLoop touches object storage (master §5).
 *
 * Two adapters ship with this port: `S3Storage` (MinIO in dev, any
 * S3-compatible endpoint in prod) and `InMemoryStorage` (deterministic, used by
 * tests and the demo runner). Both are production-quality implementations of
 * the same contract.
 */

export interface StorageObjectRef {
  readonly bucket: string;
  readonly key: string;
}

export interface PutObjectInput {
  readonly key: string;
  readonly body: Buffer;
  readonly contentType: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface PutObjectResult extends StorageObjectRef {
  readonly sizeBytes: number;
  readonly checksumSha256: string;
}

export interface GetObjectResult {
  readonly body: Buffer;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface ObjectHead {
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly lastModified: Date;
}

export interface StoragePort {
  /** Idempotent: creating an existing bucket is not an error. */
  ensureBucket(): Promise<void>;
  put(input: PutObjectInput): Promise<PutObjectResult>;
  get(key: string): Promise<GetObjectResult>;
  head(key: string): Promise<ObjectHead | null>;
  delete(key: string): Promise<void>;
  /** Time-limited read URL handed to WhatsApp/console clients. */
  presignGet(key: string, expiresInSeconds: number): Promise<string>;
  presignPut(key: string, contentType: string, expiresInSeconds: number): Promise<string>;
  readonly bucket: string;
  readonly driver: 'memory' | 's3';
}

export class ObjectNotFoundError extends Error {
  constructor(readonly key: string) {
    super(`Object not found: ${key}`);
    this.name = 'ObjectNotFoundError';
  }
}

/**
 * Deterministic key layout. Everything is shop-scoped so a DPDP deletion
 * request can enumerate a customer's media by prefix, and so bucket policies
 * can be written per shop.
 */
export function mediaKey(input: {
  shopId: string;
  jobCardId: string;
  mediaId: string;
  kind: MediaKind;
  extension: string;
}): string {
  const folder = input.kind.toLowerCase();
  const extension = input.extension.replace(/^\./, '');
  return `shops/${input.shopId}/job-cards/${input.jobCardId}/${folder}/${input.mediaId}.${extension}`;
}
