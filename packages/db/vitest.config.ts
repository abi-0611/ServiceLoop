import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Integration tests share one database; running files in parallel would
    // have them fighting over the same schema.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
    passWithNoTests: true,
  },
});
