import { describe, expect, it } from 'vitest';
import { MockSpeechAdapter } from './mock-adapter';
import { SpeechError, wavDurationMs } from './port';

/** A canonical 16 kHz mono 16-bit WAV carrying `sampleCount` samples. */
function wav(sampleCount: number, sampleRate = 16_000): Buffer {
  const bytesPerSample = 2;
  const dataBytes = sampleCount * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // PCM fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28); // byte rate
  buffer.writeUInt16LE(bytesPerSample, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

describe('wavDurationMs', () => {
  it('reads the duration off a canonical header', () => {
    expect(wavDurationMs(wav(16_000))).toBe(1000);
    expect(wavDurationMs(wav(8_000))).toBe(500);
    expect(wavDurationMs(wav(24_000, 48_000))).toBe(500);
  });

  it('returns null for anything that is not a readable WAV', () => {
    expect(wavDurationMs(Buffer.alloc(0))).toBeNull();
    expect(wavDurationMs(Buffer.from('not audio at all, definitely not a RIFF'))).toBeNull();
    // Truncated: a header with no data chunk has no duration to report.
    expect(wavDurationMs(wav(16_000).subarray(0, 36))).toBeNull();
  });

  it('walks past an unknown chunk to find the data chunk', () => {
    const base = wav(16_000);
    const extra = Buffer.alloc(8 + 4);
    extra.write('LIST', 0, 'ascii');
    extra.writeUInt32LE(4, 4);

    const spliced = Buffer.concat([
      base.subarray(0, 36),
      extra,
      base.subarray(36),
    ]);
    // The RIFF size field is now stale, which is exactly what a real file with
    // an appended chunk looks like; the walk must not depend on it.
    expect(wavDurationMs(spliced)).toBe(1000);
  });
});

describe('MockSpeechAdapter', () => {
  const audio = wav(16_000);

  it('returns the registered transcript with a real duration', async () => {
    const speech = new MockSpeechAdapter();
    speech.register(audio, { text: 'brake pad maathanum', language: 'ta', confidence: 0.62 });

    const transcript = await speech.transcribe({
      shopId: 'shop-1',
      bytes: audio,
      contentType: 'audio/wav',
    });

    expect(transcript.text).toBe('brake pad maathanum');
    expect(transcript.language).toBe('ta');
    expect(transcript.confidence).toBe(0.62);
    expect(transcript.durationMs).toBe(1000);
    expect(transcript.segments).toHaveLength(1);
    expect(transcript.segments[0]?.endMs).toBe(1000);
  });

  it('is keyed on content, so a re-encoded clip stops matching', async () => {
    const speech = new MockSpeechAdapter();
    speech.register(audio, { text: 'x', language: 'en' });
    expect(speech.has(audio)).toBe(true);
    expect(speech.has(wav(16_001))).toBe(false);
  });

  it('raises on unregistered audio rather than returning empty text', async () => {
    const speech = new MockSpeechAdapter();
    await expect(
      speech.transcribe({ shopId: 'shop-1', bytes: audio, contentType: 'audio/wav' }),
    ).rejects.toBeInstanceOf(SpeechError);
  });

  it('raises on empty audio', async () => {
    const speech = new MockSpeechAdapter();
    await expect(
      speech.transcribe({ shopId: 'shop-1', bytes: Buffer.alloc(0), contentType: 'audio/wav' }),
    ).rejects.toMatchObject({ kind: 'AUDIO_TOO_SHORT' });
  });
});
