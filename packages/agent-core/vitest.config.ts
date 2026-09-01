import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: false,
    // The voice suite runs whole telephone calls: two concurrent parties, real
    // audio frames and a modelled line that plays them over time. Fast for what
    // it is, and nowhere near the 5-second default.
    testTimeout: 30_000,
  },
});
