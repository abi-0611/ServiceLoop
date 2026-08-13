import { createHash } from 'node:crypto';
import {
  type GetObjectResult,
  type ObjectHead,
  ObjectNotFoundError,
  type PutObjectInput,
  type PutObjectResult,
  type StoragePort,
} from './port';

/**
 * Sandbox StoragePort. Deterministic and dependency-free: the demo runner, unit
 * tests and CI use it so a full journey can run without MinIO.
 *
 * Presigned URLs are synthesised as `memory://` URLs carrying an expiry — the
 * console's sandbox simulator resolves them through the API rather than
 * fetching them directly.
 */

interface StoredObject {
  readonly body: Buffer;
  readonly contentType: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly lastModified: Date;
}

export class InMemoryStorage implements StoragePort {
  readonly driver = 'memory' as const;

  private readonly objects = new Map<string, StoredObject>();
  private bucketCreated = false;

  constructor(
    readonly bucket: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async ensureBucket(): Promise<void> {
    this.bucketCreated = true;
  }

  async put(input: PutObjectInput): Promise<PutObjectResult> {
    if (!this.bucketCreated) await this.ensureBucket();

    this.objects.set(input.key, {
      body: Buffer.from(input.body),
      contentType: input.contentType,
      metadata: { ...(input.metadata ?? {}) },
      lastModified: this.now(),
    });

    return {
      bucket: this.bucket,
      key: input.key,
      sizeBytes: input.body.byteLength,
      checksumSha256: createHash('sha256').update(input.body).digest('hex'),
    };
  }

  async get(key: string): Promise<GetObjectResult> {
    const object = this.objects.get(key);
    if (object === undefined) throw new ObjectNotFoundError(key);
    return {
      body: Buffer.from(object.body),
      contentType: object.contentType,
      sizeBytes: object.body.byteLength,
      metadata: object.metadata,
    };
  }

  async head(key: string): Promise<ObjectHead | null> {
    const object = this.objects.get(key);
    if (object === undefined) return null;
    return {
      sizeBytes: object.body.byteLength,
      contentType: object.contentType,
      lastModified: object.lastModified,
    };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async presignGet(key: string, expiresInSeconds: number): Promise<string> {
    const expiresAt = this.now().getTime() + expiresInSeconds * 1000;
    return `memory://${this.bucket}/${key}?expiresAt=${expiresAt}`;
  }

  async presignPut(key: string, contentType: string, expiresInSeconds: number): Promise<string> {
    const expiresAt = this.now().getTime() + expiresInSeconds * 1000;
    return `memory://${this.bucket}/${key}?upload=1&contentType=${encodeURIComponent(contentType)}&expiresAt=${expiresAt}`;
  }

  /** Test/demo helpers — not part of StoragePort. */
  keys(): string[] {
    return [...this.objects.keys()].sort();
  }

  size(): number {
    return this.objects.size;
  }

  clear(): void {
    this.objects.clear();
  }
}
