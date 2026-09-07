import { expect, test } from '@playwright/test';

// Cut-line #2: every sheet, opened, then resized while still open -- each
// sheet clamps its own width (`maxWidth: 'calc(100vw - 40px)'`) rather than
// pushing the page into horizontal scroll or vanishing off screen.
test.beforeEach(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});
test.afterAll(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});

async function assertNoOverflow(page: import('@playwright/test').Page): Promise<void> {
  const { scrollWidth, innerWidth } = await page.evaluate<{ scrollWidth: number; innerWidth: number }>(
    '({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth })',
  );
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
}

test('the ticket sheet stays visible and un-overflowed across a resize', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByTestId('lane-FLT-201').click();
  const sheet = page.getByTestId('ticket-sheet');
  await expect(sheet).toBeVisible();
  await page.setViewportSize({ width: 900, height: 900 });
  await expect(sheet).toBeVisible();
  await assertNoOverflow(page);
  await page.setViewportSize({ width: 720, height: 900 });
  await expect(sheet).toBeVisible();
  await assertNoOverflow(page);
});

test('the cost sheet stays visible and un-overflowed across a resize', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByTestId('lane-FLT-201').click();
  await page.getByTestId('ticket-sheet').locator('.w0, .w1, .w2, .ws').first().click();
  const sheet = page.getByTestId('cost-sheet');
  await expect(sheet).toBeVisible();
  await page.setViewportSize({ width: 720, height: 900 });
  await expect(sheet).toBeVisible();
  await assertNoOverflow(page);
});

test('the fleet cost sheet stays visible and un-overflowed across a resize', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.locator('.w0, .w1, .w2').filter({ hasText: '/' }).click();
  const sheet = page.getByTestId('fleet-cost-sheet');
  await expect(sheet).toBeVisible();
  await page.setViewportSize({ width: 720, height: 900 });
  await expect(sheet).toBeVisible();
  await assertNoOverflow(page);
});

test('the sandbox sheet stays visible and un-overflowed across a resize', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByTestId('lane-FLT-201').click();
  await page.getByTestId('ticket-sheet').getByText('fd-2201', { exact: true }).first().click();
  const sheet = page.getByTestId('sandbox-sheet');
  await expect(sheet).toBeVisible();
  await page.setViewportSize({ width: 720, height: 900 });
  await expect(sheet).toBeVisible();
  await assertNoOverflow(page);
});

test('the journal sheet stays visible and un-overflowed across a resize', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  // Answered from the rail, not the ticket sheet -- see the fixme below for why
  // the ticket sheet's own copy of this same click does nothing.
  await page.getByText('nullable + backfill', { exact: true }).click();
  await expect(page.getByTestId('rail-thread')).toContainText(/resumed/);
  const jidLink = page.getByTestId('rail-thread').locator('a', { hasText: /^J-\d+$/ }).first();
  await jidLink.click();
  const sheet = page.getByTestId('journal-sheet');
  await expect(sheet).toBeVisible();
  await page.setViewportSize({ width: 720, height: 900 });
  await expect(sheet).toBeVisible();
  await assertNoOverflow(page);
});

// D2.2: fixed in App.tsx -- `onCommand`'s exact-match CTA switch now falls
// through to `processCommand` for anything it doesn't recognize as one of the
// board's own CTA commands, so the sheet's `answer ask-bbz-118 nullable +
// backfill` reaches the same `POST /command` path the rail's identical click
// already used.
test('answering a question from inside its own ticket sheet resumes the lane, same as answering from the rail', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('lane-BBZ-118').click();
  await page.getByTestId('ticket-sheet').getByText('nullable + backfill', { exact: true }).click();
  await expect(page.getByTestId('lane-BBZ-118')).toHaveAttribute('data-state', 'running');
});
