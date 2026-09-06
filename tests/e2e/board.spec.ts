import { expect, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

test('the board renders all 14 lanes', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-testid^="lane-"]')).toHaveCount(14);
});

// POLISH-2 #1: a lane with a ticket heads with the ticket; the long run id beneath
// it stays to one line, with the full id in the title attribute.
test('a lane with a ticket heads with the ticket and truncates the long run id beneath it', async ({ page }) => {
  await page.goto('/');
  const tile = page.getByTestId('lane-jira_AB-12_1788460932645');
  await expect(tile.getByText('AB-12', { exact: true })).toBeVisible();
  const runId = tile.getByText('jira_AB-12_1788460932645');
  await expect(runId).toHaveAttribute('title', 'jira_AB-12_1788460932645');
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

test('a lane tile prefixes its step text with step N/M, and shows no cap text unless it is runaway', async ({ page }) => {
  await page.goto('/');
  const runaway = page.getByTestId('lane-FLT-204');
  await expect(runaway.getByText('step 2/6 · retrying a flaky build step')).toBeVisible();
  await expect(runaway.getByText(/cap \$8 · exceeded/)).toBeVisible();
  const normal = page.getByTestId('lane-FLT-201');
  await expect(normal.getByText(/cap \$/)).toHaveCount(0);
});

test('an observed tile dims and its cost readout loses its glow', async ({ page }) => {
  await page.goto('/');
  const observed = page.getByTestId('lane-FLT-176');
  await expect(observed).toHaveCSS('opacity', '0.6');
  await expect(observed.locator('.ws')).toBeVisible();
});

test('the spend readout opens the fleet cost sheet', async ({ page }) => {
  await page.goto('/');
  await page.locator('.w0, .w1, .w2').filter({ hasText: '/' }).click();
  const sheet = page.getByTestId('fleet-cost-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('FLT-204')).toBeVisible();
});

// POLISH-2 #4: "today" defaults once the fleet passes 12 lanes; "all" refetches
// with ?all=1.
test('today is the default filter past 12 lanes, and all refetches with ?all=1', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('lane-FLT-201')).toBeVisible();
  await expect(page.locator('.chipOn', { hasText: 'today' })).toBeVisible();
  const allRequest = page.waitForRequest((req) => req.url().includes('/lanes?all=1'));
  await page.locator('.chip', { hasText: /^all \d+$/ }).click();
  await allRequest;
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
