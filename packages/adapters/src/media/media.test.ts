import sharp from 'sharp';
// sharp 0.35 stopped exposing its namespace types through the default import;
// the type comes in by name now, the value still by default.
import type { Sharp } from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  decodeWav,
  downmixToMono,
  encodeWavPcm16,
  resampleLinear,
  TARGET_SAMPLE_RATE,
  WavAudioNormaliser,
} from './audio';
import { SharpImageProcessor } from './image-processor';
import { MediaPipeline, formatBytes, type MediaLimits } from './pipeline';
import { sniffContentType, UNKNOWN_CONTENT_TYPE } from './sniff';
import { InMemoryStorage } from '../storage/in-memory-storage';

/**
 * Media pipeline.
 *
 * Fixtures are generated rather than committed: sharp renders the images and
 * the WAV encoder writes the audio, so the suite tests the real formats with no
 * binary blobs in the repository and no dependence on a fixture someone might
 * regenerate differently.
 */

const SHOP = '01920000-0000-7000-8000-0000000000aa';

const LIMITS: MediaLimits = {
  maxImageBytes: 5 * 1024 * 1024,
  maxAudioBytes: 16 * 1024 * 1024,
  maxVideoBytes: 16 * 1024 * 1024,
  maxDocumentBytes: 20 * 1024 * 1024,
  maxDimensionPx: 800,
  thumbnailPx: 128,
};

let jpeg: Buffer;
let png: Buffer;
let webp: Buffer;
/** 1200×400 landscape bytes carrying EXIF orientation 6 (rotate 90° CW). */
let rotatedJpeg: Buffer;
let wav: Buffer;

async function solid(width: number, height: number): Promise<Sharp> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 200, g: 120, b: 40 },
    },
  });
}

beforeAll(async () => {
  jpeg = await (await solid(1600, 900)).jpeg().toBuffer();
  png = await (await solid(64, 64)).png().toBuffer();
  webp = await (await solid(64, 64)).webp().toBuffer();
  // Orientation 6 = "rotate 90° clockwise to display", exactly what an Android
  // phone writes when a portrait photo is stored landscape.
  rotatedJpeg = await (await solid(1200, 400)).withMetadata({ orientation: 6 }).jpeg().toBuffer();

  // 0.25 s of a 440 Hz tone, stereo, 44.1 kHz — a plausible voice-note stand-in.
  const sampleRate = 44_100;
  const frames = Math.floor(sampleRate * 0.25);
  const stereo = new Float32Array(frames * 2);
  for (let frame = 0; frame < frames; frame += 1) {
    const value = Math.sin((2 * Math.PI * 440 * frame) / sampleRate) * 0.5;
    stereo[frame * 2] = value;
    stereo[frame * 2 + 1] = value;
  }
  wav = encodeStereoWav(stereo, sampleRate);
});

/** Test-local stereo encoder; production only ever writes mono. */
function encodeStereoWav(interleaved: Float32Array, sampleRate: number): Buffer {
  const dataBytes = interleaved.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'latin1');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'latin1');
  buffer.write('fmt ', 12, 'latin1');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 4, 28);
  buffer.writeUInt16LE(4, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'latin1');
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < interleaved.length; index += 1) {
    buffer.writeInt16LE(Math.round((interleaved[index] as number) * 32_767), 44 + index * 2);
  }
  return buffer;
}

function makePipeline(): { pipeline: MediaPipeline; storage: InMemoryStorage } {
  const storage = new InMemoryStorage('serviceloop-media');
  return { pipeline: new MediaPipeline({ storage, limits: LIMITS }), storage };
}

/* -------------------------------------------------------------------------- */

