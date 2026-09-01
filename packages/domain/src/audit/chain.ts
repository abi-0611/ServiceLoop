import { createHash } from 'node:crypto';
import { canonicalJson } from '@serviceloop/shared';

/**
 * Hash-chained audit log (phase 1.7).
 *
 * Each shop owns an independent chain. Appending event *n* computes
 *   hash(n) = sha256( hash(n-1) || canonicalJson(event(n)) )
 * so any later edit to a historical row invalidates every hash after it, and
 * `verifyAuditChain` reports the exact index where the chain first breaks.
 *
 * The hashed projection deliberately excludes the row id and the hashes
 * themselves: it covers exactly the facts an auditor cares about.
 */

export const GENESIS_HASH = '0'.repeat(64);

export interface AuditChainFacts {
  readonly shopId: string;
  readonly seq: number;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly payload: unknown;
  /** ISO-8601 with milliseconds; the stored timestamp, not the current time. */
  readonly createdAt: string;
}

export function computeAuditHash(prevHash: string, facts: AuditChainFacts): string {
  return createHash('sha256').update(prevHash).update(canonicalJson(facts)).digest('hex');
}

export interface AuditChainEntry extends AuditChainFacts {
  readonly id: string;
  readonly prevHash: string;
  readonly hash: string;
  /**
   * This entry's payload was rewritten by an approved DPDP erasure
   * (phase 7.2), so it no longer hashes to its stored `hash`.
   *
   * The alternative — recomputing the hash after redaction — is worse in a way
   * that is easy to miss: it would relink the chain from that point onward, so
   * a verification run last year and one run today would give different
   * answers about the same history. The property the chain has is "this
   * sequence of decisions has not been altered", and re-hashing after an edit
   * throws it away in order to preserve the appearance of it.
   *
   * So the row keeps its original hash, the link to the next entry is
   * unaffected, and the content check is skipped for this entry alone — which
   * the verifier reports as `redacted`, not as `valid`. A shop can still prove
   * every decision it took; it can no longer prove the *contents* of the ones
   * a customer asked it to forget, which is precisely what that customer asked
   * for.
   */
  readonly payloadRedacted?: boolean;
}

export interface ChainVerificationResult {
  readonly valid: boolean;
  readonly entriesChecked: number;
  /**
   * Entries whose payload was lawfully rewritten by an erasure and whose
   * content hash was therefore not checked.
   *
   * Reported separately rather than folded into `valid`, because "intact" and
   * "intact, with four entries redacted at a customer's request" are different
   * facts and an auditor is entitled to both. A verifier that silently skipped
   * them would be a verifier an attacker could hide behind by setting one flag.
   */
  readonly redactedEntries?: number;
  /** Zero-based index of the first bad entry, or null when the chain is intact. */
  readonly brokenAtIndex: number | null;
  readonly brokenEventId: string | null;
  readonly reason: string | null;
}

const INTACT = (entriesChecked: number, redactedEntries = 0): ChainVerificationResult => ({
  valid: true,
  entriesChecked,
  redactedEntries,
  brokenAtIndex: null,
  brokenEventId: null,
  reason: null,
});

function broken(
  index: number,
  entry: AuditChainEntry,
  entriesChecked: number,
  reason: string,
): ChainVerificationResult {
  return { valid: false, entriesChecked, brokenAtIndex: index, brokenEventId: entry.id, reason };
}

/**
 * Walks one shop's chain in sequence order. Entries must be supplied ordered by
 * `seq` ascending, starting at the chain head (`seq = 1`).
 */
export function verifyAuditChain(entries: readonly AuditChainEntry[]): ChainVerificationResult {
  let prevHash = GENESIS_HASH;
  let expectedSeq = 1;
  let redactedEntries = 0;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined) continue;

    if (entry.seq !== expectedSeq) {
      return broken(
        index,
        entry,
        index,
        `Sequence gap: expected seq ${expectedSeq}, found ${entry.seq}`,
      );
    }

    if (entry.prevHash !== prevHash) {
      return broken(
        index,
        entry,
        index,
        `Broken link: entry records prevHash ${entry.prevHash}, chain head is ${prevHash}`,
      );
    }

    const recomputed = computeAuditHash(prevHash, {
      shopId: entry.shopId,
      seq: entry.seq,
      actorType: entry.actorType,
      actorId: entry.actorId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      payload: entry.payload,
      createdAt: entry.createdAt,
    });

    if (recomputed !== entry.hash) {
      /**
       * The one lawful reason a payload may not match its hash.
       *
       * Note what is *not* skipped: the sequence check and the link check both
       * ran above and both still apply. A redacted entry that was deleted,
       * reordered, or whose `prevHash` was altered still breaks the chain. The
       * flag buys exactly one thing — permission for this row's payload to
       * differ from what was hashed — and nothing else.
       */
      if (entry.payloadRedacted === true) {
        redactedEntries += 1;
      } else {
        return broken(
          index,
          entry,
          index,
          `Content tampered: stored hash ${entry.hash}, recomputed ${recomputed}`,
        );
      }
    }

    prevHash = entry.hash;
    expectedSeq += 1;
  }

  return INTACT(entries.length, redactedEntries);
}

/** Convenience for appenders: the hash a new entry must chain onto. */
export function chainHeadHash(entries: readonly AuditChainEntry[]): string {
  const last = entries[entries.length - 1];
  return last?.hash ?? GENESIS_HASH;
}
