import { expect, test } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  await request.post('/__test/fixture?name=long-thread');
});
test.afterAll(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});

test('the ticket sheet never grows past the screen; its thread scrolls inside', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByTestId('lane-FLT-201').click();
  const sheet = page.getByTestId('ticket-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('Turn 80: edited a file and ran the unit suite')).toBeAttached();
  const box = await sheet.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(900);
  // Item 6: the body itself never scrolls -- the thread column scrolls inside
  // itself, and the composer is pinned at the bottom of the right column,
  // reachable with no scrolling at all, the sheet's band with "esc to close"
  // never moves.
  const thread = page.getByTestId('ticket-sheet-thread');
  const scrolls = await thread.evaluate((el) => { const box = el as unknown as { scrollHeight: number; clientHeight: number }; return box.scrollHeight > box.clientHeight + 50; });
  expect(scrolls).toBe(true);
  await expect(sheet.getByPlaceholder(/Tell this run something/)).toBeInViewport();
  await expect(sheet.getByText('esc to close ✕')).toBeInViewport();
  const after = await sheet.boundingBox();
  expect(after!.y + after!.height).toBeLessThanOrEqual(900);
});
