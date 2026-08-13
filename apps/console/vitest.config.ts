import { defineConfig } from 'vitest/config';

/**
 * Vitest covers component/unit tests under `src`. The console's behavioural
 * suite is Playwright (`test/e2e`), run with `pnpm test:e2e`, and is excluded
 * here so the two runners never try to execute each other's files.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['test/e2e/**', 'node_modules/**', '.next/**'],
    passWithNoTests: true,
  },
});
