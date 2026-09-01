import { CASCADE_PLAN, activeSteps, stepFor } from '@serviceloop/domain';
import { getTableName, isTable } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from '../schema';

/**
 * The cascade plan is total over the schema (phase 7.2).
 *
 * This is the test the whole declared-plan design exists for. A deletion
 * cascade written as a list of DELETE statements is correct on the day it is
 * written and quietly wrong from the first migration afterwards — somebody adds
 * `odometer_readings`, nobody remembers the cascade, and a customer who asked to
 * be forgotten stays in that table until an audit finds them.
 *
 * So the plan is data, the schema is data, and this compares them. A new table
 * fails the build until somebody has written down what an erasure does to it —
 * including "nothing, and here is why", which is a legitimate answer and is
 * recorded as one rather than left to inference.
 */

const schemaTables = Object.values(schema)
  .filter((value) => isTable(value))
  // `isTable` narrows to drizzle's generic `Table`, which is not assignable to
  // the exact per-table types the schema module exports; the cast keeps the
  // runtime check and drops the structural one, which is all this needs.
  .map((table) => getTableName(table as Parameters<typeof getTableName>[0]))
  .sort();

const plannedTables = CASCADE_PLAN.map((step) => step.table).sort();

describe('CASCADE_PLAN covers the schema', () => {
  it('finds the schema to compare against', () => {
    // A reflection failure returning nothing would make every assertion below
    // vacuously true — the same trap `no-bypass.test.ts` guards.
    expect(schemaTables.length).toBeGreaterThan(45);
  });

  it('has an entry for every table in the schema', () => {
    const missing = schemaTables.filter((table) => !plannedTables.includes(table));
    expect(
      missing,
      [
        'These tables exist in the schema and are not in CASCADE_PLAN.',
        'Every table must say what an approved erasure does to it — including',
        '"nothing", which is written as reach: { kind: \'none\' } with a rationale.',
      ].join('\n'),
    ).toEqual([]);
  });

  it('has no entry for a table that no longer exists', () => {
    const stale = plannedTables.filter((table) => !schemaTables.includes(table));
    expect(stale, 'CASCADE_PLAN names tables that are not in the schema:').toEqual([]);
  });

  it('names each table exactly once', () => {
    const duplicates = plannedTables.filter(
      (table, index) => plannedTables.indexOf(table) !== index,
    );
    // Two entries for one table means one of them is dead: the executor
    // switches on the name and would run whichever came first, twice.
    expect(duplicates).toEqual([]);
  });
});

describe('every step is justified', () => {
  it.each(CASCADE_PLAN.map((step) => [step.table, step] as const))(
    '%s explains itself',
    (_table, step) => {
      // A rationale short enough to be a label is a rationale nobody wrote.
      expect(step.rationale.length).toBeGreaterThan(30);
      expect(step.rationale.trim().endsWith('.')).toBe(true);
    },
  );

  it('gives every retained table a named legal basis and a clock', () => {
    for (const step of CASCADE_PLAN.filter((entry) => entry.action === 'RETAINED')) {
      expect(step.retention, `${step.table} is RETAINED with no basis`).toBeDefined();
      expect(step.retention?.basis.length ?? 0).toBeGreaterThan(10);
    }
  });

  it('retains nothing except the tax record', () => {
    // The carve-out must stay small. A plan that grows a fourth RETAINED table
    // is a plan drifting towards "we keep everything, legally".
    const retained = CASCADE_PLAN.filter((step) => step.action === 'RETAINED').map(
      (step) => step.table,
    );
    expect(retained.sort()).toEqual(['invoice_lines', 'invoices', 'payments']);
  });

  it('destroys the customer’s own record and their conversations', () => {
    // The three that would make the whole exercise a lie if they were wrong.
    expect(stepFor('messages')?.action).toBe('PURGED');
    expect(stepFor('conversations')?.action).toBe('PURGED');
    expect(stepFor('media_assets')?.action).toBe('PURGED');
  });

  it('keeps the audit chain rather than breaking it', () => {
    expect(stepFor('audit_events')?.action).toBe('PSEUDONYMISED');
  });

  it('leaves the metric rollups completely alone', () => {
    // The acceptance gate says metric totals are unchanged by a deletion. That
    // is only possible if nothing in the plan touches them.
    expect(stepFor('metric_rollups')?.reach.kind).toBe('none');
  });

  it('runs the customer row last', () => {
    const steps = activeSteps();
    expect(steps[steps.length - 1]?.table).toBe('customers');
  });

  it('destroys child rows before the parents they point at', () => {
    const order = activeSteps().map((step) => step.table);
    const before = (a: string, b: string): boolean => order.indexOf(a) < order.indexOf(b);

    expect(before('messages', 'conversations')).toBe(true);
    expect(before('message_reviews', 'messages')).toBe(true);
    expect(before('call_turns', 'calls')).toBe(true);
    expect(before('estimate_lines', 'estimates')).toBe(true);
    expect(before('agent_steps', 'agent_runs')).toBe(true);
    expect(before('vehicles', 'customers')).toBe(true);
  });
});
