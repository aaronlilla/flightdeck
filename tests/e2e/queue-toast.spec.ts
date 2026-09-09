import { expect, test } from '@playwright/test';

// Sweep #3: the Queue tab's own actions (add/remove/retry/merge/promote) wrote a
// receipt to the rail thread only -- invisible from the Queue tab itself, where the
// operator actually is. Every outcome must also show as a toast right there.
test.beforeEach(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});
test.afterAll(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});

test('adding and then removing a queue item toasts on the Queue tab itself', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Queue', { exact: false }).click();

  await page.getByPlaceholder('BB-123').fill('TOAST-1');
  await page.getByPlaceholder('BB-123').press('Enter');
  await expect(page.getByTestId('toast')).toBeVisible();
  await expect(page.getByTestId('toast')).toContainText('added 1 item to the queue');

  const card = page.locator('.lane', { hasText: 'TOAST-1' });
  await expect(card).toBeVisible();
  await card.getByText('Remove', { exact: true }).click();
  // Remove is irreversible: the server's confirm card shows on the card itself, and
  // nothing runs (and no toast) until that token goes back.
  const confirmYes = card.locator('[data-testid^="action-confirm-yes-removeQueueItem-"]');
  await expect(confirmYes).toBeVisible();
  await confirmYes.click();
  await expect(page.getByTestId('toast')).toContainText(/remov/i);
  await expect(card).toHaveCount(0);
});
