/**
 * AntivirusPort — the upload-scanning hook point (phase 7.1).
 *
 * A shop's customers send photographs, voice notes and PDFs into a system that
 * stores them and hands them to advisors to open. That is a malware delivery
 * path whether or not anyone has used it yet, and the honest position for a
 * two-person team is not "we scan everything" — it is "the call site exists,
 * the daemon is one environment variable away, and the boot log says which of
 * the two is true today".
 *
 * The port is therefore deliberately narrow: bytes in, a verdict out. It has no
 * opinion about what the caller does with an infected file, because the media
 * pipeline does — it rejects with a customer-facing reason, in the customer's
 * language, like every other rejection there.
 */

export type ScanVerdict =
  | { readonly status: 'CLEAN' }
  | { readonly status: 'INFECTED'; readonly signature: string }
  /**
   * The scanner could not answer. Distinct from `CLEAN` on purpose: a caller
   * configured fail-closed must be able to tell "nothing found" from "nothing
   * looked", and collapsing the two is exactly how a scanner outage becomes a
   * silent acceptance of everything for a week.
   */
  | { readonly status: 'UNAVAILABLE'; readonly reason: string };

export interface AntivirusPort {
  readonly driver: 'none' | 'clamav';
  scan(bytes: Buffer, filename?: string | null): Promise<ScanVerdict>;
}
