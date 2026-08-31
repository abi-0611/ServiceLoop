import { spawn } from 'node:child_process';
import { baseType } from './sniff';

/**
 * Audio normalisation to 16 kHz mono PCM WAV.
 *
 * That format is not arbitrary: it is what speech recognition wants, and phase
 * 4's `SpeechPort.transcribe` consumes exactly this. Doing the conversion at
 * ingest means a voice note is transcribe-ready the moment it lands, and the
 * expensive, format-specific work happens once rather than on every retry.
 *
 * Two adapters, and the difference between them is honest:
 *
 *  - `FfmpegAudioNormaliser` converts anything, and is what production uses.
 *    It shells out to a binary rather than binding a native library, so a
 *    missing or broken ffmpeg is a clear configuration error, not a segfault.
 *  - `WavAudioNormaliser` implements the full PCM path in TypeScript — RIFF
 *    parsing, 8/16/24/32-bit and float decoding, downmix, resample, re-encode.
 *    It is complete for what it claims and explicitly refuses what it cannot
 *    do, rather than pretending. WhatsApp voice notes are Opus, so a deployment
 *    without ffmpeg keeps the original audio and records that no derivative was
 *    produced; nothing is lost and nothing is faked.
 */

export interface NormalisedAudio {
  readonly bytes: Buffer;
  readonly contentType: 'audio/wav';
  readonly durationMs: number;
  readonly sampleRate: 16000;
  readonly channels: 1;
}

export type AudioNormalisationFailure =
  | { readonly kind: 'UNSUPPORTED_SOURCE_FORMAT'; readonly contentType: string }
  | { readonly kind: 'CORRUPT_SOURCE'; readonly detail: string }
  | { readonly kind: 'TOOL_UNAVAILABLE'; readonly detail: string }
  | { readonly kind: 'CONVERSION_FAILED'; readonly detail: string };

export type AudioNormalisationResult =
  | { readonly ok: true; readonly audio: NormalisedAudio }
  | { readonly ok: false; readonly failure: AudioNormalisationFailure };

export interface AudioNormaliserPort {
  readonly driver: 'ffmpeg' | 'wav';
  /** Formats this adapter will accept, for the boot log and for tests. */
  supports(contentType: string): boolean;
  toPcm16kMono(bytes: Buffer, contentType: string): Promise<AudioNormalisationResult>;
}

export const TARGET_SAMPLE_RATE = 16_000;

/* -------------------------------------------------------------------------- *
 * WAV / PCM — implemented here, in full
 * -------------------------------------------------------------------------- */

const WAV_TYPES = new Set(['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave']);

interface DecodedPcm {
  /** Interleaved samples normalised to [-1, 1]. */
  readonly samples: Float32Array;
  readonly channels: number;
  readonly sampleRate: number;
}

export class WavAudioNormaliser implements AudioNormaliserPort {
  readonly driver = 'wav' as const;

  supports(contentType: string): boolean {
    return WAV_TYPES.has(baseType(contentType));
  }

  toPcm16kMono(bytes: Buffer, contentType: string): Promise<AudioNormalisationResult> {
    if (!this.supports(contentType)) {
      return Promise.resolve({
        ok: false,
        failure: { kind: 'UNSUPPORTED_SOURCE_FORMAT', contentType },
      });
    }

    let decoded: DecodedPcm;
    try {
      decoded = decodeWav(bytes);
    } catch (error) {
      return Promise.resolve({
        ok: false,
        failure: {
          kind: 'CORRUPT_SOURCE',
          detail: error instanceof Error ? error.message : String(error),
        },
      });
    }

    const mono = downmixToMono(decoded.samples, decoded.channels);
    const resampled = resampleLinear(mono, decoded.sampleRate, TARGET_SAMPLE_RATE);

    return Promise.resolve({
      ok: true,
      audio: {
        bytes: encodeWavPcm16(resampled, TARGET_SAMPLE_RATE),
        contentType: 'audio/wav',
        durationMs: Math.round((resampled.length / TARGET_SAMPLE_RATE) * 1000),
        sampleRate: TARGET_SAMPLE_RATE,
        channels: 1,
      },
    });
  }
}

const FORMAT_PCM = 1;
const FORMAT_IEEE_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

