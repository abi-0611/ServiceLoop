import { connect, type Socket } from 'node:net';
import type { AntivirusPort, ScanVerdict } from './port';

/**
 * ClamAV over the clamd `INSTREAM` protocol.
 *
 * A socket rather than the `clamscan` binary, and a stream rather than a
 * temporary file, for one reason: the bytes never touch this container's disk.
 * A malware sample written to `/tmp` on a Cloud Run instance so it can be
 * scanned is a malware sample on a Cloud Run instance.
 *
 * The wire protocol, in full, because it is small and undocumented in most
 * client libraries:
 *
 *   → "zINSTREAM\0"
 *   → <uint32be length><chunk> …repeated
 *   → <uint32be 0>                  (terminator)
 *   ← "stream: OK\0"  |  "stream: <Signature> FOUND\0"  |  "… ERROR\0"
 *
 * Chunks must be smaller than clamd's `StreamMaxLength`; 64 KiB is well inside
 * every default.
 */

export interface ClamAvConfig {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs: number;
}

const CHUNK_BYTES = 64 * 1024;

export class ClamAvScanner implements AntivirusPort {
  readonly driver = 'clamav' as const;

  constructor(private readonly config: ClamAvConfig) {}

  async scan(bytes: Buffer): Promise<ScanVerdict> {
    let reply: string;
    try {
      reply = await this.instream(bytes);
    } catch (error) {
      return {
        status: 'UNAVAILABLE',
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    // "stream: OK" — the only clean answer clamd gives.
    if (/\bOK\b/.test(reply) && !/FOUND/.test(reply)) return { status: 'CLEAN' };

    const found = /stream:\s*(.+?)\s+FOUND/.exec(reply);
    if (found?.[1] !== undefined) return { status: 'INFECTED', signature: found[1] };

    // An ERROR reply is the scanner refusing to answer — a size limit, a
    // corrupt archive bomb, a database reload in progress. Reported as
    // unavailable rather than infected: the caller's fail-open/fail-closed
    // setting is what decides, and it cannot decide if we lie about which
    // situation this is.
    return { status: 'UNAVAILABLE', reason: reply.trim() || 'clamd returned an empty reply' };
  }

  private instream(bytes: Buffer): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const socket: Socket = connect({ host: this.config.host, port: this.config.port });
      const chunks: Buffer[] = [];
      let settled = false;

      const finish = (error: Error | null, reply?: string): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error !== null) reject(error);
        else resolve(reply ?? '');
      };

      socket.setTimeout(this.config.timeoutMs, () => {
        finish(new Error(`clamd did not answer within ${this.config.timeoutMs}ms`));
      });
      socket.on('error', (error) => {
        finish(error instanceof Error ? error : new Error(String(error)));
      });
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.on('end', () => {
        finish(null, Buffer.concat(chunks).toString('utf8').replace(/\0+$/, ''));
      });

      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
          const slice = bytes.subarray(offset, offset + CHUNK_BYTES);
          const header = Buffer.alloc(4);
          header.writeUInt32BE(slice.length, 0);
          socket.write(header);
          socket.write(slice);
        }
        // A zero-length chunk closes the stream and asks for the verdict.
        socket.write(Buffer.from([0, 0, 0, 0]));
      });
    });
  }
}
