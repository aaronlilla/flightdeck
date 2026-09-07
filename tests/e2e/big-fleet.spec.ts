import { expect, test } from '@playwright/test';

// Cut-line #2: the board at operational scale -- 2000 lanes, ten times the
// seed board's baker's dozen -- has to render, count, and filter correctly
// rather than only ever being proven against a handful of hand-written rows.
test.beforeEach(async ({ request }) => {
  await request.post('/__test/fixture?name=big-fleet');
});
test.afterAll(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});

test('a 2000-lane fleet renders every tile and the all chip counts all of them', async ({ page }) => {
  test.slow();
  await page.goto('/');
  await expect(page.getByTestId('lane-FLT-9000')).toBeVisible();
  await expect(page.locator('[data-testid^="lane-"]')).toHaveCount(2000);
  await expect(page.locator('.chipOn', { hasText: /^all \d+$/ })).toHaveText('all 2000');
});

test('the running filter at scale shows only running lanes, none of the other six states', async ({ page }) => {
  test.slow();
  await page.goto('/');
  await page.getByText(/^running \d+$/).click();
  const shown = page.locator('[data-testid^="lane-"]');
  const count = await shown.count();
  expect(count).toBeGreaterThan(0);
  expect(count).toBeLessThan(2000);
  for (let i = 0; i < count; i += 1) {
    await expect(shown.nth(i)).toHaveAttribute('data-state', 'running');
  }
});

test('the palette still finds a specific lane by id inside 2000 rows', async ({ page }) => {
  test.slow();
  await page.goto('/');
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder('lane, ticket, journal id, view…').fill('FLT-9999');
  await expect(page.getByTestId('command-palette').getByText('FLT-9999', { exact: true })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('ticket-sheet')).toBeVisible();
  await expect(page.getByTestId('ticket-sheet').getByText('FLT-9999', { exact: true })).toBeVisible();
});
