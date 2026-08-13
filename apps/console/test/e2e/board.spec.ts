import { expect, test } from '@playwright/test';

/** Board and card drawer, as an advisor. */

test('renders the seeded cards', async ({ page }) => {
  await page.goto('/board');

  await expect(page.getByRole('heading', { name: 'Job card board' })).toBeVisible();
  expect(await page.getByTestId('job-card').count()).toBeGreaterThanOrEqual(10);
});

test('groups cards into state columns', async ({ page }) => {
  await page.goto('/board');

  for (const state of ['AWAITING_APPROVAL', 'IN_PROGRESS', 'READY_FOR_DELIVERY', 'DELIVERED']) {
    await expect(page.getByTestId(`column-${state}`)).toBeVisible();
  }
});

test('does not allow dragging a card between columns', async ({ page }) => {
  // States change only through domain events; the board reflects state and
  // never sets it (phase 1.9).
  await page.goto('/board');
  await expect(page.getByTestId('job-card').first()).toHaveAttribute('draggable', 'false');
});

test('opens a card and shows its audit trail and available transitions', async ({ page }) => {
  await page.goto('/board');
  // A card that has actually moved: a DRAFT card has, correctly, no audit rows.
  await page.getByTestId('column-READY_FOR_DELIVERY').getByTestId('job-card').first().click();
  await page.waitForURL(/\/board\/[0-9a-f-]+$/);

  await expect(page.getByTestId('card-state')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Audit trail' })).toBeVisible();
  expect(await page.getByTestId('audit-trail').locator('li').count()).toBeGreaterThan(0);
  await expect(page.getByTestId('transitions')).toBeVisible();
});

test('shows guardrails read-only to an advisor', async ({ page }) => {
  await page.goto('/settings/guardrails');

  await expect(page.getByRole('heading', { name: 'Guardrails' })).toBeVisible();
  await expect(page.getByText('Only an owner can change guardrails.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save guardrails' })).toHaveCount(0);
});

test('shows the conversations shell', async ({ page }) => {
  await page.goto('/conversations');
  await expect(page.getByRole('heading', { name: 'Conversations', exact: true })).toBeVisible();
  await expect(page.getByText('No conversations yet')).toBeVisible();
});
