/**
 * Telephony audio, normalised (phase 5.1).
 *
 * A telco leg is 8 kHz mono μ-law. A speech model wants 16 kHz mono PCM16.
 * Everything above this file works in the second format and nothing above it
 * knows the first exists — which is the point: the port carries one shape, and
 * the three adapters convert at their own edge.
 *
 * The conversions are deliberately plain. G.711 is a fixed table, and linear
 * interpolation is the correct resampler for a signal that has already been
 * band-limited to 4 kHz by the telephone network itself. A polyphase filter
 * would be more code and, on audio that arrived through a mobile codec, no more
 * intelligible.
 */

/** What the port carries internally, in every adapter. */
export const INTERNAL_SAMPLE_RATE = 16_000 as const;
/** What a telco leg actually carries. */
export const TELCO_SAMPLE_RATE = 8_000 as const;

export type AudioEncoding = 'pcm16' | 'mulaw';

export interface AudioFormat {
  readonly sampleRate: number;
  readonly channels: 1;
  readonly encoding: AudioEncoding;
}

export const INTERNAL_FORMAT: AudioFormat = {
  sampleRate: INTERNAL_SAMPLE_RATE,
  channels: 1,
  encoding: 'pcm16',
};

export const TELCO_FORMAT: AudioFormat = {
  sampleRate: TELCO_SAMPLE_RATE,
  channels: 1,
  encoding: 'mulaw',
};

/**
 * One frame of audio on the port.
 *
 * `seq` is per-stream and monotonic, so a consumer can tell a dropped frame
 * from a quiet one — the distinction between "the line broke" and "nobody is
 * talking", which is exactly what endpointing depends on.
 */
export interface AudioFrame {
  readonly seq: number;
  readonly at: Date;
  /** 16 kHz mono PCM16 little-endian, always. */
  readonly pcm16: Buffer;
  readonly durationMs: number;
}

export function frameDurationMs(pcm16: Buffer, sampleRate: number = INTERNAL_SAMPLE_RATE): number {
  return Math.round((pcm16.length / 2 / sampleRate) * 1000);
}

export function samplesPerFrame(frameMs: number, sampleRate: number = INTERNAL_SAMPLE_RATE): number {
  return Math.round((sampleRate * frameMs) / 1000);
}

/**
 * Splits a PCM16 buffer into fixed-duration frames.
 *
 * A short tail is padded with silence rather than emitted as a runt frame:
 * every consumer downstream assumes a constant frame duration when it converts
 * frame counts to milliseconds, and one 7 ms frame in a stream of 20 ms ones is
 * how a latency measurement quietly becomes wrong.
 */
export function toFrames(
  pcm16: Buffer,
  options: {
    readonly frameMs: number;
    readonly startSeq?: number;
    readonly startAt?: Date;
    readonly sampleRate?: number;
  },
): AudioFrame[] {
  const sampleRate = options.sampleRate ?? INTERNAL_SAMPLE_RATE;
  const bytesPerFrame = samplesPerFrame(options.frameMs, sampleRate) * 2;
  if (bytesPerFrame === 0) return [];

  const frames: AudioFrame[] = [];
  const startAt = options.startAt ?? new Date();
  let seq = options.startSeq ?? 0;

  for (let offset = 0; offset < pcm16.length; offset += bytesPerFrame) {
    const slice = pcm16.subarray(offset, Math.min(offset + bytesPerFrame, pcm16.length));
    const padded =
      slice.length === bytesPerFrame
        ? Buffer.from(slice)
        : Buffer.concat([slice, Buffer.alloc(bytesPerFrame - slice.length)]);

    frames.push({
      seq,
      at: new Date(startAt.getTime() + frames.length * options.frameMs),
      pcm16: padded,
      durationMs: options.frameMs,
    });
    seq += 1;
  }

  return frames;
}

export function concatFrames(frames: readonly AudioFrame[]): Buffer {
  return Buffer.concat(frames.map((frame) => frame.pcm16));
}

export function totalDurationMs(frames: readonly AudioFrame[]): number {
  return frames.reduce((sum, frame) => sum + frame.durationMs, 0);
}

/**
 * Root-mean-square amplitude, 0–1.
 *
 * Used for one thing only: telling silence from speech when no recogniser is
 * attached yet. It is not voice activity detection and does not pretend to be —
 * endpointing runs off STT finality plus a silence timer (phase 5.3), and this
 * exists so a frame of pure digital silence can be recognised as such without
 * spending a model call on it.
 */
export function frameEnergy(frame: AudioFrame): number {
  const samples = frame.pcm16.length / 2;
  if (samples === 0) return 0;

  let sum = 0;
  for (let index = 0; index < samples; index += 1) {
    const sample = frame.pcm16.readInt16LE(index * 2) / 32_768;
    sum += sample * sample;
  }

  return Math.sqrt(sum / samples);
}

export function isSilent(frame: AudioFrame, threshold = 0.01): boolean {
  return frameEnergy(frame) < threshold;
}

export function silenceFrames(
  durationMs: number,
  frameMs: number,
  startSeq = 0,
  startAt = new Date(),
): AudioFrame[] {
  const bytes = samplesPerFrame(durationMs) * 2;
  return toFrames(Buffer.alloc(bytes), { frameMs, startSeq, startAt });
}

/* --------------------------------------------------------------- G.711 μ-law */

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32_635;

/**
 * PCM16 sample → μ-law byte.
 *
 * The classic reference implementation, kept in longhand rather than reduced to
 * a lookup table built at import time: a 65 536-entry table would be faster and
 * the difference is unmeasurable against 8 000 samples a second, while the
 * longhand is checkable against the ITU spec by eye.
 */
