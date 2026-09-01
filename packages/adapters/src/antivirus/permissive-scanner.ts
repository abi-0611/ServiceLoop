import type { AntivirusPort, ScanVerdict } from './port';

/**
 * The `ANTIVIRUS_DRIVER=none` adapter.
 *
 * It accepts everything except the EICAR test string, and that single exception
 * is the point of the class. A no-op scanner that accepted *literally*
 * everything would be untestable: the media pipeline's rejection path, its
 * customer-facing copy and its audit row would only ever be exercised in an
 * environment with a real ClamAV container, which is not CI. Recognising the
 * industry-standard test file means the infected branch is walked on every run
 * of the suite, with no daemon and no signatures.
 *
 * It is not a security control and does not claim to be one. The boot log says
 * `PermissiveScanner ... uploads are accepted without being scanned`.
 */
export class PermissiveScanner implements AntivirusPort {
  readonly driver = 'none' as const;

  /**
   * The EICAR anti-malware test file. Deliberately reassembled at runtime from
   * fragments rather than written as one string literal: a repository that
   * contains the intact 68-byte sequence is a repository that a developer's own
   * endpoint protection quarantines on checkout.
   */
  static readonly EICAR = [
    'X5O!P%@AP[4\\PZX54(P^)7CC)7}',
    '$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!',
    '$H+H*',
  ].join('');

  async scan(bytes: Buffer): Promise<ScanVerdict> {
    // Bounded: the marker is at the head of the file by definition, and hashing
    // a 20 MB video to find a 68-byte prefix would put the scanner on the
    // critical path of every upload for no benefit.
    const head = bytes.subarray(0, 1024).toString('latin1');
    return head.includes(PermissiveScanner.EICAR)
      ? { status: 'INFECTED', signature: 'Eicar-Test-Signature' }
      : { status: 'CLEAN' };
  }
}
