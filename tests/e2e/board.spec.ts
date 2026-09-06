import { expect, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

test('the board renders all 13 lanes', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-testid^="lane-"]')).toHaveCount(13);
});

test('the needs-you strip shows the three sources: a down integration, a parked lane, an over-cap lane', async ({ page }) => {
  await page.goto('/');
  const strip = page.getByText('Needs you').locator('../..');
  await expect(strip.getByText('3', { exact: true })).toBeVisible();
  await expect(strip.getByText('AWS sandboxes')).toBeVisible();
  await expect(strip.getByText('BBZ-118').first()).toBeVisible();
});

test('command palette opens on cmd/ctrl+K and closes on Escape', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('command-palette')).toHaveCount(0);
});

test('the theme toggle switches between dark and light', async ({ page }) => {
  await page.goto('/');
  const root = page.locator('.app');
  await expect(root).toHaveClass(/thD/);
  await page.getByText('dark').click();
  await expect(root).toHaveClass(/thL/);
});

test('settings refuses a cap above the org hard limit', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Settings').click();
  const dailyInput = page.locator('input').first();
  await dailyInput.fill('9999');
  await page.getByText('Save caps →').click();
  await expect(page.getByText(/refused above the org hard limit/)).toBeVisible();
});

test('kill shows a confirm card before anything happens', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('lane-FLT-201').click();
  await expect(page.getByTestId('ticket-sheet')).toBeVisible();
  await page.getByTestId('ticket-sheet').getByText('Kill', { exact: true }).click();
  await expect(page.getByText('Confirm — irreversible')).toBeVisible();
  await page.getByText('Not now').click();
  await expect(page.getByTestId('lane-FLT-201')).toHaveAttribute('data-state', 'running');
});

test('a dropped feed shows the disconnected banner and disables the composer', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('lane-FLT-201')).toBeVisible();
  await page.route('**/lanes', (route) => route.abort());
  await page.route('**/thread', (route) => route.abort());
  await page.route('**/journal*', (route) => route.abort());
  await page.route('**/integrations', (route) => route.abort());
  await page.route('**/caps', (route) => route.abort());
  await page.route('**/proposals', (route) => route.abort());
  await expect(page.getByText(/live feed lost/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Composer disabled/)).toBeVisible();
});
