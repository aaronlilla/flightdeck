import { expect, test } from '@playwright/test';

// Sweep #4: the real Promote click posted an empty body while the server always
// required {version, message} -- a 400 on every real click. The card must collect
// both before posting, and the stub must refuse an empty body the same way the real
// server does. After a successful promote the card shows the version, not a button.
test.beforeEach(async ({ request }) => {
  await request.post('/__test/fixture?name=queue-matrix');
});
test.afterAll(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});

test('Promote collects a version and message, then the card shows promoted <version>', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Queue', { exact: false }).click();
  const card = page.locator('.lane', { hasText: 'DONE' }).first();
  await card.getByText('Promote', { exact: true }).click();
  // Clicking Confirm promote with nothing typed must not post an empty body.
  await card.getByText('Confirm promote', { exact: true }).click();
  await expect(card.getByText('Confirm promote', { exact: true })).toBeVisible();

  await card.getByPlaceholder(/version/i).fill('1.4.2');
  await card.getByPlaceholder(/release message/i).fill('hotfix release');
  await card.getByText('Confirm promote', { exact: true }).click();

  await expect(page.getByTestId('toast')).toContainText('1.4.2');
  await expect(card.getByText('promoted 1.4.2')).toBeVisible();
  await expect(card.getByText('Promote', { exact: true })).toHaveCount(0);
});
