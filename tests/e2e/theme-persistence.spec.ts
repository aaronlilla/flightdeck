import { expect, test } from '@playwright/test';

// Cut-line #2: theme persistence across reload and across sizes. store.ts
// reads `localStorage['fd.theme']` on init and writes it back on every
// 'theme' action, so a reload -- at any viewport -- has to come back in the
// theme it was left in, never resetting to the dark default.
test.beforeEach(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});
test.afterAll(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});

test('switching to day mode survives a reload', async ({ page }) => {
  await page.goto('/');
  const root = page.locator('.app');
  await expect(root).toHaveClass(/thD/);
  await page.getByText('day mode').click();
  await expect(root).toHaveClass(/thL/);

  await page.reload();
  await expect(page.getByTestId('lane-FLT-201')).toBeVisible();
  await expect(page.locator('.app')).toHaveClass(/thL/);
});

test('a persisted light theme survives a reload at a narrower viewport', async ({ page }) => {
  await page.goto('/');
  await page.getByText('day mode').click();
  await expect(page.locator('.app')).toHaveClass(/thL/);

  await page.setViewportSize({ width: 720, height: 900 });
  await page.reload();
  await expect(page.getByTestId('lane-FLT-201')).toBeVisible();
  await expect(page.locator('.app')).toHaveClass(/thL/);
});

test('switching back to dark mode also persists across a reload', async ({ page }) => {
  await page.goto('/');
  await page.getByText('day mode').click();
  await expect(page.locator('.app')).toHaveClass(/thL/);
  await page.getByText('night ops', { exact: true }).click();
  await expect(page.locator('.app')).toHaveClass(/thD/);

  await page.reload();
  await expect(page.getByTestId('lane-FLT-201')).toBeVisible();
  await expect(page.locator('.app')).toHaveClass(/thD/);
});
