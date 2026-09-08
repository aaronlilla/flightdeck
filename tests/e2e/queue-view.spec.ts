import { expect, test } from '@playwright/test';

// Cut-line #1: the queue view for every source and every state the current
// contract defines (`queue-matrix`, 4 sources x 7 states = 28 cards), plus the
// states and buttons D2.3 wires up (fix round, review with notes, Merge and
// Promote, the backoff paused banner).
test.beforeEach(async ({ request }) => {
  await request.post('/__test/fixture?name=queue-matrix');
});
test.afterAll(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});

test('the queue view renders every (source, state) card the matrix seeds, 28 in all', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Queue', { exact: false }).click();
  // Sweep #18: the header now names the badge's own subset alongside the total, so
  // "Queue 8" in the nav and this header explain each other rather than disagreeing.
  await expect(page.getByText('Queue · 28 items, 8 need attention')).toBeVisible();
  // One card per matrix row -- each queue card is a `.lane` plate, same shape
  // the board's own tiles use (`QueueCard` in QueueView.tsx).
  await expect(page.locator('.scroll .lane')).toHaveCount(28);
});

test('every source chip and every state label the taxonomy defines shows up somewhere in the grid', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Queue', { exact: false }).click();
  for (const source of ['ticket', 'brief', 'query', 'backlog']) {
    await expect(page.locator('.chip', { hasText: source }).first()).toBeVisible();
  }
  for (const label of ['QUEUED', 'PLANNING', 'RUNNING', 'PARKED', 'REVIEW', 'FAILED', 'DONE']) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }
});

test('a review card links its own draft PR, a parked card offers Retry, a queued card offers Remove', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Queue', { exact: false }).click();
  const reviewCard = page.locator('.lane', { hasText: 'REVIEW' }).first();
  await expect(reviewCard.getByRole('link', { name: /Open PR #\d+ →/ })).toBeVisible();
  const parkedCard = page.locator('.lane', { hasText: 'PARKED' }).first();
  await expect(parkedCard.getByText('Retry →', { exact: true })).toBeVisible();
  const queuedCard = page.locator('.lane', { hasText: 'QUEUED' }).first();
  await expect(queuedCard.getByText('Remove', { exact: true })).toBeVisible();
});

// D2.3: fix round, council notes, Merge/Promote and the backoff banner, all
// wired up in QueueView.tsx and the `queue-matrix` fixture.

test('a fix-round item shows the round count and the findings it is retrying against', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Queue', { exact: false }).click();
  await expect(page.locator('.lane', { hasText: /fix round 1/i }).first()).toBeVisible();
});

test('a review item with council notes shows them on its card', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Queue', { exact: false }).click();
  await expect(page.locator('.lane', { hasText: 'REVIEW' }).first().getByText(/council notes/i)).toBeVisible();
});

test('a review item on an allowlisted repo offers Merge, and a merged hotfix offers Promote', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Queue', { exact: false }).click();
  await expect(page.locator('.lane', { hasText: 'REVIEW' }).first().getByText('Merge', { exact: true })).toBeVisible();
  await expect(page.locator('.lane', { hasText: 'DONE' }).first().getByText('Promote', { exact: true })).toBeVisible();
});

test('three consecutive tick errors show a paused banner in the queue header with the backoff reason', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Queue', { exact: false }).click();
  await expect(page.getByText(/paused .* tick-error/i)).toBeVisible();
});
