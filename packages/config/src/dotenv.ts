import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Loads the repo-root `.env` into `process.env` exactly once, using Node's
 * built-in loader (no dependency).
 *
 * Precedence is what you want: `process.loadEnvFile` never overwrites a
 * variable that is already set, so a real environment variable — CI secret,
 * container env, `FOO=bar pnpm dev` — always beats the file.
 *
 * The file is found by walking up from the current working directory to the
 * workspace root, so it works identically from `apps/api`, `apps/console` and
 * the repo root.
 */

let loaded = false;

const WORKSPACE_MARKERS = ['pnpm-workspace.yaml', 'turbo.json'];

export function findWorkspaceRoot(from: string = process.cwd()): string | null {
  let current = resolve(from);

  for (let depth = 0; depth < 10; depth += 1) {
    if (WORKSPACE_MARKERS.some((marker) => existsSync(join(current, marker)))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

export function loadDotEnvOnce(from: string = process.cwd()): string | null {
  if (loaded) return null;
  loaded = true;

  if (process.env['SERVICELOOP_SKIP_DOTENV'] === '1') return null;

  const root = findWorkspaceRoot(from);
  if (root === null) return null;

  const envPath = join(root, '.env');
  if (!existsSync(envPath)) return null;

  process.loadEnvFile(envPath);
  return envPath;
}
