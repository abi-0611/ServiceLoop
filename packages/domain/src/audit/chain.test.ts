import { uuidv7 } from '@serviceloop/shared';
import { describe, expect, it } from 'vitest';
import {
  type AuditChainEntry,
  chainHeadHash,
  computeAuditHash,
  GENESIS_HASH,
  verifyAuditChain,
} from './chain';

const SHOP_ID = uuidv7();

function buildChain(length: number): AuditChainEntry[] {
  const entries: AuditChainEntry[] = [];
  let prevHash = GENESIS_HASH;

  for (let index = 0; index < length; index += 1) {
    const facts = {
      shopId: SHOP_ID,
      seq: index + 1,
      actorType: 'STAFF',
      actorId: 'staff-1',
      action: 'job_card.state_changed',
      entityType: 'JobCard',
      entityId: `card-${index}`,
      payload: { from: 'OPEN', to: 'IN_DIAGNOSIS', index },
      createdAt: new Date(Date.UTC(2026, 3, 1, 9, index)).toISOString(),
    };
    const hash = computeAuditHash(prevHash, facts);
    entries.push({ ...facts, id: uuidv7(), prevHash, hash });
    prevHash = hash;
  }

  return entries;
}

describe('audit chain', () => {
  it('is deterministic and order-independent in payload key order', () => {
    const facts = {
      shopId: SHOP_ID,
      seq: 1,
      actorType: 'AGENT',
      actorId: null,
      action: 'test',
      entityType: 'JobCard',
      entityId: 'card-1',
      payload: { b: 2, a: 1 },
      createdAt: '2026-04-01T09:00:00.000Z',
    };
    const reordered = { ...facts, payload: { a: 1, b: 2 } };
    expect(computeAuditHash(GENESIS_HASH, facts)).toBe(computeAuditHash(GENESIS_HASH, reordered));
  });

  it('verifies an intact chain of any length', () => {
    expect(verifyAuditChain([])).toMatchObject({ valid: true, entriesChecked: 0 });
    const chain = buildChain(25);
    expect(verifyAuditChain(chain)).toEqual({
      valid: true,
      entriesChecked: 25,
      // Phase 7.2 added this: an intact chain has redacted nothing.
      redactedEntries: 0,
      brokenAtIndex: null,
      brokenEventId: null,
      reason: null,
    });
    expect(chainHeadHash(chain)).toBe(chain[24]?.hash);
    expect(chainHeadHash([])).toBe(GENESIS_HASH);
  });

  it('detects a tampered payload at the exact index', () => {
    const chain = buildChain(10);
    const target = chain[4];
    expect(target).toBeDefined();
    const tampered = [...chain];
    tampered[4] = { ...(target as AuditChainEntry), payload: { from: 'OPEN', to: 'CLOSED' } };

    const result = verifyAuditChain(tampered);
    expect(result.valid).toBe(false);
    expect(result.brokenAtIndex).toBe(4);
    expect(result.brokenEventId).toBe(target?.id);
    expect(result.reason).toMatch(/Content tampered/);
  });

  it('detects a deleted entry as a sequence gap', () => {
    const chain = buildChain(6);
    const withHole = [...chain.slice(0, 3), ...chain.slice(4)];
    const result = verifyAuditChain(withHole);
    expect(result.valid).toBe(false);
    expect(result.brokenAtIndex).toBe(3);
    expect(result.reason).toMatch(/Sequence gap: expected seq 4, found 5/);
  });

  it('detects a rewritten link even when the hash itself is recomputed', () => {
    const chain = buildChain(5);
    const target = chain[2];
    expect(target).toBeDefined();
    const entry = target as AuditChainEntry;
    const forgedFacts = {
      shopId: entry.shopId,
      seq: entry.seq,
      actorType: entry.actorType,
      actorId: entry.actorId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      payload: { forged: true },
      createdAt: entry.createdAt,
    };
    const forged: AuditChainEntry = {
      ...forgedFacts,
      id: entry.id,
      prevHash: entry.prevHash,
      hash: computeAuditHash(entry.prevHash, forgedFacts),
    };
    const tampered = [...chain];
    tampered[2] = forged;

    // Entry 2 now self-verifies, but entry 3 no longer links to it.
    const result = verifyAuditChain(tampered);
    expect(result.valid).toBe(false);
    expect(result.brokenAtIndex).toBe(3);
    expect(result.reason).toMatch(/Broken link/);
  });

  it('detects a chain that does not start at the genesis hash', () => {
    const chain = buildChain(3);
    const head = chain[0];
    const tampered = [...chain];
    tampered[0] = { ...(head as AuditChainEntry), prevHash: 'f'.repeat(64) };
    const result = verifyAuditChain(tampered);
    expect(result.valid).toBe(false);
    expect(result.brokenAtIndex).toBe(0);
  });
});

/**
 * Erasure and the hash chain, both true at once (phase 7.2).
 *
 * A DPDP deletion rewrites the payload of every audit row about the erased
 * customer and deliberately leaves the stored hash alone. These are the
 * properties that combination has to keep, and the last one is the reason the
 * flag is not simply "skip this row".
 */
describe('redacted entries', () => {
  it('reports an intact chain with a redacted payload as valid, and says how many', () => {
    const chain = buildChain(5);
    const target = chain[2] as (typeof chain)[number];
    const redacted = chain.map((entry, index) =>
      index === 2
        ? { ...entry, payload: { subjectPseudonym: 'sub_abc' }, payloadRedacted: true }
        : entry,
    );

    const result = verifyAuditChain(redacted);

    expect(result.valid).toBe(true);
    expect(result.redactedEntries).toBe(1);
    expect(result.entriesChecked).toBe(5);
    // The row keeps its original hash, so everything after it still links.
    expect(target.hash).toBe(redacted[2]?.hash);
  });

  it('still reports tampering when the payload changed and the flag is absent', () => {
    const chain = buildChain(5);
    const tampered = chain.map((entry, index) =>
      index === 2 ? { ...entry, payload: { rewritten: true } } : entry,
    );

    const result = verifyAuditChain(tampered);

    expect(result.valid).toBe(false);
    expect(result.brokenAtIndex).toBe(2);
    expect(result.reason).toContain('Content tampered');
  });

  it('still breaks when a redacted entry is deleted from the chain', () => {
    // The property that keeps the flag from being an escape hatch: it permits
    // a payload to differ from its hash and nothing else. Removing the row
    // breaks the sequence, and no flag can hide that.
    const chain = buildChain(5).map((entry) => ({ ...entry, payloadRedacted: true }));
    const withHole = [...chain.slice(0, 2), ...chain.slice(3)];

    const result = verifyAuditChain(withHole);

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Sequence gap');
  });

  it('still breaks when a redacted entry’s link is altered', () => {
    const chain = buildChain(5).map((entry) => ({ ...entry, payloadRedacted: true }));
    const relinked = chain.map((entry, index) =>
      index === 3 ? { ...entry, prevHash: '0'.repeat(64) } : entry,
    );

    const result = verifyAuditChain(relinked);

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Broken link');
  });
});
