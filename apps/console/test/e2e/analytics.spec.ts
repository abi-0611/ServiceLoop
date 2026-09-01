import { expect, test, type Page } from '@playwright/test';

/**
 * The Analytics pages (phase 6.9).
 *
 * The gate asks that the pages "render all KPIs from the plan" and that the
 * recompute reproduces the rollups. Both are checked here through the browser,
 * because the property that actually matters is one a unit test cannot see: the
 * page and the owner's WhatsApp digest are reading the *same stored rollup*, so
 * "check these numbers" re-derives them from the event log and finds nothing
 * changed — in front of the person who was asked to believe them.
 *
 * Runs as OWNER, because the backfill is owner-only and the shop overview is
 * an owner's screen.
 */

/** Folds today so the page has a rollup to read, through the console's proxy. */
async function foldToday(page: Page): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const response = await page.request.post('/api/analytics/recompute', {
    data: { from: today, to: today },
  });
  expect(response.ok(), `the fold must succeed: ${await response.text()}`).toBe(true);
  return today;
}

test.describe('analytics', () => {
  test('shows every KPI from the plan, and no data as "no data"', async ({ page }) => {
    await foldToday(page);
    await page.goto('/analytics');

    await expect(page.getByRole('heading', { name: 'Analytics' })).toBeVisible();

    // The two headline figures the business rests on.
    await expect(page.getByTestId('kpi-approved')).toBeVisible();
    await expect(page.getByTestId('kpi-recovered')).toBeVisible();

    // Every rate the plan names.
    for (const id of [
      'kpi-turnaround',
      'kpi-conversion',
      'kpi-deflection',
      'kpi-ontime',
      'kpi-recovery-rate',
      'kpi-repeat',
      'kpi-containment',
      'kpi-drafts',
      'kpi-voice',
      'kpi-reviews',
      'kpi-blocked',
      'kpi-revocations',
      'kpi-withheld',
      'kpi-alerts',
    ]) {
      await expect(page.getByTestId(id), `${id} should be on the overview`).toBeVisible();
    }

    // Every rate reads as a percentage or as "No data" — never as "NaN", never
    // as an empty tile. The rule that "no data" and "0%" are different facts is
    // asserted deterministically where it can be: over `rollupKpis` in the
    // domain suite, and over the CSV's empty cells in the API suite. What this
    // page can honestly check is that whichever of the two it got, it rendered.
    for (const id of ['kpi-conversion', 'kpi-deflection', 'kpi-recovery-rate']) {
      await expect(page.getByTestId(`${id}-value`)).toHaveText(/^(No data|\d+%)$/);
    }

    await expect(page.getByTestId('analytics-days')).toBeVisible();
  });

  test('re-derives its own numbers on request and finds them unchanged', async ({ page }) => {
    await foldToday(page);
    await page.goto('/analytics');

    await page.getByTestId('analytics-recompute').click();

    const result = page.getByTestId('analytics-recompute-result');
    await expect(result).toBeVisible();
    // The audit story, in one sentence on a screen: the numbers above were
    // re-folded from the event log and came back identical.
    await expect(result).toContainText('reproduced exactly');
  });

  test('exports the same rollups as a CSV a spreadsheet can open', async ({ page }) => {
    const today = await foldToday(page);
    const response = await page.request.get(
      `/api/analytics/export.csv?from=${today}&to=${today}`,
    );

    expect(response.ok()).toBe(true);
    expect(response.headers()['content-type']).toContain('text/csv');
    expect(response.headers()['content-disposition']).toContain('attachment');

    const rows = (await response.text()).trim().split('\n');
    expect(rows[0]).toContain('recoveredPaise');
    expect(rows[1]?.startsWith(today)).toBe(true);
  });

  test('drills down into the ledger, the touches and the digests', async ({ page }) => {
    await foldToday(page);
    await page.goto('/analytics');

    await page.getByRole('link', { name: /Declined-work ledger/ }).click();
    await expect(page.getByRole('heading', { name: 'Declined-work ledger' })).toBeVisible();
    await expect(page.getByTestId('ledger-open-value')).toBeVisible();
    await expect(page.getByTestId('ledger-recovered-value')).toBeVisible();

    await page.goto('/analytics/retention');
    await expect(page.getByRole('heading', { name: 'Retention & feedback' })).toBeVisible();

    await page.goto('/analytics/digests');
    await expect(page.getByRole('heading', { name: 'Owner digests' })).toBeVisible();
  });

  test('is reachable from the shop navigation', async ({ page }) => {
    await page.goto('/board');
    await page.getByRole('link', { name: 'Analytics', exact: true }).click();
    await expect(page).toHaveURL(/\/analytics$/);
  });
});
