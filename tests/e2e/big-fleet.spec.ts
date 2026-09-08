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

// Sweep #19: a tile's title is meant to clamp to two lines regardless of how long
// the ticket key or the title text runs.
test('a tile with a 140-character key+title clamps its title box to two lines', async ({ page }) => {
  test.slow();
  await page.goto('/');
  const tile = page.getByTestId('lane-FLT-9999-long-title-clamp-check');
  await expect(tile).toBeVisible();
  await tile.scrollIntoViewIfNeeded();
  const titleBox = tile.getByText('the withdrawal fee calculator rounds down', { exact: false });
  const box = await titleBox.boundingBox();
  expect(box).not.toBeNull();
  // LaneTile.tsx sets this element's own font-size to 12px inline; two lines at a
  // typical ~1.5 line-height plus a little rendering slack is a generous two-line cap
  // -- an unclamped tile with this much text would run to five or six lines instead.
  expect(box!.height).toBeLessThanOrEqual(12 * 1.5 * 2 + 6);
});

test('the palette still finds a specific lane by id inside 2000 rows', async ({ page }) => {
  test.slow();
  await page.goto('/');
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder('lane, ticket, journal id, view…').fill('FLT-9999');
  await expect(page.getByTestId('command-palette').getByText('FLT-9999', { exact: true })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('ticket-sheet')).toBeVisible();
  // FLT-9999 shows up twice now (the big headline, and the ticket chip beside
  // it) -- .first() picks the headline, which is what "opened the right sheet"
  // actually needs to prove.
  await expect(page.getByTestId('ticket-sheet').getByText('FLT-9999', { exact: true }).first()).toBeVisible();
});
