import { defineConfig, devices } from '@playwright/test';
import { STORAGE_STATE } from './test/e2e/helpers';

/**
 * Console end-to-end tests.
 *
 * Both servers are started here, so a cold `pnpm test:e2e` works after
 * `pnpm infra:up && pnpm db:migrate && pnpm db:seed`. A setup project signs in
 * once per role and saves the session; the role projects reuse it rather than
 * hammering the OTP endpoint, whose resend cooldown is a real guardrail.
 *
 * Mobile Chrome is a first-class project: advisors use this on a phone.
 */
export default defineConfig({
  testDir: './test/e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] === undefined ? 0 : 1,
  reporter: process.env['CI'] === undefined ? [['list']] : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/, use: { ...devices['Desktop Chrome'] } },
    {
      name: 'anonymous',
      testMatch: /login\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'advisor',
      testMatch: /board\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: STORAGE_STATE.advisor },
    },
    {
      name: 'owner',
      testMatch: /guardrails\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: STORAGE_STATE.owner },
    },
    {
      name: 'advisor-mobile',
      testMatch: /board\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Pixel 7'], storageState: STORAGE_STATE.advisor },
    },
  ],

  webServer: [
    {
      command: 'pnpm --filter @serviceloop/api run dev',
      url: 'http://localhost:3001/health',
      reuseExistingServer: true,
      timeout: 120_000,
      cwd: '../..',
    },
    {
      command: 'pnpm --filter @serviceloop/console run dev',
      url: 'http://localhost:3000/login',
      reuseExistingServer: true,
      timeout: 120_000,
      cwd: '../..',
    },
  ],
});