export function decodeWav(bytes: Buffer): DecodedPcm {
  if (bytes.length < 12 || bytes.toString('latin1', 0, 4) !== 'RIFF') {
    throw new Error('Not a RIFF container');
  }
  if (bytes.toString('latin1', 8, 12) !== 'WAVE') throw new Error('RIFF container is not WAVE');

  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let data: Buffer | null = null;

  // Chunk walk rather than assuming the canonical 44-byte layout: real
  // recorders interleave LIST/fact/bext chunks ahead of `data`.
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('latin1', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === 'fmt ') {
      if (body + 16 > bytes.length) throw new Error('Truncated fmt chunk');
      audioFormat = bytes.readUInt16LE(body);
      channels = bytes.readUInt16LE(body + 2);
      sampleRate = bytes.readUInt32LE(body + 4);
      bitsPerSample = bytes.readUInt16LE(body + 14);
      if (audioFormat === FORMAT_EXTENSIBLE && body + 26 <= bytes.length) {
        // WAVE_FORMAT_EXTENSIBLE hides the real format in the GUID's first word.
        audioFormat = bytes.readUInt16LE(body + 24);
      }
    } else if (id === 'data') {
      // A streamed WAV can carry size 0 or 0xFFFFFFFF; fall back to the tail.
      const end = size === 0 || body + size > bytes.length ? bytes.length : body + size;
      data = bytes.subarray(body, end);
    }

    // Chunks are word-aligned: an odd size is followed by a pad byte.
    offset = body + size + (size % 2);
    if (size === 0 && id !== 'data') break;
  }

  if (channels < 1 || sampleRate < 1) throw new Error('WAVE file has no usable fmt chunk');
  if (data === null || data.length === 0) throw new Error('WAVE file has no data chunk');

  return { samples: decodeSamples(data, audioFormat, bitsPerSample), channels, sampleRate };
}

function decodeSamples(data: Buffer, audioFormat: number, bitsPerSample: number): Float32Array {
  if (audioFormat === FORMAT_IEEE_FLOAT && bitsPerSample === 32) {
    const count = Math.floor(data.length / 4);
    const out = new Float32Array(count);
    for (let index = 0; index < count; index += 1) out[index] = data.readFloatLE(index * 4);
    return out;
  }

  if (audioFormat !== FORMAT_PCM) {
    throw new Error(`Unsupported WAVE audio format ${audioFormat}`);
  }

  switch (bitsPerSample) {
    case 8: {
      // 8-bit PCM is unsigned, centred on 128 — the one signedness exception.
      const out = new Float32Array(data.length);
      for (let index = 0; index < data.length; index += 1) {
        out[index] = ((data[index] as number) - 128) / 128;
      }
      return out;
    }
    case 16: {
      const count = Math.floor(data.length / 2);
      const out = new Float32Array(count);
      for (let index = 0; index < count; index += 1) {
        out[index] = data.readInt16LE(index * 2) / 32_768;
      }
      return out;
    }
    case 24: {
      const count = Math.floor(data.length / 3);
      const out = new Float32Array(count);
      for (let index = 0; index < count; index += 1) {
        const at = index * 3;
        const raw =
          (data[at] as number) | ((data[at + 1] as number) << 8) | ((data[at + 2] as number) << 16);
        // Sign-extend the 24-bit value into 32 bits.
        out[index] = (raw & 0x800000 ? raw - 0x1000000 : raw) / 8_388_608;
      }
      return out;
    }
    case 32: {
      const count = Math.floor(data.length / 4);
      const out = new Float32Array(count);
      for (let index = 0; index < count; index += 1) {
        out[index] = data.readInt32LE(index * 4) / 2_147_483_648;
      }
      return out;
    }
    default:
      throw new Error(`Unsupported PCM bit depth ${bitsPerSample}`);
  }
}

export function downmixToMono(samples: Float32Array, channels: number): Float32Array {
  if (channels <= 1) return samples;

  const frames = Math.floor(samples.length / channels);
  const out = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      sum += samples[frame * channels + channel] as number;
    }
    out[frame] = sum / channels;
  }
  return out;
}

/**
 * Linear interpolation. Speech at 16 kHz from an 8–48 kHz source is well within
 * what this handles audibly, and it avoids a filter-design dependency for a
 * path whose real job is feeding a recogniser, not mastering audio.
 */
export function resampleLinear(
  samples: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate) return samples;
  if (samples.length === 0) return samples;

  const ratio = fromRate / toRate;
  const length = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Float32Array(length);

  for (let index = 0; index < length; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, samples.length - 1);
    const weight = position - left;
    out[index] = (samples[left] as number) * (1 - weight) + (samples[right] as number) * weight;
  }
  return out;
}

