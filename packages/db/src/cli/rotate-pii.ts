import { getEnv } from '@serviceloop/config';
import { sql } from 'drizzle-orm';
import { createDatabase } from '../client';
import { activeKeyId, decryptableKeyIds, keyIdOf, reEncryptPii } from '../crypto/pii';

/**
 * The PII key-rotation job (phase 7.1, step 3 of the documented procedure).
 *
 *   pnpm pii:rotate --status      # how many rows are still on an old key
 *   pnpm pii:rotate               # rewrite them, in batches
 *
 * Run it until `--status` reports zero *before* dropping the retired key from
 * `PII_KEY_RING`. Dropping it early is the mistake that loses data permanently
 * — the ciphertext is still there and nothing can read it — which is why this
 * command exists at all rather than a background sweep nobody watches.
 *
 * Batched and resumable. A shop with a hundred thousand customers is a
 * multi-minute rewrite, and a single transaction over that holds row locks on
 * the customers table for its whole duration, which stops every inbound webhook
 * that needs to resolve a phone number.
 *
 * The columns are listed explicitly rather than discovered, and that is
 * deliberate: `encryptedText` is a named column type in the schema, so a
 * discovery pass is possible — but a rotation that silently skipped a column
 * added last month would report success and leave readable-by-nobody data
 * behind. A hard-coded list fails loudly when the schema outgrows it, and
 * `rotate-pii.test.ts` compares it against the schema.
 */

interface EncryptedColumn {
  readonly table: string;
  readonly idColumn: string;
  readonly columns: readonly string[];
}

export const ENCRYPTED_COLUMNS: readonly EncryptedColumn[] = [
  { table: 'customers', idColumn: 'id', columns: ['full_name_encrypted', 'phone_encrypted'] },
  { table: 'staff', idColumn: 'id', columns: ['phone_encrypted'] },
  // The three below were missing until `rotate-pii.test.ts` was written, which
  // is the failure the paragraph above predicts, found exactly the way it says
  // it would be. Each holds something a database dump must not hand over: the
  // WhatsApp address a thread is bound to, the number the shop rang, and a
  // customer's own words about the service they received.
  { table: 'conversations', idColumn: 'id', columns: ['external_address_encrypted'] },
  { table: 'calls', idColumn: 'id', columns: ['to_encrypted'] },
  { table: 'feedback_requests', idColumn: 'id', columns: ['comment_encrypted'] },
];

const BATCH = 500;

async function main(): Promise<void> {
  const env = getEnv();
  const database = createDatabase(env);
  const statusOnly = process.argv.includes('--status');

  console.log(`Active key:      ${activeKeyId()}`);
  console.log(`Readable keys:   ${decryptableKeyIds().join(', ')}`);
  console.log();

  let totalStale = 0;
  let totalRotated = 0;

  for (const target of ENCRYPTED_COLUMNS) {
    for (const column of target.columns) {
      // The key id lives inside the ciphertext (`v1:<keyId>:…`), not in a
      // column of its own — a column would be a second place the truth lives,
      // and the two would eventually disagree, at which point a row is
      // reported as rotated and is not.
      const stale = await database.db.execute<{ count: number }>(
        sql`select count(*)::int as count from ${sql.raw(target.table)}
            where ${sql.raw(column)} is not null
              and split_part(${sql.raw(column)}, ':', 2) <> ${activeKeyId()}`,
      );
      const staleCount = Number(stale.rows[0]?.count ?? 0);
      totalStale += staleCount;

      console.log(`${target.table}.${column}: ${staleCount} row(s) on a retired key`);
      if (statusOnly || staleCount === 0) continue;

      let rotated = 0;
      for (;;) {
        const batch = await database.db.execute<Record<string, string>>(
          sql`select ${sql.raw(target.idColumn)} as id, ${sql.raw(column)} as value
              from ${sql.raw(target.table)}
              where ${sql.raw(column)} is not null
                and split_part(${sql.raw(column)}, ':', 2) <> ${activeKeyId()}
              limit ${BATCH}`,
        );
        if (batch.rows.length === 0) break;

        // One transaction per batch. The rewrite is a pure re-encryption — the
        // plaintext is unchanged — so a partially completed rotation is
        // correct at every point, and resuming is just running it again.
        await database.db.transaction(async (tx) => {
          for (const row of batch.rows) {
            const rewritten = reEncryptPii(row.value as string);
            if (rewritten === null) continue;
            await tx.execute(
              sql`update ${sql.raw(target.table)}
                  set ${sql.raw(column)} = ${rewritten}
                  where ${sql.raw(target.idColumn)} = ${row.id}`,
            );
            rotated += 1;
          }
        });

        process.stdout.write(`  rotated ${rotated}/${staleCount}\r`);
      }
      console.log(`  rotated ${rotated}/${staleCount}   `);
      totalRotated += rotated;
    }
  }

  await database.close();
  console.log();

  if (statusOnly) {
    console.log(
      totalStale === 0
        ? `Nothing stale. It is safe to drop retired keys from PII_KEY_RING, leaving "${activeKeyId()}".`
        : `${totalStale} row(s) still on a retired key. Do NOT drop it from PII_KEY_RING yet.`,
    );
    // Non-zero when work remains, so the runbook step can be a command rather
    // than an instruction to read a number carefully.
    process.exit(totalStale === 0 ? 0 : 1);
  }

  console.log(`Rotated ${totalRotated} value(s).`);
  console.log('Run `pnpm pii:rotate --status` and see zero before dropping the old key.');
}

/** Exposed for the runbook and the test; see the comment on `ENCRYPTED_COLUMNS`. */
export function encryptedColumnCount(): number {
  return ENCRYPTED_COLUMNS.reduce((total, entry) => total + entry.columns.length, 0);
}

/** Guard for a caller that wants to know whether a value needs rewriting. */
export function isStale(encoded: string): boolean {
  return keyIdOf(encoded) !== activeKeyId();
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error('[pii:rotate] failed');
    console.error(error);
    process.exit(1);
  });
}
