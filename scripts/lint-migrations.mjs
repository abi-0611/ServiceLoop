#!/usr/bin/env node
/**
 * Migration policy linter (phase 7.5).
 *
 *   node scripts/lint-migrations.mjs
 *
 * Enforces expand-migrate-contract, which is the property that makes a Cloud
 * Run rollback safe. Cloud Run does not replace a revision atomically: for a
 * minute or two both the old and the new one are serving, against one database.
 * A migration that drops a column the old revision still selects turns that
 * minute into an outage, and — worse — a *rollback* after a destructive
 * migration has nothing to roll back to.
 *
 * So the rule is: a release may add, and may stop using. It may not remove in
 * the same release that stopped using. Removal is a separate migration, in a
 * later release, once no running code refers to the thing.
 *
 * A destructive statement is allowed when the migration file carries an
 * explicit waiver naming the release that stopped using it:
 *
 *   -- CONTRACT: dropped column `foo`, unused since 0006 (two releases ago)
 *
 * The waiver is a comment a human writes and a reviewer reads. That is the
 * whole mechanism, and it is enough — the linter's job is to make the removal
 * impossible to do *silently*, not to verify the claim.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(ROOT, 'packages', 'db', 'migrations');
const DOWN = join(MIGRATIONS, 'down');

/**
 * Statements that break a running previous revision.
 *
 * `DROP TABLE` and `DROP COLUMN` are obvious. The two that catch people out:
 *
 * - `ALTER COLUMN ... SET NOT NULL` on an existing column fails outright if any
 *   row is null, and succeeds catastrophically if none are — the old revision
 *   keeps inserting nulls and every insert starts failing.
 * - `ALTER TYPE ... ADD VALUE` is not destructive but *is* irreversible:
 *   Postgres cannot remove an enum value, so it makes the migration one-way and
 *   breaks "every migration reversible". This codebase widens enums by
 *   recreation instead, and phase 4 established that pattern.
 */
const DESTRUCTIVE = [
  { pattern: /\bDROP\s+TABLE\b/i, what: 'DROP TABLE' },
  { pattern: /\bDROP\s+COLUMN\b/i, what: 'DROP COLUMN' },
  { pattern: /\bALTER\s+COLUMN\s+"?\w+"?\s+SET\s+NOT\s+NULL\b/i, what: 'SET NOT NULL' },
  // Both spellings. Postgres accepts `TYPE` and `SET DATA TYPE`, drizzle-kit
  // emits the second, and a linter that only knew the first would have passed
  // every enum widening this repository has ever done.
  { pattern: /\bALTER\s+COLUMN\s+"?\w+"?\s+(?:SET\s+DATA\s+)?TYPE\b/i, what: 'ALTER COLUMN TYPE' },
  { pattern: /\bDROP\s+CONSTRAINT\b/i, what: 'DROP CONSTRAINT' },
  { pattern: /\bALTER\s+TYPE\s+[^\n]*ADD\s+VALUE\b/i, what: 'ALTER TYPE ... ADD VALUE' },
  { pattern: /\bRENAME\s+COLUMN\b/i, what: 'RENAME COLUMN' },
  { pattern: /\bTRUNCATE\b/i, what: 'TRUNCATE' },
];

const WAIVER = /--\s*CONTRACT:\s*(.+)/i;

/**
 * The enum-widening-by-recreation pattern, recognised structurally.
 *
 * Widening an enum is *additive* — every value that existed still exists — but
 * Postgres has no `ALTER TYPE ... ADD VALUE` that can be reversed, so this
 * codebase widens by recreation instead: rename the old type, create the wide
 * one, re-type the column with a text round-trip, drop the old. Phase 4
 * established it and phases 6 and 7 follow it.
 *
 * That produces an `ALTER COLUMN ... TYPE`, which is otherwise exactly the
 * shape of a genuinely breaking change. Recognised by structure rather than by
 * a comment for one reason: a comment-based exemption would have to be added
 * retroactively to migrations that are already applied, and editing an applied
 * migration changes the hash drizzle recorded for it — which makes the migrator
 * try to run it again.
 *
 * The check is narrow: the file must rename a type away, create one back under
 * the same name, and cast through text. A real column-type change does none of
 * those.
 */
