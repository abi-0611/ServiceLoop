import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/ports.ts'],
      reporter: ['text-summary', 'json-summary'],
      // Acceptance gate: domain coverage >= 80%.
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 75 },
    },
  },
});
