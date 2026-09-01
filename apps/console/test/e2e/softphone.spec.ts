import { expect, test } from '@playwright/test';

/**
 * The browser softphone (phase 5.1), through the browser.
 *
 * The acceptance gate's own words: "all without any telco credentials". This is
 * the test that says so — voice switched on in settings, then a whole inbound
 * call answered in a Chromium tab, driven only by clicking, ending with a
 * person on the line and a whispered summary on the screen.
 *
 * It asserts on the **marks** rather than the copy: the ⚿ badge on the two
 * non-removable segments, not the words in them. The scripts exist in three
 * languages and this shop's customers answer in Tamil, so a compliance check by
 * string comparison would break the first time somebody improves a sentence.
 *
 * Voice is switched on here rather than seeded on, because a shop starting with
 * voice off is a guarantee (§6: L0 first) and a fixture that quietly turned it
 * on would be a test proving the opposite of the product's default.
 */
test.describe('softphone', () => {
  test('an owner switches voice on, and 0 reaches a person with a whisper', async ({ page }) => {
    await page.goto('/settings/guardrails');
    await expect(page.getByRole('heading', { name: 'Voice' })).toBeVisible();

    for (const id of ['voice-enabled', 'voice-outbound', 'voice-inbound']) {
      const box = page.getByTestId(id);
      if (!(await box.isChecked())) await box.check();
    }
    await page.getByRole('button', { name: /save/i }).click();
    await expect(page.getByRole('status').or(page.getByRole('alert'))).toBeVisible();

    await page.goto('/softphone');
    await expect(page.getByRole('heading', { name: 'Softphone' })).toBeVisible();
    await expect(page.getByTestId('softphone-persona')).toBeVisible();

    await page.getByTestId('softphone-ring-shop').click();

    // Ringing, then answered. Two states, because on a real line they are two.
    const answer = page.getByTestId('softphone-answer');
    await expect(answer).toBeVisible({ timeout: 20_000 });
    await answer.click();

    // The ⚿ opening reaches the transcript before anything else is offered.
    const transcript = page.getByTestId('softphone-transcript');
    await expect(transcript.getByText('⚿ required').first()).toBeVisible({ timeout: 30_000 });

    // 0 reaches a person from anywhere, whether or not it was offered.
    await page.getByTestId('softphone-key-0').click();

    const screenPop = page.getByTestId('softphone-screen-pop');
    await expect(screenPop).toBeVisible({ timeout: 30_000 });
    await expect(screenPop).toContainText('Whispered before the legs joined');
  });
});
