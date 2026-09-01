import { describe, expect, it } from 'vitest';
import { concatFrames, toFrames, type AudioFrame } from '../telephony/audio';
import { decodeLinearAudio, sarvamLanguageCode } from './sarvam-streaming-adapter';
import { googleLanguageCode } from './google-streaming-adapter';
import {
  MockStreamingSpeechAdapter,
  decodeUtterance,
  decodeUtterances,
  encodeUtterance,
  utteranceFrames,
} from './mock-streaming-adapter';
import { toSynthesisChunks, type TranscriptEvent } from './streaming-port';

const CALL = 'call-1';
const SHOP = 'shop-1';

async function collect(events: {
  next(timeoutMs?: number): Promise<TranscriptEvent | null>;
}): Promise<TranscriptEvent[]> {
  const seen: TranscriptEvent[] = [];
  for (;;) {
    const event = await events.next(50);
    if (event === null) return seen;
    seen.push(event);
  }
}

describe('fixture audio', () => {
  it('round-trips a phrase through real PCM bytes', () => {
    const pcm = encodeUtterance({ text: 'Brake pads, two thousand four hundred', language: 'en' });
    expect(pcm.length % 2).toBe(0);
    expect(decodeUtterance(pcm)?.text).toBe('Brake pads, two thousand four hundred');
  });

  it('gives a phrase a plausible spoken length', () => {
    const short = encodeUtterance({ text: 'Yes', language: 'ta' });
    const long = encodeUtterance({
      text: 'The technician found the front brake pads worn down past the wear indicator',
      language: 'en',
    });
    expect(long.length).toBeGreaterThan(short.length);
  });

  it('reads every phrase in a multi-sentence turn', () => {
    const pcm = Buffer.concat([
      encodeUtterance({ text: 'First sentence.', language: 'en' }),
      encodeUtterance({ text: 'Second sentence.', language: 'en' }),
    ]);
    expect(decodeUtterances(pcm).map((entry) => entry.text)).toEqual([
      'First sentence.',
      'Second sentence.',
    ]);
  });
});

describe('MockStreamingSpeechAdapter — recognition', () => {
  it('emits partials before the final, growing as the audio arrives', async () => {
    const adapter = new MockStreamingSpeechAdapter({ partialsPerUtterance: 2 });
    const stream = adapter.streamTranscribe({ shopId: SHOP, callId: CALL, languageHint: 'ta' });

    for (const frame of utteranceFrames({
      text: 'seri sir pannunga brake pads maathunga',
      language: 'ta',
    })) {
      stream.push(frame);
    }
    await stream.end();

    const events = await collect(stream.events);
    const partials = events.filter((event) => event.kind === 'partial');
    const finals = events.filter((event) => event.kind === 'final');

    expect(partials.length).toBeGreaterThanOrEqual(1);
    expect(finals).toHaveLength(1);
    expect(finals[0]?.text).toBe('seri sir pannunga brake pads maathunga');
    expect(finals[0]?.languageTag).toBe('ta-IN');

    // A partial is a guess and must never carry the final's confidence: acting
    // on one is acting on something the caller has not finished saying.
    for (const partial of partials) {
      expect(partial.confidence).toBeLessThan(finals[0]?.confidence ?? 1);
      expect(finals[0]?.text.startsWith(partial.text)).toBe(true);
    }
  });

  it('returns an empty low-confidence final for audio nobody registered', async () => {
    const adapter = new MockStreamingSpeechAdapter();
    const stream = adapter.streamTranscribe({ shopId: SHOP, callId: CALL, languageHint: 'hi' });

    // A lorry going past. On a real line this is most of the audio.
    for (const frame of toFrames(Buffer.alloc(640 * 10), { frameMs: 20 })) stream.push(frame);
    await stream.end();

    const events = await collect(stream.events);
    const final = events.at(-1);
    expect(final?.kind).toBe('final');
    expect(final?.text).toBe('');
    // Below any sane `minTranscriptConfidence`, which is what drops a noisy
    // call to the keypad rather than guessing at somebody's approval.
    expect(final?.confidence).toBeLessThan(0.3);
  });

  it('honours a registered recording of real microphone audio', async () => {
    const adapter = new MockStreamingSpeechAdapter();
    const mic = Buffer.alloc(640 * 5, 3);
    adapter.register(mic, { text: 'aama seri', language: 'ta', confidence: 0.88 });

    const stream = adapter.streamTranscribe({ shopId: SHOP, callId: CALL });
    for (const frame of toFrames(mic, { frameMs: 20 })) stream.push(frame);
    await stream.end();

    const events = await collect(stream.events);
    expect(events.at(-1)?.text).toBe('aama seri');
    expect(events.at(-1)?.confidence).toBeCloseTo(0.88);
  });

  it('reports how much audio it consumed, so latency has an anchor', async () => {
    const adapter = new MockStreamingSpeechAdapter();
    const stream = adapter.streamTranscribe({ shopId: SHOP, callId: CALL });
    const frames = utteranceFrames({ text: 'one two three four five', language: 'en' });
    for (const frame of frames) stream.push(frame);
    await stream.end();

    const events = await collect(stream.events);
    const total = frames.reduce((sum, frame) => sum + frame.durationMs, 0);
    expect(events.at(-1)?.audioMs).toBe(total);
  });
});

