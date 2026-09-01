import { randomBytes } from 'node:crypto';
import { resetEnvCache } from '@serviceloop/config';
import { afterEach, describe, expect, it } from 'vitest';
import {
  activeKeyId,
  blindIndex,
  blindIndexEquals,
  decryptableKeyIds,
  decryptPii,
  encryptPii,
  isEncryptedPii,
  keyIdOf,
  reEncryptPii,
} from './pii';

/**
 * PII field encryption and the key-rotation window (phase 7.1).
 *
 * The rotation tests are the point of this file. Encryption that round-trips is
 * table stakes; the property that actually protects a shop's data is that a
 * *half-completed* rotation — which is the only state a real rotation is ever
 * observed in, because it takes hours — never makes a row unreadable.
 */

const KEY_A = randomBytes(32).toString('base64');
const KEY_B = randomBytes(32).toString('base64');
const BLIND = randomBytes(32).toString('base64');

function useEnv(overrides: Record<string, string>): void {
  resetEnvCache();
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DEMO_MODE: 'true',
    BLIND_INDEX_KEY: BLIND,
    ...overrides,
  });
}

afterEach(() => {
  for (const key of ['PII_ENCRYPTION_KEY', 'PII_KEY_ID', 'PII_KEY_RING', 'BLIND_INDEX_KEY']) {
    delete process.env[key];
  }
  resetEnvCache();
});

describe('encryptPii / decryptPii', () => {
  it('round-trips and never emits the plaintext', () => {
    useEnv({ PII_ENCRYPTION_KEY: KEY_A, PII_KEY_ID: 'k1' });
    const encoded = encryptPii('Ramesh Kumar');
    expect(encoded).not.toContain('Ramesh');
    expect(decryptPii(encoded)).toBe('Ramesh Kumar');
    expect(isEncryptedPii(encoded)).toBe(true);
  });

  it('produces different ciphertext for the same plaintext', () => {
    useEnv({ PII_ENCRYPTION_KEY: KEY_A, PII_KEY_ID: 'k1' });
    // A random IV per write. Without it, two customers with the same name
    // would be visibly the same to anybody holding a database dump.
    expect(encryptPii('+919876543210')).not.toBe(encryptPii('+919876543210'));
  });

  it('refuses a tampered auth tag rather than returning garbage', () => {
    useEnv({ PII_ENCRYPTION_KEY: KEY_A, PII_KEY_ID: 'k1' });
    const parts = encryptPii('+919876543210').split(':');
    parts[3] = Buffer.alloc(16, 9).toString('base64');
    expect(() => decryptPii(parts.join(':'))).toThrow();
  });

  it('records the key id inside the ciphertext', () => {
    useEnv({ PII_ENCRYPTION_KEY: KEY_A, PII_KEY_ID: '2026-q3' });
    expect(keyIdOf(encryptPii('x'))).toBe('2026-q3');
    expect(keyIdOf('not a ciphertext')).toBeNull();
  });
});

describe('key rotation', () => {
  it('reads a row written under a retired key that is still in the ring', () => {
    // Step 0: everything is written under k1.
    useEnv({ PII_ENCRYPTION_KEY: KEY_A, PII_KEY_ID: 'k1' });
    const legacy = encryptPii('+919876543210');

    // Steps 1 and 2: k2 is active, k1 is still in the ring.
    useEnv({
      PII_ENCRYPTION_KEY: KEY_B,
      PII_KEY_ID: 'k2',
      PII_KEY_RING: JSON.stringify({ k1: KEY_A, k2: KEY_B }),
    });

    expect(decryptPii(legacy)).toBe('+919876543210');
    expect(decryptableKeyIds()).toEqual(['k1', 'k2']);
    expect(activeKeyId()).toBe('k2');
  });

  it('is the *only* thing that makes a rolling deploy safe', () => {
    // The failure this window prevents: k2 is active and k1 has been dropped
    // from the ring before the re-encryption job finished.
    useEnv({ PII_ENCRYPTION_KEY: KEY_A, PII_KEY_ID: 'k1' });
    const legacy = encryptPii('Ramesh Kumar');

    useEnv({ PII_ENCRYPTION_KEY: KEY_B, PII_KEY_ID: 'k2' });
    expect(() => decryptPii(legacy)).toThrow(/No PII key available for keyId "k1"/);
  });

  it('rewrites a stale value under the active key and leaves a current one alone', () => {
    useEnv({ PII_ENCRYPTION_KEY: KEY_A, PII_KEY_ID: 'k1' });
    const legacy = encryptPii('Ramesh Kumar');

    useEnv({
      PII_ENCRYPTION_KEY: KEY_B,
      PII_KEY_ID: 'k2',
      PII_KEY_RING: JSON.stringify({ k1: KEY_A, k2: KEY_B }),
    });

    const rotated = reEncryptPii(legacy);
    expect(rotated).not.toBeNull();
    expect(keyIdOf(rotated as string)).toBe('k2');
    expect(decryptPii(rotated as string)).toBe('Ramesh Kumar');

    // Idempotent: a second pass over a row the first pass rewrote is a no-op,
    // which is what lets the job be run repeatedly until it reports zero.
    expect(reEncryptPii(rotated as string)).toBeNull();
  });
});

describe('blindIndex', () => {
  it('is deterministic within a shop and different across shops', () => {
    useEnv({ PII_ENCRYPTION_KEY: KEY_A, PII_KEY_ID: 'k1' });
    const shopA = blindIndex('shop-a', '+919876543210');
    const shopB = blindIndex('shop-b', '+919876543210');

    expect(blindIndex('shop-a', '+919876543210')).toBe(shopA);
    // Scoping is what stops one shop's index being used to probe another's for
    // "is this customer of mine also a customer of theirs".
    expect(shopA).not.toBe(shopB);
    expect(blindIndexEquals(shopA, shopA)).toBe(true);
    expect(blindIndexEquals(shopA, shopB)).toBe(false);
  });

  it('normalises case and surrounding whitespace', () => {
    useEnv({ PII_ENCRYPTION_KEY: KEY_A, PII_KEY_ID: 'k1' });
    expect(blindIndex('shop-a', '  Ramesh Kumar ')).toBe(blindIndex('shop-a', 'ramesh kumar'));
  });
});
