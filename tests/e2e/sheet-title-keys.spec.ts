import { expect, test } from '@playwright/test';

// Sweep #31: CostSheet, SandboxSheet and FleetCostSheet titled themselves with the raw
// run id (e.g. "merged-1") instead of the lane's own ticket key -- the run id belongs
// in a `title` attribute tooltip, never as visible text.
test.beforeEach(async ({ request }) => {
  await request.post('/__test/fixture?name=human-board');
});
test.afterAll(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});

test('the cost sheet titles itself with the ticket key, not the raw run id', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('lane-merged-1').click();
  await page.getByTestId('ticket-sheet').locator('.w0, .w1, .w2, .ws').first().click();
  const sheet = page.getByTestId('cost-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('FLT-702', { exact: false })).toBeVisible();
  await expect(sheet.getByText('merged-1')).toHaveCount(0);
});

test('the sandbox sheet titles itself with the ticket key, not the raw run id', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('lane-merged-1').click();
  await page.getByTestId('ticket-sheet').getByText('sandbox', { exact: true }).first().click();
  const sheet = page.getByTestId('sandbox-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('FLT-702', { exact: false })).toBeVisible();
  await expect(sheet.getByText('merged-1')).toHaveCount(0);
});

test('the fleet cost sheet lists lanes by ticket key, not the raw run id', async ({ page }) => {
  await page.goto('/');
  await page.locator('.w0, .w1, .w2').filter({ hasText: '/' }).click();
  const sheet = page.getByTestId('fleet-cost-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('FLT-702', { exact: false })).toBeVisible();
  await expect(sheet.getByText('merged-1')).toHaveCount(0);
});
