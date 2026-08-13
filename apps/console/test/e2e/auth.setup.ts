import { test as setup } from '@playwright/test';
import { DEMO_PHONES, signIn, STORAGE_STATE } from './helpers';

/**
 * Signs in once per role and saves the session. Later projects reuse it, so the
 * OTP resend cooldown — a real anti-abuse guardrail — is never fought against.
 */

setup('authenticate as advisor', async ({ page }) => {
  await signIn(page, DEMO_PHONES.advisor);
  await page.context().storageState({ path: STORAGE_STATE.advisor });
});

setup('authenticate as owner', async ({ page }) => {
  await signIn(page, DEMO_PHONES.owner);
  await page.context().storageState({ path: STORAGE_STATE.owner });
});