describe('MockStreamingSpeechAdapter — synthesis', () => {
  it('emits playable frames whose words can be read back', async () => {
    const adapter = new MockStreamingSpeechAdapter();
    const stream = adapter.streamSynthesize({ shopId: SHOP, callId: CALL, language: 'en' });

    await stream.write('So I will go ahead with the brake pads. Shall I confirm?');
    await stream.end();

    const frames: AudioFrame[] = [];
    for (;;) {
      const frame = await stream.frames.next(20);
      if (frame === null) break;
      frames.push(frame);
    }

    expect(frames.length).toBeGreaterThan(0);
    expect(MockStreamingSpeechAdapter.heard(frames)).toBe(
      'So I will go ahead with the brake pads. Shall I confirm?',
    );
    expect(stream.firstFrameAt()).not.toBeNull();
    expect(stream.synthesisedMs()).toBeGreaterThan(0);
  });

  it('never synthesises the rest of a turn after a barge-in', async () => {
    const adapter = new MockStreamingSpeechAdapter();
    const stream = adapter.streamSynthesize({ shopId: SHOP, callId: CALL, language: 'en' });

    await stream.write('First sentence.');
    const beforeCancel = stream.synthesisedMs();
    await stream.cancel();
    await stream.write('Second sentence that the customer talked over.');

    expect(stream.synthesisedMs()).toBe(beforeCancel);
    expect(stream.isClosed).toBe(true);
  });

  it('splits a turn at sentence boundaries so the first one can start early', () => {
    expect(toSynthesisChunks('One. Two! Three?')).toEqual(['One.', 'Two!', 'Three?']);
    // Devanagari danda counts as a sentence end, or a Hindi turn is one chunk.
    expect(toSynthesisChunks('पहला वाक्य। दूसरा वाक्य।')).toHaveLength(2);
    expect(toSynthesisChunks('   ')).toEqual([]);
  });

  it('produces one continuous stream when frames are concatenated', async () => {
    const adapter = new MockStreamingSpeechAdapter({ frameMs: 20 });
    const stream = adapter.streamSynthesize({ shopId: SHOP, callId: CALL, language: 'ta' });
    await stream.write('ஒரு நிமிடம்.');
    await stream.end();

    const frames: AudioFrame[] = [];
    for (;;) {
      const frame = await stream.frames.next(20);
      if (frame === null) break;
      frames.push(frame);
    }

    expect(concatFrames(frames).length).toBe(frames.length * 640);
    expect(frames.map((frame) => frame.seq)).toEqual(frames.map((_, index) => index));
  });
});

describe('provider language codes and payloads', () => {
  it('maps the three launch languages to their -IN locales', () => {
    expect(sarvamLanguageCode('ta')).toBe('ta-IN');
    expect(sarvamLanguageCode('hi')).toBe('hi-IN');
    expect(googleLanguageCode('en')).toBe('en-IN');
  });

  it('strips a RIFF wrapper and passes raw PCM through', () => {
    const pcm = Buffer.alloc(640, 5);
    const wav = Buffer.concat([wavHeader(pcm.length), pcm]);
    expect(decodeLinearAudio(wav, 'audio/wav').equals(pcm)).toBe(true);
    expect(decodeLinearAudio(pcm, 'audio/l16').equals(pcm)).toBe(true);
  });

  it('refuses compressed audio rather than writing static to a phone line', () => {
    // The failure this prevents is the nastiest kind: MP3 bytes on a telephony
    // leg are valid frames of pure noise, and every log line says "synthesised".
    expect(() => decodeLinearAudio(Buffer.from([0xff, 0xfb, 0x90]), 'audio/mp3')).toThrow(
      /linear PCM/u,
    );
  });
});

function wavHeader(dataLength: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataLength, 40);
  return header;
}