export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write('RIFF', 0, 'latin1');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'latin1');
  buffer.write('fmt ', 12, 'latin1');
  buffer.writeUInt32LE(16, 16); // PCM fmt chunk size
  buffer.writeUInt16LE(FORMAT_PCM, 20);
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36, 'latin1');
  buffer.writeUInt32LE(dataBytes, 40);

  for (let index = 0; index < samples.length; index += 1) {
    // Clamp before scaling: interpolation can push a sample fractionally past
    // full scale, and wrapping there is an audible click.
    const clamped = Math.max(-1, Math.min(1, samples[index] as number));
    buffer.writeInt16LE(Math.round(clamped * 32_767), 44 + index * 2);
  }

  return buffer;
}

/* -------------------------------------------------------------------------- *
 * ffmpeg — production
 * -------------------------------------------------------------------------- */

export class FfmpegAudioNormaliser implements AudioNormaliserPort {
  readonly driver = 'ffmpeg' as const;

  constructor(
    private readonly binary = 'ffmpeg',
    private readonly timeoutMs = 30_000,
  ) {}

  supports(_contentType: string): boolean {
    return true;
  }

  async toPcm16kMono(bytes: Buffer, _contentType: string): Promise<AudioNormalisationResult> {
    const result = await this.run(bytes);
    if (!result.ok) return result;

    try {
      const decoded = decodeWav(result.bytes);
      const mono = downmixToMono(decoded.samples, decoded.channels);
      return {
        ok: true,
        audio: {
          bytes: result.bytes,
          contentType: 'audio/wav',
          durationMs: Math.round((mono.length / TARGET_SAMPLE_RATE) * 1000),
          sampleRate: TARGET_SAMPLE_RATE,
          channels: 1,
        },
      };
    } catch (error) {
      return {
        ok: false,
        failure: {
          kind: 'CONVERSION_FAILED',
          detail: `ffmpeg produced output this build cannot read: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
  }

  private run(
    input: Buffer,
  ): Promise<{ ok: true; bytes: Buffer } | { ok: false; failure: AudioNormalisationFailure }> {
    return new Promise((resolve) => {
      const child = spawn(
        this.binary,
        [
          '-hide_banner',
          '-loglevel', 'error',
          '-i', 'pipe:0',
          '-ac', '1',
          '-ar', String(TARGET_SAMPLE_RATE),
          '-c:a', 'pcm_s16le',
          '-f', 'wav',
          'pipe:1',
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;

      const finish = (
        value: { ok: true; bytes: Buffer } | { ok: false; failure: AudioNormalisationFailure },
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({
          ok: false,
          failure: { kind: 'CONVERSION_FAILED', detail: `ffmpeg timed out after ${this.timeoutMs}ms` },
        });
      }, this.timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

      child.on('error', (error) => {
        finish({
          ok: false,
          failure: {
            kind: 'TOOL_UNAVAILABLE',
            detail: `Could not run "${this.binary}": ${error.message}`,
          },
        });
      });

      child.on('close', (code) => {
        if (code === 0 && stdout.length > 0) {
          finish({ ok: true, bytes: Buffer.concat(stdout) });
          return;
        }
        finish({
          ok: false,
          failure: {
            kind: 'CONVERSION_FAILED',
            detail: Buffer.concat(stderr).toString('utf8').slice(0, 500) || `ffmpeg exited ${code}`,
          },
        });
      });

      // stdin can close early when ffmpeg rejects the input; an EPIPE here is
      // the process's verdict, not a crash, and `close` reports it properly.
      child.stdin.on('error', () => undefined);
      child.stdin.end(input);
    });
  }
}

/**
 * Prefers ffmpeg when a binary is configured, and always keeps the in-process
 * WAV path as the fallback so a deployment without ffmpeg still handles the
 * formats it can.
 */
export class CompositeAudioNormaliser implements AudioNormaliserPort {
  readonly driver: 'ffmpeg' | 'wav';
  private readonly wav = new WavAudioNormaliser();

  constructor(private readonly ffmpeg: FfmpegAudioNormaliser | null) {
    this.driver = ffmpeg === null ? 'wav' : 'ffmpeg';
  }

  supports(contentType: string): boolean {
    return this.ffmpeg !== null || this.wav.supports(contentType);
  }

  async toPcm16kMono(bytes: Buffer, contentType: string): Promise<AudioNormalisationResult> {
    if (this.wav.supports(contentType)) return this.wav.toPcm16kMono(bytes, contentType);
    if (this.ffmpeg !== null) return this.ffmpeg.toPcm16kMono(bytes, contentType);
    return { ok: false, failure: { kind: 'UNSUPPORTED_SOURCE_FORMAT', contentType } };
  }
}
