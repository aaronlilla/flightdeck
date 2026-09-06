import { expect, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

test('the board renders all 15 lanes', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-testid^="lane-"]')).toHaveCount(15);
});

// Final fidelity sweep #1: a lane with a ticket heads the tile with the ticket
// alone, one line, exactly as the prototype's `{{l.id}}` -- the long run id
// never renders as a second visible line, only as the headline's title attribute.
test('a lane with a ticket heads the tile with the ticket alone, run id only in the title', async ({ page }) => {
  await page.goto('/');
  const tile = page.getByTestId('lane-jira_AB-12_1788460932645');
  const headline = tile.getByText('AB-12', { exact: true });
  await expect(headline).toBeVisible();
  await expect(headline).toHaveAttribute('title', 'jira_AB-12_1788460932645');
  await expect(tile.getByText('jira_AB-12_1788460932645', { exact: true })).toHaveCount(0);
});

test('the needs-you strip shows the three sources: a down integration, a parked lane, an over-cap lane', async ({ page }) => {
  await page.goto('/');
  const strip = page.getByText('Needs you').locator('../..');
  await expect(strip.getByText('3', { exact: true })).toBeVisible();
  await expect(strip.getByText('AWS sandboxes')).toBeVisible();
  await expect(strip.getByText('BBZ-118').first()).toBeVisible();
});

// Final fidelity sweep #3: the prototype's needs-you strip is one row of shrinking
// plates at 1440, never a third plate wrapping onto a second full-width row.
test('the needs-you strip keeps all three plates on one row at 1440', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const strip = page.getByText('Needs you').locator('../..');
  const plates = strip.locator('.plate');
  await expect(plates).toHaveCount(3);
  // The web fonts land after the first paint and reflow the plates, so measure only once
  // the layout has stopped moving; otherwise this reads a mid-reflow frame and flakes.
  // The main tsconfig carries no DOM lib, so browser globals are reached through a
  // string-bodied evaluate rather than a typed arrow, the same way overflow.spec.ts does.
  await page.evaluate('document.fonts.ready');
  await expect.poll(async () => {
    const tops = await page.evaluate<number[]>(
      `Array.from(document.querySelectorAll('.plate')).map(n => Math.round(n.getBoundingClientRect().y))`);
    return new Set(tops).size;
  }, { timeout: 5000 }).toBe(1);
});

test('command palette opens on cmd/ctrl+K and closes on Escape', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('command-palette')).toHaveCount(0);
});

// Row: the theme chip labels the mode a click switches TO, not the mode showing
// now (script_wrapped.txt 303) -- so the chip reads "day mode" while dark.
test('the theme toggle switches between dark and light', async ({ page }) => {
  await page.goto('/');
  const root = page.locator('.app');
  await expect(root).toHaveClass(/thD/);
  await page.getByText('day mode').click();
  await expect(root).toHaveClass(/thL/);
});

test('settings refuses a cap above the org hard limit', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Settings').click();
  const dailyInput = page.locator('input').first();
  await dailyInput.fill('99000000');
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

// Row: cap text matches the prototype's own `'cap $'+cap+' · ×'+Math.round(cost/cap)`, in
// tokens now rather than dollars
// (no word "exceeded", multiplier rounded), and shows once cost exceeds cap regardless
// of the separate `runaway` flag.
test('a lane tile prefixes its step text with step N/M, and shows cap text once cost exceeds cap', async ({ page }) => {
  await page.goto('/');
  const runaway = page.getByTestId('lane-FLT-204');
  await expect(runaway.getByText('step 2/6 · retrying a flaky build step')).toBeVisible();
  await expect(runaway.getByText('cap 1.6M tokens · ×3')).toBeVisible();
  const normal = page.getByTestId('lane-FLT-201');
  await expect(normal.getByText(/cap \d/)).toHaveCount(0);
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

// POLISH-2 #4: "today" defaults once the fleet passes 12 lanes -- the filter row no
// The prototype's board opens on `all`, whatever the fleet's size, and the chip that is
// active says so. Nothing switches the filter on the operator's behalf.
test('the board opens on all, and all is the active chip', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('lane-FLT-201')).toBeVisible();
  await expect(page.locator('.chipOn', { hasText: /^all \d+$/ })).toHaveCount(1);
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
