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
