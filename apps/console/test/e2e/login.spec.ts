import { expect, test } from '@playwright/test';
import { DEMO_PHONES, signIn } from './helpers';

/** The unauthenticated surface: sign-in and the auth boundary. */

test('signs in with a phone OTP and lands on the board', async ({ page }) => {
  await signIn(page, DEMO_PHONES.technician);

  await expect(page.getByRole('heading', { name: 'Job card board' })).toBeVisible();
  await expect(page.getByTestId('job-card').first()).toBeVisible();
});

test('redirects an unauthenticated visitor to login', async ({ page }) => {
  await page.goto('/board');
  await page.waitForURL('**/login');
  await expect(page.getByRole('button', { name: 'Send code' })).toBeVisible();
});

test('refuses a number that belongs to no shop, without saying so', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Mobile number').fill('9812345678');
  await page.getByRole('button', { name: 'Send code' }).click();

  // The prompt advances identically for an unknown number — no enumeration —
  // but no code is shown, because none was sent.
  await expect(page.getByLabel('6-digit code')).toBeVisible();
  await expect(page.getByTestId('demo-code')).toHaveCount(0);

  await page.getByLabel('6-digit code').fill('000000');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
});
