import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import type { Database } from './client';

/**
 * Migrations.
 *
 * Forward migrations are applied by drizzle's own migrator, which records each
 * applied file in `drizzle.__drizzle_migrations`.
 *
 * Every migration also ships a hand-written reverse script in
 * `migrations/down/<name>.down.sql` (master §8: every migration reversible).
 * `rollbackLastMigration` applies the newest one and removes its ledger row, so
 * a failed deploy can be undone without restoring a backup.
 */

export const MIGRATIONS_FOLDER = join(__dirname, '..', 'migrations');

interface JournalEntry {
  readonly idx: number;
  readonly when: number;
  readonly tag: string;
}

interface Journal {
  readonly entries: readonly JournalEntry[];
}

export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

export async function readJournal(): Promise<Journal> {
  const raw = await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8');
  return JSON.parse(raw) as Journal;
}

export interface RollbackResult {
  readonly rolledBack: string | null;
  readonly remaining: number;
}

export async function rollbackLastMigration(db: Database): Promise<RollbackResult> {
  const applied = await db.execute<{ id: number; created_at: string }>(sql`
    select id, created_at
    from drizzle.__drizzle_migrations
    order by created_at desc, id desc
    limit 1
  `);

  const last = applied.rows[0];
  if (last === undefined) return { rolledBack: null, remaining: 0 };

  const journal = await readJournal();
  const entry = journal.entries.find((candidate) => candidate.when === Number(last.created_at));
  if (entry === undefined) {
    throw new Error(
      `Cannot roll back: no journal entry matches applied migration timestamp ${last.created_at}`,
    );
  }

  const downPath = join(MIGRATIONS_FOLDER, 'down', `${entry.tag}.down.sql`);
  const script = await readFile(downPath, 'utf8');

  await db.transaction(async (tx) => {
    for (const statement of splitStatements(script)) {
      await tx.execute(sql.raw(statement));
    }
    await tx.execute(sql`delete from drizzle.__drizzle_migrations where id = ${last.id}`);
  });

  const remaining = await db.execute<{ count: number }>(
    sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
  );

  return { rolledBack: entry.tag, remaining: Number(remaining.rows[0]?.count ?? 0) };
}

function splitStatements(script: string): string[] {
  return script
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}