describe('content sniffing', () => {
  it('identifies the formats a workshop actually sends', () => {
    expect(sniffContentType(jpeg).contentType).toBe('image/jpeg');
    expect(sniffContentType(png).contentType).toBe('image/png');
    expect(sniffContentType(webp).contentType).toBe('image/webp');
    expect(sniffContentType(wav).contentType).toBe('audio/wav');
    expect(sniffContentType(Buffer.from('%PDF-1.7\n')).contentType).toBe('application/pdf');
  });

  it('distinguishes an Opus voice note from a Vorbis file inside one OGG container', () => {
    const opus = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(24), Buffer.from('OpusHead')]);
    const vorbis = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(24), Buffer.from('\x01vorbis')]);

    expect(sniffContentType(opus).contentType).toBe('audio/ogg; codecs=opus');
    expect(sniffContentType(vorbis).contentType).toBe('audio/ogg; codecs=vorbis');
    expect(sniffContentType(opus).kind).toBe('AUDIO');
  });

  it('trusts the bytes over a mislabelled declared type', () => {
    const result = sniffContentType(png, 'image/jpeg');
    expect(result.contentType).toBe('image/png');
    expect(result.declaredTypeMismatch).toBe(true);
  });

  it('refuses to inherit a declared type for bytes it does not recognise', () => {
    // The header on the front is why this matters: a browser told
    // `text/html` would run it.
    const disguised = Buffer.from('<html><script>alert(1)</script></html>');
    const result = sniffContentType(disguised, 'image/jpeg');

    expect(result.contentType).toBe(UNKNOWN_CONTENT_TYPE);
    expect(result.kind).toBe('DOCUMENT');
    expect(result.declaredTypeMismatch).toBe(true);
  });

  it('accepts a declared type that agrees with the bytes without flagging it', () => {
    expect(sniffContentType(jpeg, 'image/jpeg').declaredTypeMismatch).toBe(false);
    expect(sniffContentType(wav, 'audio/wav').declaredTypeMismatch).toBe(false);
  });
});

describe('image normalisation', () => {
  const processor = new SharpImageProcessor();

  it('applies EXIF rotation so a sideways photo reaches OCR upright', async () => {
    // Orientation 6 means the 1200×400 stored bytes should present as 400×1200.
    const metadata = await processor.metadata(rotatedJpeg);
    expect(metadata.widthPx).toBe(400);
    expect(metadata.heightPx).toBe(1200);

    const normalised = await processor.normalise(rotatedJpeg, 2000);
    expect(normalised.widthPx).toBe(400);
    expect(normalised.heightPx).toBe(1200);
  });

  it('bounds the longest edge while preserving the aspect ratio', async () => {
    const normalised = await processor.normalise(jpeg, 800);
    expect(Math.max(normalised.widthPx, normalised.heightPx)).toBe(800);
    expect(normalised.widthPx / normalised.heightPx).toBeCloseTo(1600 / 900, 2);
  });

  it('does not enlarge an image that is already small', async () => {
    const normalised = await processor.normalise(png, 800);
    expect(normalised.widthPx).toBe(64);
    expect(normalised.heightPx).toBe(64);
  });

  it('produces a square thumbnail', async () => {
    const thumbnail = await processor.thumbnail(jpeg, 128);
    expect(thumbnail.widthPx).toBe(128);
    expect(thumbnail.heightPx).toBe(128);
    expect(thumbnail.bytes.byteLength).toBeLessThan(jpeg.byteLength);
  });
});

