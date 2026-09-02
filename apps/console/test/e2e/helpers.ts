import { expect, type Locator, type Page } from '@playwright/test';

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
 * Fills a field and makes sure the value survived.
 *
 * Every input on the console is a React *controlled* input, so a `fill` that
 * lands before hydration writes the DOM node and is then wiped the moment React
 * mounts and re-renders from its own still-empty state. What is left is a blank
 * field, a `required` form that silently declines to submit, and a failure with
 * nothing on screen to explain it — no error, no request, just the placeholder
 * where the typed value should be.
 *
 * It bites hardest on the first page load under CI, where Next compiles the
 * route on demand and hydration arrives seconds after the markup does.
 *
 * Re-filling until the value sticks is the fix. A fixed `waitForTimeout` is the
 * flake: it is either too short on a loaded runner or dead time on every run.
 */
export async function fillField(field: Locator, value: string): Promise<void> {
  await expect(async () => {
    await field.fill(value);
    await expect(field).toHaveValue(value, { timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
}

/**
 * Enters a number on the login form and advances to the code stage.
 *
 * The fill and the click are retried *together*, because the race they guard
 * against takes both out at once. Until the login page hydrates, React's
 * `onSubmit` is not attached, so clicking "Send code" submits the form the way a
 * browser does without JavaScript: a native GET to `/login?phone=…`. No request
 * ever reaches the API, the resulting reload empties the field, and the suite
 * then waits fifteen seconds for a code nobody asked for — which is exactly the
 * failure this replaced, and it showed no error on screen because nothing had
 * gone wrong on the server.
 *
 * It is worst on the first page load under CI, where Next compiles the route on
 * demand and hydration lands seconds behind the markup.
 *
 * Retrying is safe against the resend cooldown: the attempt that loses the race
 * sends nothing at all.
 */
export async function submitPhone(page: Page, phone: string): Promise<void> {
  await expect(async () => {
    await fillField(page.getByLabel('Mobile number'), phone);
    await page.getByRole('button', { name: 'Send code' }).click();

    // The OTP resend cooldown is a real anti-abuse guardrail, and back-to-back
    // suite runs hit it. Wait it out rather than weakening it for tests.
    const cooldown = page.getByRole('alert').filter({ hasText: 'Wait before requesting another' });
    if (await cooldown.isVisible().catch(() => false)) {
      await page.waitForTimeout(31_000);
      await page.getByRole('button', { name: 'Send code' }).click();
    }

    await expect(page.getByLabel('6-digit code')).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 45_000, intervals: [500, 1_000, 2_000] });
}

/**
 * Full phone-OTP sign-in through the UI. In DEMO_MODE the API returns the code
 * and the console renders it, which is the only reason this can be automated
 * without an SMS provider.
 */
export async function signIn(page: Page, phone: string): Promise<void> {
  await page.goto('/login');
  await submitPhone(page, phone);

  const demoCode = page.getByTestId('demo-code');
  await expect(demoCode).toBeVisible();

  const text = (await demoCode.textContent()) ?? '';
  const code = /(\d{6})/.exec(text)?.[1];
  expect(code, 'DEMO_MODE must surface the OTP in the console').toBeTruthy();

  await fillField(page.getByLabel('6-digit code'), code as string);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/board');
}
