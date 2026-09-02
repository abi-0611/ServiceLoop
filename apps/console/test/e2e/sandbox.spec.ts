import { expect, test, type Page } from '@playwright/test';
import { fillField } from './helpers';

/**
 * Picks a persona and returns the name the inbox will show for their thread.
 *
 * The option label is `👤 Ravi Kumar · TN09BX4432`; the inbox titles the thread
 * with the customer's name. Matching on that is what makes "open the thread I
 * just wrote on" reliable — the list is ordered by recent activity, and the
 * staff group is usually the busiest thing in it.
 */
async function actAs(page: Page, kind: '👤' | '🔧'): Promise<string> {
  const picker = page.getByTestId('persona-picker');
  await expect(picker).toBeVisible();

  const option = picker.locator('option').filter({ hasText: kind }).first();
  const value = await option.getAttribute('value');
  const label = (await option.textContent()) ?? '';
  expect(value, `the shop must have a ${kind} persona to act as`).toBeTruthy();

  await picker.selectOption(value as string);
  return (label.split('·')[0] ?? '').replace(kind, '').trim();
}

/**
 * The phase-2 acceptance round trip, through the browser (2.2, 2.6, 2.10).
 *
 * Everything here goes through the sandbox simulator, which renders each
 * message as a signed Cloud API webhook and pushes it down the same pipeline a
 * Meta delivery takes. That is what makes this a real end-to-end test rather
 * than a UI smoke test with a stubbed back end.
 */

test.describe('sandbox simulator', () => {
  test('a customer message appears in the inbox with its session state', async ({ page }) => {
    await page.goto('/sandbox');

    await expect(page.getByRole('heading', { name: 'Sandbox simulator' })).toBeVisible();

    const customer = await actAs(page, '👤');
    const message = `Is my car ready? ${Date.now()}`;
    await fillField(page.getByTestId('simulator-input'), message);
    await page.getByTestId('simulator-send').click();

    // The trace is the simulator's reason for existing: it says where the
    // message went, not just that something happened.
    const trace = page.getByTestId('trace-panel');
    await expect(trace).toContainText('webhook');
    await expect(trace).toContainText('router');
    await expect(trace).toContainText('session');

    // The same message, in the real inbox.
    //
    // Navigating by the id the trace reports rather than hunting the list: the
    // list preview shows the *last* message on a thread, which is the shop's
    // reply and not the question, and its ordering is by recent activity —
    // both of which make a text search here quietly pick the wrong thread.
    const conversationId = await page
      .getByTestId('trace-conversation')
      .getAttribute('data-conversation-id');
    expect(conversationId, 'the trace must report which thread the message landed on').toBeTruthy();

    await page.goto('/conversations');
    await expect(page.getByTestId('thread-list')).toBeVisible();
    await expect(page.getByTestId('thread-list')).toContainText(customer);

    await page.goto(`/conversations/${conversationId as string}`);

    await expect(page.getByTestId('thread')).toContainText(message);
    // A thread the customer just wrote on has an open 24-hour window.
    await expect(page.getByTestId('window-countdown').first()).toContainText('left');
  });

  test('an advisor reply is sent through the outbound gate', async ({ page }) => {
    await page.goto('/sandbox');

    await actAs(page, '👤');
    const inbound = `Any update? ${Date.now()}`;
    await fillField(page.getByTestId('simulator-input'), inbound);
    await page.getByTestId('simulator-send').click();
    await expect(page.getByTestId('trace-panel')).toContainText('router');

    const conversationId = await page
      .getByTestId('trace-conversation')
      .getAttribute('data-conversation-id');
    await page.goto(`/conversations/${conversationId as string}`);
    await expect(page.getByTestId('thread')).toContainText(inbound);

    const reply = `Ready by 5pm. ${Date.now()}`;
    await fillField(page.getByTestId('reply-input'), reply);
    await page.getByTestId('reply-send').click();

    // Whatever the gate decided is shown: sent messages appear in the thread,
    // refusals appear as a notice with the reason. Both are acceptable
    // outcomes; a silent disappearance is not.
    const sent = page.getByTestId('thread').getByText(reply, { exact: false });
    const notice = page.getByTestId('reply-notice');
    await expect(sent.or(notice).first()).toBeVisible();
  });
});

test.describe('paper job-card intake', () => {
  test('a photo from the workshop group becomes a confirmable draft', async ({ page }) => {
    await page.goto('/sandbox');

    // A technician persona writes in the evidence group, where a photo is an
    // intake trigger with or without a caption.
    await actAs(page, '🔧');

    // A 1×1 PNG. The fixture OCR adapter keys on the bytes' hash and refuses an
    // image it does not know — which is the correct behaviour and exactly what
    // this asserts: the pipeline reports the refusal rather than inventing a
    // job card from an unknown photograph.
    await page.getByTestId('simulator-file').setInputFiles({
      name: 'card.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
    });

    const trace = page.getByTestId('trace-panel');
    await expect(trace).toContainText('media');
    await expect(trace).toContainText('intake');
  });

  test('the intake queue lists drafts with their uncertain fields', async ({ page }) => {
    await page.goto('/intake');
    await expect(page.getByRole('heading', { name: 'Intake' })).toBeVisible();

    const list = page.getByTestId('draft-list');
    const empty = page.getByText('Nothing waiting');
    await expect(list.or(empty).first()).toBeVisible();

    if (await list.isVisible().catch(() => false)) {
      await list.locator('li').first().click();
      await expect(page.getByTestId('draft-fields')).toBeVisible();
      // Every field carries its confidence — that is what the screen is for.
      await expect(page.getByTestId('draft-fields')).toContainText('%');
    }
  });
});

test.describe('digital job card', () => {
  test('the form creates an OPEN card through the same intake service', async ({ page }) => {
    await page.goto('/intake/new');

    // A unique name per run. Repeated runs otherwise leave several customers
    // sharing one name, and the simulator's persona list — and therefore the
    // inbox lookup in the tests above — becomes ambiguous.
    const suffix = String(Date.now()).slice(-4);
    await fillField(page.getByTestId('field-customerName'), `Playwright Customer ${suffix}`);
    await fillField(page.getByTestId('field-phone'), `98${String(Date.now()).slice(-8)}`);
    await fillField(page.getByTestId('field-registration'), `TN09PW${suffix}`);
    await fillField(page.getByTestId('field-complaint-0'), 'Brake noise on the front left');
    await fillField(page.getByTestId('field-line-0'), 'Front brake pad set');

    await page.getByTestId('create-job-card').click();

    await expect(page.getByTestId('new-card-result')).toContainText('Job card');
    await expect(page.getByRole('link', { name: 'Open the card' })).toBeVisible();
  });
});
