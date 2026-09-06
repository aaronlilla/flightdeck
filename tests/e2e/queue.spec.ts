import { expect, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

// Drives the whole intake-queue path through the browser against the stub server's own
// fake planner/chain (`stub-server.ts#fakeAdvance`): add a ticket, watch it move off the
// queue's own board from queued to review, and follow the draft PR link it lands on.
// Nothing here is a real Jira ticket, a real worktree, or a real pull request -- this
// proves the console's own wiring end to end, not the real planner or the real chain.
test('adding a ticket reaches review with a draft PR link', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Queue', { exact: false }).click();
  await expect(page.getByText('nothing queued', { exact: false })).toBeVisible();

  await page.getByPlaceholder('BB-123').fill('DEMO-1');
  await page.getByPlaceholder('BB-123').press('Enter');

  // `getByText` matches case-insensitive substrings by default, and "Flight review" in
  // the top nav already contains "review" -- scoped to the queue card's own state label
  // so this actually waits for the item, never the nav bar that was on screen the whole
  // time.
  const card = page.locator('.lane', { hasText: 'DEMO-1' });
  await expect(card.locator('.lbl')).toHaveText(/QUEUED|RUNNING/);
  await expect(card.locator('.lbl')).toHaveText('REVIEW', { timeout: 10_000 });

  const prLink = page.getByRole('link', { name: /Open PR #\d+/ });
  await expect(prLink).toBeVisible();
  await expect(prLink).toHaveAttribute('href', /https:\/\/github\.com\/example\/repo\/pull\/\d+/);
});

test('a pasted brief and a query both add items', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Queue', { exact: false }).click();

  await page.getByText('brief', { exact: true }).click();
  await page.getByPlaceholder('# Goal: ...').fill('# Goal: fix the thing');
  await page.getByText('Add ⏎').click();
  await expect(page.locator('.lane', { hasText: 'brief' }).first()).toBeVisible();

  await page.getByText('query', { exact: true }).click();
  const queryInput = page.locator('input.inp');
  await queryInput.fill('sprint = 42');
  await queryInput.press('Enter');
  await expect(page.locator('.chip', { hasText: 'query' }).first()).toBeVisible();
});
