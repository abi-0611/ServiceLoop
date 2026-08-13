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
}

export interface ChainVerificationResult {
  readonly valid: boolean;
  readonly entriesChecked: number;
  /** Zero-based index of the first bad entry, or null when the chain is intact. */
  readonly brokenAtIndex: number | null;
  readonly brokenEventId: string | null;
  readonly reason: string | null;
}

const INTACT = (entriesChecked: number): ChainVerificationResult => ({
  valid: true,
  entriesChecked,
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
      return broken(
        index,
        entry,
        index,
        `Content tampered: stored hash ${entry.hash}, recomputed ${recomputed}`,
      );
    }

    prevHash = entry.hash;
    expectedSeq += 1;
  }

  return INTACT(entries.length);
}

/** Convenience for appenders: the hash a new entry must chain onto. */
export function chainHeadHash(entries: readonly AuditChainEntry[]): string {
  const last = entries[entries.length - 1];
  return last?.hash ?? GENESIS_HASH;
}