export function pcm16ToMulawSample(sample: number): number {
  let value = sample;
  const sign = value < 0 ? 0x80 : 0x00;
  if (value < 0) value = -value;
  if (value > MULAW_CLIP) value = MULAW_CLIP;
  value += MULAW_BIAS;

  let exponent = 7;
  for (let mask = 0x4000; (value & mask) === 0 && exponent > 0; mask >>= 1) {
    exponent -= 1;
  }

  const mantissa = (value >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

export function mulawToPcm16Sample(byte: number): number {
  const value = ~byte & 0xff;
  const sign = value & 0x80;
  const exponent = (value >> 4) & 0x07;
  const mantissa = value & 0x0f;

  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;

  return sign !== 0 ? -sample : sample;
}

export function pcm16ToMulaw(pcm16: Buffer): Buffer {
  const out = Buffer.alloc(pcm16.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = pcm16ToMulawSample(pcm16.readInt16LE(index * 2));
  }
  return out;
}

export function mulawToPcm16(mulaw: Buffer): Buffer {
  const out = Buffer.alloc(mulaw.length * 2);
  for (let index = 0; index < mulaw.length; index += 1) {
    out.writeInt16LE(clampInt16(mulawToPcm16Sample(mulaw[index] as number)), index * 2);
  }
  return out;
}

/* ----------------------------------------------------------------- resampling */

/** 8 kHz → 16 kHz by linear interpolation. */
export function upsample8kTo16k(pcm16: Buffer): Buffer {
  const inputSamples = pcm16.length / 2;
  if (inputSamples === 0) return Buffer.alloc(0);

  const out = Buffer.alloc(inputSamples * 2 * 2);
  for (let index = 0; index < inputSamples; index += 1) {
    const current = pcm16.readInt16LE(index * 2);
    const next = index + 1 < inputSamples ? pcm16.readInt16LE((index + 1) * 2) : current;
    out.writeInt16LE(current, index * 4);
    out.writeInt16LE(clampInt16(Math.round((current + next) / 2)), index * 4 + 2);
  }

  return out;
}

/**
 * 16 kHz → 8 kHz by averaging sample pairs.
 *
 * Averaging rather than dropping every other sample: decimation without a
 * filter aliases anything above 4 kHz back down into the speech band, and a
 * sibilant that folds into a vowel is a word the far end mishears.
 */
export function downsample16kTo8k(pcm16: Buffer): Buffer {
  const inputSamples = pcm16.length / 2;
  const outputSamples = Math.floor(inputSamples / 2);
  const out = Buffer.alloc(outputSamples * 2);

  for (let index = 0; index < outputSamples; index += 1) {
    const first = pcm16.readInt16LE(index * 4);
    const second = pcm16.readInt16LE(index * 4 + 2);
    out.writeInt16LE(clampInt16(Math.round((first + second) / 2)), index * 2);
  }

  return out;
}

/** Provider bytes (whatever they are) → the internal 16 kHz PCM16 the port carries. */
export function toInternalPcm(bytes: Buffer, format: AudioFormat): Buffer {
  const pcm = format.encoding === 'mulaw' ? mulawToPcm16(bytes) : Buffer.from(bytes);
  if (format.sampleRate === INTERNAL_SAMPLE_RATE) return pcm;
  if (format.sampleRate === TELCO_SAMPLE_RATE) return upsample8kTo16k(pcm);
  return resamplePcmTelephony(pcm, format.sampleRate, INTERNAL_SAMPLE_RATE);
}

/** The internal format → whatever the provider's leg wants. */
export function fromInternalPcm(pcm16: Buffer, format: AudioFormat): Buffer {
  const resampled =
    format.sampleRate === INTERNAL_SAMPLE_RATE
      ? pcm16
      : format.sampleRate === TELCO_SAMPLE_RATE
        ? downsample16kTo8k(pcm16)
        : resamplePcmTelephony(pcm16, INTERNAL_SAMPLE_RATE, format.sampleRate);

  return format.encoding === 'mulaw' ? pcm16ToMulaw(resampled) : resampled;
}

/**
 * The general case, for a provider that negotiates something unusual.
 *
 * Named `resamplePcmTelephony` rather than the obvious `resampleLinear`: the
 * media pipeline already exports a resampler of that name for stored voice
 * notes, and two functions with one name in a barrel export is a bug waiting
 * for whichever import wins.
 */
export function resamplePcmTelephony(pcm16: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate) return Buffer.from(pcm16);

  const inputSamples = pcm16.length / 2;
  if (inputSamples === 0) return Buffer.alloc(0);

  const outputSamples = Math.max(1, Math.round((inputSamples * toRate) / fromRate));
  const out = Buffer.alloc(outputSamples * 2);
  const ratio = (inputSamples - 1) / Math.max(1, outputSamples - 1);

  for (let index = 0; index < outputSamples; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(inputSamples - 1, left + 1);
    const fraction = position - left;
    const value =
      pcm16.readInt16LE(left * 2) * (1 - fraction) + pcm16.readInt16LE(right * 2) * fraction;
    out.writeInt16LE(clampInt16(Math.round(value)), index * 2);
  }

  return out;
}

function clampInt16(value: number): number {
  if (value > 32_767) return 32_767;
  if (value < -32_768) return -32_768;
  return value;
}

/**
 * A canonical 16-bit mono WAV around PCM, for the recording that gets stored.
 *
 * Written here rather than pulled from a library because the header is 44 bytes
 * and the alternative is a dependency whose only job would be to write them.
 */
export function pcmToWav(pcm16: Buffer, sampleRate: number = INTERNAL_SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * 2;

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm16.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm16.length, 40);

  return Buffer.concat([header, pcm16]);
}
