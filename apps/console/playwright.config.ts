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
      name: 'channels',
      testMatch: /sandbox\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: STORAGE_STATE.advisor },
    },
    {
      // Phase 5's softphone.
      name: 'voice',
      testMatch: /softphone\.spec\.ts/,
      dependencies: ['setup'],
      // As OWNER: switching voice on is an owner's decision, and the same
      // session then places the call — which is exactly the sequence a shop
      // goes through the first time.
      use: { ...devices['Desktop Chrome'], storageState: STORAGE_STATE.owner },
    },
    {
      name: 'advisor-mobile',
      testMatch: /board\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Pixel 7'], storageState: STORAGE_STATE.advisor },
    },
    {
      // The review queue runs as OWNER: the graduation report is owner-only, and
      // the advisor's view of it is asserted inside the spec with its own
      // context rather than by a second project.
      name: 'review',
      testMatch: /review\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: STORAGE_STATE.owner },
    },
    {
      // An advisor clearing the queue between jobs is doing it on a phone.
      name: 'review-mobile',
      testMatch: /review\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Pixel 7'], storageState: STORAGE_STATE.owner },
    },
    {
      // Phase 4's surfaces. As an advisor, because that is who reads the ETA
      // history and clears the confirm queue; the gate screen is deliberately
      // reachable by every role.
      name: 'loop',
      testMatch: /loop\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: STORAGE_STATE.advisor },
    },
    {
      // The gate person is holding a phone at a barrier. If this screen only
      // worked on a desk it would not work at all.
      name: 'loop-mobile',
      testMatch: /loop\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Pixel 7'], storageState: STORAGE_STATE.advisor },
    },
    {
      // Phase 6's analytics. As OWNER, because the backfill is owner-only and
      // the shop overview is an owner's screen — and because the point of the
      // "check these numbers" button is that the person being asked to believe
      // the figures can make the system derive them again.
      name: 'analytics',
      testMatch: /analytics\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: STORAGE_STATE.owner },
    },
    {
      // An owner reads their numbers on the same phone the digest arrives on.
      name: 'analytics-mobile',
      testMatch: /analytics\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Pixel 7'], storageState: STORAGE_STATE.owner },
    },
    {
      // The inbox is read on a phone at a counter more often than on a desk.
      name: 'channels-mobile',
      testMatch: /sandbox\.spec\.ts/,
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
