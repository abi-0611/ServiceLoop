import { getEnv } from '@serviceloop/config';
import { sql } from 'drizzle-orm';
import { AuditService } from '../services/audit-service';
import { createDatabase } from '../client';

/**
 * Verifies every shop's audit chain (phase 7.5).
 *
 *   pnpm audit:verify
 *   pnpm audit:verify --shop <uuid>
 *
 * Exists as a CLI, separate from the API endpoint that does the same thing, for
 * one reason: it must work against a *restored backup*, with no API, no Redis
 * and no running workers. `scripts/restore-and-verify.sh` is its main caller,
 * and the chain is the strongest evidence available that a restore is complete
 * — any row lost, truncated or reordered in transit breaks a hash link, and
 * nothing else in the schema notices.
 *
 * Redacted entries are reported and are *not* failures. A chain carrying four
 * payloads rewritten by an approved DPDP erasure is intact; treating that as
 * tampering would mean honouring a customer's legal right looked identical to
 * an attack on the audit log.
 */
async function main(): Promise<void> {
  const env = getEnv();
  const database = createDatabase(env);
  const audit = new AuditService(database.db, null);

  const shopArgument = argValue('--shop');
  const shops = await database.db.execute<{ id: string; name: string }>(
    shopArgument === null
      ? sql`select id, name from shops order by created_at`
      : sql`select id, name from shops where id = ${shopArgument}`,
  );

  if (shops.rows.length === 0) {
    console.error(shopArgument === null ? 'No shops found.' : `No shop ${shopArgument}.`);
    await database.close();
    process.exit(1);
  }

  let failures = 0;
  let redacted = 0;

  for (const shop of shops.rows) {
    const result = await audit.verifyChain(shop.id);
    const redactedNote =
      (result.redactedEntries ?? 0) > 0 ? `, ${result.redactedEntries} redacted` : '';

    if (result.valid) {
      console.log(
        `  ok      ${shop.name} — ${result.entriesChecked} entries${redactedNote}`,
      );
      redacted += result.redactedEntries ?? 0;
    } else {
      failures += 1;
      console.error(
        [
          `  BROKEN  ${shop.name} (${shop.id})`,
          `          at entry index ${result.brokenAtIndex} (event ${result.brokenEventId})`,
          `          ${result.reason}`,
          `          ${result.entriesChecked} entries were checked before the break.`,
        ].join('\n'),
      );
    }
  }

  await database.close();

  console.log();
  if (failures === 0) {
    console.log(
      `Audit chain verified for ${shops.rows.length} shop(s)${redacted > 0 ? `, with ${redacted} lawfully redacted entr${redacted === 1 ? 'y' : 'ies'}` : ''}.`,
    );
    return;
  }

  // Exits non-zero so a restore drill or a nightly job fails loudly. The
  // instruction below matters as much as the exit code: repairing a chain
  // destroys the evidence of what broke it.
  console.error(
    [
      `${failures} shop(s) failed verification.`,
      '',
      'Do NOT repair or re-hash anything. Capture the break point first:',
      '  docs/runbooks/alerts.md#audit-chain',
    ].join('\n'),
  );
  process.exit(1);
}

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

main().catch((error: unknown) => {
  console.error('[audit:verify] failed');
  console.error(error);
  process.exit(1);
});
