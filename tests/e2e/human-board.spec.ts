import { expect, test } from '@playwright/test';

// H2.7: the human-UI board -- 31 lanes shaped like the real one this stream was
// reported against (4 probes, a ticket retried three times, a draft PR in review,
// a done+merged lane, a killed lane, a lane parked on a question, a self item),
// exercising H2.1 through H2.6 against one shared fixture.
test.beforeEach(async ({ request }) => {
  await request.post('/__test/fixture?name=human-board');
});
test.afterAll(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});

test('H2.1: a titled tile bolds the ticket key, names its kind, and shows the plain sentence', async ({ page }) => {
  await page.goto('/');
  const tile = page.getByTestId('lane-merged-1');
  await expect(tile).toBeVisible();
  await expect(tile.getByText('FLT-702')).toBeVisible();
  await expect(tile.getByText('fix the withdrawal fee rounding error')).toBeVisible();
  await expect(tile.getByText('ticket')).toBeVisible();
  await expect(tile.getByText(/Merged into develop/)).toBeVisible();
  await expect(tile.getByText('PR #120')).toBeVisible();
});

test('H2.1 fix: a long title wraps onto its own second line under the key, never running the key and the title together', async ({ page }) => {
  await page.goto('/');
  const tile = page.getByTestId('lane-long-title-1');
  await expect(tile).toBeVisible();
  const key = tile.getByText('FLT-705', { exact: true });
  await expect(key).toBeVisible();
  const keyRowText = await key.locator('xpath=..').textContent();
  expect(keyRowText ?? '').not.toContain('withdrawal fee');
});

test('H1.3 fix: a PR the board has never read shows "checks not read yet" and no fabricated 0 files +0 -0', async ({ page }) => {
  await page.goto('/');
  const tile = page.getByTestId('lane-unread-pr-1');
  await expect(tile).toBeVisible();
  await expect(tile.getByRole('link', { name: 'PR #121' })).toBeVisible();
  await expect(tile.getByText(/checks not read yet/)).toBeVisible();
  await expect(tile.getByText(/0 files/)).toHaveCount(0);
});

test('Needs-you fix: a stale ask shows as "stale ask from ..." with Dismiss, and Dismiss clears it', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText(/stale ask from .*FLT-707/)).toBeVisible();
  await page.getByText('Dismiss').first().click();
  await expect(page.getByText(/stale ask from .*FLT-707/)).toHaveCount(0);
});

test('H2.2: the three-attempt chain ticket folds into one card with an attempt chip, and probes hide by default', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-testid^="lane-chain-"]')).toHaveCount(1);
  await expect(page.getByText('attempt 3 of 3')).toBeVisible();
  await expect(page.getByTestId('lane-probe-0')).toHaveCount(0);
  await page.getByText('Probes').click();
  await expect(page.getByTestId('lane-probe-0')).toBeVisible();
});

test('H2.2: the Archived filter starts empty until something is retired', async ({ page }) => {
  await page.goto('/');
  await page.getByText(/^Archived \d+$/).click();
  await expect(page.getByText('no lanes match this filter')).toBeVisible();
});

test('H2.3: Clean up previews and retires the finished lanes, which then show under Archived', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Clean up', { exact: true }).click();
  await expect(page.getByText(/Retire \d+ finished lanes/)).toBeVisible();
  await page.getByText('Confirm', { exact: true }).click();
  await expect(page.getByText(/retired \d+ lanes/)).toBeVisible();
  await page.getByText(/^Archived \d+$/).click();
  await expect(page.getByTestId('lane-merged-1')).toBeVisible();
  await expect(page.getByText('Unretire').first()).toBeVisible();
});

test('H2.3: Merge ready previews and merges the one ready PR', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Merge ready', { exact: true }).click();
  await expect(page.getByText(/Merge \d+ ready lanes/)).toBeVisible();
  await page.getByText('Confirm', { exact: true }).click();
  await expect(page.getByText(/merged \d+ lanes/)).toBeVisible();
});

test('H2.4: the ticket sheet shows the kind, a source link, and the Story section', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('lane-merged-1').click();
  const sheet = page.getByTestId('ticket-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('ticket')).toBeVisible();
  await expect(sheet.getByText('source ↗')).toBeVisible();
  await expect(sheet.getByText('Story')).toBeVisible();
});

test('H2.6: the palette finds a lane by its title, not its run id', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder('lane, ticket, journal id, view…').fill('withdrawal fee rounding');
  await expect(page.getByTestId('command-palette').getByText('FLT-702', { exact: true })).toBeVisible();
  await page.getByPlaceholder('lane, ticket, journal id, view…').fill('merged-1');
  await expect(page.getByTestId('command-palette').getByText('FLT-702', { exact: true })).toHaveCount(0);
});

test('board-after screenshot at 1440x900', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('lane-merged-1')).toBeVisible();
  await page.screenshot({ path: 'test-results/board-after.png', fullPage: false });
});
