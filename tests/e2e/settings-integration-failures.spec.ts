import { expect, test } from '@playwright/test';

// Sweep #29: the Settings screen's own "manage" (check-now) and "Reconnect" buttons
// each fired their POST with no catch, so a 500 vanished into an unhandled rejection
// and the operator got no feedback at all.
test.beforeEach(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});
test.afterAll(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});

test('a failed check-now shows up as a receipt, not silence', async ({ page }) => {
  await page.route('**/integrations/github/check', (route) => route.fulfill({ status: 500, body: 'boom' }));
  await page.goto('/');
  await page.getByText('Settings').click();
  await page.locator('.row', { hasText: 'GitHub' }).getByText('manage').click();
  await expect(page.getByTestId('toast')).toBeVisible();
  await expect(page.getByTestId('toast')).toContainText('the server did not say why');
});

test('a failed reconnect shows up as a receipt, not silence', async ({ page }) => {
  await page.route('**/integrations/aws/reconnect', (route) => route.fulfill({ status: 500, body: 'boom' }));
  await page.goto('/');
  await page.getByText('Settings').click();
  await page.locator('.row', { hasText: 'AWS sandboxes' }).getByText(/Reconnect/).click();
  await expect(page.getByTestId('toast')).toBeVisible();
  await expect(page.getByTestId('toast')).toContainText('the server did not say why');
});

test('the settings screen has no dead "Paste credentials" or "+ add server" controls', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Settings').click();
  await expect(page.getByText('Paste credentials')).toHaveCount(0);
  await expect(page.getByText('+ add server')).toHaveCount(0);
});
