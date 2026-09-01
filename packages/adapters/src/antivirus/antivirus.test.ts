import { describe, expect, it } from 'vitest';
import { InMemoryStorage } from '../storage/in-memory-storage';
import { MediaPipeline } from '../media/pipeline';
import type { AntivirusPort, ScanVerdict } from './port';
import { PermissiveScanner } from './permissive-scanner';

/**
 * Upload scanning (phase 7.1) — and, more importantly, the media pipeline's
 * behaviour on each verdict, which is where the security decision actually is.
 */

/** A 1x1 PNG. Small, real, and sniffed as an image by the pipeline. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** The EICAR test string, reassembled so this file is not itself quarantined. */
const EICAR = Buffer.from(
  ['X5O!P%@AP[4\\PZX54(P^)7CC)7}', '$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!', '$H+H*'].join(''),
  'latin1',
);

class StubScanner implements AntivirusPort {
  readonly driver = 'clamav' as const;
  constructor(private readonly verdict: ScanVerdict) {}
  async scan(): Promise<ScanVerdict> {
    return this.verdict;
  }
}

function pipeline(antivirus: AntivirusPort | undefined, failClosed = false): {
  pipeline: MediaPipeline;
  storage: InMemoryStorage;
} {
  const storage = new InMemoryStorage('test-bucket');
  return {
    storage,
    pipeline: new MediaPipeline({
      storage,
      limits: {
        maxImageBytes: 5_000_000,
        maxAudioBytes: 5_000_000,
        maxVideoBytes: 5_000_000,
        maxDocumentBytes: 5_000_000,
        maxDimensionPx: 2200,
        thumbnailPx: 320,
      },
      ...(antivirus === undefined ? {} : { antivirus }),
      antivirusFailClosed: failClosed,
    }),
  };
}

describe('PermissiveScanner', () => {
  it('holds the exact 68-byte EICAR sequence', () => {
    // A backslash lost to source escaping produces a constant that matches
    // nothing, and every other test here still passes — the scanner reports
    // CLEAN, which is what it reports for everything. The length is the only
    // cheap check that catches it.
    expect(PermissiveScanner.EICAR).toHaveLength(68);
    expect(EICAR.toString('latin1')).toBe(PermissiveScanner.EICAR);
  });

  it('passes an ordinary photograph', async () => {
    expect(await new PermissiveScanner().scan(PNG)).toEqual({ status: 'CLEAN' });
  });

  it('recognises the EICAR test file, so the infected path is exercised in CI', async () => {
    // The entire reason this class is not a `return CLEAN` stub: without a
    // detectable sample, the pipeline's rejection path would only ever run in
    // an environment with a real ClamAV container.
    expect(await new PermissiveScanner().scan(EICAR)).toEqual({
      status: 'INFECTED',
      signature: 'Eicar-Test-Signature',
    });
  });
});

describe('MediaPipeline scanning', () => {
  const request = {
    shopId: 'shop-1',
    bytes: PNG,
    origin: 'INBOUND_WHATSAPP' as const,
    declaredContentType: 'image/png',
  };

  it('stores a clean file', async () => {
    const { pipeline: media } = pipeline(new PermissiveScanner());
    const result = await media.ingest(request);
    expect(result.ok).toBe(true);
  });

  it('rejects an infected file and stores nothing at all', async () => {
    const { pipeline: media, storage } = pipeline(new PermissiveScanner());

    const result = await media.ingest({ ...request, bytes: EICAR });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe('INFECTED');
    // The property that matters more than the rejection: nothing reached
    // object storage, so there is no infected object in a bucket the console
    // can read and no cleanup delete that has to succeed.
    expect(storage.keys()).toEqual([]);
  });

  it('accepts and flags an unscannable file when configured fail-open', async () => {
    const { pipeline: media } = pipeline(
      new StubScanner({ status: 'UNAVAILABLE', reason: 'clamd not listening' }),
      false,
    );

    const result = await media.ingest(request);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Never silently: the warning rides on the descriptor, so "which files went
    // in unscanned during the outage" is answerable afterwards.
    expect(result.media.warnings.join(' ')).toContain('Virus scan unavailable');
  });

  it('refuses an unscannable file when configured fail-closed', async () => {
    const { pipeline: media, storage } = pipeline(
      new StubScanner({ status: 'UNAVAILABLE', reason: 'clamd not listening' }),
      true,
    );

    const result = await media.ingest(request);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe('SCAN_UNAVAILABLE');
    expect(storage.keys()).toEqual([]);
  });

  it('works with no scanner wired at all', async () => {
    // A unit test constructing a pipeline by hand must not have to stand one up.
    const { pipeline: media } = pipeline(undefined);
    expect((await media.ingest(request)).ok).toBe(true);
  });
});
