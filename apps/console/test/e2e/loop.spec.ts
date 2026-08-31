import { expect, test } from '@playwright/test';

/**
 * The phase-4 console surfaces: the ETA history, the confirm queue, the
 * delivery panel and the gate.
 *
 * The gate test is the one that carries real weight. It types a code the shop
 * never issued and asserts the screen says STOP — through the real endpoint,
 * which verifies a signature before it touches a row, so a pass at a barrier is
 * being refused for the reason it would be refused in a workshop.
 */

test.describe('card drawer — the end of the loop', () => {
  test('shows the promise, the ETA history and the delivery panel', async ({ page }) => {
    await page.goto('/board');
    await page.getByTestId('column-READY_FOR_DELIVERY').getByTestId('job-card').first().click();
    await page.waitForURL(/\/board\/[0-9a-f-]+$/);

    // The question an advisor is answering on the phone is "you said four
    // o'clock", so the promise and the current answer are both on the card.
    await expect(page.getByRole('heading', { name: 'Promise & ETA' })).toBeVisible();
    await expect(page.getByTestId('eta-promised')).toBeVisible();
    await expect(page.getByTestId('eta-current')).toBeVisible();

    // A seeded card has no ETA history yet, which is a legitimate state and
    // must render as a sentence rather than an empty box.
    const entries = page.getByTestId('eta-entry');
    const nothingYet = page.getByText('Nothing has changed the estimate yet.');
    await expect(entries.first().or(nothingYet)).toBeVisible();

    await expect(page.getByTestId('delivery-panel')).toBeVisible();
    await expect(page.getByTestId('delivery-ready')).toBeVisible();
    await expect(page.getByTestId('delivery-invoice')).toBeVisible();
    await expect(page.getByTestId('delivery-gate-pass')).toBeVisible();
  });
});

test.describe('status signals', () => {
  test('explains itself when nothing is waiting', async ({ page }) => {
    await page.goto('/status');

    await expect(page.getByRole('heading', { name: 'Status signals' })).toBeVisible();

    // Either state is correct. What must not happen is the page failing to
    // render, and a quiet queue is the *expected* state for a shop whose audio
    // is good — the signals it was sure about applied themselves.
    const queue = page.getByTestId('status-queue');
    const empty = page.getByText('Nothing waiting');
    await expect(queue.or(empty).first()).toBeVisible();
  });
});

test.describe('the gate', () => {
  test('refuses a code the shop never issued, and says which red it is', async ({ page }) => {
    await page.goto('/gate');

    await expect(page.getByRole('heading', { name: 'Gate' })).toBeVisible();

    await page.getByTestId('gate-code').fill('ZZZZZZ');
    await page.getByTestId('gate-verify').click();

    const verdict = page.getByTestId('gate-verdict');
    await expect(verdict).toBeVisible();
    await expect(verdict).toHaveAttribute('data-allow', 'false');

    // One word for the barrier, one sentence for why. A gate person told only
    // "invalid" has learnt nothing.
    await expect(page.getByTestId('gate-headline')).toHaveText('STOP');
    await expect(verdict).toContainText(/no pass matches|not issued|expired|already/i);
  });

  test('asks for a code rather than verifying nothing', async ({ page }) => {
    await page.goto('/gate');
    await expect(page.getByTestId('gate-verify')).toBeDisabled();
  });
});
