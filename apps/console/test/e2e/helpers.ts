import { expect, type Page } from '@playwright/test';

/** Seeded demo staff. Each role uses its own number so the per-number OTP
 * resend cooldown never makes one test flake another. */
export const DEMO_PHONES = {
  owner: '9840012001',
  advisor: '9840012002',
  technician: '9840012003',
} as const;

export const STORAGE_STATE = {
  owner: 'test/e2e/.auth/owner.json',
  advisor: 'test/e2e/.auth/advisor.json',
} as const;

/**
 * Full phone-OTP sign-in through the UI. In DEMO_MODE the API returns the code
 * and the console renders it, which is the only reason this can be automated
 * without an SMS provider.
 */
export async function signIn(page: Page, phone: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Mobile number').fill(phone);
  await page.getByRole('button', { name: 'Send code' }).click();

  const demoCode = page.getByTestId('demo-code');

  // The OTP resend cooldown is a real anti-abuse guardrail, and back-to-back
  // suite runs hit it. Wait it out rather than weakening it for tests.
  const cooldown = page.getByRole('alert').filter({ hasText: 'Wait before requesting another' });
  if (await cooldown.isVisible().catch(() => false)) {
    await page.waitForTimeout(31_000);
    await page.getByRole('button', { name: 'Send code' }).click();
  }

  await expect(demoCode).toBeVisible();

  const text = (await demoCode.textContent()) ?? '';
  const code = /(\d{6})/.exec(text)?.[1];
  expect(code, 'DEMO_MODE must surface the OTP in the console').toBeTruthy();

  await page.getByLabel('6-digit code').fill(code as string);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/board');
}
