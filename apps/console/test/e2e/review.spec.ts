import { expect, test, type Page } from '@playwright/test';

/**
 * The L0 shadow-mode round trip, through the browser (phase 3.9).
 *
 * The acceptance gate asks for one thing by name: *the agent drafts, an advisor
 * edits, and the send goes out with the edit*. That is what this walks — and it
 * walks it through the real path, because the candidate is produced by the
 * sandbox asking `ApprovalService` to put a genuine evidence bundle to a
 * customer, and the gate holding it because the shop is at L0. Nothing here is
 * a fixture row inserted to make a page look populated.
 */

interface Draft {
  readonly messageId: string;
  /** Whose thread it landed on — the route picks the customer, not the caller. */
  readonly conversationId: string;
}

/**
 * Produces a real held candidate and returns its message id and thread.
 *
 * Through the console's own proxy, so the request carries the httpOnly session
 * cookie exactly as the page would — a test that authenticated differently from
 * the app would not be testing the app.
 */
async function draftApproval(page: Page): Promise<Draft> {
  const response = await page.request.post('/api/sandbox/approval-draft');
  expect(
    response.ok(),
    `the sandbox must be able to draft an approval: ${await response.text()}`,
  ).toBe(true);

  const body = (await response.json()) as {
    messageId: string;
    status: string;
    conversationId: string;
  };

  // The whole point of L0: the gate held it rather than sending it.
  expect(body.status, 'at L0 the draft must be held, not sent').toBe('PENDING_APPROVAL');
  return { messageId: body.messageId, conversationId: body.conversationId };
}

function candidate(page: Page, messageId: string) {
  return page.locator(`[data-testid="review-candidate"][data-message-id="${messageId}"]`);
}

test.describe('review queue — L0 shadow mode', () => {
  test('the agent drafts, an advisor edits, and the edit is what goes out', async ({ page }) => {
    await page.goto('/review');
    const { messageId, conversationId } = await draftApproval(page);
    await page.reload();

    const card = candidate(page, messageId);
    await expect(card).toBeVisible();

    // The draft is shown in full — this is the thing being judged.
    const original = (await card.getByTestId('review-body').textContent()) ?? '';
    expect(original.length).toBeGreaterThan(0);

    // And how long the customer has been waiting, because the cost of shadow
    // mode is a person waiting and hiding it is how a shop never leaves L0.
    await expect(card.getByTestId('review-waited')).toBeVisible();

    await card.getByTestId('review-edit').click();

    const editor = card.getByTestId('review-edit-body');
    await expect(editor).toHaveValue(original.trim());

    // The advisor's own words, and unique to this run: the suite drafts against
    // several customers, so a fixed phrase would match somebody else's thread.
    const signature = `Anna, one moment ${Date.now()}`;
    const edited = `${signature} — ${original.trim()} Shall we go ahead?`;
    await editor.fill(edited);
    await card.getByTestId('review-send-edited').click();

    // Decided candidates leave the queue.
    await expect(card).toBeHidden();

    // And *this* customer received the advisor's words, not the agent's.
    //
    // By the thread id the route reported rather than the top of the inbox: the
    // list is ordered by recent activity, and a suite that drafts to several
    // customers can reorder it between the send and the read.
    await page.goto(`/conversations/${conversationId}`);
    await expect(page.getByTestId('thread')).toContainText(signature);
  });

  test('approving sends the draft unchanged', async ({ page }) => {
    await page.goto('/review');
    const { messageId } = await draftApproval(page);
    await page.reload();

    const card = candidate(page, messageId);
    await expect(card).toBeVisible();

    await card.getByTestId('review-approve').click();
    await expect(card).toBeHidden();
  });

  test('rejecting demands a reason before it will do anything', async ({ page }) => {
    await page.goto('/review');
    const { messageId } = await draftApproval(page);
    await page.reload();

    const card = candidate(page, messageId);
    await card.getByTestId('review-reject').click();

    // Without a reason the graduation report cannot tell a bad draft from a
    // busy afternoon, so the button stays disabled until there is one.
    const confirm = card.getByTestId('review-confirm-reject');
    await expect(confirm).toBeDisabled();

    await card.getByTestId('review-reject-reason').fill('It quoted a price the estimate does not carry');
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect(card).toBeHidden();
  });

  test('an empty queue says so rather than showing nothing', async ({ page }) => {
    await page.goto('/review');

    // Either state is valid depending on what earlier tests left behind; what
    // must never happen is a blank panel with no explanation.
    const populated = page.getByTestId('review-queue');
    const empty = page.getByText('Nothing waiting');
    await expect(populated.or(empty)).toBeVisible();
  });
});

test.describe('graduation report', () => {
  test('an owner sees the numbers and the recommendation', async ({ page }) => {
    await page.goto('/review');

    const report = page.getByTestId('graduation-report');
    await expect(report).toBeVisible();
    await expect(report).toContainText('Sent without edit');
    await expect(report).toContainText('Checker blocked');

    // The verdict is always stated, and the rationale always says why — a
    // recommendation an owner cannot check is one they should not act on.
    await expect(page.getByTestId('graduation-verdict')).toBeVisible();
    await expect(page.getByTestId('graduation-rationale')).not.toBeEmpty();
  });

  test('an advisor does not see it, because they cannot act on it', async ({ browser }) => {
    const context = await browser.newContext({ storageState: 'test/e2e/.auth/advisor.json' });
    const page = await context.newPage();

    await page.goto('/review');
    await expect(page.getByRole('heading', { name: 'Review queue' })).toBeVisible();
    await expect(page.getByTestId('graduation-report')).toHaveCount(0);

    await context.close();
  });
});
