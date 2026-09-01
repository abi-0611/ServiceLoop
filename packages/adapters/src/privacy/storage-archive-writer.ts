import type { ArchiveEntry, ArchiveWriter, StoredArchive } from '@serviceloop/domain';
import type { StoragePort } from '../storage/port';
import { writeZip } from './zip';

/**
 * Writes a DPDP export archive to object storage.
 *
 * The key is deliberately *not* guessable and deliberately *not* under the
 * shop's media prefix: `privacy/exports/<shopId>/<requestId>.zip`. Two
 * consequences follow, and both are the point.
 *
 * A separate prefix means an object-lifecycle rule can expire the whole
 * directory on a schedule without touching a single job-card photograph — which
 * is what turns "the link expires" into "the bytes are gone", and those are very
 * different promises. The console says the second one.
 *
 * And putting the request id in the key rather than a random suffix means a
 * second export for the same request overwrites the first. That is correct:
 * there is one archive per request, and an orphaned earlier copy is a
 * customer's entire history sitting in a bucket that nothing points at.
 */
export class StorageArchiveWriter implements ArchiveWriter {
  constructor(private readonly storage: StoragePort) {}

  async write(input: {
    readonly shopId: string;
    readonly requestId: string;
    readonly entries: readonly ArchiveEntry[];
  }): Promise<StoredArchive> {
    const zip = writeZip(input.entries.map((entry) => ({ name: entry.name, bytes: entry.bytes })));
    const key = archiveKey(input.shopId, input.requestId);

    await this.storage.put({
      key,
      body: zip.bytes,
      contentType: 'application/zip',
      metadata: {
        shopId: input.shopId,
        // No customer identifier in the metadata. Object metadata is visible to
        // anybody with bucket-list permission, which is a wider audience than
        // the archive's contents deserve.
        requestId: input.requestId,
        kind: 'dpdp-export',
      },
    });

    return { key, sizeBytes: zip.bytes.length, sha256: zip.sha256 };
  }

  async read(key: string): Promise<Buffer> {
    const object = await this.storage.get(key);
    return object.body;
  }

  async remove(key: string): Promise<void> {
    await this.storage.delete(key);
  }
}

export function archiveKey(shopId: string, requestId: string): string {
  return `privacy/exports/${shopId}/${requestId}.zip`;
}
