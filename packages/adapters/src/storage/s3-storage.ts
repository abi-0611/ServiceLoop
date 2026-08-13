import { createHash } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  type GetObjectResult,
  type ObjectHead,
  ObjectNotFoundError,
  type PutObjectInput,
  type PutObjectResult,
  type StoragePort,
} from './port';

/**
 * S3-compatible StoragePort. Backs MinIO in development and any S3-compatible
 * endpoint in production; GCS is reached through its S3 interoperability
 * endpoint until the native GCS adapter lands.
 */

export interface S3StorageOptions {
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
  readonly forcePathStyle: boolean;
}

function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata
    ?.httpStatusCode;
  return name === 'NotFound' || name === 'NoSuchKey' || status === 404;
}

export class S3Storage implements StoragePort {
  readonly driver = 's3' as const;
  readonly bucket: string;

  private readonly client: S3Client;

  constructor(options: S3StorageOptions) {
    this.bucket = options.bucket;
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: options.forcePathStyle,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return;
    } catch (error) {
      if (!isNotFound(error)) {
        const name = (error as { name?: string }).name;
        // MinIO answers 403 for a bucket owned by someone else; surface that.
        if (name !== 'NotFound' && name !== 'NoSuchBucket') throw error;
      }
    }
    await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
  }

  async put(input: PutObjectInput): Promise<PutObjectResult> {
    const checksum = createHash('sha256').update(input.body).digest('hex');

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        Metadata: { ...(input.metadata ?? {}), 'sha256-hex': checksum },
      }),
    );

    return {
      bucket: this.bucket,
      key: input.key,
      sizeBytes: input.body.byteLength,
      checksumSha256: checksum,
    };
  }

  async get(key: string): Promise<GetObjectResult> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const body = response.Body;
      if (body === undefined) throw new ObjectNotFoundError(key);

      const bytes = await body.transformToByteArray();
      return {
        body: Buffer.from(bytes),
        contentType: response.ContentType ?? 'application/octet-stream',
        sizeBytes: bytes.byteLength,
        metadata: response.Metadata ?? {},
      };
    } catch (error) {
      if (isNotFound(error)) throw new ObjectNotFoundError(key);
      throw error;
    }
  }

  async head(key: string): Promise<ObjectHead | null> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        sizeBytes: response.ContentLength ?? 0,
        contentType: response.ContentType ?? 'application/octet-stream',
        lastModified: response.LastModified ?? new Date(0),
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async presignGet(key: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  }

  async presignPut(key: string, contentType: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
      { expiresIn: expiresInSeconds },
    );
  }

  async close(): Promise<void> {
    this.client.destroy();
  }
}
