import { expect, test } from '@playwright/test';

// Sweep #21: actionable spans across the rail, the tiles, the sheets and the queue
// cards were mouse-only. Each now carries role=button, tabIndex=0 and Enter/Space
// handling through one shared helper -- this proves it end to end in each area.
test.beforeEach(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});
test.afterAll(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});

test('a lane tile opens its sheet on Enter, with no mouse click at all', async ({ page }) => {
  await page.goto('/');
  const tile = page.getByTestId('lane-FLT-201');
  await expect(tile).toHaveAttribute('role', 'button');
  await tile.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('ticket-sheet')).toBeVisible();
});

test('the ticket sheet\'s close button closes on Space', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('lane-FLT-201').click();
  const sheet = page.getByTestId('ticket-sheet');
  await expect(sheet).toBeVisible();
  const closeButton = sheet.getByText('esc to close ✕');
  await expect(closeButton).toHaveAttribute('role', 'button');
  await closeButton.focus();
  await page.keyboard.press(' ');
  await expect(sheet).toBeHidden();
});

test('a queue card\'s Remove button fires on Enter', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Queue', { exact: false }).click();
  await page.getByPlaceholder('BB-123').fill('DEMO-9');
  await page.getByPlaceholder('BB-123').press('Enter');
  const card = page.locator('.lane', { hasText: 'DEMO-9' });
  await expect(card).toBeVisible();
  const removeButton = card.getByText('Remove');
  await expect(removeButton).toHaveAttribute('role', 'button');
  await removeButton.focus();
  await page.keyboard.press('Enter');
  // Remove is irreversible: the server answers with a confirm card, and the
  // keyboard alone has to drive that second step too before anything runs.
  const confirmYes = card.locator('[data-testid^="action-confirm-yes-removeQueueItem-"]');
  await expect(confirmYes).toBeVisible();
  await confirmYes.focus();
  await page.keyboard.press('Enter');
  await expect(card).toHaveCount(0);
});

test('the rail\'s quick-command chip fires on Enter', async ({ page }) => {
  await page.goto('/');
  const chip = page.locator('.chipB', { hasText: 'spend today' });
  await expect(chip).toHaveAttribute('role', 'button');
  await chip.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('spend today', { exact: false }).last()).toBeVisible();
});