describe('audio normalisation', () => {
  const normaliser = new WavAudioNormaliser();

  it('converts stereo 44.1 kHz to mono 16 kHz PCM', async () => {
    const result = await normaliser.toPcm16kMono(wav, 'audio/wav');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.audio.sampleRate).toBe(TARGET_SAMPLE_RATE);
    expect(result.audio.channels).toBe(1);
    expect(result.audio.durationMs).toBeGreaterThan(230);
    expect(result.audio.durationMs).toBeLessThan(270);

    const decoded = decodeWav(result.audio.bytes);
    expect(decoded.channels).toBe(1);
    expect(decoded.sampleRate).toBe(TARGET_SAMPLE_RATE);
  });

  it('round-trips PCM through encode and decode without drift', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 0.999, -0.999]);
    const decoded = decodeWav(encodeWavPcm16(samples, TARGET_SAMPLE_RATE));

    expect(decoded.samples.length).toBe(samples.length);
    for (const [index, expected] of [...samples].entries()) {
      expect(decoded.samples[index]).toBeCloseTo(expected, 3);
    }
  });

  it('clamps rather than wrapping a sample past full scale', () => {
    // Interpolation can overshoot; wrapping would be an audible click.
    const decoded = decodeWav(encodeWavPcm16(new Float32Array([1.4, -1.4]), TARGET_SAMPLE_RATE));
    expect(decoded.samples[0]).toBeCloseTo(1, 2);
    expect(decoded.samples[1]).toBeCloseTo(-1, 2);
  });

  it('downmixes and resamples with the arithmetic you would expect', () => {
    expect([...downmixToMono(new Float32Array([1, 0, 0.5, 0.5]), 2)]).toEqual([0.5, 0.5]);
    expect(resampleLinear(new Float32Array([0, 1, 0, 1]), 32_000, 16_000).length).toBe(2);
    expect(resampleLinear(new Float32Array([0, 1]), 16_000, 16_000).length).toBe(2);
  });

  it('says plainly that it cannot transcode Opus rather than pretending', async () => {
    const result = await normaliser.toPcm16kMono(Buffer.from('OggS'), 'audio/ogg; codecs=opus');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('UNSUPPORTED_SOURCE_FORMAT');
  });

  it('reports a corrupt WAV instead of emitting silence', async () => {
    const result = await normaliser.toPcm16kMono(Buffer.from('RIFFxxxxWAVEnope'), 'audio/wav');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('CORRUPT_SOURCE');
  });

  it('reads a WAV whose data chunk follows an extra LIST chunk', () => {
    // Real recorders interleave metadata chunks; assuming the canonical
    // 44-byte layout would read the wrong bytes as audio.
    const canonical = encodeWavPcm16(new Float32Array([0.25, -0.25]), TARGET_SAMPLE_RATE);
    const list = Buffer.concat([
      Buffer.from('LIST'),
      (() => {
        const size = Buffer.alloc(4);
        size.writeUInt32LE(4);
        return size;
      })(),
      Buffer.from('INFO'),
    ]);
    const withList = Buffer.concat([
      canonical.subarray(0, 36),
      list,
      canonical.subarray(36),
    ]);
    withList.writeUInt32LE(withList.length - 8, 4);

    const decoded = decodeWav(withList);
    expect(decoded.samples.length).toBe(2);
    expect(decoded.samples[0]).toBeCloseTo(0.25, 3);
  });
});

