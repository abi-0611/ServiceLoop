import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Phase 2 acceptance gate: "zero send paths bypass `OutboundGate`".
 *
 * That is an architectural claim, and a claim nobody checks is a claim that
 * quietly stops being true — the first time someone in a hurry calls the
 * WhatsApp port directly from a controller, every consent, quiet-hours and
 * frequency rule silently stops applying to that path.
 *
 * So this test enforces it mechanically: it walks the repository's TypeScript
 * and asserts that the channel-send methods are only ever invoked from the
 * adapter that defines them, the gate that guards them, and their tests.
 * Adding a legitimate new caller means adding it to `ALLOWED` here, in a diff a
 * reviewer will see.
 */

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');

const SEARCH_ROOTS = ['apps', 'packages'];

const SKIP_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  '.next',
  '.turbo',
  'coverage',
  'migrations',
  'test-results',
  'playwright-report',
]);

/** Methods that put bytes on a customer-visible channel. */
const SEND_METHODS = [
  'sendSessionMessage',
  'sendTemplate',
  'sendInteractive',
  'sendMedia',
] as const;

/**
 * The only places a channel send may legitimately appear.
 *
 * - the WhatsApp adapter: it *is* the transport, and its contract suite
 * - `ChannelSender` implementations: thin translation, reached only via the gate
 * - `outbound-gate.ts`: the choke point itself
 */
const ALLOWED: readonly string[] = [
  // The transport itself, its contract suite, and `WhatsAppChannelSender` —
  // the `ChannelSender` the gate holds as a private dependency. It lives beside
  // the adapter rather than in the API so the workers and the demo runner share
  // one implementation instead of each growing a copy.
  'packages/adapters/src/whatsapp',
  'packages/domain/src/messaging/outbound-gate.ts',
  'packages/domain/src/messaging/no-bypass.test.ts',
];

function walk(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    if (SKIP_DIRECTORIES.has(entry)) continue;
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      walk(full, found);
    } else if (/\.tsx?$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

function posixRelative(file: string): string {
  return relative(REPO_ROOT, file).split(sep).join('/');
}

function isAllowed(relativePath: string): boolean {
  return ALLOWED.some((allowed) => relativePath === allowed || relativePath.startsWith(`${allowed}/`));
}

describe('OutboundGate is the only send path', () => {
  const files = SEARCH_ROOTS.flatMap((root) => {
    const full = join(REPO_ROOT, root);
    try {
      return walk(full);
    } catch {
      return [];
    }
  });

  it('finds the repository to scan', () => {
    // A silent zero-file walk would make every assertion below vacuously true.
    expect(files.length).toBeGreaterThan(50);
  });

  it('has no channel send outside the adapter, the gate and their tests', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const relativePath = posixRelative(file);
      if (isAllowed(relativePath)) continue;

      const source = readFileSync(file, 'utf8');
      for (const [index, line] of source.split('\n').entries()) {
        for (const method of SEND_METHODS) {
          // `.sendTemplate(` — a call, not a type reference or an import.
          if (new RegExp(`\\.${method}\\s*\\(`).test(line)) {
            offenders.push(`${relativePath}:${index + 1} calls .${method}()`);
          }
        }
      }
    }

    expect(
      offenders,
      `A customer-visible send must go through OutboundGate.send(). Offending call sites:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('exports no alternative sender from the messaging module', () => {
    const index = readFileSync(join(__dirname, 'index.ts'), 'utf8');

    // `ChannelSender` is exported as a *type* so adapters can implement it;
    // nothing exported here may be a concrete thing that sends.
    expect(index).toContain('OutboundGate');
    for (const method of SEND_METHODS) {
      expect(index).not.toContain(method);
    }
  });
});
