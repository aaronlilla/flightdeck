import { expect, test } from '@playwright/test';

// Sweep #6: `buildNeeds` kept a lane whose question was dismissed (cleared to null,
// but the lane stays `parked`) in Needs You as an ordinary "asks: -" plate, and the
// dismiss itself rendered as a red Refused card even though it succeeded.
test.beforeEach(async ({ request }) => {
  await request.post('/__test/fixture?name=human-board');
});
test.afterAll(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});

test('dismissing a stale ask drops it from Needs You and posts a plain success, not a refusal', async ({ page }) => {
  await page.goto('/');
  const strip = page.getByText('Needs you').locator('../..');
  await expect(strip.getByText('Dismiss', { exact: true })).toBeVisible();
  await strip.getByText('Dismiss', { exact: true }).click();
  await expect(strip.getByText('Dismiss', { exact: true })).toHaveCount(0);
  await expect(strip.getByText(/^asks: —$|^asks: -$/)).toHaveCount(0);
  await expect(page.getByText('Refused')).toHaveCount(0);
});
