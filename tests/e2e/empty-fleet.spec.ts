import { expect, test } from '@playwright/test';

// Own isolated fixture (`empty-fleet`), reset back to `default` afterwards so a
// spec file that runs after this one in the shared stub process never inherits
// zero lanes by accident.
test.beforeEach(async ({ request }) => {
  await request.post('/__test/fixture?name=empty-fleet');
});
test.afterAll(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});

test('an empty fleet renders no lanes, the all chip at 0, and no needs-you strip', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-testid^="lane-"]')).toHaveCount(0);
  await expect(page.locator('.chipOn', { hasText: /^all \d+$/ })).toHaveText('all 0');
  await expect(page.getByText('Needs you')).toHaveCount(0);
});

test('an empty fleet shows the queue empty state and the board rail, not a crash', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('rail-thread')).toBeVisible();
  await page.getByText('Queue', { exact: false }).click();
  await expect(page.getByText('nothing queued', { exact: false })).toBeVisible();
});

test('the palette has nothing to list but a lane and still opens and closes', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('command-palette')).toBeVisible();
  // Views still show up with no query -- the palette's own list is never empty
  // just because the fleet is.
  await expect(page.getByText('switch view').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('command-palette')).toHaveCount(0);
});
