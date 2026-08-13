import { loadEnv } from '@serviceloop/config';
import { describe, expect, it } from 'vitest';
import { createNotifierPort, createStoragePort } from './factory';
import { InMemoryNotifier, LoggingNotifier } from './notifier/sandbox-notifiers';
import { InMemoryStorage } from './storage/in-memory-storage';
import { mediaKey, ObjectNotFoundError } from './storage/port';

describe('InMemoryStorage', () => {
  it('round-trips an object with its checksum and metadata', async () => {
    const storage = new InMemoryStorage('serviceloop-media');
    await storage.ensureBucket();

    const body = Buffer.from('brake pad photo');
    const put = await storage.put({
      key: 'shops/s1/job-cards/j1/photo/m1.jpg',
      body,
      contentType: 'image/jpeg',
      metadata: { capturedBy: 'tech-1' },
    });

    expect(put.sizeBytes).toBe(body.byteLength);
    expect(put.checksumSha256).toMatch(/^[0-9a-f]{64}$/);

    const fetched = await storage.get(put.key);
    expect(fetched.body.toString()).toBe('brake pad photo');
    expect(fetched.contentType).toBe('image/jpeg');
    expect(fetched.metadata['capturedBy']).toBe('tech-1');

    const head = await storage.head(put.key);
    expect(head?.sizeBytes).toBe(body.byteLength);
  });

  it('reports a missing object rather than returning empty content', async () => {
    const storage = new InMemoryStorage('serviceloop-media');
    await expect(storage.get('missing')).rejects.toBeInstanceOf(ObjectNotFoundError);
    expect(await storage.head('missing')).toBeNull();
  });

  it('deletes objects and issues presigned URLs that carry an expiry', async () => {
    const storage = new InMemoryStorage(
      'serviceloop-media',
      () => new Date('2026-04-01T00:00:00Z'),
    );
    await storage.put({ key: 'k', body: Buffer.from('x'), contentType: 'text/plain' });

    const url = await storage.presignGet('k', 900);
    expect(url).toContain('memory://serviceloop-media/k');
    expect(url).toContain(`expiresAt=${new Date('2026-04-01T00:15:00Z').getTime()}`);

    await storage.delete('k');
    expect(storage.size()).toBe(0);
  });

  it('lays media keys out shop-first so a DPDP deletion can enumerate by prefix', () => {
    expect(
      mediaKey({
        shopId: 'shop-1',
        jobCardId: 'card-1',
        mediaId: 'media-1',
        kind: 'PHOTO',
        extension: '.jpg',
      }),
    ).toBe('shops/shop-1/job-cards/card-1/photo/media-1.jpg');
  });
});

describe('notifiers', () => {
  it('logs the OTP code while masking the recipient', async () => {
    const lines: Array<[string, Record<string, unknown>]> = [];
    const notifier = new LoggingNotifier((line, fields) => lines.push([line, fields]));

    const receipt = await notifier.deliver({
      kind: 'STAFF_OTP',
      to: '+919876543210',
      code: '123456',
      ttlSeconds: 300,
      language: 'en',
    });

    expect(receipt.accepted).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.[1]['code']).toBe('123456');
    expect(lines[0]?.[1]['to']).toBe('+9198xxxxx210');
  });

  it('captures deliveries for assertions', async () => {
    const notifier = new InMemoryNotifier();
    await notifier.deliver({
      kind: 'STAFF_OTP',
      to: '+919876543210',
      code: '654321',
      ttlSeconds: 300,
      language: 'ta',
    });

    expect(notifier.all()).toHaveLength(1);
    const last = notifier.lastTo('+919876543210');
    expect(last?.notification.kind).toBe('STAFF_OTP');
    expect(notifier.lastTo('+919999999999')).toBeNull();
  });
});

describe('adapter factory', () => {
  it('builds the sandbox adapters in DEMO_MODE', () => {
    const env = loadEnv({ STORAGE_DRIVER: 'memory' });
    expect(createStoragePort(env).driver).toBe('memory');
    expect(createNotifierPort(env).driver).toBe('log');
  });

  it('builds the S3 adapter when a driver is configured', () => {
    const storage = createStoragePort(loadEnv({ STORAGE_DRIVER: 's3' }));
    expect(storage.driver).toBe('s3');
    expect(storage.bucket).toBe('serviceloop-media');
  });

  it('refuses to pretend an unimplemented adapter is live', () => {
    expect(() =>
      createStoragePort(
        loadEnv({
          NODE_ENV: 'test',
          DEMO_MODE: 'false',
          STORAGE_DRIVER: 'gcs',
          GCS_BUCKET: 'serviceloop-prod',
        }),
      ),
    ).toThrow(/No storage adapter is implemented/);
  });
});
