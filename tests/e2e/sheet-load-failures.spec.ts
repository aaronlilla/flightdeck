import { expect, test } from '@playwright/test';

// Sweep #26: CostSheet, SandboxSheet and the ticket sheet's summary block all
// swallowed a failed fetch and rendered as though the empty result were real data --
// "0 tokens"/no by-step breakdown, "no sandbox log", and a summary block that simply
// never appeared. Each must show an explicit could-not-load state instead.
test.beforeEach(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});
test.afterAll(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});

test('the cost sheet shows a could-not-load state when its own fetch fails, not a bare 0 tokens', async ({ page }) => {
  await page.route('**/run/*/cost', (route) => route.fulfill({ status: 500, body: 'boom' }));
  await page.goto('/');
  await page.getByTestId('lane-FLT-201').click();
  await page.getByTestId('ticket-sheet').locator('.w0, .w1, .w2, .ws').first().click();
  const sheet = page.getByTestId('cost-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText(/could not load/i)).toBeVisible();
});

test('the sandbox sheet shows a could-not-load state when its own fetch fails, not "no sandbox log"', async ({ page }) => {
  await page.route('**/run/*/sandbox', (route) => route.fulfill({ status: 500, body: 'boom' }));
  await page.goto('/');
  await page.getByTestId('lane-FLT-201').click();
  await page.getByTestId('ticket-sheet').getByText('sandbox', { exact: true }).first().click();
  const sheet = page.getByTestId('sandbox-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText(/could not load/i)).toBeVisible();
  await expect(sheet.getByText('no sandbox log')).toHaveCount(0);
});

test('the ticket sheet summary block shows a could-not-load state when its own fetch fails, not silence', async ({ page }) => {
  await page.route('**/run/*/summary', (route) => route.fulfill({ status: 500, body: 'boom' }));
  await page.goto('/');
  await page.getByTestId('lane-FLT-201').click();
  const sheet = page.getByTestId('ticket-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText(/could not load/i)).toBeVisible();
});
