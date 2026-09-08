import { expect, test } from '@playwright/test';

// Sweep #11: a sheet had no focus trap -- Tab walked off it onto the tiles behind it.
// Tab (and Shift+Tab) must cycle only within the open sheet, and Escape must still close.
test.beforeEach(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});
test.afterAll(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});

test('Tab cycles within the open ticket sheet and never reaches a covered tile', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('lane-FLT-201').click();
  const sheet = page.getByTestId('ticket-sheet');
  await expect(sheet).toBeVisible();

  // Tab all the way around the ring (comfortably more presses than the sheet has
  // focusable elements) and check focus never leaves the sheet.
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press('Tab');
    const insideSheet = await page.evaluate(`(() => {
      const sheetEl = document.querySelector('[data-testid="ticket-sheet"]');
      return sheetEl ? sheetEl.contains(document.activeElement) : false;
    })()`) as boolean;
    expect(insideSheet).toBe(true);
  }
});

test('Escape still closes the sheet with the focus trap wired', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('lane-FLT-201').click();
  const sheet = page.getByTestId('ticket-sheet');
  await expect(sheet).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
});