describe('MediaPipeline', () => {
  it('stores an image with its normalised copy and thumbnail', async () => {
    const { pipeline, storage } = makePipeline();
    const result = await pipeline.ingest({
      shopId: SHOP,
      bytes: jpeg,
      declaredContentType: 'image/jpeg',
      origin: 'INBOUND_WHATSAPP',
      providerMediaId: 'media-1',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.media.kind).toBe('PHOTO');
    expect(result.media.contentType).toBe('image/jpeg');
    expect(result.media.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.media.widthPx).toBe(800);
    expect(result.media.providerMediaId).toBe('media-1');

    // Original, normalised and thumbnail are all retrievable.
    expect((await storage.get(result.media.storageKey)).body.byteLength).toBe(jpeg.byteLength);
    expect(await storage.head(result.media.derivedKey as string)).not.toBeNull();
    expect(await storage.head(result.media.thumbnailKey as string)).not.toBeNull();
  });

  it('keeps the original untouched alongside the derivative', async () => {
    const { pipeline, storage } = makePipeline();
    const result = await pipeline.ingest({
      shopId: SHOP,
      bytes: rotatedJpeg,
      origin: 'INBOUND_WHATSAPP',
    });
    if (!result.ok) return expect.unreachable('ingest should have succeeded');

    const original = await storage.get(result.media.storageKey);
    expect(original.body.equals(rotatedJpeg)).toBe(true);

    // …and the derivative is the upright one OCR will read: the source bytes
    // are landscape 1200×400, so a portrait derivative proves the EXIF rotation
    // was applied. Exact pixels are the resize limit's business, not this test's.
    const derived = await storage.get(result.media.derivedKey as string);
    const meta = await new SharpImageProcessor().metadata(derived.body);
    expect(meta.heightPx).toBeGreaterThan(meta.widthPx);
    expect(meta.heightPx / meta.widthPx).toBeCloseTo(3, 1);
    expect(Math.max(meta.widthPx, meta.heightPx)).toBe(LIMITS.maxDimensionPx);
  });

  it('stores png and webp as themselves', async () => {
    const { pipeline } = makePipeline();
    for (const [bytes, expected] of [
      [png, 'image/png'],
      [webp, 'image/webp'],
    ] as const) {
      const result = await pipeline.ingest({ shopId: SHOP, bytes, origin: 'CONSOLE_UPLOAD' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.media.contentType).toBe(expected);
    }
  });

  it('converts an audio upload to a 16 kHz mono derivative', async () => {
    const { pipeline, storage } = makePipeline();
    const result = await pipeline.ingest({
      shopId: SHOP,
      bytes: wav,
      declaredContentType: 'audio/wav',
      origin: 'INBOUND_WHATSAPP',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.media.kind).toBe('AUDIO');
    expect(result.media.derivedContentType).toBe('audio/wav');
    expect(result.media.durationMs).toBeGreaterThan(200);

    const decoded = decodeWav((await storage.get(result.media.derivedKey as string)).body);
    expect(decoded.sampleRate).toBe(TARGET_SAMPLE_RATE);
    expect(decoded.channels).toBe(1);
  });

  it('keeps an Opus voice note and says why it produced no derivative', async () => {
    const { pipeline } = makePipeline();
    const opus = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(24), Buffer.from('OpusHead')]);

    const result = await pipeline.ingest({
      shopId: SHOP,
      bytes: opus,
      declaredContentType: 'audio/ogg; codecs=opus',
      origin: 'INBOUND_WHATSAPP',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The audio is stored and usable; only the transcode is absent, and the
    // reason is recorded rather than swallowed.
    expect(result.media.derivedKey).toBeNull();
    expect(result.media.warnings.join(' ')).toContain('FFMPEG_PATH');
  });

  it('rejects an oversized file with a reason a customer can be told', async () => {
    const { pipeline } = makePipeline();
    const tiny = new MediaPipeline({
      storage: new InMemoryStorage('serviceloop-media'),
      limits: { ...LIMITS, maxImageBytes: 1024 },
    });

    const result = await tiny.ingest({ shopId: SHOP, bytes: jpeg, origin: 'INBOUND_WHATSAPP' });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.rejection.code).toBe('TOO_LARGE');
    expect(result.rejection.reason).toContain('larger than');
    expect(pipeline.limitFor('PHOTO')).toBe(LIMITS.maxImageBytes);
  });

  it('rejects an empty file', async () => {
    const { pipeline } = makePipeline();
    const result = await pipeline.ingest({
      shopId: SHOP,
      bytes: Buffer.alloc(0),
      origin: 'INBOUND_WHATSAPP',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.code).toBe('EMPTY');
  });

  it('applies a different size limit per media kind', async () => {
    const { pipeline } = makePipeline();
    expect(pipeline.limitFor('PHOTO')).toBe(LIMITS.maxImageBytes);
    expect(pipeline.limitFor('AUDIO')).toBe(LIMITS.maxAudioBytes);
    expect(pipeline.limitFor('VIDEO')).toBe(LIMITS.maxVideoBytes);
    expect(pipeline.limitFor('DOCUMENT')).toBe(LIMITS.maxDocumentBytes);
  });

  it('files media under the job card when one is known, and the inbox otherwise', async () => {
    const { pipeline } = makePipeline();
    const inbox = await pipeline.ingest({ shopId: SHOP, bytes: png, origin: 'CONSOLE_UPLOAD' });
    const carded = await pipeline.ingest({
      shopId: SHOP,
      bytes: png,
      jobCardId: 'card-1',
      origin: 'CONSOLE_UPLOAD',
    });

    if (!inbox.ok || !carded.ok) return expect.unreachable('both ingests should succeed');
    expect(inbox.media.storageKey).toContain('/job-cards/inbox/');
    expect(carded.media.storageKey).toContain('/job-cards/card-1/');
    // Shop-first layout, so a DPDP deletion can enumerate by prefix.
    expect(carded.media.storageKey.startsWith(`shops/${SHOP}/`)).toBe(true);
  });

  it('flags a mislabelled upload but still stores it', async () => {
    const { pipeline } = makePipeline();
    const result = await pipeline.ingest({
      shopId: SHOP,
      bytes: png,
      declaredContentType: 'image/jpeg',
      origin: 'INBOUND_WHATSAPP',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.media.contentType).toBe('image/png');
    expect(result.media.warnings.some((warning) => warning.includes('declared'))).toBe(true);
  });

  it('formats sizes the way the customer-facing message needs them', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
