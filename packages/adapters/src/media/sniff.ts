import type { MediaKind } from '@serviceloop/shared';

/**
 * Content-type sniffing from magic bytes.
 *
 * The declared `mime_type` on a WhatsApp media object is whatever the sending
 * device claimed. Trusting it means a `.jpg` that is really an executable ends
 * up in object storage with `Content-Type: image/jpeg`, and later gets served
 * to a browser under that header. So the bytes decide, and the declared type is
 * only a hint used to break ties the magic numbers cannot.
 *
 * Hand-rolled rather than pulled from a library: the set of formats a workshop
 * actually sends is small and stable, and this way the rule that decides what
 * gets stored is right here, readable, and tested.
 */

export interface SniffResult {
  readonly contentType: string;
  readonly kind: MediaKind;
  readonly extension: string;
  /** True when the bytes contradicted the sender's declared type. */
  readonly declaredTypeMismatch: boolean;
}

interface Signature {
  readonly contentType: string;
  readonly kind: MediaKind;
  readonly extension: string;
  matches(bytes: Buffer): boolean;
}

function startsWith(bytes: Buffer, prefix: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + prefix.length) return false;
  return prefix.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(bytes: Buffer, offset: number, length: number): string {
  if (bytes.length < offset + length) return '';
  return bytes.subarray(offset, offset + length).toString('latin1');
}

const SIGNATURES: readonly Signature[] = [
  {
    contentType: 'image/jpeg',
    kind: 'PHOTO',
    extension: 'jpg',
    matches: (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]),
  },
  {
    contentType: 'image/png',
    kind: 'PHOTO',
    extension: 'png',
    matches: (bytes) => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  {
    contentType: 'image/webp',
    kind: 'PHOTO',
    extension: 'webp',
    matches: (bytes) => ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP',
  },
  {
    contentType: 'image/gif',
    kind: 'PHOTO',
    extension: 'gif',
    matches: (bytes) => ascii(bytes, 0, 3) === 'GIF',
  },
  {
    contentType: 'image/heic',
    kind: 'PHOTO',
    extension: 'heic',
    // ISO-BMFF `ftyp` box with a HEIF brand — what an iPhone camera produces.
    matches: (bytes) =>
      ascii(bytes, 4, 4) === 'ftyp' && ['heic', 'heix', 'mif1', 'heim'].includes(ascii(bytes, 8, 4)),
  },
  {
    contentType: 'audio/ogg',
    kind: 'AUDIO',
    extension: 'ogg',
    matches: (bytes) => ascii(bytes, 0, 4) === 'OggS',
  },
  {
    contentType: 'audio/wav',
    kind: 'AUDIO',
    extension: 'wav',
    matches: (bytes) => ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE',
  },
  {
    contentType: 'audio/mpeg',
    kind: 'AUDIO',
    extension: 'mp3',
    matches: (bytes) => ascii(bytes, 0, 3) === 'ID3' || startsWith(bytes, [0xff, 0xfb]),
  },
  {
    contentType: 'audio/amr',
    kind: 'AUDIO',
    extension: 'amr',
    matches: (bytes) => ascii(bytes, 0, 6) === '#!AMR\n',
  },
  {
    contentType: 'video/mp4',
    kind: 'VIDEO',
    extension: 'mp4',
    matches: (bytes) =>
      ascii(bytes, 4, 4) === 'ftyp' && ['isom', 'mp42', 'avc1', 'M4V '].includes(ascii(bytes, 8, 4)),
  },
  {
    contentType: 'video/3gpp',
    kind: 'VIDEO',
    extension: '3gp',
    matches: (bytes) => ascii(bytes, 4, 4) === 'ftyp' && ascii(bytes, 8, 3) === '3gp',
  },
  {
    contentType: 'application/pdf',
    kind: 'DOCUMENT',
    extension: 'pdf',
    matches: (bytes) => ascii(bytes, 0, 5) === '%PDF-',
  },
];

/**
 * An OGG container can hold Opus or Vorbis. WhatsApp voice notes are Opus, and
 * knowing which matters to the transcoder, so the codec is read from the first
 * page header rather than assumed.
 */
function refineOgg(bytes: Buffer): string {
  const header = bytes.subarray(0, 128).toString('latin1');
  if (header.includes('OpusHead')) return 'audio/ogg; codecs=opus';
  if (header.includes('vorbis')) return 'audio/ogg; codecs=vorbis';
  return 'audio/ogg';
}

export const UNKNOWN_CONTENT_TYPE = 'application/octet-stream';

export function sniffContentType(bytes: Buffer, declaredType?: string): SniffResult {
  const declared = normaliseType(declaredType);

  for (const signature of SIGNATURES) {
    if (!signature.matches(bytes)) continue;

    const contentType =
      signature.contentType === 'audio/ogg' ? refineOgg(bytes) : signature.contentType;

    return {
      contentType,
      kind: signature.kind,
      extension: signature.extension,
      declaredTypeMismatch: declared !== null && baseType(declared) !== baseType(contentType),
    };
  }

  // Nothing matched. We refuse to inherit the sender's claim — an unrecognised
  // blob is stored as an opaque download, never as something a browser will
  // execute or render.
  return {
    contentType: UNKNOWN_CONTENT_TYPE,
    kind: 'DOCUMENT',
    extension: 'bin',
    declaredTypeMismatch: declared !== null,
  };
}

function normaliseType(value: string | undefined): string | null {
  if (value === undefined || value.trim().length === 0) return null;
  return value.trim().toLowerCase();
}

/** `audio/ogg; codecs=opus` → `audio/ogg`. */
export function baseType(contentType: string): string {
  const [base = ''] = contentType.split(';');
  return base.trim().toLowerCase();
}
