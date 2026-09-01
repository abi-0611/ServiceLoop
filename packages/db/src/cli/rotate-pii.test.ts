import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { ENCRYPTED_COLUMNS } from './rotate-pii';
import * as schema from '../schema';

/**
 * The rotation covers every encrypted column (phase 7.1).
 *
 * `rotate-pii.ts` hard-codes its column list rather than discovering it, and
 * says why: a rotation that silently skipped a column added last month would
 * report success and leave behind ciphertext that, once the retired key is
 * dropped from `PII_KEY_RING`, nobody can ever read again. That is permanent
 * data loss produced by a command reporting that it succeeded.
 *
 * A hard-coded list is only safe if something compares it against the schema.
 * This is that something, and it is the reason the list is allowed to be
 * hard-coded at all.
 *
 * **It found three missing columns the first time it ran** —
 * `conversations.external_address_encrypted`, `calls.to_encrypted` and
 * `feedback_requests.comment_encrypted` — which is exactly the failure the
 * comment in `rotate-pii.ts` predicts. Adding the test and fixing the list were
 * the same change.
 */

/**
 * Every `encryptedText` column in the schema, found structurally.
 *
 * The custom type has no marker on the column object, so it is recognised by
 * its SQL name suffix — every one of them is named `*_encrypted`, which is a
 * convention the schema keeps deliberately for exactly this kind of check. A
 * column holding PII under some other name would escape this, which is why the
 * convention is worth keeping rather than a detail.
 */
function encryptedColumnsInSchema(): { table: string; column: string }[] {
  const found: { table: string; column: string }[] = [];

  for (const value of Object.values(schema)) {
    // Drizzle tables are objects with a symbol-keyed config; anything else in
    // the barrel (enums, relations, helpers) is skipped.
    if (typeof value !== 'object' || value === null) continue;

    let config;
    try {
      config = getTableConfig(value as never);
    } catch {
      continue;
    }

    for (const column of config.columns) {
      if (column.name.endsWith('_encrypted')) {
        found.push({ table: config.name, column: column.name });
      }
    }
  }

  return found.sort((a, b) => `${a.table}.${a.column}`.localeCompare(`${b.table}.${b.column}`));
}

describe('the PII rotation column list', () => {
  it('finds encrypted columns to compare against', () => {
    // A guard on the guard: if the discovery above ever returns nothing —
    // because the barrel changed shape, or the naming convention did — every
    // other assertion in this file passes vacuously and the test becomes a
    // decoration that reports the rotation is complete.
    expect(encryptedColumnsInSchema().length).toBeGreaterThan(3);
  });

  it('covers every encrypted column in the schema', () => {
    const declared = new Set(
      ENCRYPTED_COLUMNS.flatMap((target) =>
        target.columns.map((column) => `${target.table}.${column}`),
      ),
    );

    const missing = encryptedColumnsInSchema()
      .map((entry) => `${entry.table}.${entry.column}`)
      .filter((key) => !declared.has(key));

    expect(
      missing,
      [
        'These encrypted columns exist in the schema and `pnpm pii:rotate` would not rewrite them.',
        'Add them to ENCRYPTED_COLUMNS in rotate-pii.ts.',
        'Leaving one out means that when the retired key is dropped from PII_KEY_RING,',
        'the data in that column becomes permanently unreadable — and the command that',
        'was supposed to prevent that will have reported success.',
      ].join('\n'),
    ).toEqual([]);
  });

  it('names no column that has left the schema', () => {
    const actual = new Set(
      encryptedColumnsInSchema().map((entry) => `${entry.table}.${entry.column}`),
    );

    const stale = ENCRYPTED_COLUMNS.flatMap((target) =>
      target.columns.map((column) => `${target.table}.${column}`),
    ).filter((key) => !actual.has(key));

    // A stale entry is not dangerous the way a missing one is — the rotation
    // would fail loudly on an unknown column rather than skip it quietly — but
    // it means the list has stopped being maintained, and the missing-column
    // half of this test is only as trustworthy as the maintenance.
    expect(stale, 'ENCRYPTED_COLUMNS names columns that no longer exist:').toEqual([]);
  });

  it('gives every target an id column to page by', () => {
    // The rotation is batched and resumable, which requires a stable ordering
    // key. A target with the wrong id column would page over the same batch for
    // ever, or skip rows — and either way `--status` would never reach zero.
    for (const target of ENCRYPTED_COLUMNS) {
      expect(target.idColumn, `${target.table} has no id column`).toBeTruthy();
      expect(target.columns.length, `${target.table} has no columns listed`).toBeGreaterThan(0);
    }
  });
});