function isEnumRecreation(statements, columnTypeMatch) {
  const renamed = /ALTER\s+TYPE\s+"?(?:public\.)?"?[\w."]+"?\s+RENAME\s+TO/i.test(statements);
  const recreated = /CREATE\s+TYPE\s+/i.test(statements);
  const castThroughText = /USING\s+"?\w+"?::text::/i.test(statements);
  return renamed && recreated && castThroughText && columnTypeMatch;
}

const problems = [];
const notes = [];

const forward = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith('.sql'))
  .sort();

if (forward.length === 0) {
  console.error('No migrations found. Did the path change?');
  process.exit(1);
}

for (const file of forward) {
  const source = readFileSync(join(MIGRATIONS, file), 'utf8');
  const waived = [...source.matchAll(new RegExp(WAIVER, 'gi'))].map((match) => match[1].trim());

  // Strip comments before scanning, so a statement *described* in the header
  // prose is not reported as a statement performed. Every migration in this
  // repository opens with several paragraphs explaining itself, and without
  // this the linter fires on its own documentation.
  const statements = source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

  for (const rule of DESTRUCTIVE) {
    if (!rule.pattern.test(statements)) continue;

    if (rule.what === 'ALTER COLUMN TYPE' && isEnumRecreation(statements, true)) {
      notes.push(`${file}: ALTER COLUMN TYPE is the enum-widening-by-recreation pattern`);
      continue;
    }

    if (waived.length > 0) {
      notes.push(`${file}: ${rule.what} waived — ${waived[0]}`);
      continue;
    }
    problems.push(
      [
        `${file}: contains ${rule.what} with no CONTRACT waiver.`,
        '    Expand-migrate-contract: a release may add, and may stop using. Removal',
        '    belongs in a later migration, once no running revision refers to it.',
        '    If this genuinely is the contract step, say so in the file:',
        `        -- CONTRACT: ${rule.what.toLowerCase()}, unused since <migration> (<n> releases ago)`,
      ].join('\n'),
    );
  }

  // Every forward migration needs a reverse script. Master section 8: every
  // migration reversible.
  const base = file.replace(/\.sql$/, '');
  try {
    readFileSync(join(DOWN, `${base}.down.sql`), 'utf8');
  } catch {
    problems.push(`${file}: has no reverse script at migrations/down/${base}.down.sql`);
  }
}

// The journal has to name every file, or drizzle skips it silently on a fresh
// database — which shows up as a missing table in production and nowhere else.
const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8'));
const tagged = new Set(journal.entries.map((entry) => entry.tag));
for (const file of forward) {
  const tag = file.replace(/\.sql$/, '');
  if (!tagged.has(tag)) problems.push(`${file}: not listed in meta/_journal.json`);
}
for (const entry of journal.entries) {
  if (!forward.includes(`${entry.tag}.sql`)) {
    problems.push(`meta/_journal.json names ${entry.tag}, which has no .sql file`);
  }
}

// Journal timestamps must increase: drizzle applies in `when` order, not
// filename order, so a mis-ordered entry runs a later migration first.
let previous = 0;
for (const entry of journal.entries) {
  if (entry.when <= previous) {
    problems.push(
      `meta/_journal.json: ${entry.tag} has timestamp ${entry.when}, not after the previous ${previous}`,
    );
  }
  previous = entry.when;
}

for (const note of notes) console.log(`  waived  ${note}`);

if (problems.length > 0) {
  console.error(`\nMigration policy violations (${problems.length}):\n`);
  for (const problem of problems) console.error(`  ${problem}\n`);
  process.exit(1);
}

console.log(`Migration policy clean: ${forward.length} migration(s), all reversible and journalled.`);
