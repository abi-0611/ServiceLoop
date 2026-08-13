import { expect, test } from '@playwright/test';

/** Guardrail editing, as the owner. */

test('lets an owner edit a guardrail, and the change persists', async ({ page }) => {
  await page.goto('/settings/guardrails');

  const start = page.getByLabel('Start');
  await expect(start).toBeEnabled();

  const original = await start.inputValue();
  const next = original === '21:00' ? '21:45' : '21:00';

  await start.fill(next);
  await page.getByRole('button', { name: 'Save guardrails' }).click();
  await expect(page.getByTestId('guardrail-message')).toContainText('Saved and audited');

  await page.reload();
  await expect(page.getByLabel('Start')).toHaveValue(next);

  // Restore so repeated runs are idempotent.
  await page.getByLabel('Start').fill(original);
  await page.getByRole('button', { name: 'Save guardrails' }).click();
  await expect(page.getByTestId('guardrail-message')).toContainText('Saved and audited');
});

test('rejects an out-of-range guardrail with a field-level error', async ({ page }) => {
  await page.goto('/settings/guardrails');

  await page.getByLabel('Price floor (% of list)').fill('250');
  await page.getByRole('button', { name: 'Save guardrails' }).click();

  await expect(page.getByTestId('guardrail-errors')).toContainText('pricing.priceFloorPercent');

  // The rejected patch must not have been applied.
  await page.reload();
  await expect(page.getByLabel('Price floor (% of list)')).toHaveValue('100');
});

test('shows the non-negotiable guardrails as fixed', async ({ page }) => {
  await page.goto('/settings/guardrails');

  await expect(page.getByText('AI disclosure on first contact')).toBeVisible();
  await expect(page.getByText('Evidence-anchored claims')).toBeVisible();
});
