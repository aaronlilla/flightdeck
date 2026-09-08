import { expect, test } from '@playwright/test';

// Sweep #1: a confirm/plan card born from a typed rail command (`kill <lane>`,
// `merge ready lanes`) carries its own token in `btns`, distinct from the card's
// own `k`. Confirm/Run plan must send that token, and Not now must actually
// dismiss the card rather than leaving it "awaiting you"/"awaiting go" forever.
test.beforeEach(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});
test.afterAll(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});

test('typing "kill <lane>" and clicking Confirm actually kills the lane', async ({ page }) => {
  await page.goto('/');
  const rail = page.getByTestId('rail-thread');
  const composer = page.getByPlaceholder(/command…/);
  await composer.fill('kill FLT-201');
  await composer.press('Enter');
  await expect(rail.getByText('Confirm — irreversible')).toBeVisible();
  await rail.getByText('Confirm', { exact: true }).click();
  await expect(page.getByTestId('lane-FLT-201')).toHaveAttribute('data-state', 'killed');
  await expect(rail.getByText('confirmed')).toBeVisible();
  await expect(rail.getByText('FLT-201 killed').first()).toBeVisible();
});

test('typing "kill <lane>" and clicking Not now dismisses the card without killing anything', async ({ page }) => {
  await page.goto('/');
  const rail = page.getByTestId('rail-thread');
  const composer = page.getByPlaceholder(/command…/);
  await composer.fill('kill FLT-215');
  await composer.press('Enter');
  await expect(rail.getByText('Confirm — irreversible')).toBeVisible();
  await rail.getByText('Not now', { exact: true }).click();
  await expect(rail.getByText('declined')).toBeVisible();
  await expect(rail.getByText('Confirm', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('lane-FLT-215')).not.toHaveAttribute('data-state', 'killed');
});

test('"merge ready lanes" plan card: Run plan merges every ready lane', async ({ page }) => {
  await page.goto('/');
  const rail = page.getByTestId('rail-thread');
  const composer = page.getByPlaceholder(/command…/);
  await composer.fill('merge ready lanes');
  await composer.press('Enter');
  await expect(rail.getByText('Plan ·')).toBeVisible();
  await rail.getByText('Run plan').click();
  await expect(rail.getByText('confirmed')).toBeVisible();
  await expect(rail.getByText('FLT-193 merged').first()).toBeVisible();
});
